/**
 * Shared, user-agnostic market analysis phase.
 *
 * Extracted from the trade-analysis-workflow steps 1–7 (fetchMarketData through
 * agentDecision). None of this reads or needs userId/accountBalance — it only
 * depends on symbol + exchange, so it can be run once and its result reused
 * across every user sharing the same confluence group (see src/worker/tick.ts).
 *
 * trade-analysis-workflow.ts's steps call these same phase functions, so the
 * single-user webhook/manual path stays behaviorally identical while gaining
 * no new Mastra run/trace overhead for the worker's group path.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared schemas (mirrors market-data-tool / indicators-tool / smc-tool / etc.)
// ---------------------------------------------------------------------------

export const candleSchema = z.object({
  timestamp: z.number(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
});

export const indicatorsResultSchema = z.object({
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

export const topDownBiasSchema = z.object({
  htfBias: z.enum(['BULLISH', 'BEARISH', 'NEUTRAL']),
  intermediateBias: z.enum(['BULLISH', 'BEARISH', 'NEUTRAL']),
  tradeBias: z.enum(['BULLISH', 'BEARISH', 'NEUTRAL']),
  biasStrength: z.enum(['STRONG', 'MODERATE', 'WEAK']),
  htfReason: z.string(),
  intermediateReason: z.string(),
});

export const smcDetectionSchema = z.object({
  type: z.string(),
  priceLevel: z.number(),
  direction: z.enum(['BULLISH', 'BEARISH']),
  strengthScore: z.number(),
  distanceFromCurrentPrice: z.number(),
});

export const smcResultSchema = z.object({
  fvgs: z.array(smcDetectionSchema),
  orderBlocks: z.array(smcDetectionSchema),
  bos: z.array(smcDetectionSchema),
  choch: z.array(smcDetectionSchema),
  liquiditySweeps: z.array(smcDetectionSchema),
  currentPrice: z.number(),
  candleCount: z.number(),
});

export const patternSchema = z.object({
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

export const wallSchema = z.object({
  price: z.number(),
  totalSize: z.number(),
  distanceFromCurrentPrice: z.number(),
});

export const orderbookResultSchema = z.object({
  bidWalls: z.array(wallSchema),
  askWalls: z.array(wallSchema),
  imbalanceRatio: z.number(),
  dominantSide: z.enum(['BID', 'ASK', 'NEUTRAL']),
  currentSpread: z.number(),
});

export const newsItemSchema = z.object({
  title: z.string(),
  source: z.string(),
  url: z.string(),
  publishedAt: z.string(),
  sentiment: z.enum(['BULLISH', 'BEARISH', 'NEUTRAL']),
  sentimentScore: z.number(),
});

export const newsResultSchema = z.object({
  items: z.array(newsItemSchema),
  overallSentiment: z.enum(['BULLISH', 'BEARISH', 'NEUTRAL']),
});

export const onchainResultSchema = z.object({
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reject after `ms` milliseconds with a descriptive error. */
function timeoutAfter(ms: number, label: string): Promise<never> {
  return new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Phase "${label}" timed out after ${ms}ms`)), ms),
  );
}

const PHASE_TIMEOUT_MS = 30_000;

function withTimeout<T>(label: string, work: () => Promise<T>): Promise<T> {
  return Promise.race([work(), timeoutAfter(PHASE_TIMEOUT_MS, label)]);
}

// ---------------------------------------------------------------------------
// Input / output shapes
// ---------------------------------------------------------------------------

export interface MarketAnalysisInput {
  symbol: string;
  exchange: 'binance' | 'bybit' | 'bingx';
  triggeredBy: 'scheduled' | 'manual' | 'tradingview';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mastra: any;
}

export interface MarketAnalysisResult {
  symbol: string;
  exchange: 'binance' | 'bybit' | 'bingx';
  triggeredBy: 'scheduled' | 'manual' | 'tradingview';
  candles1h: z.infer<typeof candleSchema>[];
  candles4h: z.infer<typeof candleSchema>[];
  candles1d: z.infer<typeof candleSchema>[];
  indicators1h: z.infer<typeof indicatorsResultSchema>;
  indicators4h: z.infer<typeof indicatorsResultSchema>;
  indicators1d: z.infer<typeof indicatorsResultSchema>;
  topDownBias: z.infer<typeof topDownBiasSchema>;
  smcStructures: z.infer<typeof smcResultSchema>;
  chartPatterns: z.infer<typeof patternSchema>[];
  orderBook: z.infer<typeof orderbookResultSchema>;
  news: z.infer<typeof newsResultSchema>;
  onchain: z.infer<typeof onchainResultSchema>;
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  action: 'ENTER_LONG' | 'ENTER_SHORT' | 'HOLD';
  entryZone: { low: number | null; high: number | null };
  sl: number | null;
  tp: number | null;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  primarySignalSource: string;
  strategiesTriggered: string[];
  reasoning: string;
}

// ---------------------------------------------------------------------------
// Phase 1 — fetchMarketData
// ---------------------------------------------------------------------------

export async function fetchMarketDataPhase<T extends { symbol: string; exchange: string }>(
  input: T,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mastra: any,
): Promise<
  T & {
    candles1h: z.infer<typeof candleSchema>[];
    candles4h: z.infer<typeof candleSchema>[];
    candles1d: z.infer<typeof candleSchema>[];
  }
> {
  return withTimeout('fetchMarketData', async () => {
    const { symbol, exchange } = input;
    const tool = mastra?.getTool('marketDataTool');
    if (!tool) throw new Error('marketDataTool not found in Mastra instance');

    const [r1h, r4h, r1d] = await Promise.all([
      tool.execute!({ symbol, timeframe: '1h', limit: 200, exchange }, {}),
      tool.execute!({ symbol, timeframe: '4h', limit: 200, exchange }, {}),
      tool.execute!({ symbol, timeframe: '1d', limit: 200, exchange }, {}),
    ]);

    return {
      ...input,
      candles1h: (r1h as { candles: z.infer<typeof candleSchema>[] }).candles,
      candles4h: (r4h as { candles: z.infer<typeof candleSchema>[] }).candles,
      candles1d: (r1d as { candles: z.infer<typeof candleSchema>[] }).candles,
    };
  });
}

// ---------------------------------------------------------------------------
// Phase 2 — computeIndicators
// ---------------------------------------------------------------------------

export async function computeIndicatorsPhase<
  T extends {
    candles1h: z.infer<typeof candleSchema>[];
    candles4h: z.infer<typeof candleSchema>[];
    candles1d: z.infer<typeof candleSchema>[];
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
>(input: T, mastra: any): Promise<
  T & {
    indicators1h: z.infer<typeof indicatorsResultSchema>;
    indicators4h: z.infer<typeof indicatorsResultSchema>;
    indicators1d: z.infer<typeof indicatorsResultSchema>;
  }
> {
  return withTimeout('computeIndicators', async () => {
    const tool = mastra?.getTool('indicatorsTool');
    if (!tool) throw new Error('indicatorsTool not found in Mastra instance');

    const [ind1h, ind4h, ind1d] = await Promise.all([
      tool.execute!({ candles: input.candles1h }, {}),
      tool.execute!({ candles: input.candles4h }, {}),
      tool.execute!({ candles: input.candles1d }, {}),
    ]);

    return {
      ...input,
      indicators1h: ind1h as z.infer<typeof indicatorsResultSchema>,
      indicators4h: ind4h as z.infer<typeof indicatorsResultSchema>,
      indicators1d: ind1d as z.infer<typeof indicatorsResultSchema>,
    };
  });
}

// ---------------------------------------------------------------------------
// Phase 2b — deriveTopDownBias
// Deterministic (no LLM): reads 1d + 4h indicators, applies EMA-stack + MACD
// scoring, gates with ADX, then combines into a single tradeBias directive.
// ---------------------------------------------------------------------------

type BiasResult = { bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'; reason: string };

function deriveSingleTimeframeBias(indicators: z.infer<typeof indicatorsResultSchema>): BiasResult {
  // ADX < 20 → market has no trend; treat as NEUTRAL regardless of EMA/MACD
  if (indicators.adx.value < 20) {
    return {
      bias: 'NEUTRAL',
      reason: `ADX=${indicators.adx.value.toFixed(1)} (< 20, range-bound — no trend bias)`,
    };
  }

  // EMA stack: each layer that price is above/below adds ±1
  let score = 0;
  const e = indicators.ema;
  score += e.priceAboveEma20 ? 1 : -1;
  score += e.priceAboveEma50 ? 1 : -1;
  score += e.priceAboveEma200 ? 1 : -1;

  // MACD direction adds ±1 as momentum confirmation
  if (indicators.macd.direction === 'BULLISH') score += 1;
  else if (indicators.macd.direction === 'BEARISH') score -= 1;

  // Score range: −4 to +4; require ≥ 2 for a directional bias
  const bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' =
    score >= 2 ? 'BULLISH' : score <= -2 ? 'BEARISH' : 'NEUTRAL';

  const reason =
    `ADX=${indicators.adx.value.toFixed(1)}, ` +
    `EMA(above20/50/200)=${e.priceAboveEma20}/${e.priceAboveEma50}/${e.priceAboveEma200}, ` +
    `MACD=${indicators.macd.direction}, score=${score}`;

  return { bias, reason };
}

function combineTopDownBias(
  htf: BiasResult,
  intermediate: BiasResult,
): Pick<z.infer<typeof topDownBiasSchema>, 'tradeBias' | 'biasStrength'> {
  const h = htf.bias;
  const i = intermediate.bias;

  if (h === 'BULLISH' && i === 'BULLISH') return { tradeBias: 'BULLISH', biasStrength: 'STRONG' };
  if (h === 'BEARISH' && i === 'BEARISH') return { tradeBias: 'BEARISH', biasStrength: 'STRONG' };
  if (h === 'BULLISH' && i === 'NEUTRAL') return { tradeBias: 'BULLISH', biasStrength: 'MODERATE' };
  if (h === 'BEARISH' && i === 'NEUTRAL') return { tradeBias: 'BEARISH', biasStrength: 'MODERATE' };
  if (h === 'NEUTRAL' && i === 'BULLISH') return { tradeBias: 'BULLISH', biasStrength: 'MODERATE' };
  if (h === 'NEUTRAL' && i === 'BEARISH') return { tradeBias: 'BEARISH', biasStrength: 'MODERATE' };
  if (h === 'NEUTRAL' && i === 'NEUTRAL') return { tradeBias: 'NEUTRAL', biasStrength: 'WEAK' };
  // HTF conflicts with 4h (BULLISH vs BEARISH or vice versa) — stay neutral
  return { tradeBias: 'NEUTRAL', biasStrength: 'WEAK' };
}

export function deriveTopDownBiasPhase<
  T extends {
    indicators1d: z.infer<typeof indicatorsResultSchema>;
    indicators4h: z.infer<typeof indicatorsResultSchema>;
  },
>(input: T): T & { topDownBias: z.infer<typeof topDownBiasSchema> } {
  const htf = deriveSingleTimeframeBias(input.indicators1d);
  const intermediate = deriveSingleTimeframeBias(input.indicators4h);
  const { tradeBias, biasStrength } = combineTopDownBias(htf, intermediate);

  return {
    ...input,
    topDownBias: {
      htfBias: htf.bias,
      intermediateBias: intermediate.bias,
      tradeBias,
      biasStrength,
      htfReason: htf.reason,
      intermediateReason: intermediate.reason,
    },
  };
}

// ---------------------------------------------------------------------------
// Phase 3 — detectSMCStructures
// ---------------------------------------------------------------------------

export async function detectSMCStructuresPhase<T extends { candles1h: z.infer<typeof candleSchema>[] }>(
  input: T,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mastra: any,
): Promise<T & { smcStructures: z.infer<typeof smcResultSchema> }> {
  return withTimeout('detectSMCStructures', async () => {
    const tool = mastra?.getTool('smcTool');
    if (!tool) throw new Error('smcTool not found in Mastra instance');

    // Use 1h candles as the primary timeframe for SMC structures
    const result = await tool.execute!({ candles: input.candles1h }, {});

    return {
      ...input,
      smcStructures: result as z.infer<typeof smcResultSchema>,
    };
  });
}

// ---------------------------------------------------------------------------
// Phase 4 — detectChartPatterns
// ---------------------------------------------------------------------------

export async function detectChartPatternsPhase<T extends { candles1h: z.infer<typeof candleSchema>[] }>(
  input: T,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mastra: any,
): Promise<T & { chartPatterns: z.infer<typeof patternSchema>[] }> {
  return withTimeout('detectChartPatterns', async () => {
    const tool = mastra?.getTool('patternTool');
    if (!tool) throw new Error('patternTool not found in Mastra instance');

    const result = await tool.execute!({ candles: input.candles1h, sensitivity: 0.05 }, {});

    return {
      ...input,
      chartPatterns: (result as { patterns: z.infer<typeof patternSchema>[] }).patterns,
    };
  });
}

// ---------------------------------------------------------------------------
// Phase 5 — analyzeOrderBook
// ---------------------------------------------------------------------------

export async function analyzeOrderBookPhase<T extends { symbol: string; exchange: string }>(
  input: T,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mastra: any,
): Promise<T & { orderBook: z.infer<typeof orderbookResultSchema> }> {
  return withTimeout('analyzeOrderBook', async () => {
    const tool = mastra?.getTool('orderbookTool');
    if (!tool) throw new Error('orderbookTool not found in Mastra instance');

    const result = await tool.execute!(
      {
        symbol: input.symbol,
        exchange: input.exchange,
        depth: 50,
      },
      {},
    );

    return {
      ...input,
      orderBook: result as z.infer<typeof orderbookResultSchema>,
    };
  });
}

// ---------------------------------------------------------------------------
// Phase 6a — fetchNews (run concurrently with 6b)
// ---------------------------------------------------------------------------

export async function fetchNewsPhase<T extends { symbol: string }>(
  input: T,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mastra: any,
): Promise<T & { news: z.infer<typeof newsResultSchema> }> {
  return withTimeout('fetchNews', async () => {
    const tool = mastra?.getTool('newsTool');
    if (!tool) throw new Error('newsTool not found in Mastra instance');

    // Extract base currency from symbol, e.g. "BTC/USDT" → "BTC"
    const baseCurrency = input.symbol.split('/')[0] ?? input.symbol;
    const result = await tool.execute!({ currencies: [baseCurrency] }, {});

    return {
      ...input,
      news: result as z.infer<typeof newsResultSchema>,
    };
  });
}

// ---------------------------------------------------------------------------
// Phase 6b — fetchOnchainSignals (run concurrently with 6a)
// ---------------------------------------------------------------------------

export async function fetchOnchainSignalsPhase<T extends { symbol: string }>(
  input: T,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mastra: any,
): Promise<T & { onchain: z.infer<typeof onchainResultSchema> }> {
  return withTimeout('fetchOnchainSignals', async () => {
    const tool = mastra?.getTool('onchainTool');
    if (!tool) throw new Error('onchainTool not found in Mastra instance');

    const baseCurrency = input.symbol.split('/')[0] ?? input.symbol;
    const result = await tool.execute!(
      {
        symbol: input.symbol,
        baseCurrency,
      },
      {},
    );

    return {
      ...input,
      onchain: result as z.infer<typeof onchainResultSchema>,
    };
  });
}

// ---------------------------------------------------------------------------
// Phase 7 — agentDecision
// ---------------------------------------------------------------------------

export interface AgentDecisionInput {
  symbol: string;
  candles1h: z.infer<typeof candleSchema>[];
  candles4h: z.infer<typeof candleSchema>[];
  candles1d: z.infer<typeof candleSchema>[];
  indicators1h: z.infer<typeof indicatorsResultSchema>;
  indicators4h: z.infer<typeof indicatorsResultSchema>;
  indicators1d: z.infer<typeof indicatorsResultSchema>;
  topDownBias: z.infer<typeof topDownBiasSchema>;
  smcStructures: z.infer<typeof smcResultSchema>;
  chartPatterns: z.infer<typeof patternSchema>[];
  orderBook: z.infer<typeof orderbookResultSchema>;
  news: z.infer<typeof newsResultSchema>;
  onchain: z.infer<typeof onchainResultSchema>;
}

export async function agentDecisionPhase<T extends AgentDecisionInput>(
  input: T,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mastra: any,
): Promise<
  T & {
    bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    action: 'ENTER_LONG' | 'ENTER_SHORT' | 'HOLD';
    entryZone: { low: number | null; high: number | null };
    sl: number | null;
    tp: number | null;
    confidence: 'LOW' | 'MEDIUM' | 'HIGH';
    primarySignalSource: string;
    strategiesTriggered: string[];
    reasoning: string;
  }
> {
  return withTimeout('agentDecision', async () => {
    const agent = mastra?.getAgent('tradingAgent');
    if (!agent) throw new Error('tradingAgent not found in Mastra instance');

    const { news, onchain } = input;
    const topDown = input.topDownBias;
    const topDownSection = `## TOP-DOWN BIAS (HTF FILTER — MANDATORY CONSTRAINT)
HTF (1d): ${topDown.htfBias} — ${topDown.htfReason}
Intermediate (4h): ${topDown.intermediateBias} — ${topDown.intermediateReason}
Combined Trade Bias: ${topDown.tradeBias} (Strength: ${topDown.biasStrength})

RULES YOU MUST FOLLOW:
- If tradeBias is BULLISH → only ENTER_LONG or HOLD are allowed. ENTER_SHORT is FORBIDDEN.
- If tradeBias is BEARISH → only ENTER_SHORT or HOLD are allowed. ENTER_LONG is FORBIDDEN.
- If tradeBias is NEUTRAL → ENTER_LONG or ENTER_SHORT are allowed but confidence must be MEDIUM or lower.
- When a counter-trend trade would otherwise trigger, output HOLD and cite the HTF filter in reasoning.
- Include "top-down-alignment" in strategiesTriggered when the LTF signal agrees with tradeBias.`;

    const prompt = `You are the trading decision engine. Analyze the following data and return ONLY a valid JSON object with no prose.

${topDownSection}

## Symbol
${input.symbol}

## Market Data (candle counts)
- 1h candles: ${input.candles1h.length}
- 4h candles: ${input.candles4h.length}
- 1d candles: ${input.candles1d.length}

## Technical Indicators
### 1h
${JSON.stringify(input.indicators1h, null, 2)}

### 4h
${JSON.stringify(input.indicators4h, null, 2)}

### 1d
${JSON.stringify(input.indicators1d, null, 2)}

## SMC Structures
${JSON.stringify(input.smcStructures, null, 2)}

## Chart Patterns
${JSON.stringify(input.chartPatterns, null, 2)}

## Order Book
${JSON.stringify(input.orderBook, null, 2)}

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
      typeof response.text === 'string' ? response.text : JSON.stringify(response.text ?? '');

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
      ...input,
      ...parsed,
    };
  });
}

// ---------------------------------------------------------------------------
// Composed entrypoint — used directly by the worker (src/worker/tick.ts) to
// run the full analysis once per confluence group, with no Mastra
// workflow.createRun() overhead.
// ---------------------------------------------------------------------------

export async function runMarketAnalysis(input: MarketAnalysisInput): Promise<MarketAnalysisResult> {
  const { mastra } = input;

  const step1 = await fetchMarketDataPhase(input, mastra);
  const step2 = await computeIndicatorsPhase(step1, mastra);
  const step2b = deriveTopDownBiasPhase(step2);
  const step3 = await detectSMCStructuresPhase(step2b, mastra);
  const step4 = await detectChartPatternsPhase(step3, mastra);
  const step5 = await analyzeOrderBookPhase(step4, mastra);

  const [withNews, withOnchain] = await Promise.all([
    fetchNewsPhase(step5, mastra),
    fetchOnchainSignalsPhase(step5, mastra),
  ]);

  const merged = { ...step5, news: withNews.news, onchain: withOnchain.onchain };
  const decision = await agentDecisionPhase(merged, mastra);

  return decision as MarketAnalysisResult;
}
