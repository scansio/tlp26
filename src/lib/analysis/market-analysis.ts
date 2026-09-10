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
import { db } from '@/db';
import { ohlcvCache } from '@/db/schema';
import {
  buildAnalysisCacheKey,
  readThroughDeterministicCache,
  CACHE_TTL_LTF_MS,
  CACHE_TTL_FUNDING_MS,
} from './analysis-cache';

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry attempts for the agentDecision LLM call (transient API failures). */
const AGENT_RETRY_ATTEMPTS = Number(process.env.WORKER_AGENT_RETRY_ATTEMPTS ?? 3);
/** Delay between agentDecision retry attempts, in ms. Defaults to 1 minute. */
const AGENT_RETRY_DELAY_MS = Number(process.env.WORKER_AGENT_RETRY_DELAY_MS ?? 60_000);

/** Retry `work` up to `attempts` times, waiting `delayMs` between failures. */
async function withRetry<T>(
  label: string,
  attempts: number,
  delayMs: number,
  work: () => Promise<T>,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await work();
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) {
        console.warn(
          `[market-analysis] ${label} attempt ${attempt}/${attempts} failed, retrying in ${delayMs}ms`,
          err,
        );
        await sleep(delayMs);
      }
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Input / output shapes
// ---------------------------------------------------------------------------

export interface MarketAnalysisInput {
  symbol: string;
  exchange: 'binance' | 'bybit' | 'bingx';
  marketType: 'spot' | 'swap';
  triggeredBy: 'scheduled' | 'manual' | 'tradingview';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mastra: any;
}

