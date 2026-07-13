/**
 * Strategy Backtester
 *
 * Simulates trading strategies on historical OHLCV data by iterating through
 * candles chronologically and applying the same indicator, SMC, and pattern
 * tools used in the live trading pipeline. No LLM is used — entry signals are
 * generated via deterministic rules mirroring the tool output heuristics the
 * trading-agent follows.
 *
 * Strategies supported (from user_risk_profiles.strategies):
 *   "SMC"                  — FVG + BOS confluence entry
 *   "Technical Indicators" — RSI oversold/overbought + EMA/MACD confluence
 *   "Chart Patterns"       — Detected pattern breakout (confidence ≥ 0.7)
 *   "Trend Following"      — EMA cross trend-following (price > EMA20 > EMA50)
 */

import { eq } from 'drizzle-orm';
import { rsi, ema, macd } from 'technicalindicators';
import { db } from '@/db';
import { userRiskProfiles, backtestRuns } from '@/db/schema';
import { fetchHistoricalOHLCV, type OHLCVCandle } from '@/lib/historical-data';
import { smcTool } from '@/mastra/tools/smc-tool';
import { patternTool } from '@/mastra/tools/pattern-tool';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

// ---------------------------------------------------------------------------
// Per-exchange taker fee rates (same constants as risk-tool)
// ---------------------------------------------------------------------------
const TAKER_FEES: Record<string, number> = {
  binance: 0.0004,
  bybit: 0.00055,
  bingx: 0.0005,
};
const DEFAULT_TAKER_FEE = TAKER_FEES['binance'];

// Minimum candles needed before the first bar we attempt to trade
// (EMA-200 requires 200 data points; we add a small buffer)
const WARMUP_CANDLES = 210;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StrategyName =
  | 'SMC'
  | 'Chart Patterns'
  | 'Technical Indicators'
  | 'Trend Following';

export interface BacktestInput {
  /** Clerk userId (loads risk profile) */
  userId: string;
  symbol: string;
  timeframe: string;
  startDate: Date;
  endDate: Date;
  /**
   * Exchange used to determine taker fee rate. Defaults to 'binance'.
   */
  exchange?: string;
  /**
   * Starting account balance in USDT. Defaults to 10 000.
   */
  initialBalance?: number;
  /**
   * Override which strategies to simulate. When omitted the user's risk profile
   * strategies are used.
   */
  strategies?: StrategyName[];
}

export interface EquityPoint {
  date: string; // ISO date string
  portfolioValue: number;
}

export interface StrategyMetrics {
  strategy: StrategyName;
  totalTrades: number;
  winRate: number; // 0–100 %
  avgWin: number; // $ per winning trade
  avgLoss: number; // $ per losing trade (positive = loss amount)
  profitFactor: number; // gross profit / gross loss; Infinity when no losses
  maxDrawdownPct: number; // peak-to-trough as % of peak equity
  maxDrawdownUsdt: number; // peak-to-trough in $
  sharpeRatio: number; // annualised
  totalReturnPct: number; // %
  equityCurve: EquityPoint[];
}

export interface TradeRecord {
  date: string; // ISO timestamp of trade exit
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entry: number;
  exit: number;
  pnl: number;
  strategy: StrategyName;
}

