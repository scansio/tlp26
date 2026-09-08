/**
 * Trade Analysis Workflow — 9-Step Decision Pipeline
 *
 * Steps:
 *  1. fetchMarketData       — OHLCV for 15m, 1h, 4h, 1d
 *  2. computeIndicators     — RSI, EMA, MACD, BB, ADX (per timeframe; 15m is LTF entry timing only)
 *  2b. deriveTopDownBias    — HTF (1d) + intermediate (4h) trend filter; blocks counter-trend entries
 *  3. detectSMCStructures   — FVG, OB, BOS/ChoCH, liquidity sweeps
 *  4. detectChartPatterns   — classical pattern detection
 *  5. analyzeOrderBook      — L2 liquidity walls + imbalance
 *  6a/6b (parallel):
 *     fetchNews             — CryptoPanic + CoinGecko sentiment
 *     fetchOnchainSignals   — funding rate + netflow + liquidation levels
 *  7. agentDecision         — trading-agent synthesizes everything (constrained by topDownBias)
 *  8. finalizeSignal        — risk-sizes, persists to trade_signals, and auto-executes
 *                             per the user's tradingMode (auto/manual) and executionMode (paper/live)
 *
 * Steps 1–7 are thin wrappers around the user-agnostic phase functions in
 * src/lib/analysis/market-analysis.ts (each phase applies its own 30s
 * timeout). Step 8 wraps finalizeForUser in src/lib/analysis/finalize-for-user.ts.
 * Both modules are called directly (without workflow.createRun()) by the
 * background worker (src/worker/) to reuse one market analysis across every
 * user sharing a confluence group, then fan out per-user finalization.
 */

import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import {
  candleSchema,
  indicatorsResultSchema,
  topDownBiasSchema,
  smcResultSchema,
  patternSchema,
  orderbookResultSchema,
  newsResultSchema,
  onchainResultSchema,
  fetchMarketDataPhase,
  computeIndicatorsPhase,
  deriveTopDownBiasPhase,
  detectSMCStructuresPhase,
  detectChartPatternsPhase,
  analyzeOrderBookPhase,
  fetchNewsPhase,
  fetchOnchainSignalsPhase,
  agentDecisionPhase,
  type MarketAnalysisResult,
} from '@/lib/analysis/market-analysis';
import { finalizeForUser } from '@/lib/analysis/finalize-for-user';

// ---------------------------------------------------------------------------
// Step 1 — fetchMarketData
// Input:  { userId, symbol, triggeredBy, exchange }
// Output: adds { candles1h, candles4h, candles1d }
// ---------------------------------------------------------------------------

const step1InputSchema = z.object({
  userId: z.string(),
  symbol: z.string(),
  triggeredBy: z.enum(['scheduled', 'manual', 'tradingview']),
  /** Exchange to use for all data + execution (default: binance). */
  exchange: z.enum(['binance', 'bybit', 'bingx']).default('binance'),
});

const step1OutputSchema = step1InputSchema.extend({
  candles15m: z.array(candleSchema),
  candles1h: z.array(candleSchema),
  candles4h: z.array(candleSchema),
  candles1d: z.array(candleSchema),
});

const fetchMarketData = createStep({
  id: 'fetchMarketData',
  description: 'Fetch OHLCV candles for 15m, 1h, 4h, and 1d timeframes via CCXT.',
  inputSchema: step1InputSchema,
  outputSchema: step1OutputSchema,
  execute: async ({ inputData, mastra }) => fetchMarketDataPhase(inputData, mastra),
});

// ---------------------------------------------------------------------------
// Step 2 — computeIndicators
// ---------------------------------------------------------------------------

const step2OutputSchema = step1OutputSchema.extend({
  indicators15m: indicatorsResultSchema,
  indicators1h: indicatorsResultSchema,
  indicators4h: indicatorsResultSchema,
  indicators1d: indicatorsResultSchema,
});

const step2bOutputSchema = step2OutputSchema.extend({
  topDownBias: topDownBiasSchema,
});

const computeIndicators = createStep({
  id: 'computeIndicators',
  description: 'Compute RSI, EMA, MACD, Bollinger Bands, ADX for each timeframe.',
  inputSchema: step1OutputSchema,
  outputSchema: step2OutputSchema,
  execute: async ({ inputData, mastra }) => {
    // fetchMarketData always populates candles15m in this pipeline, so
    // indicators15m is always computed too — computeIndicatorsPhase's return
    // type only marks it optional to accommodate the eval harness's older
    // fixtures, which don't go through this workflow.
    const result = await computeIndicatorsPhase(inputData, mastra);
    return result as z.infer<typeof step2OutputSchema>;
  },
});

