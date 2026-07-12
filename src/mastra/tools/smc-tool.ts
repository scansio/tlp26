import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

// ─── Shared schemas ───────────────────────────────────────────────────────────

const candleSchema = z.object({
  timestamp: z.number().describe('Unix timestamp in milliseconds'),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
});

const liquidationLevelSchema = z.object({
  price: z.number(),
  totalLiquidationUsd: z.number(),
  side: z.enum(['LONG', 'SHORT']),
});

const detectionSchema = z.object({
  type: z.string(),
  priceLevel: z.number().describe('Key price level for this structure'),
  direction: z.enum(['BULLISH', 'BEARISH']),
  strengthScore: z.number().min(0).max(1).describe('Normalized strength 0–1'),
  distanceFromCurrentPrice: z.number().describe('Distance from current close as a percentage'),
});

// ─── Types ────────────────────────────────────────────────────────────────────

type Candle = z.infer<typeof candleSchema>;
type LiquidationLevel = z.infer<typeof liquidationLevelSchema>;
type Detection = z.infer<typeof detectionSchema>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Absolute body size of a candle */
function bodySize(c: Candle): number {
  return Math.abs(c.close - c.open);
}

/** Average body size over all candles */
function averageBodySize(candles: Candle[]): number {
  if (!candles.length) return 0;
  return candles.reduce((s, c) => s + bodySize(c), 0) / candles.length;
}

/**
 * Find swing highs and lows using a fixed 5-candle lookback on each side.
 * A candle at index i is a swing high if its high is the highest in
 * [i-SWING_LOOKBACK .. i+SWING_LOOKBACK]. Same logic for swing lows.
 */
const SWING_LOOKBACK = 5;

function findSwings(candles: Candle[]): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];

  for (let i = SWING_LOOKBACK; i < candles.length - SWING_LOOKBACK; i++) {
    const windowHighs = candles.slice(i - SWING_LOOKBACK, i + SWING_LOOKBACK + 1).map((c) => c.high);
    const windowLows = candles.slice(i - SWING_LOOKBACK, i + SWING_LOOKBACK + 1).map((c) => c.low);
    if (candles[i].high === Math.max(...windowHighs)) highs.push(i);
    if (candles[i].low === Math.min(...windowLows)) lows.push(i);
  }
  return { highs, lows };
}

/** Percentage distance between two price levels */
function pctDistance(a: number, b: number): number {
  if (b === 0) return 0;
  return ((a - b) / b) * 100;
}

/** Check whether any candle in `candles[fromIdx+1..end]` has entered the FVG zone */
function isFvgMitigated(
  candles: Candle[],
  fromIdx: number,
  gapLow: number,
  gapHigh: number,
): boolean {
  for (let j = fromIdx + 1; j < candles.length; j++) {
    // A candle mitigates the FVG if its high reaches into or above the gap bottom
    // (for bullish FVG) or its low reaches into or below the gap top (for bearish FVG).
    if (candles[j].low <= gapHigh && candles[j].high >= gapLow) return true;
  }
  return false;
}

// ─── Detectors ────────────────────────────────────────────────────────────────

/**
 * Fair Value Gaps (FVG)
 *
 * Bullish FVG:  candle[i-2].high < candle[i].low  (gap between prior-prior high and current low)
 * Bearish FVG:  candle[i-2].low  > candle[i].high (gap between prior-prior low  and current high)
 *
 * Strength score = gap size / ATR-20 (capped at 1).
 * Only unmitigated FVGs are reported.
 */
