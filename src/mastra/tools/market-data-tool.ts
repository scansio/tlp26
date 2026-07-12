import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import ccxt, { type OHLCV, type Exchange, NetworkError, ExchangeError } from 'ccxt';

const SUPPORTED_EXCHANGES = ['binance', 'bingx', 'bybit'] as const;
type SupportedExchange = (typeof SUPPORTED_EXCHANGES)[number];

const candleSchema = z.object({
  timestamp: z.number().describe('Unix timestamp in milliseconds'),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
});

export const marketDataTool = createTool({
  id: 'market-data-tool',
  description:
    'Fetch OHLCV candlestick data from a crypto exchange via CCXT. Returns verified price data for chart analysis.',
  inputSchema: z.object({
    symbol: z.string().describe('Trading pair symbol, e.g. BTC/USDT'),
    timeframe: z
      .enum(['1m', '5m', '15m', '1h', '4h', '1d'])
      .describe('Candlestick timeframe'),
    limit: z
      .number()
      .int()
      .positive()
      .default(200)
      .describe('Number of candles to fetch (default 200)'),
    exchange: z
      .enum(SUPPORTED_EXCHANGES)
      .default('binance')
      .describe('Exchange to fetch from (default: binance)'),
  }),
  outputSchema: z.object({
    candles: z.array(candleSchema),
    symbol: z.string(),
    timeframe: z.string(),
    exchange: z.string(),
  }),
  execute: async (inputData) => {
    const { symbol, timeframe, limit, exchange } = inputData as {
      symbol: string;
      timeframe: '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
      limit: number;
      exchange: SupportedExchange;
    };

    const exchangeId: SupportedExchange = exchange ?? 'binance';

    const ExchangeClass = ccxt[exchangeId as keyof typeof ccxt] as new (config?: object) => Exchange;
    if (!ExchangeClass) {
      throw new Error(`Exchange '${exchangeId}' is not supported by CCXT.`);
    }

    const client = new ExchangeClass({ enableRateLimit: true });

    let rawCandles: OHLCV[];
    try {
      await client.loadMarkets();
      if (!client.markets[symbol]) {
        throw new Error(
          `Symbol '${symbol}' not found on ${exchangeId}. Check the trading pair format (e.g. BTC/USDT).`,
        );
      }
      rawCandles = await client.fetchOHLCV(symbol, timeframe, undefined, limit);
    } catch (err: unknown) {
      if (err instanceof NetworkError) {
        throw new Error(
          `Network error fetching ${symbol} from ${exchangeId}: ${(err as Error).message}. The exchange may be unreachable or timed out.`,
        );
      }
      if (err instanceof ExchangeError) {
        throw new Error(
          `Exchange error from ${exchangeId} for ${symbol}: ${(err as Error).message}`,
        );
      }
      throw err;
    }

    const candles = rawCandles
      .filter((c): c is OHLCV =>
        Array.isArray(c) && c.length >= 6 && c.every((v) => v !== null && v !== undefined),
      )
      .map((c) => ({
        timestamp: c[0] as number,
        open: c[1] as number,
        high: c[2] as number,
        low: c[3] as number,
        close: c[4] as number,
        volume: c[5] as number,
      }));

    return {
      candles,
      symbol,
      timeframe,
      exchange: exchangeId,
    };
  },
});
