import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

// ─────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────

const candleSchema = z.object({
  timestamp: z.number().describe('Unix timestamp in milliseconds'),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
});

const detectedPatternSchema = z.object({
  patternType: z.string().describe('Name of the detected chart pattern'),
  direction: z.enum(['BULLISH', 'BEARISH']),
  necklinePrice: z.number().describe('Key support/resistance level for the pattern'),
  targetPrice: z.number().describe('Measured move projection from pattern'),
  invalidationLevel: z.number().describe('Price level that would invalidate the pattern'),
  confidenceScore: z.number().min(0).max(1).describe('Confidence score 0.0–1.0'),
});

export type DetectedPattern = z.infer<typeof detectedPatternSchema>;

export const patternTool = createTool({
  id: 'chart-pattern-detection',
  description:
    'Detects classical chart patterns (H&S, Double Top/Bottom, Triangles, Flags, Wedges) from OHLCV candle data using a ZigZag pivot algorithm. Returns patterns sorted by confidence descending.',
  inputSchema: z.object({
    candles: z.array(candleSchema).describe('Array of OHLCV candles in chronological order'),
    sensitivity: z
      .number()
      .min(0.01)
      .max(0.5)
      .default(0.05)
      .describe('ZigZag sensitivity as a fraction of price (default 0.05 = 5%)'),
  }),
  outputSchema: z.object({
    patterns: z.array(detectedPatternSchema).describe(
      'Detected patterns with confidenceScore >= 0.6, sorted by confidence descending',
    ),
  }),
  execute: async (inputData) => {
    const { candles, sensitivity } = inputData as {
      candles: z.infer<typeof candleSchema>[];
      sensitivity: number;
    };

    if (!candles || candles.length < 10) {
      return { patterns: [] };
    }

    const pivots = computeZigZag(candles, sensitivity);

    if (pivots.length < 3) {
      return { patterns: [] };
    }

    const raw: DetectedPattern[] = [
      ...detectHeadAndShoulders(pivots),
      ...detectDoubleTopBottom(pivots),
      ...detectTriangles(pivots, candles),
      ...detectFlags(pivots, candles),
      ...detectWedges(pivots),
    ];

    const patterns = raw
      .filter((p) => p.confidenceScore >= 0.6)
      .sort((a, b) => b.confidenceScore - a.confidenceScore);

    return { patterns };
  },
});

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

interface Pivot {
  index: number;
  timestamp: number;
  price: number;
  type: 'HIGH' | 'LOW';
}

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ─────────────────────────────────────────────
// ZigZag Pivot Algorithm
// ─────────────────────────────────────────────

/**
 * Produces an alternating array of pivot HIGHs and LOWs.
 * A pivot flip occurs when price moves against the current direction by >= sensitivity%.
 */
function computeZigZag(candles: Candle[], sensitivity: number): Pivot[] {
  const pivots: Pivot[] = [];

  if (candles.length === 0) return pivots;

  let direction: 'UP' | 'DOWN' = 'UP';
  let extremeIndex = 0;
  let extremePrice = candles[0].high;

  for (let i = 1; i < candles.length; i++) {
    const candle = candles[i];

    if (direction === 'UP') {
      if (candle.high > extremePrice) {
        extremePrice = candle.high;
        extremeIndex = i;
      } else if ((extremePrice - candle.low) / extremePrice >= sensitivity) {
        // Commit the high pivot, flip to DOWN
        pivots.push({
          index: extremeIndex,
          timestamp: candles[extremeIndex].timestamp,
          price: extremePrice,
          type: 'HIGH',
        });
        direction = 'DOWN';
        extremePrice = candle.low;
        extremeIndex = i;
      }
    } else {
      if (candle.low < extremePrice) {
        extremePrice = candle.low;
        extremeIndex = i;
      } else if ((candle.high - extremePrice) / extremePrice >= sensitivity) {
        // Commit the low pivot, flip to UP
        pivots.push({
          index: extremeIndex,
          timestamp: candles[extremeIndex].timestamp,
          price: extremePrice,
          type: 'LOW',
        });
        direction = 'UP';
        extremePrice = candle.high;
        extremeIndex = i;
      }
    }
  }

  // Commit the last extreme as the final pivot
  pivots.push({
    index: extremeIndex,
    timestamp: candles[extremeIndex].timestamp,
    price: extremePrice,
    type: direction === 'UP' ? 'HIGH' : 'LOW',
  });

  return pivots;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** Pairwise symmetry score: 1.0 when a === b, decays linearly. */
function symmetryScore(a: number, b: number, tolerance = 0.05): number {
  if (a === 0 && b === 0) return 1;
  const denom = Math.max(Math.abs(a), Math.abs(b));
  if (denom === 0) return 1;
  const diff = Math.abs(a - b) / denom;
  return Math.max(0, 1 - diff / tolerance);
}

/** Linear trendline fit over (x, y) pairs. Returns slope and intercept. */
function linearFit(points: { x: number; y: number }[]): { slope: number; intercept: number } {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: points[0]?.y ?? 0 };
  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumXX = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumXX += p.x * p.x;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / n };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