// ---------------------------------------------------------------------------
// Step 2b — deriveTopDownBias
// Deterministic (no LLM): reads 1d + 4h indicators, applies EMA-stack + MACD
// scoring, gates with ADX, then combines into a single tradeBias directive.
// ---------------------------------------------------------------------------

const deriveTopDownBias = createStep({
  id: 'deriveTopDownBias',
  description: 'Derive HTF (1d) and intermediate (4h) trend bias; combine into a tradeBias directive.',
  inputSchema: step2OutputSchema,
  outputSchema: step2bOutputSchema,
  execute: async ({ inputData }) => deriveTopDownBiasPhase(inputData),
});

// ---------------------------------------------------------------------------
// Step 3 — detectSMCStructures
// ---------------------------------------------------------------------------

const step3OutputSchema = step2bOutputSchema.extend({
  smcStructures: smcResultSchema,
});

const detectSMCStructures = createStep({
  id: 'detectSMCStructures',
  description: 'Detect FVG, Order Blocks, BOS/ChoCH, and liquidity sweeps using SMC tool.',
  inputSchema: step2bOutputSchema,
  outputSchema: step3OutputSchema,
  execute: async ({ inputData, mastra }) => detectSMCStructuresPhase(inputData, mastra),
});

// ---------------------------------------------------------------------------
// Step 4 — detectChartPatterns
// ---------------------------------------------------------------------------

const step4OutputSchema = step3OutputSchema.extend({
  chartPatterns: z.array(patternSchema),
});

const detectChartPatterns = createStep({
  id: 'detectChartPatterns',
  description: 'Detect classical chart patterns: H&S, double top/bottom, triangles, flags, wedges.',
  inputSchema: step3OutputSchema,
  outputSchema: step4OutputSchema,
  execute: async ({ inputData, mastra }) => detectChartPatternsPhase(inputData, mastra),
});

// ---------------------------------------------------------------------------
// Step 5 — analyzeOrderBook
// ---------------------------------------------------------------------------

const step5OutputSchema = step4OutputSchema.extend({
  orderBook: orderbookResultSchema,
});

const analyzeOrderBook = createStep({
  id: 'analyzeOrderBook',
  description: 'Analyze live L2 order book for liquidity walls and bid/ask imbalance.',
  inputSchema: step4OutputSchema,
  outputSchema: step5OutputSchema,
  execute: async ({ inputData, mastra }) => analyzeOrderBookPhase(inputData, mastra),
});

// ---------------------------------------------------------------------------
// Step 6a — fetchNews (parallel with 6b)
// ---------------------------------------------------------------------------

const step6aOutputSchema = step5OutputSchema.extend({
  news: newsResultSchema,
});

const fetchNews = createStep({
  id: 'fetchNews',
  description: 'Fetch CryptoPanic + CoinGecko news sentiment for the trading symbol.',
  inputSchema: step5OutputSchema,
  outputSchema: step6aOutputSchema,
  execute: async ({ inputData, mastra }) => fetchNewsPhase(inputData, mastra),
});

// ---------------------------------------------------------------------------
// Step 6b — fetchOnchainSignals (parallel with 6a)
// ---------------------------------------------------------------------------

const step6bOutputSchema = step5OutputSchema.extend({
  onchain: onchainResultSchema,
});

const fetchOnchainSignals = createStep({
  id: 'fetchOnchainSignals',
  description: 'Fetch on-chain signals: funding rate, open interest, netflow, liquidation levels.',
  inputSchema: step5OutputSchema,
  outputSchema: step6bOutputSchema,
  execute: async ({ inputData, mastra }) => fetchOnchainSignalsPhase(inputData, mastra),
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
  exchange: z.enum(['binance', 'bybit', 'bingx']),
  candles15m: z.array(candleSchema),
  candles1h: z.array(candleSchema),
  candles4h: z.array(candleSchema),
  candles1d: z.array(candleSchema),
  indicators15m: indicatorsResultSchema,
  indicators1h: indicatorsResultSchema,
  indicators4h: indicatorsResultSchema,
  indicators1d: indicatorsResultSchema,
  topDownBias: topDownBiasSchema,
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
    // Both parallel branches contain the same upstream context (steps 1–5).
    // fetchNews branch is used as the primary carrier for that context.
    const merged = { ...inputData.fetchNews, onchain: inputData.fetchOnchainSignals.onchain };
    return agentDecisionPhase(merged, mastra);
  },
});

