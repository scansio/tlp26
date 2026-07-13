/**
 * Trade Analysis Workflow — 9-Step Decision Pipeline
 *
 * Steps:
 *  1. fetchMarketData       — OHLCV for 1h, 4h, 1d
 *  2. computeIndicators     — RSI, EMA, MACD, BB, ADX (per timeframe)
 *  3. detectSMCStructures   — FVG, OB, BOS/ChoCH, liquidity sweeps
 *  4. detectChartPatterns   — classical pattern detection
 *  5. analyzeOrderBook      — L2 liquidity walls + imbalance
 *  6a/6b (parallel):
 *     fetchNews             — CryptoPanic + CoinGecko sentiment
 *     fetchOnchainSignals   — funding rate + netflow + liquidation levels
 *  7. agentDecision         — trading-agent synthesizes everything
 *  8. calculateRisk         — position size + net P&L after fees/slippage
 *  9. routeSignal           — persist to trade_signals; auto-execute deferred
 *
 * Each step wraps its execute body in a 30-second Promise.race timeout.
 * The execute-trade-tool is not yet implemented (TLP-16); the auto-execute
 * branch in step 9 logs a warning and is marked deferred.
 */

import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { db } from '@/db';
import { tradeSignals, userRiskProfiles } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { propagatePublisherSignal } from '@/lib/copy-mirror-engine';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reject after `ms` milliseconds with a descriptive error. */
function timeoutAfter(ms: number, label: string): Promise<never> {
  return new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Step "${label}" timed out after ${ms}ms`)), ms),
  );
}

const STEP_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Shared candle schema (mirrors market-data-tool / indicators-tool)
// ---------------------------------------------------------------------------

const candleSchema = z.object({
  timestamp: z.number(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
});

// ---------------------------------------------------------------------------
// Step 1 — fetchMarketData
// Input:  { userId, symbol, triggeredBy, accountBalance }
// Output: adds { candles1h, candles4h, candles1d }
// ---------------------------------------------------------------------------

const step1InputSchema = z.object({
  userId: z.string(),
  symbol: z.string(),
  triggeredBy: z.enum(['scheduled', 'manual', 'tradingview']),
  /** Account balance in USDT used for risk sizing in step 8.
   *  Defaults to 10 000 USDT when not provided; callers should supply the
   *  real balance once live execution is enabled. */
  accountBalance: z.number().positive().default(10_000),
  /** Exchange to use for all data + execution (default: binance). */
  exchange: z.enum(['binance', 'bybit', 'bingx']).default('binance'),
});

const step1OutputSchema = step1InputSchema.extend({
  candles1h: z.array(candleSchema),
  candles4h: z.array(candleSchema),
  candles1d: z.array(candleSchema),
});

const fetchMarketData = createStep({
  id: 'fetchMarketData',
  description: 'Fetch OHLCV candles for 1h, 4h, and 1d timeframes via CCXT.',
  inputSchema: step1InputSchema,
  outputSchema: step1OutputSchema,
  execute: async ({ inputData, mastra }) => {
    const work = async () => {
      const { symbol, exchange } = inputData;
      const tool = mastra?.getTool('marketDataTool');
      if (!tool) throw new Error('marketDataTool not found in Mastra instance');

      const [r1h, r4h, r1d] = await Promise.all([
        tool.execute!({ symbol, timeframe: '1h', limit: 200, exchange }, {}),
        tool.execute!({ symbol, timeframe: '4h', limit: 200, exchange }, {}),
        tool.execute!({ symbol, timeframe: '1d', limit: 200, exchange }, {}),
      ]);

      return {
        ...inputData,
        candles1h: (r1h as { candles: z.infer<typeof candleSchema>[] }).candles,
        candles4h: (r4h as { candles: z.infer<typeof candleSchema>[] }).candles,
        candles1d: (r1d as { candles: z.infer<typeof candleSchema>[] }).candles,
      };
    };

    return Promise.race([work(), timeoutAfter(STEP_TIMEOUT_MS, 'fetchMarketData')]);
  },
});

// ---------------------------------------------------------------------------
// Step 2 — computeIndicators
// ---------------------------------------------------------------------------

const indicatorsResultSchema = z.object({
  rsi: z.object({
    value: z.number(),
    classification: z.enum(['OVERSOLD', 'NEUTRAL', 'OVERBOUGHT']),
    direction: z.enum(['BULLISH', 'BEARISH', 'NEUTRAL']),
  }),
  ema: z.object({
    ema20: z.number(),
    ema50: z.number(),
    ema200: z.number(),
    priceAboveEma20: z.boolean(),
    priceAboveEma50: z.boolean(),
    priceAboveEma200: z.boolean(),
    direction: z.enum(['BULLISH', 'BEARISH', 'NEUTRAL']),
  }),
  macd: z.object({
    macdLine: z.number(),
    signalLine: z.number(),
    histogram: z.number(),
    crossoverDirection: z.enum(['BULLISH_CROSSOVER', 'BEARISH_CROSSOVER', 'NO_CROSSOVER']),
    direction: z.enum(['BULLISH', 'BEARISH', 'NEUTRAL']),
  }),
  bollingerBands: z.object({
    upper: z.number(),
    middle: z.number(),
    lower: z.number(),
    bandwidthPercent: z.number(),
    pricePosition: z.enum(['ABOVE_UPPER', 'NEAR_UPPER', 'MIDDLE', 'NEAR_LOWER', 'BELOW_LOWER']),
    direction: z.enum(['BULLISH', 'BEARISH', 'NEUTRAL']),
  }),
  adx: z.object({
    value: z.number(),
    trendStrength: z.enum(['WEAK', 'MODERATE', 'STRONG']),
    direction: z.enum(['BULLISH', 'BEARISH', 'NEUTRAL']),
  }),
  candleCount: z.number(),
});

const step2OutputSchema = step1OutputSchema.extend({
  indicators1h: indicatorsResultSchema,
  indicators4h: indicatorsResultSchema,
  indicators1d: indicatorsResultSchema,
});

const computeIndicators = createStep({
  id: 'computeIndicators',
  description: 'Compute RSI, EMA, MACD, Bollinger Bands, ADX for each timeframe.',
  inputSchema: step1OutputSchema,
  outputSchema: step2OutputSchema,
  execute: async ({ inputData, mastra }) => {
    const work = async () => {
      const tool = mastra?.getTool('indicatorsTool');
      if (!tool) throw new Error('indicatorsTool not found in Mastra instance');

      const [ind1h, ind4h, ind1d] = await Promise.all([
        tool.execute!({ candles: inputData.candles1h }, {}),
        tool.execute!({ candles: inputData.candles4h }, {}),
        tool.execute!({ candles: inputData.candles1d }, {}),
      ]);

      return {
        ...inputData,
        indicators1h: ind1h as z.infer<typeof indicatorsResultSchema>,
        indicators4h: ind4h as z.infer<typeof indicatorsResultSchema>,
        indicators1d: ind1d as z.infer<typeof indicatorsResultSchema>,
      };
    };

    return Promise.race([work(), timeoutAfter(STEP_TIMEOUT_MS, 'computeIndicators')]);
  },
});

// ---------------------------------------------------------------------------
// Step 3 — detectSMCStructures
// ---------------------------------------------------------------------------

const smcDetectionSchema = z.object({
  type: z.string(),
  priceLevel: z.number(),
  direction: z.enum(['BULLISH', 'BEARISH']),
  strengthScore: z.number(),
  distanceFromCurrentPrice: z.number(),
});

const smcResultSchema = z.object({
  fvgs: z.array(smcDetectionSchema),
  orderBlocks: z.array(smcDetectionSchema),
  bos: z.array(smcDetectionSchema),
  choch: z.array(smcDetectionSchema),
  liquiditySweeps: z.array(smcDetectionSchema),
  currentPrice: z.number(),
  candleCount: z.number(),
});

const step3OutputSchema = step2OutputSchema.extend({
  smcStructures: smcResultSchema,
});

const detectSMCStructures = createStep({
  id: 'detectSMCStructures',
  description: 'Detect FVG, Order Blocks, BOS/ChoCH, and liquidity sweeps using SMC tool.',
  inputSchema: step2OutputSchema,
  outputSchema: step3OutputSchema,
  execute: async ({ inputData, mastra }) => {
    const work = async () => {
      const tool = mastra?.getTool('smcTool');
      if (!tool) throw new Error('smcTool not found in Mastra instance');

      // Use 1h candles as the primary timeframe for SMC structures
      const result = await tool.execute!({ candles: inputData.candles1h }, {});

      return {
        ...inputData,
        smcStructures: result as z.infer<typeof smcResultSchema>,
      };
    };

    return Promise.race([work(), timeoutAfter(STEP_TIMEOUT_MS, 'detectSMCStructures')]);
  },
});

// ---------------------------------------------------------------------------
// Step 4 — detectChartPatterns
// ---------------------------------------------------------------------------

const patternSchema = z.object({
  type: z.string(),
  direction: z.enum(['BULLISH', 'BEARISH', 'NEUTRAL']),
  confidenceScore: z.number(),
  necklinePrice: z.number().optional(),
  targetPrice: z.number().optional(),
  stopLossPrice: z.number().optional(),
  patternStartIndex: z.number(),
  patternEndIndex: z.number(),
  description: z.string(),
});

const step4OutputSchema = step3OutputSchema.extend({
  chartPatterns: z.array(patternSchema),
});

const detectChartPatterns = createStep({
  id: 'detectChartPatterns',
  description: 'Detect classical chart patterns: H&S, double top/bottom, triangles, flags, wedges.',
  inputSchema: step3OutputSchema,
  outputSchema: step4OutputSchema,
  execute: async ({ inputData, mastra }) => {
    const work = async () => {
      const tool = mastra?.getTool('patternTool');
      if (!tool) throw new Error('patternTool not found in Mastra instance');

      const result = await tool.execute!({ candles: inputData.candles1h, sensitivity: 0.05 }, {});

      return {
        ...inputData,
        chartPatterns: (result as { patterns: z.infer<typeof patternSchema>[] }).patterns,
      };
    };

    return Promise.race([work(), timeoutAfter(STEP_TIMEOUT_MS, 'detectChartPatterns')]);
  },
});

// ---------------------------------------------------------------------------
// Step 5 — analyzeOrderBook
// ---------------------------------------------------------------------------

const wallSchema = z.object({
  price: z.number(),
  totalSize: z.number(),
  distanceFromCurrentPrice: z.number(),
});

const orderbookResultSchema = z.object({
  bidWalls: z.array(wallSchema),
  askWalls: z.array(wallSchema),
  imbalanceRatio: z.number(),
  dominantSide: z.enum(['BID', 'ASK', 'NEUTRAL']),
  currentSpread: z.number(),
});

const step5OutputSchema = step4OutputSchema.extend({
  orderBook: orderbookResultSchema,
});

const analyzeOrderBook = createStep({
  id: 'analyzeOrderBook',
  description: 'Analyze live L2 order book for liquidity walls and bid/ask imbalance.',
  inputSchema: step4OutputSchema,
  outputSchema: step5OutputSchema,
  execute: async ({ inputData, mastra }) => {
    const work = async () => {
      const tool = mastra?.getTool('orderbookTool');
      if (!tool) throw new Error('orderbookTool not found in Mastra instance');

      const result = await tool.execute!(
        {
          symbol: inputData.symbol,
          exchange: inputData.exchange,
          depth: 50,
        },
        {},
      );

      return {
        ...inputData,
        orderBook: result as z.infer<typeof orderbookResultSchema>,
      };
    };

    return Promise.race([work(), timeoutAfter(STEP_TIMEOUT_MS, 'analyzeOrderBook')]);
  },
});

// ---------------------------------------------------------------------------
// Step 6a — fetchNews (parallel with 6b)
// ---------------------------------------------------------------------------

const newsItemSchema = z.object({
  title: z.string(),
  source: z.string(),
  url: z.string(),
  publishedAt: z.string(),
  sentiment: z.enum(['BULLISH', 'BEARISH', 'NEUTRAL']),
  sentimentScore: z.number(),
});

const newsResultSchema = z.object({
  items: z.array(newsItemSchema),
  overallSentiment: z.enum(['BULLISH', 'BEARISH', 'NEUTRAL']),
});

const step6aOutputSchema = step5OutputSchema.extend({
  news: newsResultSchema,
});

const fetchNews = createStep({
  id: 'fetchNews',
  description: 'Fetch CryptoPanic + CoinGecko news sentiment for the trading symbol.',
  inputSchema: step5OutputSchema,
  outputSchema: step6aOutputSchema,
  execute: async ({ inputData, mastra }) => {
    const work = async () => {
      const tool = mastra?.getTool('newsTool');
      if (!tool) throw new Error('newsTool not found in Mastra instance');

      // Extract base currency from symbol, e.g. "BTC/USDT" → "BTC"
      const baseCurrency = inputData.symbol.split('/')[0] ?? inputData.symbol;
      const result = await tool.execute!({ currencies: [baseCurrency] }, {});

      return {
        ...inputData,
        news: result as z.infer<typeof newsResultSchema>,
      };
    };

    return Promise.race([work(), timeoutAfter(STEP_TIMEOUT_MS, 'fetchNews')]);
  },
});

// ---------------------------------------------------------------------------
// Step 6b — fetchOnchainSignals (parallel with 6a)
// ---------------------------------------------------------------------------

const onchainResultSchema = z.object({
  fundingRate: z.number(),
  fundingBias: z.enum(['BULLISH', 'BEARISH', 'NEUTRAL']),
  openInterest: z.number(),
  oiChange24h: z.number(),
  exchangeNetflow: z.number(),
  liquidationLevels: z.array(
    z.object({
      price: z.number(),
      totalLiquidationUsd: z.number(),
      side: z.enum(['LONG', 'SHORT']),
    }),
  ),
});

const step6bOutputSchema = step5OutputSchema.extend({
  onchain: onchainResultSchema,
});

const fetchOnchainSignals = createStep({
  id: 'fetchOnchainSignals',
  description: 'Fetch on-chain signals: funding rate, open interest, netflow, liquidation levels.',
  inputSchema: step5OutputSchema,
  outputSchema: step6bOutputSchema,
  execute: async ({ inputData, mastra }) => {
    const work = async () => {
      const tool = mastra?.getTool('onchainTool');
      if (!tool) throw new Error('onchainTool not found in Mastra instance');

      const baseCurrency = inputData.symbol.split('/')[0] ?? inputData.symbol;
      const result = await tool.execute!(
        {
          symbol: inputData.symbol,
          baseCurrency,
        },
        {},
      );

      return {
        ...inputData,
        onchain: result as z.infer<typeof onchainResultSchema>,
      };
    };

    return Promise.race([work(), timeoutAfter(STEP_TIMEOUT_MS, 'fetchOnchainSignals')]);
  },
});

// ---------------------------------------------------------------------------
// Step 7 — agentDecision
// Input receives merged parallel output: { fetchNews: {...}, fetchOnchainSignals: {...} }
// ---------------------------------------------------------------------------

const parallelOutputSchema = z.object({
  fetchNews: step6aOutputSchema,
  fetchOnchainSignals: step6bOutputSchema,
});

const agentDecisionOutputSchema = z.object({
  // Carry forward the shared context from step 5 (both parallel branches had it)
  userId: z.string(),
  symbol: z.string(),
  triggeredBy: z.enum(['scheduled', 'manual', 'tradingview']),
  accountBalance: z.number(),
  exchange: z.enum(['binance', 'bybit', 'bingx']),
  candles1h: z.array(candleSchema),
  candles4h: z.array(candleSchema),
  candles1d: z.array(candleSchema),
  indicators1h: indicatorsResultSchema,
  indicators4h: indicatorsResultSchema,
  indicators1d: indicatorsResultSchema,
  smcStructures: smcResultSchema,
  chartPatterns: z.array(patternSchema),
  orderBook: orderbookResultSchema,
  news: newsResultSchema,
  onchain: onchainResultSchema,
  // Agent decision fields
  bias: z.enum(['BULLISH', 'BEARISH', 'NEUTRAL']),
  action: z.enum(['ENTER_LONG', 'ENTER_SHORT', 'HOLD']),
  entryZone: z.object({ low: z.number().nullable(), high: z.number().nullable() }),
  sl: z.number().nullable(),
  tp: z.number().nullable(),
  confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  primarySignalSource: z.string(),
  strategiesTriggered: z.array(z.string()),
  reasoning: z.string(),
});

const agentDecision = createStep({
  id: 'agentDecision',
  description: 'Trading agent synthesizes all tool outputs into a structured trade decision.',
  inputSchema: parallelOutputSchema,
  outputSchema: agentDecisionOutputSchema,
  execute: async ({ inputData, mastra }) => {
    const work = async () => {
      const agent = mastra?.getAgent('tradingAgent');
      if (!agent) throw new Error('tradingAgent not found in Mastra instance');

      // Both parallel branches contain the same upstream context (steps 1–5).
      // fetchNews branch is used as the primary carrier for that context.
      const ctx = inputData.fetchNews;
      const news = inputData.fetchNews.news;
      const onchain = inputData.fetchOnchainSignals.onchain;

      const prompt = `You are the trading decision engine. Analyze the following data and return ONLY a valid JSON object with no prose.

## Symbol
${ctx.symbol}

## Market Data (candle counts)
- 1h candles: ${ctx.candles1h.length}
- 4h candles: ${ctx.candles4h.length}
- 1d candles: ${ctx.candles1d.length}

## Technical Indicators
### 1h
${JSON.stringify(ctx.indicators1h, null, 2)}

### 4h
${JSON.stringify(ctx.indicators4h, null, 2)}

### 1d
${JSON.stringify(ctx.indicators1d, null, 2)}

## SMC Structures
${JSON.stringify(ctx.smcStructures, null, 2)}

## Chart Patterns
${JSON.stringify(ctx.chartPatterns, null, 2)}

## Order Book
${JSON.stringify(ctx.orderBook, null, 2)}

## News Sentiment
Overall: ${news.overallSentiment}
${news.items.slice(0, 5).map((n) => `- [${n.sentiment}] ${n.title}`).join('\n')}

## On-Chain / Derivatives
${JSON.stringify(onchain, null, 2)}

## Required Output (JSON only — no markdown, no prose)
{
  "bias": "BULLISH|BEARISH|NEUTRAL",
  "action": "ENTER_LONG|ENTER_SHORT|HOLD",
  "entryZone": { "low": <number|null>, "high": <number|null> },
  "sl": <number|null>,
  "tp": <number|null>,
  "confidence": "LOW|MEDIUM|HIGH",
  "primarySignalSource": "<string>",
  "strategiesTriggered": ["<string>"],
  "reasoning": "<string>"
}`;

      const response = await agent.generate([{ role: 'user', content: prompt }]);

      // Extract JSON from the agent text response
      const rawText: string =
        typeof response.text === 'string'
          ? response.text
          : JSON.stringify(response.text ?? '');

      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error(`agentDecision: could not extract JSON from agent response: ${rawText}`);
      }

      const parsed = JSON.parse(jsonMatch[0]) as {
        bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
        action: 'ENTER_LONG' | 'ENTER_SHORT' | 'HOLD';
        entryZone: { low: number | null; high: number | null };
        sl: number | null;
        tp: number | null;
        confidence: 'LOW' | 'MEDIUM' | 'HIGH';
        primarySignalSource: string;
        strategiesTriggered: string[];
        reasoning: string;
      };

      return {
        userId: ctx.userId,
        symbol: ctx.symbol,
        triggeredBy: ctx.triggeredBy,
        accountBalance: ctx.accountBalance,
        exchange: ctx.exchange,
        candles1h: ctx.candles1h,
        candles4h: ctx.candles4h,
        candles1d: ctx.candles1d,
        indicators1h: ctx.indicators1h,
        indicators4h: ctx.indicators4h,
        indicators1d: ctx.indicators1d,
        smcStructures: ctx.smcStructures,
        chartPatterns: ctx.chartPatterns,
        orderBook: ctx.orderBook,
        news,
        onchain,
        ...parsed,
      };
    };

    return Promise.race([work(), timeoutAfter(STEP_TIMEOUT_MS, 'agentDecision')]);
  },
});

// ---------------------------------------------------------------------------
// Step 8 — calculateRisk
// ---------------------------------------------------------------------------

const riskResultSchema = z.object({
  exchange: z.string(),
  direction: z.string(),
  entryPrice: z.number(),
  stopLossPrice: z.number(),
  takeProfitPrice: z.number(),
  positionSizeUsdt: z.number(),
  positionSizeUnits: z.number(),
  takerFeePct: z.number(),
  slippagePct: z.number(),
  roundTripFeePct: z.number(),
  grossExpectedLoss: z.number(),
  grossExpectedProfit: z.number(),
  netExpectedLoss: z.number(),
  netExpectedProfit: z.number(),
  totalFeeCost: z.number(),
  breakEvenDistance: z.number(),
  riskPerTradePct: z.number(),
  netRiskPct: z.number(),
});

const step8OutputSchema = agentDecisionOutputSchema.extend({
  riskCalculation: riskResultSchema.nullable(),
});

const calculateRisk = createStep({
  id: 'calculateRisk',
  description: 'Calculate position size and net P&L after fees and slippage.',
  inputSchema: agentDecisionOutputSchema,
  outputSchema: step8OutputSchema,
  execute: async ({ inputData, mastra }) => {
    const work = async () => {
      // Skip risk calculation when the agent decided to hold
      if (inputData.action === 'HOLD') {
        return { ...inputData, riskCalculation: null };
      }

      const entryPrice = inputData.entryZone.low ?? inputData.entryZone.high;
      const sl = inputData.sl;
      const tp = inputData.tp;

      if (!entryPrice || !sl || !tp) {
        console.warn('calculateRisk: missing entry/sl/tp — skipping risk sizing');
        return { ...inputData, riskCalculation: null };
      }

      const tool = mastra?.getTool('riskTool');
      if (!tool) throw new Error('riskTool not found in Mastra instance');

      // Look up the user's risk profile to get riskPerTradePct and slippagePct
      let riskPerTradePct = 1.0;
      let slippagePct = 0.05;
      try {
        const [profile] = await db
          .select()
          .from(userRiskProfiles)
          .where(eq(userRiskProfiles.userId, inputData.userId))
          .limit(1);
        if (profile) {
          riskPerTradePct = parseFloat(profile.riskPerTradePct ?? '1.0');
          slippagePct = parseFloat(profile.slippagePct ?? '0.05');
        }
      } catch (err) {
        console.warn('calculateRisk: could not load risk profile, using defaults', err);
      }

      const direction = inputData.action === 'ENTER_LONG' ? 'LONG' : 'SHORT';

      const result = await tool.execute!(
        {
          exchange: inputData.exchange,
          accountBalance: inputData.accountBalance,
          riskPerTradePct,
          entryPrice,
          stopLossPrice: sl,
          takeProfitPrice: tp,
          direction,
          slippagePct,
        },
        {},
      );

      return {
        ...inputData,
        riskCalculation: result as z.infer<typeof riskResultSchema>,
      };
    };

    return Promise.race([work(), timeoutAfter(STEP_TIMEOUT_MS, 'calculateRisk')]);
  },
});

// ---------------------------------------------------------------------------
// Step 9 — routeSignal
// ---------------------------------------------------------------------------

const step9OutputSchema = z.object({
  signalId: z.string().nullable(),
  action: z.enum(['ENTER_LONG', 'ENTER_SHORT', 'HOLD']),
  symbol: z.string(),
  userId: z.string(),
  executionMode: z.string(),
  autoExecuteDeferred: z.boolean(),
});

const routeSignal = createStep({
  id: 'routeSignal',
  description:
    'Persist the trade signal to the database. Auto-execute branch is deferred pending TLP-16.',
  inputSchema: step8OutputSchema,
  outputSchema: step9OutputSchema,
  execute: async ({ inputData }) => {
    const work = async () => {
      const { userId, symbol, action, confidence, reasoning, exchange, strategiesTriggered } =
        inputData;

      if (action === 'HOLD') {
        return {
          signalId: null,
          action,
          symbol,
          userId,
          executionMode: 'n/a',
          autoExecuteDeferred: false,
        };
      }

      const entryPrice = inputData.entryZone.low ?? inputData.entryZone.high;
      const direction = action === 'ENTER_LONG' ? 'LONG' : 'SHORT';

      // Derive news sentiment score from items average (overallSentimentScore not in schema)
      const newsItems = inputData.news?.items ?? [];
      const avgSentimentScore =
        newsItems.length > 0
          ? newsItems.reduce((sum: number, item: { sentimentScore: number }) => sum + item.sentimentScore, 0) / newsItems.length
          : null;
      const newsSentiment = inputData.news?.overallSentiment ?? null;
      const newsSentimentScore = avgSentimentScore !== null ? String(avgSentimentScore) : null;

      const onchain = inputData.onchain;
      const onChainFundingRate = onchain?.fundingRate != null ? String(onchain.fundingRate) : null;
      const onChainFundingBias = onchain?.fundingBias ?? null;
      const onChainNetflow = onchain?.exchangeNetflow != null ? String(onchain.exchangeNetflow) : null;

      // Look up the user's execution mode
      let executionMode = 'paper';
      try {
        const [profile] = await db
          .select()
          .from(userRiskProfiles)
          .where(eq(userRiskProfiles.userId, userId))
          .limit(1);
        if (profile) {
          executionMode = profile.executionMode ?? 'paper';
        }
      } catch (err) {
        console.warn('routeSignal: could not load risk profile, defaulting to paper', err);
      }

      // Persist signal to trade_signals
      const [inserted] = await db
        .insert(tradeSignals)
        .values({
          userId,
          symbol,
          timeframe: '1h',
          direction,
          entryPrice: entryPrice ? String(entryPrice) : null,
          stopLoss: inputData.sl ? String(inputData.sl) : null,
          takeProfit: inputData.tp ? String(inputData.tp) : null,
          confidence,
          reasoning,
          strategySource: strategiesTriggered.join(', '),
          source: 'ai',
          status: 'pending',
          newsSentiment,
          newsSentimentScore,
          onChainFundingRate,
          onChainFundingBias,
          onChainNetflow,
          rawPayload: {
            triggeredBy: inputData.triggeredBy,
            exchange,
            riskCalculation: inputData.riskCalculation,
            smcStructures: inputData.smcStructures,
            chartPatterns: inputData.chartPatterns,
            indicators1h: inputData.indicators1h,
          },
        })
        .returning({ id: tradeSignals.id });

      const signalId = inserted?.id ?? null;

      // Fire-and-forget: propagate to copy-trading subscribers asynchronously
      if (signalId) {
        void propagatePublisherSignal(signalId, userId);
      }

      // Auto-execute branch: deferred until TLP-16 (execute-trade-tool) is implemented
      let autoExecuteDeferred = false;
      if (executionMode === 'auto') {
        console.warn(
          `routeSignal: executionMode=auto detected for signal ${signalId} but execute-trade-tool ` +
            `is not yet implemented (TLP-16). Signal saved as pending — manual approval required.`,
        );
        autoExecuteDeferred = true;
      }

      return {
        signalId,
        action,
        symbol,
        userId,
        executionMode,
        autoExecuteDeferred,
      };
    };

    return Promise.race([work(), timeoutAfter(STEP_TIMEOUT_MS, 'routeSignal')]);
  },
});

// ---------------------------------------------------------------------------
// Workflow assembly
// ---------------------------------------------------------------------------

export const tradeAnalysisWorkflow = createWorkflow({
  id: 'tradeAnalysisWorkflow',
  description:
    'End-to-end 9-step trade analysis pipeline: market data → indicators → SMC → patterns → order book → news + on-chain (parallel) → agent decision → risk sizing → signal routing.',
  inputSchema: z.object({
    userId: z.string().describe('Clerk user ID of the trader'),
    symbol: z.string().describe('Trading pair symbol, e.g. BTC/USDT'),
    triggeredBy: z
      .enum(['scheduled', 'manual', 'tradingview'])
      .describe('What triggered this workflow run'),
    accountBalance: z
      .number()
      .positive()
      .default(10_000)
      .describe('Available account balance in USDT for risk sizing'),
    exchange: z
      .enum(['binance', 'bybit', 'bingx'])
      .default('binance')
      .describe('Exchange to use for market data and execution'),
  }),
  outputSchema: step9OutputSchema,
})
  .then(fetchMarketData)
  .then(computeIndicators)
  .then(detectSMCStructures)
  .then(detectChartPatterns)
  .then(analyzeOrderBook)
  .parallel([fetchNews, fetchOnchainSignals])
  .then(agentDecision)
  .then(calculateRisk)
  .then(routeSignal);

tradeAnalysisWorkflow.commit();