/** R² goodness-of-fit (0–1) for a linear model. */
function rSquared(points: { x: number; y: number }[], slope: number, intercept: number): number {
  const meanY = points.reduce((s, p) => s + p.y, 0) / points.length;
  let ssTot = 0,
    ssRes = 0;
  for (const p of points) {
    ssTot += (p.y - meanY) ** 2;
    ssRes += (p.y - (slope * p.x + intercept)) ** 2;
  }
  if (ssTot === 0) return 1;
  return Math.max(0, 1 - ssRes / ssTot);
}

// ─────────────────────────────────────────────
// Head & Shoulders + Inverse H&S
// ─────────────────────────────────────────────

/**
 * H&S needs 5 pivots in this order: LOW (left shoulder), HIGH (left shoulder peak),
 * LOW (neckline-left), HIGH (head), LOW (neckline-right), HIGH (right shoulder peak), LOW (end)
 * We look for windows of 5 pivots where pattern starts with HIGH for H&S:
 *   P0=HIGH(leftShoulder), P1=LOW(neckL), P2=HIGH(head), P3=LOW(neckR), P4=HIGH(rightShoulder)
 *   or starts LOW for inverse H&S.
 *
 * Target (H&S BEARISH): neckline - (head - neckline)
 * Invalidation (H&S):   above head
 *
 * Target (Inverse H&S BULLISH): neckline + (neckline - head)
 * Invalidation (Inverse H&S): below head
 */
