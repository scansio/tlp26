import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const TV_INTERVAL_MAP: Record<string, string> = {
  '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30',
  '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720',
  '1d': 'D', '1w': 'W', '1M': 'M',
};

export const chartTool = createTool({
  id: 'chart-tool',
  description:
    'Display an interactive TradingView chart in the chat UI for a given symbol and timeframe. ' +
    'Call this every time you fetch market data so the user can see the live chart.',
  inputSchema: z.object({
    symbol: z.string().describe('Trading pair, e.g. BTC/USDT or BTCUSDT'),
    exchange: z.string().describe('Exchange name, e.g. binance'),
    interval: z.string().describe('Timeframe, e.g. 1h, 4h, 1d'),
  }),
  outputSchema: z.object({
    tvSymbol: z.string(),
    tvExchange: z.string(),
    tvInterval: z.string(),
    widgetType: z.literal('tradingview'),
  }),
  execute: async (inputData) => {
    const { symbol, exchange, interval } = inputData as {
      symbol: string;
      exchange: string;
      interval: string;
    };

    const tvSymbol = symbol.replace('/', '').toUpperCase();
    const tvExchange = exchange.toUpperCase();
    const tvInterval = TV_INTERVAL_MAP[interval.toLowerCase()] ?? interval;

    return {
      tvSymbol,
      tvExchange,
      tvInterval,
      widgetType: 'tradingview' as const,
    };
  },
});