// ---------------------------------------------------------------------------
// Step 8 — finalizeSignal
// Consolidates the former calculateRisk + routeSignal steps into a single
// call to finalizeForUser: loads the risk profile once, resolves the real
// per-user account balance, sizes the position, persists the signal via
// create-signal-tool, and auto-executes according to the user's tradingMode.
// ---------------------------------------------------------------------------

const finalizeSignalOutputSchema = z.object({
  signalId: z.string().nullable(),
  action: z.enum(['ENTER_LONG', 'ENTER_SHORT', 'HOLD']),
  symbol: z.string(),
  userId: z.string(),
  executionMode: z.string(),
  executionResult: z
    .object({
      success: z.boolean(),
      executionId: z.string().nullable(),
      exchangeOrderId: z.string().nullable(),
      fillPrice: z.number().nullable(),
      mode: z.enum(['paper', 'live']),
      signalStatus: z.string(),
      message: z.string(),
    })
    .nullable(),
});

const finalizeSignal = createStep({
  id: 'finalizeSignal',
  description:
    'Risk-size, persist, and (per the user\'s tradingMode) auto-execute the trade signal for this user.',
  inputSchema: agentDecisionOutputSchema,
  outputSchema: finalizeSignalOutputSchema,
  execute: async ({ inputData, mastra }) => {
    const analysis: MarketAnalysisResult = {
      symbol: inputData.symbol,
      exchange: inputData.exchange,
      triggeredBy: inputData.triggeredBy,
      candles15m: inputData.candles15m,
      candles1h: inputData.candles1h,
      candles4h: inputData.candles4h,
      candles1d: inputData.candles1d,
      indicators15m: inputData.indicators15m,
      indicators1h: inputData.indicators1h,
      indicators4h: inputData.indicators4h,
      indicators1d: inputData.indicators1d,
      topDownBias: inputData.topDownBias,
      smcStructures: inputData.smcStructures,
      chartPatterns: inputData.chartPatterns,
      orderBook: inputData.orderBook,
      news: inputData.news,
      onchain: inputData.onchain,
      bias: inputData.bias,
      action: inputData.action,
      entryZone: inputData.entryZone,
      sl: inputData.sl,
      tp: inputData.tp,
      confidence: inputData.confidence,
      primarySignalSource: inputData.primarySignalSource,
      strategiesTriggered: inputData.strategiesTriggered,
      reasoning: inputData.reasoning,
    };

    return finalizeForUser({
      userId: inputData.userId,
      analysis,
      // Single-user webhook/manual path — not part of a confluence group.
      analysisRunId: null,
      executionExchange: inputData.exchange,
      mastra,
    });
  },
});

// ---------------------------------------------------------------------------
// Workflow assembly
// ---------------------------------------------------------------------------

export const tradeAnalysisWorkflow = createWorkflow({
  id: 'tradeAnalysisWorkflow',
  description:
    'End-to-end 9-step trade analysis pipeline: market data → indicators → top-down HTF bias → SMC → patterns → order book → news + on-chain (parallel) → agent decision → finalize (risk-size, persist, auto-execute).',
  inputSchema: z.object({
    userId: z.string().describe('Clerk user ID of the trader'),
    symbol: z.string().describe('Trading pair symbol, e.g. BTC/USDT'),
    triggeredBy: z
      .enum(['scheduled', 'manual', 'tradingview'])
      .describe('What triggered this workflow run'),
    exchange: z
      .enum(['binance', 'bybit', 'bingx'])
      .default('binance')
      .describe('Exchange to use for market data and execution'),
  }),
  outputSchema: finalizeSignalOutputSchema,
})
  .then(fetchMarketData)
  .then(computeIndicators)
  .then(deriveTopDownBias)
  .then(detectSMCStructures)
  .then(detectChartPatterns)
  .then(analyzeOrderBook)
  .parallel([fetchNews, fetchOnchainSignals])
  .then(agentDecision)
  .then(finalizeSignal);

tradeAnalysisWorkflow.commit();