function detectFVGs(candles: Candle[], currentPrice: number): Detection[] {
  const results: Detection[] = [];
  if (candles.length < 3) return results;

  // ATR-20 for normalization
  const atr20 =
    candles.slice(-20).reduce((s, c, _, arr) => {
      if (arr.indexOf(c) === 0) return s;
      return s + (c.high - c.low);
    }, 0) / Math.max(1, Math.min(20, candles.length) - 1);

  for (let i = 2; i < candles.length; i++) {
    const prev2 = candles[i - 2];
    const curr = candles[i];

    // Bullish FVG
    if (prev2.high < curr.low) {
      const gapLow = prev2.high;
      const gapHigh = curr.low;
      if (!isFvgMitigated(candles, i, gapLow, gapHigh)) {
        const gapSize = gapHigh - gapLow;
        const midpoint = (gapLow + gapHigh) / 2;
        results.push({
          type: 'FVG',
          priceLevel: midpoint,
          direction: 'BULLISH',
          strengthScore: Math.min(1, gapSize / (atr20 || gapSize)),
          distanceFromCurrentPrice: pctDistance(midpoint, currentPrice),
        });
      }
    }

    // Bearish FVG
    if (prev2.low > curr.high) {
      const gapLow = curr.high;
      const gapHigh = prev2.low;
      if (!isFvgMitigated(candles, i, gapLow, gapHigh)) {
        const gapSize = gapHigh - gapLow;
        const midpoint = (gapLow + gapHigh) / 2;
        results.push({
          type: 'FVG',
          priceLevel: midpoint,
          direction: 'BEARISH',
          strengthScore: Math.min(1, gapSize / (atr20 || gapSize)),
          distanceFromCurrentPrice: pctDistance(midpoint, currentPrice),
        });
      }
    }
  }
  return results;
}

/**
 * Order Blocks (OB)
 *
 * Bearish OB: last bullish candle before a bearish displacement move.
 * Bullish OB: last bearish candle before a bullish displacement move.
 *
 * Displacement threshold: the move after the OB candle is >1.5× average body size.
 *
 * Strength score = displacement body size / (1.5× avg body size), capped at 1.
 */
function detectOrderBlocks(candles: Candle[], currentPrice: number): Detection[] {
  const results: Detection[] = [];
  if (candles.length < 3) return results;

  const avgBody = averageBodySize(candles);
  const displacementThreshold = 1.5 * avgBody;

  for (let i = 1; i < candles.length - 1; i++) {
    const obCandle = candles[i];
    const nextCandle = candles[i + 1];
    const nextBody = bodySize(nextCandle);

    if (nextBody <= displacementThreshold) continue;

    const obBody = bodySize(obCandle);
    const strengthScore = Math.min(1, nextBody / (displacementThreshold || nextBody));

    // Bearish OB: bullish OB candle (close > open) followed by a bearish displacement
    if (obCandle.close > obCandle.open && nextCandle.close < nextCandle.open) {
      results.push({
        type: 'ORDER_BLOCK',
        priceLevel: (obCandle.high + obCandle.low) / 2,
        direction: 'BEARISH',
        strengthScore,
        distanceFromCurrentPrice: pctDistance((obCandle.high + obCandle.low) / 2, currentPrice),
      });
    }

    // Bullish OB: bearish OB candle (close < open) followed by a bullish displacement
    if (obCandle.close < obCandle.open && nextCandle.close > nextCandle.open) {
      results.push({
        type: 'ORDER_BLOCK',
        priceLevel: (obCandle.high + obCandle.low) / 2,
        direction: 'BULLISH',
        strengthScore,
        distanceFromCurrentPrice: pctDistance((obCandle.high + obCandle.low) / 2, currentPrice),
      });
    }
    void obBody; // referenced only for commentary — strengthScore derives from displacement
  }
  return results;
}

/**
 * Break of Structure (BOS) and Change of Character (ChoCH)
 *
 * BOS detection uses identified swing highs/lows:
 *   - Bullish BOS: close above a prior swing high
 *   - Bearish BOS: close below a prior swing low
 *
 * ChoCH: the first BOS opposite to the running trend direction.
 *
 * Trend direction is seeded from the first BOS observed in the series.
 * Subsequent BOS events that confirm the trend are tagged BOS.
 * The first BOS event that contradicts the trend is tagged ChoCH (and resets
 * the trend direction).
 *
 * Strength score = |close - breached level| / level, capped at 1.
 */