function detectHeadAndShoulders(pivots: Pivot[]): DetectedPattern[] {
  const results: DetectedPattern[] = [];
  if (pivots.length < 5) return results;

  // Slide a 5-pivot window
  for (let i = 0; i <= pivots.length - 5; i++) {
    const window = pivots.slice(i, i + 5);

    // ── H&S (BEARISH) ──
    // Pattern: HIGH, LOW, HIGH, LOW, HIGH where middle HIGH is the tallest
    if (
      window[0].type === 'HIGH' &&
      window[1].type === 'LOW' &&
      window[2].type === 'HIGH' &&
      window[3].type === 'LOW' &&
      window[4].type === 'HIGH'
    ) {
      const [lShoulder, neckL, head, neckR, rShoulder] = window;

      // Head must be higher than both shoulders
      if (head.price <= lShoulder.price || head.price <= rShoulder.price) continue;

      // Neckline: average of neckL and neckR lows
      const neckline = (neckL.price + neckR.price) / 2;

      // Shoulder symmetry
      const shoulderSym = symmetryScore(lShoulder.price, rShoulder.price, 0.08);
      const neckSym = symmetryScore(neckL.price, neckR.price, 0.05);

      // Head must be meaningfully above shoulders (at least 2% more)
      const headLift = (head.price - Math.max(lShoulder.price, rShoulder.price)) / head.price;
      const headScore = Math.min(1, headLift / 0.04);

      const confidence = 0.4 * shoulderSym + 0.3 * neckSym + 0.3 * headScore;

      const target = neckline - (head.price - neckline);
      const invalidation = head.price * 1.001; // slightly above head

      results.push({
        patternType: 'Head & Shoulders',
        direction: 'BEARISH',
        necklinePrice: neckline,
        targetPrice: target,
        invalidationLevel: invalidation,
        confidenceScore: Math.min(1, Math.max(0, confidence)),
      });
    }

    // ── Inverse H&S (BULLISH) ──
    // Pattern: LOW, HIGH, LOW, HIGH, LOW where middle LOW is the deepest
    if (
      window[0].type === 'LOW' &&
      window[1].type === 'HIGH' &&
      window[2].type === 'LOW' &&
      window[3].type === 'HIGH' &&
      window[4].type === 'LOW'
    ) {
      const [lShoulder, neckL, head, neckR, rShoulder] = window;

      // Head must be lower than both shoulders
      if (head.price >= lShoulder.price || head.price >= rShoulder.price) continue;

      const neckline = (neckL.price + neckR.price) / 2;

      const shoulderSym = symmetryScore(lShoulder.price, rShoulder.price, 0.08);
      const neckSym = symmetryScore(neckL.price, neckR.price, 0.05);

      const headDrop = (Math.min(lShoulder.price, rShoulder.price) - head.price) / head.price;
      const headScore = Math.min(1, headDrop / 0.04);

      const confidence = 0.4 * shoulderSym + 0.3 * neckSym + 0.3 * headScore;

      const target = neckline + (neckline - head.price);
      const invalidation = head.price * 0.999;

      results.push({
        patternType: 'Inverse Head & Shoulders',
        direction: 'BULLISH',
        necklinePrice: neckline,
        targetPrice: target,
        invalidationLevel: invalidation,
        confidenceScore: Math.min(1, Math.max(0, confidence)),
      });
    }
  }

  return results;
}

// ─────────────────────────────────────────────
// Double Top + Double Bottom
// ─────────────────────────────────────────────

/**
 * Double Top (BEARISH): HIGH, LOW, HIGH (equal highs)
 * Neckline = the LOW between the two peaks
 * Target = neckline - (peak - neckline)
 * Invalidation = above higher peak
 *
 * Double Bottom (BULLISH): LOW, HIGH, LOW (equal lows)
 * Neckline = the HIGH between the two troughs
 * Target = neckline + (neckline - trough)
 * Invalidation = below lower trough
 */
function detectDoubleTopBottom(pivots: Pivot[]): DetectedPattern[] {
  const results: DetectedPattern[] = [];
  if (pivots.length < 3) return results;

  for (let i = 0; i <= pivots.length - 3; i++) {
    const [p0, p1, p2] = pivots.slice(i, i + 3);

    // ── Double Top ──
    if (p0.type === 'HIGH' && p1.type === 'LOW' && p2.type === 'HIGH') {
      const peakSym = symmetryScore(p0.price, p2.price, 0.04);
      if (peakSym < 0.3) continue; // peaks too dissimilar

      const neckline = p1.price;
      const peakAvg = (p0.price + p2.price) / 2;
      const target = neckline - (peakAvg - neckline);
      const invalidation = Math.max(p0.price, p2.price) * 1.001;

      // Ensure neckline is meaningfully below peaks
      const depth = (peakAvg - neckline) / peakAvg;
      const depthScore = Math.min(1, depth / 0.05);

      const confidence = 0.6 * peakSym + 0.4 * depthScore;

      results.push({
        patternType: 'Double Top',
        direction: 'BEARISH',
        necklinePrice: neckline,
        targetPrice: target,
        invalidationLevel: invalidation,
        confidenceScore: Math.min(1, Math.max(0, confidence)),
      });
    }

    // ── Double Bottom ──
    if (p0.type === 'LOW' && p1.type === 'HIGH' && p2.type === 'LOW') {
      const troughSym = symmetryScore(p0.price, p2.price, 0.04);
      if (troughSym < 0.3) continue;

      const neckline = p1.price;
      const troughAvg = (p0.price + p2.price) / 2;
      const target = neckline + (neckline - troughAvg);
      const invalidation = Math.min(p0.price, p2.price) * 0.999;

      const depth = (neckline - troughAvg) / neckline;
      const depthScore = Math.min(1, depth / 0.05);

      const confidence = 0.6 * troughSym + 0.4 * depthScore;

      results.push({
        patternType: 'Double Bottom',
        direction: 'BULLISH',
        necklinePrice: neckline,
        targetPrice: target,
        invalidationLevel: invalidation,
        confidenceScore: Math.min(1, Math.max(0, confidence)),
      });
    }
  }

  return results;
}

