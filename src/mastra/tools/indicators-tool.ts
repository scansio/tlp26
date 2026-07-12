import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  rsi,
  ema,
  macd,
  bollingerbands,
  adx,
} from 'technicalindicators';

// ─── Shared candle schema (mirrors market-data-tool output) ──────────────────

const candleSchema = z.object({
  timestamp: z.number().describe('Unix timestamp in milliseconds'),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
});

type Candle = z.infer<typeof candleSchema>;

// ─── Direction type ───────────────────────────────────────────────────────────

const directionEnum = z.enum(['BULLISH', 'BEARISH', 'NEUTRAL']);

// ─── Output schema ────────────────────────────────────────────────────────────

const outputSchema = z.object({
  rsi: z.object({
    value: z.number().describe('RSI(14) latest value (0–100)'),
    classification: z
      .enum(['OVERSOLD', 'NEUTRAL', 'OVERBOUGHT'])
      .describe('OVERSOLD <30, NEUTRAL 30–70, OVERBOUGHT >70'),
    direction: directionEnum.describe(
      'BULLISH when oversold, BEARISH when overbought, NEUTRAL otherwise',
    ),
  }),
  ema: z.object({
    ema20: z.number().describe('EMA(20) latest value'),
    ema50: z.number().describe('EMA(50) latest value'),
    ema200: z.number().describe('EMA(200) latest value'),
    priceAboveEma20: z
      .boolean()
      .describe('True if current close price is above EMA(20)'),
    priceAboveEma50: z
      .boolean()
      .describe('True if current close price is above EMA(50)'),
    priceAboveEma200: z
      .boolean()
      .describe('True if current close price is above EMA(200)'),
    direction: directionEnum.describe(
      'BULLISH when price is above EMA20, EMA50 and EMA200; BEARISH when below all three; NEUTRAL otherwise',
    ),
  }),
  macd: z.object({
    macdLine: z.number().describe('MACD line value (fast EMA − slow EMA)'),
    signalLine: z.number().describe('Signal line value (EMA of MACD line)'),
    histogram: z.number().describe('Histogram value (MACD line − signal line)'),
    crossoverDirection: z
      .enum(['BULLISH_CROSSOVER', 'BEARISH_CROSSOVER', 'NO_CROSSOVER'])
      .describe(
        'BULLISH_CROSSOVER when MACD crossed above signal, BEARISH_CROSSOVER when crossed below',
      ),
    direction: directionEnum.describe(
      'BULLISH when MACD line is above signal line, BEARISH when below, NEUTRAL on equality',
    ),
  }),
  bollingerBands: z.object({
    upper: z.number().describe('Upper Bollinger Band (20, 2σ)'),
    middle: z.number().describe('Middle band (SMA 20)'),
    lower: z.number().describe('Lower Bollinger Band (20, 2σ)'),
    bandwidthPercent: z
      .number()
      .describe('% bandwidth: (upper − lower) / middle × 100'),
    pricePosition: z
      .enum(['ABOVE_UPPER', 'NEAR_UPPER', 'MIDDLE', 'NEAR_LOWER', 'BELOW_LOWER'])
      .describe('Position of current close relative to the bands'),
    direction: directionEnum.describe(
      'BULLISH when price is near or above upper band, BEARISH when near or below lower band, NEUTRAL otherwise',
    ),
  }),
  adx: z.object({
    value: z.number().describe('ADX(14) latest value'),
    trendStrength: z
      .enum(['WEAK', 'MODERATE', 'STRONG'])
      .describe('WEAK <20, MODERATE 20–40, STRONG >40'),
    direction: directionEnum.describe(
      'NEUTRAL — ADX measures trend strength not direction; direction is always NEUTRAL',
    ),
  }),
  candleCount: z.number().describe('Number of candles provided as input'),
});

// ─── Tool ─────────────────────────────────────────────────────────────────────