function detectBOSAndChoCH(candles: Candle[], currentPrice: number): { bos: Detection[]; choch: Detection[] } {
  const bos: Detection[] = [];
  const choch: Detection[] = [];
  if (candles.length < SWING_LOOKBACK * 2 + 2) return { bos, choch };

  const { highs: swingHighIdxs, lows: swingLowIdxs } = findSwings(candles);

  // For each candle, check if it breaks a prior swing high or low
  let trendDirection: 'BULLISH' | 'BEARISH' | null = null;

  for (let i = SWING_LOOKBACK + 1; i < candles.length; i++) {
    const c = candles[i];

    // Most recent prior swing high and low (strictly before i)
    const priorHighIdx = swingHighIdxs.filter((idx) => idx < i).slice(-1)[0];
    const priorLowIdx = swingLowIdxs.filter((idx) => idx < i).slice(-1)[0];

    if (priorHighIdx !== undefined) {
      const swingHigh = candles[priorHighIdx].high;
      if (c.close > swingHigh) {
        const strength = Math.min(1, (c.close - swingHigh) / swingHigh);
        if (trendDirection === 'BEARISH') {
          // ChoCH — first bullish break while trend was bearish
          choch.push({
            type: 'ChoCH',
            priceLevel: swingHigh,
            direction: 'BULLISH',
            strengthScore: strength,
            distanceFromCurrentPrice: pctDistance(swingHigh, currentPrice),
          });
          trendDirection = 'BULLISH';
        } else {
          bos.push({
            type: 'BOS',
            priceLevel: swingHigh,
            direction: 'BULLISH',
            strengthScore: strength,
            distanceFromCurrentPrice: pctDistance(swingHigh, currentPrice),
          });
          if (trendDirection === null) trendDirection = 'BULLISH';
        }
      }
    }

    if (priorLowIdx !== undefined) {
      const swingLow = candles[priorLowIdx].low;
      if (c.close < swingLow) {
        const strength = Math.min(1, (swingLow - c.close) / swingLow);
        if (trendDirection === 'BULLISH') {
          // ChoCH — first bearish break while trend was bullish
          choch.push({
            type: 'ChoCH',
            priceLevel: swingLow,
            direction: 'BEARISH',
            strengthScore: strength,
            distanceFromCurrentPrice: pctDistance(swingLow, currentPrice),
          });
          trendDirection = 'BEARISH';
        } else {
          bos.push({
            type: 'BOS',
            priceLevel: swingLow,
            direction: 'BEARISH',
            strengthScore: strength,
            distanceFromCurrentPrice: pctDistance(swingLow, currentPrice),
          });
          if (trendDirection === null) trendDirection = 'BEARISH';
        }
      }
    }
  }

  return { bos, choch };
}

/**
 * Liquidity Sweeps
 *
 * A sweep occurs when a candle wick extends beyond a prior swing high/low
 * but the candle closes back inside the prior range.
 *
 * Cross-references with liquidation levels: if a sweep price is within 0.5%
 * of a liquidation cluster, the `isHighProbability` annotation is added to
 * the label (reflected in a higher strengthScore cap).
 *
 * Base strength score = wick extension beyond swing / swing level, capped at 0.8.
 * If near a liquidation cluster: score is boosted to 0.9–1.0.
 */