// ─────────────────────────────────────────────
// Triangles: Ascending, Descending, Symmetrical
// ─────────────────────────────────────────────

/**
 * All triangles require >= 4 pivots (at least 2 highs + 2 lows).
 * We extract all highs and all lows from a window of n pivots, fit linear trendlines,
 * and classify by slope direction:
 *   Ascending  (BULLISH): flat/rising resistance + rising support
 *   Descending (BEARISH): falling resistance + flat/falling support
 *   Symmetrical(depends): falling resistance + rising support → direction is momentum-based
 *
 * Target   = breakout level ± (widest vertical extent of triangle)
 * Neckline = apex price (where the two lines converge)
 * Invalidation = opposite trendline at the time of breakout
 */
function detectTriangles(pivots: Pivot[], candles: Candle[]): DetectedPattern[] {
  const results: DetectedPattern[] = [];
  const MIN_WINDOW = 6;
  if (pivots.length < MIN_WINDOW) return results;

  // Use the most recent pivots (up to 16) to find an in-progress triangle
  for (
    let windowSize = MIN_WINDOW;
    windowSize <= Math.min(16, pivots.length);
    windowSize += 2
  ) {
    const window = pivots.slice(pivots.length - windowSize);

    const highs = window.filter((p) => p.type === 'HIGH');
    const lows = window.filter((p) => p.type === 'LOW');

    if (highs.length < 2 || lows.length < 2) continue;

    const highPoints = highs.map((p) => ({ x: p.index, y: p.price }));
    const lowPoints = lows.map((p) => ({ x: p.index, y: p.price }));

    const { slope: hiSlope, intercept: hiInt } = linearFit(highPoints);
    const { slope: loSlope, intercept: loInt } = linearFit(lowPoints);

    const hiR2 = rSquared(highPoints, hiSlope, hiInt);
    const loR2 = rSquared(lowPoints, loSlope, loInt);

    // Both trendlines must have decent fit
    const fitScore = (hiR2 + loR2) / 2;
    if (fitScore < 0.5) continue;

    // Trendlines must be converging (not parallel / diverging)
    const slopeDiff = hiSlope - loSlope;
    if (slopeDiff >= 0) continue; // high slope must be lower than low slope

    // Apex: x where hiSlope*x + hiInt = loSlope*x + loInt
    const apexX = (loInt - hiInt) / (hiSlope - loSlope);
    const apexPrice = hiSlope * apexX + hiInt;

    // Widest vertical range = first entry of triangle
    const firstHi = hiSlope * window[0].index + hiInt;
    const firstLo = loSlope * window[0].index + loInt;
    const triangleHeight = Math.abs(firstHi - firstLo);

    const touchCount = highs.length + lows.length;
    const touchScore = Math.min(1, (touchCount - 4) / 4);

    const FLAT_SLOPE_THRESHOLD = 0.01; // relative to average price
    const avgPrice = (apexPrice + (firstHi + firstLo) / 2) / 2;
    const normHiSlope = Math.abs(hiSlope) / avgPrice;
    const normLoSlope = Math.abs(loSlope) / avgPrice;

    const hiFlat = normHiSlope < FLAT_SLOPE_THRESHOLD;
    const loFlat = normLoSlope < FLAT_SLOPE_THRESHOLD;

    if (hiFlat && loSlope > 0) {
      // ── Ascending Triangle (BULLISH) ──
      // Flat resistance + rising support
      const confidence = 0.5 * fitScore + 0.3 * touchScore + 0.2;
      results.push({
        patternType: 'Ascending Triangle',
        direction: 'BULLISH',
        necklinePrice: apexPrice,
        targetPrice: apexPrice + triangleHeight,
        invalidationLevel: loSlope * window[window.length - 1].index + loInt,
        confidenceScore: Math.min(1, Math.max(0, confidence)),
      });
    } else if (loFlat && hiSlope < 0) {
      // ── Descending Triangle (BEARISH) ──
      // Falling resistance + flat support
      const confidence = 0.5 * fitScore + 0.3 * touchScore + 0.2;
      results.push({
        patternType: 'Descending Triangle',
        direction: 'BEARISH',
        necklinePrice: apexPrice,
        targetPrice: apexPrice - triangleHeight,
        invalidationLevel: hiSlope * window[window.length - 1].index + hiInt,
        confidenceScore: Math.min(1, Math.max(0, confidence)),
      });
    } else if (!hiFlat && !loFlat && hiSlope < 0 && loSlope > 0) {
      // ── Symmetrical Triangle ──
      // Both sides converging — direction determined by broader trend
      const firstClose = candles[window[0].index]?.close ?? apexPrice;
      const lastClose = candles[window[window.length - 1].index]?.close ?? apexPrice;
      const trendUp = lastClose > firstClose;

      const confidence = 0.5 * fitScore + 0.3 * touchScore + 0.15;
      results.push({
        patternType: 'Symmetrical Triangle',
        direction: trendUp ? 'BULLISH' : 'BEARISH',
        necklinePrice: apexPrice,
        targetPrice: trendUp ? apexPrice + triangleHeight : apexPrice - triangleHeight,
        invalidationLevel: trendUp
          ? loSlope * window[window.length - 1].index + loInt
          : hiSlope * window[window.length - 1].index + hiInt,
        confidenceScore: Math.min(1, Math.max(0, confidence)),
      });
    }
  }

  return results;
}