export interface MarketAnalysisResult {
  symbol: string;
  exchange: 'binance' | 'bybit' | 'bingx';
  marketType: 'spot' | 'swap';
  triggeredBy: 'scheduled' | 'manual' | 'tradingview';
  candles15m: z.infer<typeof candleSchema>[];
  candles1h: z.infer<typeof candleSchema>[];
  candles4h: z.infer<typeof candleSchema>[];
  candles1d: z.infer<typeof candleSchema>[];
  indicators15m: z.infer<typeof indicatorsResultSchema>;
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

type CandleSet = {
  candles15m: z.infer<typeof candleSchema>[];
  candles1h: z.infer<typeof candleSchema>[];
  candles4h: z.infer<typeof candleSchema>[];
  candles1d: z.infer<typeof candleSchema>[];
};

/**
 * Best-effort backfill of ohlcv_cache with every *closed* candle (i.e. every
 * candle except the last, currently-forming one per timeframe) from a fresh
 * fetch, so the backtester (src/lib/historical-data.ts) benefits from the
 * same CCXT calls the worker is already making. Closed candles are
 * immutable, so onConflictDoNothing is correct here — this is a write-only
 * side channel, never read back by fetchMarketDataPhase itself (see the
 * read-through cache below for why: ohlcv_cache has no per-row "last written
 * at" column, so a freshness check keyed off the forming candle's own
 * timestamp would serve an HTF candle frozen at its opening values for the
 * rest of its period). Never allowed to fail the analysis phase.
 *
 * Gated to marketType='spot' on the 'binance' exchange (historical-data.ts's
 * own default exchange) only: ohlcv_cache has no exchange/marketType column,
 * so it's keyed by (symbol, timeframe, timestamp) alone across every
 * exchange and market. Writing swap/perpetual candles (different basis,
 * volume profile) or non-Binance spot candles into the same rows under
 * onConflictDoNothing would let whichever confluence group happens to fetch
 * a timestamp first silently win, corrupting the backtester's spot data with
 * no way to tell which source a given row came from.
 */
async function backfillClosedCandles(
  symbol: string,
  exchange: string,
  marketType: string,
  candles: CandleSet,
): Promise<void> {
  if (marketType !== 'spot' || exchange !== 'binance') return;

  try {
    const perTimeframe: { timeframe: string; candles: z.infer<typeof candleSchema>[] }[] = [
      { timeframe: '15m', candles: candles.candles15m },
      { timeframe: '1h', candles: candles.candles1h },
      { timeframe: '4h', candles: candles.candles4h },
      { timeframe: '1d', candles: candles.candles1d },
    ];

    for (const { timeframe, candles: series } of perTimeframe) {
      const closed = series.slice(0, -1); // drop the last (currently-forming) candle
      if (closed.length === 0) continue;

      await db
        .insert(ohlcvCache)
        .values(
          closed.map((c) => ({
            symbol,
            timeframe,
            timestamp: c.timestamp,
            open: String(c.open),
            high: String(c.high),
            low: String(c.low),
            close: String(c.close),
            volume: String(c.volume),
          })),
        )
        .onConflictDoNothing();
    }
  } catch (err) {
    console.warn('[market-analysis] backfillClosedCandles failed (non-fatal)', err);
  }
}

export async function fetchMarketDataPhase<
  T extends { symbol: string; exchange: string; marketType: string },
>(
  input: T,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mastra: any,
): Promise<T & CandleSet> {
  return withTimeout('fetchMarketData', async () => {
    const { symbol, exchange, marketType } = input;
    const cacheKey = buildAnalysisCacheKey(symbol, exchange, marketType, 'market-data');

    const candles = await readThroughDeterministicCache<CandleSet>(
      cacheKey,
      'market-data',
      CACHE_TTL_LTF_MS,
      async () => {
        const tool = mastra?.getTool('marketDataTool');
        if (!tool) throw new Error('marketDataTool not found in Mastra instance');

        const [r15m, r1h, r4h, r1d] = await Promise.all([
          tool.execute!({ symbol, timeframe: '15m', limit: 200, exchange, marketType }, {}),
          tool.execute!({ symbol, timeframe: '1h', limit: 200, exchange, marketType }, {}),
          tool.execute!({ symbol, timeframe: '4h', limit: 200, exchange, marketType }, {}),
          tool.execute!({ symbol, timeframe: '1d', limit: 200, exchange, marketType }, {}),
        ]);

        const result: CandleSet = {
          candles15m: (r15m as { candles: z.infer<typeof candleSchema>[] }).candles,
          candles1h: (r1h as { candles: z.infer<typeof candleSchema>[] }).candles,
          candles4h: (r4h as { candles: z.infer<typeof candleSchema>[] }).candles,
          candles1d: (r1d as { candles: z.infer<typeof candleSchema>[] }).candles,
        };

        void backfillClosedCandles(symbol, exchange, marketType, result);

        return result;
      },
    );

    return { ...input, ...candles };
  });
}

// ---------------------------------------------------------------------------
// Phase 2 — computeIndicators
// ---------------------------------------------------------------------------

type IndicatorSet = {
  indicators15m?: z.infer<typeof indicatorsResultSchema>;
  indicators1h: z.infer<typeof indicatorsResultSchema>;
  indicators4h: z.infer<typeof indicatorsResultSchema>;
  indicators1d: z.infer<typeof indicatorsResultSchema>;
};

export async function computeIndicatorsPhase<
  T extends {
    // Optional: the eval harness replays frozen fixtures recorded before the
    // 15m LTF was added and doesn't carry this field. Production (worker +
    // trade-analysis-workflow) always fetches it via fetchMarketDataPhase.
    candles15m?: z.infer<typeof candleSchema>[];
    candles1h: z.infer<typeof candleSchema>[];
    candles4h: z.infer<typeof candleSchema>[];
    candles1d: z.infer<typeof candleSchema>[];
    // Optional: eval/derive-challenge.ts calls this phase directly with just
    // candles, no symbol/exchange context. Production always has both (via
    // fetchMarketDataPhase's output) — caching is simply skipped without them,
    // since there'd be no meaningful cache key to build.
    symbol?: string;
    exchange?: string;
    marketType?: string;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
>(input: T, mastra: any): Promise<T & IndicatorSet> {
  return withTimeout('computeIndicators', async () => {
    const compute = async (): Promise<IndicatorSet> => {
      const tool = mastra?.getTool('indicatorsTool');
      if (!tool) throw new Error('indicatorsTool not found in Mastra instance');

      const has15m = Array.isArray(input.candles15m) && input.candles15m.length > 0;

      const [ind15m, ind1h, ind4h, ind1d] = await Promise.all([
        has15m ? tool.execute!({ candles: input.candles15m }, {}) : Promise.resolve(undefined),
        tool.execute!({ candles: input.candles1h }, {}),
        tool.execute!({ candles: input.candles4h }, {}),
        tool.execute!({ candles: input.candles1d }, {}),
      ]);

      return {
        ...(ind15m !== undefined ? { indicators15m: ind15m as z.infer<typeof indicatorsResultSchema> } : {}),
        indicators1h: ind1h as z.infer<typeof indicatorsResultSchema>,
        indicators4h: ind4h as z.infer<typeof indicatorsResultSchema>,
        indicators1d: ind1d as z.infer<typeof indicatorsResultSchema>,
      };
    };

    const indicators =
      input.symbol && input.exchange
        ? await readThroughDeterministicCache<IndicatorSet>(
            buildAnalysisCacheKey(input.symbol, input.exchange, input.marketType ?? 'spot', 'indicators'),
            'indicators',
            CACHE_TTL_LTF_MS,
            compute,
          )
        : await compute();

    return { ...input, ...indicators };
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

export async function detectSMCStructuresPhase<
  T extends { candles1h: z.infer<typeof candleSchema>[]; symbol: string; exchange: string; marketType?: string },
>(
  input: T,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mastra: any,
): Promise<T & { smcStructures: z.infer<typeof smcResultSchema> }> {
  return withTimeout('detectSMCStructures', async () => {
    const cacheKey = buildAnalysisCacheKey(input.symbol, input.exchange, input.marketType ?? 'spot', 'smc');

    const smcStructures = await readThroughDeterministicCache<z.infer<typeof smcResultSchema>>(
      cacheKey,
      'smc',
      CACHE_TTL_LTF_MS,
      async () => {
        const tool = mastra?.getTool('smcTool');
        if (!tool) throw new Error('smcTool not found in Mastra instance');

        // Use 1h candles as the primary timeframe for SMC structures
        const result = await tool.execute!({ candles: input.candles1h }, {});
        return result as z.infer<typeof smcResultSchema>;
      },
    );

    return { ...input, smcStructures };
  });
}

// ---------------------------------------------------------------------------
// Phase 4 — detectChartPatterns
// ---------------------------------------------------------------------------

export async function detectChartPatternsPhase<
  T extends { candles1h: z.infer<typeof candleSchema>[]; symbol: string; exchange: string; marketType?: string },
>(
  input: T,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mastra: any,
): Promise<T & { chartPatterns: z.infer<typeof patternSchema>[] }> {
  return withTimeout('detectChartPatterns', async () => {
    const cacheKey = buildAnalysisCacheKey(input.symbol, input.exchange, input.marketType ?? 'spot', 'patterns');

    const chartPatterns = await readThroughDeterministicCache<z.infer<typeof patternSchema>[]>(
      cacheKey,
      'patterns',
      CACHE_TTL_LTF_MS,
      async () => {
        const tool = mastra?.getTool('patternTool');
        if (!tool) throw new Error('patternTool not found in Mastra instance');

        const result = await tool.execute!({ candles: input.candles1h, sensitivity: 0.05 }, {});
        return (result as { patterns: z.infer<typeof patternSchema>[] }).patterns;
      },
    );

    return { ...input, chartPatterns };
  });
}

// ---------------------------------------------------------------------------
// Phase 5 — analyzeOrderBook
// ---------------------------------------------------------------------------

export async function analyzeOrderBookPhase<
  T extends { symbol: string; exchange: string; marketType: string },
>(
  input: T,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mastra: any,
): Promise<T & { orderBook: z.infer<typeof orderbookResultSchema> }> {
  return withTimeout('analyzeOrderBook', async () => {
    const cacheKey = buildAnalysisCacheKey(input.symbol, input.exchange, input.marketType, 'orderbook');

    const orderBook = await readThroughDeterministicCache<z.infer<typeof orderbookResultSchema>>(
      cacheKey,
      'orderbook',
      CACHE_TTL_LTF_MS,
      async () => {
        const tool = mastra?.getTool('orderbookTool');
        if (!tool) throw new Error('orderbookTool not found in Mastra instance');

        const result = await tool.execute!(
          {
            symbol: input.symbol,
            exchange: input.exchange,
            marketType: input.marketType,
            depth: 50,
          },
          {},
        );
        return result as z.infer<typeof orderbookResultSchema>;
      },
    );

    return { ...input, orderBook };
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
    // newsTool (src/mastra/tools/news-tool.ts) already reads/writes the
    // news_cache table itself (1-day TTL, keyed by the same sorted/uppercased
    // currency list this phase passes in) — no extra caching needed here.
    // An earlier version of this phase wrapped the call in its own 5-minute
    // cache using the exact same cache key, which just clobbered the tool's
    // 1-day expiresAt down to 5 minutes on every round trip and forced a real
    // external fetch far more often than intended. Do not re-add a wrapper
    // here without changing the key so the two layers don't collide.
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

export async function fetchOnchainSignalsPhase<T extends { symbol: string; exchange: string; marketType: string }>(
  input: T,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mastra: any,
): Promise<T & { onchain: z.infer<typeof onchainResultSchema> }> {
  return withTimeout('fetchOnchainSignals', async () => {
    // onchain-tool returns funding rate + netflow + open interest + liquidation
    // levels from a single Coinglass/Santiment call — it isn't split by field,
    // so there's no way to give netflow its own (longer, daily) TTL without
    // either a second live call or caching a stale netflow value alongside a
    // fresh funding rate. We cache the whole result under one key at the
    // funding-rate (hourly) TTL — stricter than the requested daily TTL for
    // netflow specifically, but never staler than what was asked for.
    const cacheKey = buildAnalysisCacheKey(input.symbol, input.exchange, input.marketType, 'onchain');

    const onchain = await readThroughDeterministicCache<z.infer<typeof onchainResultSchema>>(
      cacheKey,
      'onchain',
      CACHE_TTL_FUNDING_MS,
      async () => {
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
        return result as z.infer<typeof onchainResultSchema>;
      },
    );

    return { ...input, onchain };
  });
}

// ---------------------------------------------------------------------------
// Phase 7 — agentDecision
// ---------------------------------------------------------------------------

export interface AgentDecisionInput {
  symbol: string;
  // Optional: see computeIndicatorsPhase — absent when replaying eval fixtures
  // recorded before the 15m LTF was added.
  candles15m?: z.infer<typeof candleSchema>[];
  candles1h: z.infer<typeof candleSchema>[];
  candles4h: z.infer<typeof candleSchema>[];
  candles1d: z.infer<typeof candleSchema>[];
  indicators15m?: z.infer<typeof indicatorsResultSchema>;
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
  const agent = mastra?.getAgent('tradingAgent');
  if (!agent) throw new Error('tradingAgent not found in Mastra instance');

  const parsed = await withRetry('agentDecision', AGENT_RETRY_ATTEMPTS, AGENT_RETRY_DELAY_MS, () =>
    withTimeout('agentDecision', async () => {
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
- Include "top-down-alignment" in strategiesTriggered when the LTF signal agrees with tradeBias.` +
        (input.indicators15m
          ? `

## LTF ENTRY TIMING (15m)
The 15m timeframe is for entry timing and trigger precision only — it never overrides tradeBias.
Use it to judge whether price is at a favorable entry right now (momentum exhaustion, pullback into
the zone, fresh crossover) versus chasing an extended move. Include "ltf-entry-timing" in
strategiesTriggered when the 15m indicators support entering at the current price.`
          : '');

      const prompt = `You are the trading decision engine. Analyze the following data and return ONLY a valid JSON object with no prose.

${topDownSection}

## Symbol
${input.symbol}

## Market Data (candle counts)
${input.candles15m ? `- 15m candles: ${input.candles15m.length}\n` : ''}- 1h candles: ${input.candles1h.length}
- 4h candles: ${input.candles4h.length}
- 1d candles: ${input.candles1d.length}

## Technical Indicators${input.indicators15m ? `
### 15m (entry timing only)
${JSON.stringify(input.indicators15m, null, 2)}
` : ''}
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

      return JSON.parse(jsonMatch[0]) as {
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
    }),
  );

  return {
    ...input,
    ...parsed,
  };
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