export interface BacktestResult {
  id: string;
  userId: string;
  config: BacktestInput & { exchange: string; initialBalance: number };
  metrics: {
    totalTrades: number;
    winRate: number;
    avgWin: number;
    avgLoss: number;
    profitFactor: number;
    maxDrawdownPct: number;
    maxDrawdownUsdt: number;
    sharpeRatio: number;
    totalReturnPct: number;
    equityCurve: EquityPoint[];
    perStrategy: StrategyMetrics[];
    trades: TradeRecord[];
  };
  equityCurve: EquityPoint[];
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Internal trade record
// ---------------------------------------------------------------------------

interface SimTrade {
  strategy: StrategyName;
  direction: 'LONG' | 'SHORT';
  entryTimestamp: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  positionSizeUsdt: number;
  exitTimestamp?: number;
  exitPrice?: number;
  pnl?: number; // net after fees + slippage
  outcome?: 'WIN' | 'LOSS';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map timeframe string → milliseconds */
const TIMEFRAME_MS: Record<string, number> = {
  '1m': 60_000,
  '3m': 3 * 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '2h': 2 * 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '8h': 8 * 60 * 60_000,
  '12h': 12 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '3d': 3 * 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
};

/** Candles per trading day for Sharpe annualisation */
function candlesPerYear(timeframe: string): number {
  const ms = TIMEFRAME_MS[timeframe] ?? 60 * 60_000; // fallback 1h
  return (365 * 24 * 60 * 60_000) / ms;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Net P&L for a closed trade after round-trip fees and slippage */
function netPnl(
  direction: 'LONG' | 'SHORT',
  entryPrice: number,
  exitPrice: number,
  positionSizeUsdt: number,
  takerFeeRate: number,
  slippageRate: number,
): number {
  const units = positionSizeUsdt / entryPrice;
  const grossPnl =
    direction === 'LONG'
      ? (exitPrice - entryPrice) * units
      : (entryPrice - exitPrice) * units;

  // Round-trip fees on notional (entry + exit) + one-way slippage on entry
  const roundTripFee = positionSizeUsdt * 2 * takerFeeRate;
  const slippageCost = positionSizeUsdt * slippageRate;

  return grossPnl - roundTripFee - slippageCost;
}

/** Compute annualised Sharpe ratio from per-trade returns (as fractions of account). */
function computeSharpe(
  tradeReturns: number[],
  timeframe: string,
  tradesPerYear: number,
): number {
  if (tradeReturns.length < 2) return 0;

  const n = tradeReturns.length;
  const mean = tradeReturns.reduce((s, r) => s + r, 0) / n;

  const variance =
    tradeReturns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / (n - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return mean > 0 ? Infinity : 0;

  // Annualise: assume trades are spread evenly over the backtest period
  const annualisationFactor = Math.sqrt(tradesPerYear);
  return round2((mean / stdDev) * annualisationFactor);
}

/** Compute max drawdown (% and $) from an equity curve. */
function computeMaxDrawdown(equityCurve: number[]): {
  pct: number;
  usdt: number;
} {
  let peak = equityCurve[0] ?? 0;
  let maxDdUsdt = 0;
  let maxDdPct = 0;

  for (const val of equityCurve) {
    if (val > peak) peak = val;
    const dd = peak - val;
    const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
    if (dd > maxDdUsdt) maxDdUsdt = dd;
    if (ddPct > maxDdPct) maxDdPct = ddPct;
  }

  return { pct: round2(maxDdPct), usdt: round2(maxDdUsdt) };
}

/** Compute aggregate metrics from a set of trades and an equity curve. */
function computeMetrics(
  trades: SimTrade[],
  equityHistory: number[], // portfolio value at each trade close
  initialBalance: number,
  timeframe: string,
): Omit<StrategyMetrics, 'strategy' | 'equityCurve'> & {
  equityCurve: number[];
} {
  const closed = trades.filter((t) => t.pnl !== undefined);
  const wins = closed.filter((t) => t.outcome === 'WIN');
  const losses = closed.filter((t) => t.outcome === 'LOSS');

  const totalTrades = closed.length;
  const winRate =
    totalTrades > 0 ? round2((wins.length / totalTrades) * 100) : 0;
  const avgWin =
    wins.length > 0
      ? round2(wins.reduce((s, t) => s + (t.pnl ?? 0), 0) / wins.length)
      : 0;
  const avgLoss =
    losses.length > 0
      ? round2(
          Math.abs(
            losses.reduce((s, t) => s + (t.pnl ?? 0), 0) / losses.length,
          ),
        )
      : 0;

  const grossProfit = wins.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0));
  const profitFactor =
    grossLoss === 0
      ? grossProfit > 0
        ? Infinity
        : 1
      : round2(grossProfit / grossLoss);

  const { pct: maxDrawdownPct, usdt: maxDrawdownUsdt } =
    computeMaxDrawdown(equityHistory.length > 0 ? equityHistory : [initialBalance]);

  // Returns as fractions of account (using initial balance denominator)
  const tradeReturns = closed.map((t) => (t.pnl ?? 0) / initialBalance);
  // Approximate trades per year
  const approxTradesPerYear = candlesPerYear(timeframe) / Math.max(totalTrades, 1);
  const sharpeRatio = computeSharpe(tradeReturns, timeframe, approxTradesPerYear);

  const finalBalance =
    equityHistory.length > 0
      ? equityHistory[equityHistory.length - 1]
      : initialBalance;
  const totalReturnPct = round2(
    ((finalBalance - initialBalance) / initialBalance) * 100,
  );

  return {
    totalTrades,
    winRate,
    avgWin,
    avgLoss,
    profitFactor,
    maxDrawdownPct,
    maxDrawdownUsdt,
    sharpeRatio,
    totalReturnPct,
    equityCurve: equityHistory,
  };
}

// ---------------------------------------------------------------------------
// Signal generators (deterministic rules per strategy)
// ---------------------------------------------------------------------------

interface Signal {
  direction: 'LONG' | 'SHORT';
  stopLoss: number;
  takeProfit: number;
  strategy: StrategyName;
}

/**
 * "Technical Indicators" strategy:
 * LONG  when RSI < 35 (oversold) AND price > EMA20 AND MACD histogram > 0
 * SHORT when RSI > 65 (overbought) AND price < EMA20 AND MACD histogram < 0
 *
 * Uses the same technicalindicators library and parameters as indicators-tool.ts.
 */
function signalTechnicalIndicators(
  candles: OHLCVCandle[],
): Signal | null {
  if (candles.length < WARMUP_CANDLES) return null;

  const closes = candles.map((c) => c.close);
  const close = closes[closes.length - 1];
  const atr = computeATR(candles, 14);
  if (atr === 0) return null;

  // RSI(14)
  const rsiValues = rsi({ period: 14, values: closes });
  const rsiValue = rsiValues[rsiValues.length - 1];
  if (rsiValue === undefined) return null;

  // EMA(20)
  const ema20Values = ema({ period: 20, values: closes });
  const ema20 = ema20Values[ema20Values.length - 1];
  if (ema20 === undefined) return null;

  // MACD(12, 26, 9)
  const macdResults = macd({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const latestMacd = macdResults[macdResults.length - 1];
  if (!latestMacd || latestMacd.histogram === undefined) return null;

  const priceAboveEma20 = close > ema20;
  const slMultiple = 1.5;
  const tpMultiple = 3.0;

  if (rsiValue < 35 && priceAboveEma20 && latestMacd.histogram > 0) {
    return {
      direction: 'LONG',
      stopLoss: close - slMultiple * atr,
      takeProfit: close + tpMultiple * atr,
      strategy: 'Technical Indicators',
    };
  }

  if (rsiValue > 65 && !priceAboveEma20 && latestMacd.histogram < 0) {
    return {
      direction: 'SHORT',
      stopLoss: close + slMultiple * atr,
      takeProfit: close - tpMultiple * atr,
      strategy: 'Technical Indicators',
    };
  }

  return null;
}

/**
 * "Trend Following" strategy:
 * LONG  when price > EMA20 > EMA50 (bullish stack)
 * SHORT when price < EMA20 < EMA50 (bearish stack)
 * Only enters when EMA20 crosses EMA50 on the current candle.
 *
 * Uses the same ema() from technicalindicators as indicators-tool.ts.
 */
function signalTrendFollowing(
  candles: OHLCVCandle[],
): Signal | null {
  if (candles.length < WARMUP_CANDLES) return null;

  const closes = candles.map((c) => c.close);
  const close = closes[closes.length - 1];
  const atr = computeATR(candles, 14);
  if (atr === 0) return null;

  // Current bar
  const ema20Values = ema({ period: 20, values: closes });
  const ema50Values = ema({ period: 50, values: closes });
  const currEma20 = ema20Values[ema20Values.length - 1];
  const currEma50 = ema50Values[ema50Values.length - 1];
  if (currEma20 === undefined || currEma50 === undefined) return null;

  // Previous bar
  const prevCloses = closes.slice(0, -1);
  const prevEma20Values = ema({ period: 20, values: prevCloses });
  const prevEma50Values = ema({ period: 50, values: prevCloses });
  const prevEma20 = prevEma20Values[prevEma20Values.length - 1];
  const prevEma50 = prevEma50Values[prevEma50Values.length - 1];
  if (prevEma20 === undefined || prevEma50 === undefined) return null;

  // Bullish cross: ema20 crossed above ema50
  if (prevEma20 <= prevEma50 && currEma20 > currEma50) {
    return {
      direction: 'LONG',
      stopLoss: close - 1.5 * atr,
      takeProfit: close + 3.0 * atr,
      strategy: 'Trend Following',
    };
  }

  // Bearish cross: ema20 crossed below ema50
  if (prevEma20 >= prevEma50 && currEma20 < currEma50) {
    return {
      direction: 'SHORT',
      stopLoss: close + 1.5 * atr,
      takeProfit: close - 3.0 * atr,
      strategy: 'Trend Following',
    };
  }

  return null;
}

/**
 * "SMC" strategy:
 * LONG  when there is a bullish BOS + an unmitigated bullish FVG below current price
 * SHORT when there is a bearish BOS + an unmitigated bearish FVG above current price
 */
async function signalSMC(candles: OHLCVCandle[]): Promise<Signal | null> {
  if (candles.length < 20) return null;

  let smcResult: Awaited<ReturnType<AnyFn>>;
  try {
    smcResult = await (smcTool.execute as AnyFn)({ candles }, {});
  } catch {
    return null;
  }

  const { fvgs, bos } = smcResult as {
    fvgs: Array<{ type: string; low?: number; high?: number }>;
    bos: Array<{ type: string }>;
  };

  const close = candles[candles.length - 1].close;
  const atr = computeATR(candles, 14);
  if (atr === 0) return null;

  const hasBullishBos = bos.some((b) => b.type === 'BULLISH');
  const hasBearishBos = bos.some((b) => b.type === 'BEARISH');

  // Bullish FVG: gap below current price (price trades up into it)
  const bullishFvg = fvgs.find(
    (f) => f.type === 'BULLISH' && f.high !== undefined && f.high < close,
  );
  // Bearish FVG: gap above current price (price trades down into it)
  const bearishFvg = fvgs.find(
    (f) => f.type === 'BEARISH' && f.low !== undefined && f.low > close,
  );

  if (hasBullishBos && bullishFvg) {
    return {
      direction: 'LONG',
      stopLoss: close - 1.5 * atr,
      takeProfit: close + 3.0 * atr,
      strategy: 'SMC',
    };
  }

  if (hasBearishBos && bearishFvg) {
    return {
      direction: 'SHORT',
      stopLoss: close + 1.5 * atr,
      takeProfit: close - 3.0 * atr,
      strategy: 'SMC',
    };
  }

  return null;
}

/**
 * "Chart Patterns" strategy:
 * LONG  when a bullish pattern with confidence >= 0.7 is detected
 * SHORT when a bearish pattern with confidence >= 0.7 is detected
 */
async function signalChartPatterns(
  candles: OHLCVCandle[],
): Promise<Signal | null> {
  if (candles.length < 30) return null;

  let patResult: Awaited<ReturnType<AnyFn>>;
  try {
    patResult = await (patternTool.execute as AnyFn)({ candles }, {});
  } catch {
    return null;
  }

  const { patterns } = patResult as {
    patterns: Array<{
      direction: string;
      confidenceScore: number;
      breakoutTarget?: number;
    }>;
  };

  if (!patterns || patterns.length === 0) return null;

  const close = candles[candles.length - 1].close;
  const atr = computeATR(candles, 14);
  if (atr === 0) return null;

  // Best confidence pattern first (already sorted by pattern-tool)
  const topPattern = patterns[0];

  if (topPattern.confidenceScore < 0.7) return null;

  if (topPattern.direction === 'BULLISH') {
    return {
      direction: 'LONG',
      stopLoss: close - 1.5 * atr,
      takeProfit:
        topPattern.breakoutTarget && topPattern.breakoutTarget > close
          ? topPattern.breakoutTarget
          : close + 3.0 * atr,
      strategy: 'Chart Patterns',
    };
  }

  if (topPattern.direction === 'BEARISH') {
    return {
      direction: 'SHORT',
      stopLoss: close + 1.5 * atr,
      takeProfit:
        topPattern.breakoutTarget && topPattern.breakoutTarget < close
          ? topPattern.breakoutTarget
          : close - 3.0 * atr,
      strategy: 'Chart Patterns',
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// ATR helper (used for SL/TP placement)
// ---------------------------------------------------------------------------

function computeATR(candles: OHLCVCandle[], period: number): number {
  if (candles.length < period + 1) return 0;

  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close),
    );
    trs.push(tr);
  }

  // Simple moving average of the last `period` TRs
  const slice = trs.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}

// ---------------------------------------------------------------------------
// Main backtest runner
// ---------------------------------------------------------------------------

export async function runBacktest(
  input: BacktestInput,
  onProgress?: (percentComplete: number) => void,
): Promise<BacktestResult> {
  const {
    userId,
    symbol,
    timeframe,
    startDate,
    endDate,
    exchange: exchangeId = 'binance',
    initialBalance = 10_000,
    strategies: strategiesOverride,
  } = input;

  // -------------------------------------------------------------------------
  // 1. Load risk profile
  // -------------------------------------------------------------------------
  const [profile] = await db
    .select()
    .from(userRiskProfiles)
    .where(eq(userRiskProfiles.userId, userId))
    .limit(1);

  if (!profile) {
    throw new Error(`Risk profile not found for userId: ${userId}`);
  }

  // Use caller-provided strategies if given; fall back to the risk profile
  const strategies: StrategyName[] =
    strategiesOverride && strategiesOverride.length > 0
      ? strategiesOverride
      : ((profile.strategies ?? []) as StrategyName[]);

  if (strategies.length === 0) {
    throw new Error('No strategies configured in risk profile.');
  }

  const riskPerTradePct = Number(profile.riskPerTradePct ?? 1);
  const maxTradesPerDay = profile.maxTradesPerDay ?? 5;
  const maxDailyLossPct = Number(profile.maxDailyLossPct ?? 3);
  const slippageRate = Number(profile.slippagePct ?? 0.05) / 100;
  const takerFeeRate = TAKER_FEES[exchangeId] ?? DEFAULT_TAKER_FEE;

  // -------------------------------------------------------------------------
  // 2. Fetch historical candles (with enough warmup before startDate)
  // -------------------------------------------------------------------------
  const tfMs = TIMEFRAME_MS[timeframe];
  if (!tfMs) throw new Error(`Unsupported timeframe: ${timeframe}`);

  // Fetch WARMUP_CANDLES worth of extra data before startDate
  const warmupMs = WARMUP_CANDLES * tfMs;
  const fetchStart = new Date(startDate.getTime() - warmupMs);

  const allCandles = await fetchHistoricalOHLCV({
    symbol,
    timeframe,
    startDate: fetchStart,
    endDate,
    exchange: exchangeId,
  });

  if (allCandles.length === 0) {
    throw new Error('No historical data returned for the given range.');
  }

  // Index of the first candle at or after startDate
  const startMs = startDate.getTime();
  const firstLiveIdx = allCandles.findIndex((c) => c.timestamp >= startMs);
  if (firstLiveIdx < WARMUP_CANDLES) {
    throw new Error(
      `Insufficient warmup data: need at least ${WARMUP_CANDLES} candles before startDate.`,
    );
  }

  // -------------------------------------------------------------------------
  // 3. Candle-by-candle simulation
  // -------------------------------------------------------------------------
  let balance = initialBalance;
  const allTrades: SimTrade[] = [];
  // Per-strategy open positions (one position per strategy at a time)
  const openPositions = new Map<StrategyName, SimTrade>();
  // Per-strategy closed trades (for per-strategy metrics)
  const tradesByStrategy = new Map<StrategyName, SimTrade[]>();
  // Per-strategy equity histories
  const equityByStrategy = new Map<StrategyName, number[]>();

  for (const strategy of strategies) {
    tradesByStrategy.set(strategy, []);
    equityByStrategy.set(strategy, [initialBalance]);
  }

  // Global equity curve (portfolio value at each candle close in live range)
  const globalEquityHistory: number[] = [];
  const globalEquityCurve: EquityPoint[] = [];

  // Daily tracking
  let currentDayKey = '';
  let dailyTrades = 0;
  let dailyLoss = 0;

  const totalLiveCandles = allCandles.length - firstLiveIdx;
  let lastReportedPct = 0;

  for (let i = firstLiveIdx; i < allCandles.length; i++) {
    // Report progress every ~2% to avoid flooding the callback
    if (onProgress && totalLiveCandles > 0) {
      const pct = Math.round(((i - firstLiveIdx) / totalLiveCandles) * 100);
      if (pct > lastReportedPct) {
        lastReportedPct = pct;
        onProgress(pct);
      }
    }

    const candle = allCandles[i];
    const candleSlice = allCandles.slice(0, i + 1); // history up to and including this candle

    // Reset daily counters when day changes
    const dayKey = new Date(candle.timestamp).toISOString().slice(0, 10);
    if (dayKey !== currentDayKey) {
      currentDayKey = dayKey;
      dailyTrades = 0;
      dailyLoss = 0;
    }

    // -----------------------------------------------------------------------
    // 3a. Check exits for all open positions against this candle's high/low
    //     Pessimistic: if both SL and TP are within the candle range, SL hits first.
    // -----------------------------------------------------------------------
    for (const [strategy, position] of openPositions) {
      let exitPrice: number | null = null;
      let outcome: 'WIN' | 'LOSS' | null = null;

      if (position.direction === 'LONG') {
        // SL hit first (pessimistic)
        if (candle.low <= position.stopLoss) {
          exitPrice = position.stopLoss;
          outcome = 'LOSS';
        } else if (candle.high >= position.takeProfit) {
          exitPrice = position.takeProfit;
          outcome = 'WIN';
        }
      } else {
        // SHORT — SL is above, TP below
        if (candle.high >= position.stopLoss) {
          exitPrice = position.stopLoss;
          outcome = 'LOSS';
        } else if (candle.low <= position.takeProfit) {
          exitPrice = position.takeProfit;
          outcome = 'WIN';
        }
      }

      if (exitPrice !== null && outcome !== null) {
        const pnl = netPnl(
          position.direction,
          position.entryPrice,
          exitPrice,
          position.positionSizeUsdt,
          takerFeeRate,
          slippageRate,
        );

        position.exitTimestamp = candle.timestamp;
        position.exitPrice = exitPrice;
        position.pnl = pnl;
        position.outcome = outcome;

        balance += pnl;
        if (pnl < 0) dailyLoss += Math.abs(pnl);

        allTrades.push(position);
        tradesByStrategy.get(strategy)!.push(position);
        equityByStrategy.get(strategy)!.push(balance);

        openPositions.delete(strategy);
      }
    }

    // -----------------------------------------------------------------------
    // 3b. Emit global equity curve point
    // -----------------------------------------------------------------------
    globalEquityHistory.push(balance);
    globalEquityCurve.push({
      date: new Date(candle.timestamp).toISOString(),
      portfolioValue: round2(balance),
    });

    // -----------------------------------------------------------------------
    // 3c. Check daily limits before generating new signals
    // -----------------------------------------------------------------------
    const dailyLossLimitReached =
      maxDailyLossPct > 0 &&
      (dailyLoss / initialBalance) * 100 >= maxDailyLossPct;
    const dailyTradesLimitReached = dailyTrades >= maxTradesPerDay;

    if (dailyLossLimitReached || dailyTradesLimitReached) {
      continue; // skip signal generation for the rest of this day
    }

    // -----------------------------------------------------------------------
    // 3d. Generate signals for each active strategy (skip if already in position)
    // -----------------------------------------------------------------------
    for (const strategy of strategies) {
      if (openPositions.has(strategy)) continue; // one position per strategy at a time

      let signal: Signal | null = null;

      try {
        switch (strategy) {
          case 'Technical Indicators':
            signal = signalTechnicalIndicators(candleSlice);
            break;
          case 'Trend Following':
            signal = signalTrendFollowing(candleSlice);
            break;
          case 'SMC':
            signal = await signalSMC(candleSlice);
            break;
          case 'Chart Patterns':
            signal = await signalChartPatterns(candleSlice);
            break;
        }
      } catch {
        // Tool errors are non-fatal — skip signal for this candle
        continue;
      }

      if (!signal) continue;

      // Validate SL/TP direction (entry is candle.close)
      if (signal.direction === 'LONG' && signal.stopLoss >= candle.close) continue;
      if (signal.direction === 'SHORT' && signal.stopLoss <= candle.close) continue;

      // Position sizing: risk riskPerTradePct% of current balance
      const slDistance =
        signal.direction === 'LONG'
          ? (candle.close - signal.stopLoss) / candle.close
          : (signal.stopLoss - candle.close) / candle.close;

      if (slDistance <= 0) continue;

      const roundTripFeeRate = 2 * takerFeeRate;
      const totalDragRate = roundTripFeeRate + slippageRate;
      const maxRiskUsdt = balance * (riskPerTradePct / 100);
      const positionSizeUsdt = maxRiskUsdt / (slDistance + totalDragRate);

      // Don't open a position larger than the balance
      if (positionSizeUsdt <= 0 || positionSizeUsdt > balance) continue;

      const trade: SimTrade = {
        strategy,
        direction: signal.direction,
        entryTimestamp: candle.timestamp,
        entryPrice: candle.close, // entry at signal candle close
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        positionSizeUsdt,
      };

      openPositions.set(strategy, trade);
      dailyTrades++;
    }
  }

  // -------------------------------------------------------------------------
  // 4. Force-close any remaining open positions at last candle close
  // -------------------------------------------------------------------------
  const lastCandle = allCandles[allCandles.length - 1];
  for (const [strategy, position] of openPositions) {
    const pnl = netPnl(
      position.direction,
      position.entryPrice,
      lastCandle.close,
      position.positionSizeUsdt,
      takerFeeRate,
      slippageRate,
    );

    position.exitTimestamp = lastCandle.timestamp;
    position.exitPrice = lastCandle.close;
    position.pnl = pnl;
    position.outcome = pnl >= 0 ? 'WIN' : 'LOSS';

    balance += pnl;
    allTrades.push(position);
    tradesByStrategy.get(strategy)!.push(position);
    equityByStrategy.get(strategy)!.push(balance);
  }
  openPositions.clear();

  // -------------------------------------------------------------------------
  // 5. Compute aggregate metrics
  // -------------------------------------------------------------------------
  const globalMetrics = computeMetrics(
    allTrades,
    globalEquityHistory,
    initialBalance,
    timeframe,
  );

  const globalEquityCurveOutput: EquityPoint[] = globalEquityCurve;

  // Per-strategy metrics
  const perStrategy: StrategyMetrics[] = strategies.map((strategy) => {
    const stratTrades = tradesByStrategy.get(strategy) ?? [];
    const stratEquity = equityByStrategy.get(strategy) ?? [initialBalance];
    const stratMetrics = computeMetrics(
      stratTrades,
      stratEquity,
      initialBalance,
      timeframe,
    );

    const stratEquityCurve: EquityPoint[] = stratEquity.map((val, idx) => ({
      date:
        idx < stratTrades.length
          ? new Date(stratTrades[idx].exitTimestamp ?? lastCandle.timestamp).toISOString()
          : new Date(lastCandle.timestamp).toISOString(),
      portfolioValue: round2(val),
    }));

    return {
      strategy,
      totalTrades: stratMetrics.totalTrades,
      winRate: stratMetrics.winRate,
      avgWin: stratMetrics.avgWin,
      avgLoss: stratMetrics.avgLoss,
      profitFactor: stratMetrics.profitFactor,
      maxDrawdownPct: stratMetrics.maxDrawdownPct,
      maxDrawdownUsdt: stratMetrics.maxDrawdownUsdt,
      sharpeRatio: stratMetrics.sharpeRatio,
      totalReturnPct: stratMetrics.totalReturnPct,
      equityCurve: stratEquityCurve,
    };
  });

  // Build the individual trade list for the UI trade-by-trade breakdown
  const tradeRecords: TradeRecord[] = allTrades
    .filter((t) => t.exitTimestamp !== undefined && t.exitPrice !== undefined && t.pnl !== undefined)
    .map((t) => ({
      date: new Date(t.exitTimestamp!).toISOString(),
      symbol,
      direction: t.direction,
      entry: round2(t.entryPrice),
      exit: round2(t.exitPrice!),
      pnl: round2(t.pnl!),
      strategy: t.strategy,
    }));

  if (onProgress) onProgress(100);

  const metrics = {
    totalTrades: globalMetrics.totalTrades,
    winRate: globalMetrics.winRate,
    avgWin: globalMetrics.avgWin,
    avgLoss: globalMetrics.avgLoss,
    profitFactor: globalMetrics.profitFactor,
    maxDrawdownPct: globalMetrics.maxDrawdownPct,
    maxDrawdownUsdt: globalMetrics.maxDrawdownUsdt,
    sharpeRatio: globalMetrics.sharpeRatio,
    totalReturnPct: globalMetrics.totalReturnPct,
    equityCurve: globalEquityCurveOutput,
    perStrategy,
    trades: tradeRecords,
  };

  // -------------------------------------------------------------------------
  // 6. Persist to backtest_runs
  // -------------------------------------------------------------------------
  const config = {
    ...input,
    exchange: exchangeId,
    initialBalance,
    startDate: input.startDate.toISOString(),
    endDate: input.endDate.toISOString(),
  };

  const [inserted] = await db
    .insert(backtestRuns)
    .values({
      userId,
      config,
      metrics,
      equityCurve: globalEquityCurveOutput,
    })
    .returning();

  return {
    id: inserted.id,
    userId,
    config: {
      ...input,
      exchange: exchangeId,
      initialBalance,
    },
    metrics,
    equityCurve: globalEquityCurveOutput,
    createdAt: inserted.createdAt ?? new Date(),
  };
}