// ─────────────────────────────────────────────
// Flags: Bull Flag + Bear Flag
// ─────────────────────────────────────────────

/**
 * Flag = sharp impulse (flagpole) followed by a tight counter-trend consolidation channel.
 *
 * Bull Flag (BULLISH):
 *   Flagpole: strong upward move (last LOW to last HIGH before consolidation)
 *   Consolidation: 3–5 pivots trending slightly down (negative slope on both highs and lows)
 *   Target = breakout level + flagpole length
 *   Invalidation = below the bottom of the flag channel
 *
 * Bear Flag (BEARISH): mirror image
 *
 * We look at the last 6–10 pivots:
 *   First 2 pivots form the pole; remaining form the flag.
 */
function detectFlags(pivots: Pivot[], candles: Candle[]): DetectedPattern[] {
  const results: DetectedPattern[] = [];
  if (pivots.length < 6) return results;

  const MIN_FLAG_PIVOTS = 4; // pivots in the flag body

  for (
    let start = 0;
    start <= pivots.length - (2 + MIN_FLAG_PIVOTS);
    start++
  ) {
    const pole = pivots.slice(start, start + 2);
    const flag = pivots.slice(start + 2, start + 2 + MIN_FLAG_PIVOTS);

    // ── Bull Flag ──
    if (pole[0].type === 'LOW' && pole[1].type === 'HIGH') {
      const poleLen = pole[1].price - pole[0].price;
      if (poleLen / pole[0].price < 0.03) continue; // pole must be at least 3%

      const flagHighs = flag.filter((p) => p.type === 'HIGH');
      const flagLows = flag.filter((p) => p.type === 'LOW');
      if (flagHighs.length < 1 || flagLows.length < 1) continue;

      const hiPts = flagHighs.map((p) => ({ x: p.index, y: p.price }));
      const loPts = flagLows.map((p) => ({ x: p.index, y: p.price }));

      const { slope: hiSlope, intercept: hiInt } = linearFit(hiPts);
      const { slope: loSlope, intercept: loInt } = linearFit(loPts);

      // Flag channel should slope slightly downward (counter-trend)
      if (hiSlope >= 0 || loSlope >= 0) continue;

      // Channel must be relatively tight (< 50% of pole height)
      const lastIdx = flag[flag.length - 1].index;
      const channelTop = hiSlope * lastIdx + hiInt;
      const channelBot = loSlope * lastIdx + loInt;
      const channelHeight = Math.abs(channelTop - channelBot);
      if (channelHeight > poleLen * 0.5) continue;

      // Retracement of pole must be < 61.8%
      const retrace = (pole[1].price - channelBot) / poleLen;
      const retraceScore = retrace < 0.618 ? Math.max(0, 1 - retrace / 0.618) : 0;

      const avgCandle = candles[pole[1].index];
      const breakout = avgCandle ? avgCandle.close : channelTop;

      // Pole impulsiveness score (relative to recent average candle size)
      const poleScore = Math.min(1, (poleLen / pole[0].price) / 0.08);

      const confidence = 0.4 * poleScore + 0.4 * retraceScore + 0.2;

      results.push({
        patternType: 'Bull Flag',
        direction: 'BULLISH',
        necklinePrice: channelTop,
        targetPrice: breakout + poleLen,
        invalidationLevel: channelBot,
        confidenceScore: Math.min(1, Math.max(0, confidence)),
      });
    }

    // ── Bear Flag ──
    if (pole[0].type === 'HIGH' && pole[1].type === 'LOW') {
      const poleLen = pole[0].price - pole[1].price;
      if (poleLen / pole[0].price < 0.03) continue;

      const flagHighs = flag.filter((p) => p.type === 'HIGH');
      const flagLows = flag.filter((p) => p.type === 'LOW');
      if (flagHighs.length < 1 || flagLows.length < 1) continue;

      const hiPts = flagHighs.map((p) => ({ x: p.index, y: p.price }));
      const loPts = flagLows.map((p) => ({ x: p.index, y: p.price }));

      const { slope: hiSlope, intercept: hiInt } = linearFit(hiPts);
      const { slope: loSlope, intercept: loInt } = linearFit(loPts);

      // Flag channel should slope slightly upward (counter-trend)
      if (hiSlope <= 0 || loSlope <= 0) continue;

      const lastIdx = flag[flag.length - 1].index;
      const channelTop = hiSlope * lastIdx + hiInt;
      const channelBot = loSlope * lastIdx + loInt;
      const channelHeight = Math.abs(channelTop - channelBot);
      if (channelHeight > poleLen * 0.5) continue;

      const retrace = (channelTop - pole[1].price) / poleLen;
      const retraceScore = retrace < 0.618 ? Math.max(0, 1 - retrace / 0.618) : 0;

      const avgCandle = candles[pole[1].index];
      const breakout = avgCandle ? avgCandle.close : channelBot;

      const poleScore = Math.min(1, (poleLen / pole[0].price) / 0.08);

      const confidence = 0.4 * poleScore + 0.4 * retraceScore + 0.2;

      results.push({
        patternType: 'Bear Flag',
        direction: 'BEARISH',
        necklinePrice: channelBot,
        targetPrice: breakout - poleLen,
        invalidationLevel: channelTop,
        confidenceScore: Math.min(1, Math.max(0, confidence)),
      });
    }
  }

  return results;
}