export const indicatorsTool = createTool({
  id: 'indicators-tool',
  description:
    'Compute RSI(14), EMA(20/50/200), MACD(12,26,9), Bollinger Bands(20,2), and ADX(14) from an OHLCV candle array. Requires at least 200 candles. Returns latest values, classifications, and BULLISH/BEARISH/NEUTRAL direction for each indicator.',
  inputSchema: z.object({
    candles: z
      .array(candleSchema)
      .describe(
        'OHLCV candle array — the "candles" output from market-data-tool. Must contain at least 200 candles.',
      ),
  }),
  outputSchema,
  execute: async (inputData) => {
    const { candles } = inputData as { candles: Candle[] };

    if (!candles || candles.length < 200) {
      throw new Error(
        `Insufficient OHLCV data: received ${candles?.length ?? 0} candle(s) but at least 200 are required to compute all indicators (EMA-200 needs 200 data points).`,
      );
    }

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const currentClose = closes[closes.length - 1];

    // ── RSI(14) ──────────────────────────────────────────────────────────────
    const rsiValues = rsi({ period: 14, values: closes });
    const rsiValue = rsiValues[rsiValues.length - 1];

    if (rsiValue === undefined) {
      throw new Error('RSI computation returned no values. Ensure at least 15 candles are provided.');
    }

    const rsiClassification: 'OVERSOLD' | 'NEUTRAL' | 'OVERBOUGHT' =
      rsiValue < 30 ? 'OVERSOLD' : rsiValue > 70 ? 'OVERBOUGHT' : 'NEUTRAL';
    const rsiDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL' =
      rsiValue < 30 ? 'BULLISH' : rsiValue > 70 ? 'BEARISH' : 'NEUTRAL';

    // ── EMA(20 / 50 / 200) ───────────────────────────────────────────────────
    const ema20Values = ema({ period: 20, values: closes });
    const ema50Values = ema({ period: 50, values: closes });
    const ema200Values = ema({ period: 200, values: closes });

    const ema20 = ema20Values[ema20Values.length - 1];
    const ema50 = ema50Values[ema50Values.length - 1];
    const ema200 = ema200Values[ema200Values.length - 1];

    if (ema20 === undefined || ema50 === undefined || ema200 === undefined) {
      throw new Error('EMA computation returned no values.');
    }

    const priceAboveEma20 = currentClose > ema20;
    const priceAboveEma50 = currentClose > ema50;
    const priceAboveEma200 = currentClose > ema200;

    const emaDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL' =
      priceAboveEma20 && priceAboveEma50 && priceAboveEma200
        ? 'BULLISH'
        : !priceAboveEma20 && !priceAboveEma50 && !priceAboveEma200
          ? 'BEARISH'
          : 'NEUTRAL';

    // ── MACD(12, 26, 9) ──────────────────────────────────────────────────────
    const macdResults = macd({
      values: closes,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    });

    const latestMacd = macdResults[macdResults.length - 1];
    const prevMacd = macdResults[macdResults.length - 2];

    if (!latestMacd || latestMacd.MACD === undefined || latestMacd.signal === undefined || latestMacd.histogram === undefined) {
      throw new Error('MACD computation returned insufficient values.');
    }

    const macdLine = latestMacd.MACD;
    const signalLine = latestMacd.signal;
    const histogram = latestMacd.histogram;

    let crossoverDirection: 'BULLISH_CROSSOVER' | 'BEARISH_CROSSOVER' | 'NO_CROSSOVER' = 'NO_CROSSOVER';
    if (
      prevMacd &&
      prevMacd.MACD !== undefined &&
      prevMacd.signal !== undefined
    ) {
      const prevAbove = prevMacd.MACD > prevMacd.signal;
      const currAbove = macdLine > signalLine;
      if (!prevAbove && currAbove) {
        crossoverDirection = 'BULLISH_CROSSOVER';
      } else if (prevAbove && !currAbove) {
        crossoverDirection = 'BEARISH_CROSSOVER';
      }
    }

    const macdDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL' =
      macdLine > signalLine ? 'BULLISH' : macdLine < signalLine ? 'BEARISH' : 'NEUTRAL';

    // ── Bollinger Bands(20, 2) ────────────────────────────────────────────────
    const bbResults = bollingerbands({ period: 20, stdDev: 2, values: closes });
    const latestBb = bbResults[bbResults.length - 1];

    if (!latestBb) {
      throw new Error('Bollinger Bands computation returned insufficient values.');
    }

    const { upper, middle, lower } = latestBb;
    const bandwidthPercent = ((upper - lower) / middle) * 100;

    let pricePosition: 'ABOVE_UPPER' | 'NEAR_UPPER' | 'MIDDLE' | 'NEAR_LOWER' | 'BELOW_LOWER';
    if (currentClose > upper) {
      pricePosition = 'ABOVE_UPPER';
    } else if (currentClose >= middle + (upper - middle) * 0.5) {
      pricePosition = 'NEAR_UPPER';
    } else if (currentClose <= lower) {
      pricePosition = 'BELOW_LOWER';
    } else if (currentClose <= middle - (middle - lower) * 0.5) {
      pricePosition = 'NEAR_LOWER';
    } else {
      pricePosition = 'MIDDLE';
    }

    const bbDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL' =
      pricePosition === 'ABOVE_UPPER' || pricePosition === 'NEAR_UPPER'
        ? 'BULLISH'
        : pricePosition === 'BELOW_LOWER' || pricePosition === 'NEAR_LOWER'
          ? 'BEARISH'
          : 'NEUTRAL';

    // ── ADX(14) ──────────────────────────────────────────────────────────────
    const adxResults = adx({ high: highs, low: lows, close: closes, period: 14 });
    const latestAdx = adxResults[adxResults.length - 1];

    if (latestAdx === undefined) {
      throw new Error('ADX computation returned no values.');
    }

    const adxValue = latestAdx.adx;

    const trendStrength: 'WEAK' | 'MODERATE' | 'STRONG' =
      adxValue < 20 ? 'WEAK' : adxValue <= 40 ? 'MODERATE' : 'STRONG';

    // ── Return ────────────────────────────────────────────────────────────────
    return {
      rsi: {
        value: rsiValue,
        classification: rsiClassification,
        direction: rsiDirection,
      },
      ema: {
        ema20,
        ema50,
        ema200,
        priceAboveEma20,
        priceAboveEma50,
        priceAboveEma200,
        direction: emaDirection,
      },
      macd: {
        macdLine,
        signalLine,
        histogram,
        crossoverDirection,
        direction: macdDirection,
      },
      bollingerBands: {
        upper,
        middle,
        lower,
        bandwidthPercent,
        pricePosition,
        direction: bbDirection,
      },
      adx: {
        value: adxValue,
        trendStrength,
        direction: 'NEUTRAL' as const,
      },
      candleCount: candles.length,
    };
  },
});