function detectLiquiditySweeps(
  candles: Candle[],
  currentPrice: number,
  liquidationLevels: LiquidationLevel[],
): Detection[] {
  const results: Detection[] = [];
  if (candles.length < SWING_LOOKBACK * 2 + 2) return results;

  const { highs: swingHighIdxs, lows: swingLowIdxs } = findSwings(candles);

  for (let i = SWING_LOOKBACK + 1; i < candles.length; i++) {
    const c = candles[i];

    const priorHighIdx = swingHighIdxs.filter((idx) => idx < i).slice(-1)[0];
    const priorLowIdx = swingLowIdxs.filter((idx) => idx < i).slice(-1)[0];

    // Bullish liquidity sweep: wick below prior swing low but close above it
    if (priorLowIdx !== undefined) {
      const swingLow = candles[priorLowIdx].low;
      if (c.low < swingLow && c.close > swingLow) {
        const wickExtension = swingLow - c.low;
        let score = Math.min(0.8, wickExtension / swingLow);

        // Cross-reference with liquidation levels
        const nearLiq = liquidationLevels.find(
          (l) => l.side === 'LONG' && Math.abs(pctDistance(l.price, swingLow)) <= 0.5,
        );
        if (nearLiq) {
          // Boost: proportional to liquidation cluster size (relative to total)
          const totalLiq = liquidationLevels.reduce((s, l) => s + l.totalLiquidationUsd, 0);
          const liqShare = totalLiq > 0 ? nearLiq.totalLiquidationUsd / totalLiq : 0;
          score = Math.min(1, 0.85 + liqShare * 0.15);
        }

        results.push({
          type: nearLiq ? 'LIQUIDITY_SWEEP_HIGH_PROB' : 'LIQUIDITY_SWEEP',
          priceLevel: swingLow,
          direction: 'BULLISH',
          strengthScore: score,
          distanceFromCurrentPrice: pctDistance(swingLow, currentPrice),
        });
      }
    }

    // Bearish liquidity sweep: wick above prior swing high but close below it
    if (priorHighIdx !== undefined) {
      const swingHigh = candles[priorHighIdx].high;
      if (c.high > swingHigh && c.close < swingHigh) {
        const wickExtension = c.high - swingHigh;
        let score = Math.min(0.8, wickExtension / swingHigh);

        const nearLiq = liquidationLevels.find(
          (l) => l.side === 'SHORT' && Math.abs(pctDistance(l.price, swingHigh)) <= 0.5,
        );
        if (nearLiq) {
          const totalLiq = liquidationLevels.reduce((s, l) => s + l.totalLiquidationUsd, 0);
          const liqShare = totalLiq > 0 ? nearLiq.totalLiquidationUsd / totalLiq : 0;
          score = Math.min(1, 0.85 + liqShare * 0.15);
        }

        results.push({
          type: nearLiq ? 'LIQUIDITY_SWEEP_HIGH_PROB' : 'LIQUIDITY_SWEEP',
          priceLevel: swingHigh,
          direction: 'BEARISH',
          strengthScore: score,
          distanceFromCurrentPrice: pctDistance(swingHigh, currentPrice),
        });
      }
    }
  }

  return results;
}

// ─── Tool ─────────────────────────────────────────────────────────────────────

export const smcTool = createTool({
  id: 'smc-tool',
  description:
    'Detects Smart Money Concepts (SMC) structures from OHLCV data: Fair Value Gaps, Order Blocks, Break of Structure, Change of Character, and Liquidity Sweeps. Optionally cross-references liquidity sweep zones with on-chain liquidation levels to flag high-probability setups.',
  inputSchema: z.object({
    candles: z.array(candleSchema).min(1).describe('OHLCV candle array, oldest first'),
    liquidationLevels: z
      .array(liquidationLevelSchema)
      .optional()
      .default([])
      .describe('Optional liquidation levels from onchain-tool for liquidity sweep cross-referencing'),
  }),
  outputSchema: z.object({
    fvgs: z.array(detectionSchema).describe('Detected unmitigated Fair Value Gaps'),
    orderBlocks: z.array(detectionSchema).describe('Detected Order Blocks with displacement confirmation'),
    bos: z.array(detectionSchema).describe('Break of Structure events'),
    choch: z.array(detectionSchema).describe('Change of Character events (first BOS opposing trend)'),
    liquiditySweeps: z.array(detectionSchema).describe('Detected liquidity sweeps; HIGH_PROB type when near a liquidation cluster'),
    currentPrice: z.number().describe('Current price used for distanceFromCurrentPrice calculations'),
    candleCount: z.number().describe('Number of candles analysed'),
  }),
  execute: async (inputData) => {
    const { candles, liquidationLevels } = inputData as {
      candles: Candle[];
      liquidationLevels: LiquidationLevel[];
    };

    if (!candles.length) {
      return {
        fvgs: [],
        orderBlocks: [],
        bos: [],
        choch: [],
        liquiditySweeps: [],
        currentPrice: 0,
        candleCount: 0,
      };
    }

    const currentPrice = candles[candles.length - 1].close;
    const liqLevels = liquidationLevels ?? [];

    const fvgs = detectFVGs(candles, currentPrice);
    const orderBlocks = detectOrderBlocks(candles, currentPrice);
    const { bos, choch } = detectBOSAndChoCH(candles, currentPrice);
    const liquiditySweeps = detectLiquiditySweeps(candles, currentPrice, liqLevels);

    return {
      fvgs,
      orderBlocks,
      bos,
      choch,
      liquiditySweeps,
      currentPrice,
      candleCount: candles.length,
    };
  },
});