// ─────────────────────────────────────────────
// Wedges: Rising + Falling
// ─────────────────────────────────────────────

/**
 * Wedges look structurally similar to triangles but BOTH trendlines slope in the same direction.
 *
 * Rising Wedge (BEARISH):
 *   Both highs-line and lows-line have positive slope, but highs slope > lows slope
 *   (wedge is compressing from below — bullish momentum is slowing)
 *   Neckline = price where lines converge (apex)
 *   Target = apex - widest height
 *   Invalidation = above the upper trendline
 *
 * Falling Wedge (BULLISH):
 *   Both trendlines negative slope, lows slope < highs slope (steeper drop on lows)
 *   Neckline = apex
 *   Target = apex + widest height
 *   Invalidation = below lower trendline
 */
function detectWedges(pivots: Pivot[]): DetectedPattern[] {
  const results: DetectedPattern[] = [];
  const MIN_WINDOW = 6;
  if (pivots.length < MIN_WINDOW) return results;

  for (
    let windowSize = MIN_WINDOW;
    windowSize <= Math.min(16, pivots.length);
    windowSize += 2
  ) {
    const window = pivots.slice(pivots.length - windowSize);

    const highs = window.filter((p) => p.type === 'HIGH');
    const lows = window.filter((p) => p.type === 'LOW');

    if (highs.length < 2 || lows.length < 2) continue;

    const highPoints = highs.map((p) => ({ x: p.index, y: p.price }));
    const lowPoints = lows.map((p) => ({ x: p.index, y: p.price }));

    const { slope: hiSlope, intercept: hiInt } = linearFit(highPoints);
    const { slope: loSlope, intercept: loInt } = linearFit(lowPoints);

    const hiR2 = rSquared(highPoints, hiSlope, hiInt);
    const loR2 = rSquared(lowPoints, loSlope, loInt);
    const fitScore = (hiR2 + loR2) / 2;
    if (fitScore < 0.5) continue;

    // Slopes must be same direction (both positive or both negative)
    const bothPositive = hiSlope > 0 && loSlope > 0;
    const bothNegative = hiSlope < 0 && loSlope < 0;
    if (!bothPositive && !bothNegative) continue;

    // For a wedge, the two lines must converge (gap narrowing over time)
    const firstGap =
      hiSlope * window[0].index + hiInt - (loSlope * window[0].index + loInt);
    const lastGap =
      hiSlope * window[window.length - 1].index +
      hiInt -
      (loSlope * window[window.length - 1].index + loInt);

    // Gap must be shrinking and positive (lines not crossed yet)
    if (firstGap <= 0 || lastGap <= 0 || lastGap >= firstGap) continue;

    const wedgeHeight = Math.abs(firstGap);
    const convergenceScore = 1 - lastGap / firstGap; // 1 = fully converged
    const touchCount = highs.length + lows.length;
    const touchScore = Math.min(1, (touchCount - 4) / 4);

    // Apex X where the two lines meet: hiSlope*x + hiInt = loSlope*x + loInt
    const slopeDiff = hiSlope - loSlope;
    if (slopeDiff === 0) continue;
    const apexX = (loInt - hiInt) / slopeDiff;
    const apexPrice = hiSlope * apexX + hiInt;

    const confidence = 0.4 * fitScore + 0.35 * convergenceScore + 0.25 * touchScore;
    const lastWindowIdx = window[window.length - 1].index;

    if (bothPositive && hiSlope > loSlope) {
      // ── Rising Wedge (BEARISH) — upper line rises faster ──
      results.push({
        patternType: 'Rising Wedge',
        direction: 'BEARISH',
        necklinePrice: apexPrice,
        targetPrice: apexPrice - wedgeHeight,
        invalidationLevel: hiSlope * lastWindowIdx + hiInt,
        confidenceScore: Math.min(1, Math.max(0, confidence)),
      });
    } else if (bothNegative && loSlope < hiSlope) {
      // ── Falling Wedge (BULLISH) — lower line drops faster ──
      results.push({
        patternType: 'Falling Wedge',
        direction: 'BULLISH',
        necklinePrice: apexPrice,
        targetPrice: apexPrice + wedgeHeight,
        invalidationLevel: loSlope * lastWindowIdx + loInt,
        confidenceScore: Math.min(1, Math.max(0, confidence)),
      });
    }
  }

  return results;
}
