import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import ccxt from 'ccxt';
import type { OrderBook, Exchange } from 'ccxt';

export const orderbookTool = createTool({
  id: 'orderbook-analysis',
  description:
    'Fetches live L2 order book depth and detects institutional liquidity walls and bid/ask imbalance for a given symbol and exchange.',
  inputSchema: z.object({
    symbol: z.string().describe('Trading pair symbol, e.g. BTC/USDT'),
    exchange: z.string().default('binance').describe('Exchange id: binance, bybit, bingx'),
    depth: z.number().default(50).describe('Order book depth (number of levels per side)'),
  }),
  outputSchema: z.object({
    bidWalls: z.array(
      z.object({
        price: z.number(),
        totalSize: z.number(),
        distanceFromCurrentPrice: z.number().describe('Distance as percentage from mid price'),
      }),
    ),
    askWalls: z.array(
      z.object({
        price: z.number(),
        totalSize: z.number(),
        distanceFromCurrentPrice: z.number().describe('Distance as percentage from mid price'),
      }),
    ),
    imbalanceRatio: z.number(),
    dominantSide: z.enum(['BID', 'ASK', 'NEUTRAL']),
    currentSpread: z.number().describe('Bid-ask spread as percentage of mid price'),
  }),
  execute: async (inputData) => {
    const { symbol, exchange, depth } = inputData;
    return await analyzeOrderBook(symbol, exchange, depth);
  },
});

interface OrderBookLevel {
  price: number;
  size: number;
}

interface LiquidityWall {
  price: number;
  totalSize: number;
  distanceFromCurrentPrice: number;
}

function clusterLevels(
  levels: OrderBookLevel[],
  clusterBandPct: number,
): { anchorPrice: number; totalSize: number }[] {
  if (levels.length === 0) return [];

  const clusters: { anchorPrice: number; totalSize: number }[] = [];

  for (const level of levels) {
    const existing = clusters.find(
      (c) => Math.abs((level.price - c.anchorPrice) / c.anchorPrice) <= clusterBandPct,
    );
    if (existing) {
      existing.totalSize += level.size;
    } else {
      clusters.push({ anchorPrice: level.price, totalSize: level.size });
    }
  }

  return clusters;
}

function detectWalls(
  levels: OrderBookLevel[],
  midPrice: number,
  clusterBandPct: number,
): LiquidityWall[] {
  const rawClusters = clusterLevels(levels, clusterBandPct);
  if (rawClusters.length === 0) return [];

  const totalSizes = rawClusters.map((c) => c.totalSize);
  const averageSize = totalSizes.reduce((a, b) => a + b, 0) / totalSizes.length;

  return rawClusters
    .filter((c) => c.totalSize > 2 * averageSize)
    .map((c) => ({
      price: c.anchorPrice,
      totalSize: c.totalSize,
      distanceFromCurrentPrice: Math.abs((c.anchorPrice - midPrice) / midPrice) * 100,
    }));
}

async function analyzeOrderBook(
  symbol: string,
  exchange: string,
  depth: number,
): Promise<{
  bidWalls: LiquidityWall[];
  askWalls: LiquidityWall[];
  imbalanceRatio: number;
  dominantSide: 'BID' | 'ASK' | 'NEUTRAL';
  currentSpread: number;
}> {
  const exchangeId = exchange.toLowerCase();

  // Guard: ensure the exchange class exists in ccxt
  if (!(exchangeId in ccxt)) {
    throw new Error(
      `Exchange '${exchangeId}' is not supported. Supported exchanges include: binance, bybit, bingx.`,
    );
  }

  const ExchangeClass = (ccxt as unknown as Record<string, new () => Exchange>)[exchangeId];
  const client = new ExchangeClass();

  let orderBook: OrderBook;
  try {
    orderBook = await client.fetchOrderBook(symbol, depth);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Order book unavailable for ${symbol} on ${exchangeId}: ${message}`);
  }

  const bids: OrderBookLevel[] = (orderBook.bids as [number, number][]).map(
    ([price, size]) => ({ price, size }),
  );
  const asks: OrderBookLevel[] = (orderBook.asks as [number, number][]).map(
    ([price, size]) => ({ price, size }),
  );

  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 0;

  if (bestBid === 0 || bestAsk === 0) {
    throw new Error(
      `Order book for ${symbol} on ${exchangeId} returned empty bid or ask side.`,
    );
  }

  const midPrice = (bestBid + bestAsk) / 2;
  const currentSpread = ((bestAsk - bestBid) / midPrice) * 100;
  const CLUSTER_BAND = 0.001; // 0.1%
  const IMBALANCE_WINDOW = 0.02; // 2%

  // Detect liquidity walls on each side
  const bidWalls = detectWalls(bids, midPrice, CLUSTER_BAND);
  const askWalls = detectWalls(asks, midPrice, CLUSTER_BAND);

  // Imbalance ratio: total bid volume / total ask volume within 2% of mid
  const bidVolume = bids
    .filter((l) => Math.abs((l.price - midPrice) / midPrice) <= IMBALANCE_WINDOW)
    .reduce((sum, l) => sum + l.size, 0);

  const askVolume = asks
    .filter((l) => Math.abs((l.price - midPrice) / midPrice) <= IMBALANCE_WINDOW)
    .reduce((sum, l) => sum + l.size, 0);

  const imbalanceRatio = askVolume === 0 ? 0 : bidVolume / askVolume;

  let dominantSide: 'BID' | 'ASK' | 'NEUTRAL';
  if (imbalanceRatio > 1.5) {
    dominantSide = 'BID';
  } else if (imbalanceRatio < 0.67) {
    dominantSide = 'ASK';
  } else {
    dominantSide = 'NEUTRAL';
  }

  return {
    bidWalls,
    askWalls,
    imbalanceRatio,
    dominantSide,
    currentSpread,
  };
}
