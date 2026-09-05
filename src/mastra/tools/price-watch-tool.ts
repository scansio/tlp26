import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import ccxt, { type Exchange } from 'ccxt';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { priceWatches } from '@/db/schema';
import { applyPublicDataMirror } from './exchange-public-client';
import { toExchangeSymbol, type MarketType } from './market-symbol';

const SUPPORTED_EXCHANGES = ['binance', 'bingx', 'bybit'] as const;
type SupportedExchange = (typeof SUPPORTED_EXCHANGES)[number];

async function fetchLastPrice(
  symbol: string,
  exchangeId: SupportedExchange,
  marketType: MarketType,
): Promise<number> {
  const ExchangeClass = ccxt[exchangeId as keyof typeof ccxt] as new (config?: object) => Exchange;
  if (!ExchangeClass) {
    throw new Error(`Exchange '${exchangeId}' is not supported by CCXT.`);
  }
  const client = new ExchangeClass({ enableRateLimit: true });
  applyPublicDataMirror(client, exchangeId, marketType);
  const exchangeSymbol = toExchangeSymbol(symbol, marketType);
  await client.loadMarkets();
  if (!client.markets[exchangeSymbol]) {
    throw new Error(
      `Symbol '${symbol}' not found on ${exchangeId} (${marketType} market). Check the trading pair format (e.g. BTC/USDT).`,
    );
  }
  const ticker = await client.fetchTicker(exchangeSymbol);
  const price = ticker.last ?? ticker.close;
  if (typeof price !== 'number') {
    throw new Error(`Could not read a last price for ${symbol} on ${exchangeId}.`);
  }
  return price;
}

// ---------------------------------------------------------------------------
// create-price-watch-tool
// ---------------------------------------------------------------------------

export const createPriceWatchTool = createTool({
  id: 'create-price-watch-tool',
  description:
    'Watch a symbol for price crossing a target level, then notify the user (Telegram/Discord) and show it ' +
    'in their in-app Price Watches list. If the user explicitly asked to also take a trade when the level ' +
    'hits (e.g. "buy when it retests X"), set actionType=trade and supply tradeDirection/sl/tp — these must ' +
    'come from real tool data (indicators/smc/risk-tool), never invented. In manual trading mode this creates ' +
    'a pending signal for approval, not an immediate order — tell the user that explicitly. Direction ' +
    '(above/below the target) is derived server-side from the live price, not from the LLM.',
  inputSchema: z.object({
    userId: z.string().describe('Clerk user ID — read from the system context message, do not invent'),
    symbol: z.string().describe('Trading pair, e.g. BTC/USDT'),
    exchange: z.enum(SUPPORTED_EXCHANGES).default('binance'),
    marketType: z
      .enum(['spot', 'swap'])
      .default('spot')
      .describe("'swap' = USDT-M perpetual futures — use the context's Market Type default unless the user says otherwise."),
    targetPrice: z.number().positive().describe('Price level to watch for'),
    note: z.string().optional().describe("Short human-readable label, e.g. 'BTC support retest'"),
    actionType: z.enum(['notify', 'trade']).default('notify'),
    tradeDirection: z.enum(['LONG', 'SHORT']).optional().describe('Required if actionType=trade'),
    leverage: z.number().int().positive().optional().describe('Leverage for the trade action if marketType=swap'),
    marginMode: z.enum(['cross', 'isolated']).optional(),
    sl: z.number().positive().optional().describe('Stop-loss — required if actionType=trade, from real tool data'),
    tp: z.number().positive().optional().describe('Take-profit — required if actionType=trade, from real tool data'),
    confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
    reasoning: z.string().optional(),
    strategySource: z.string().optional(),
    timeframe: z.string().optional(),
  }),
  outputSchema: z.object({
    watchId: z.string(),
    symbol: z.string(),
    targetPrice: z.number(),
    direction: z.enum(['above', 'below']),
    currentPrice: z.number(),
    actionType: z.enum(['notify', 'trade']),
    message: z.string(),
  }),
  execute: async (inputData) => {
    const {
      userId, symbol, exchange, marketType, targetPrice, note, actionType,
      tradeDirection, leverage, marginMode, sl, tp, confidence, reasoning, strategySource, timeframe,
    } = inputData as {
      userId: string;
      symbol: string;
      exchange: SupportedExchange;
      marketType: MarketType;
      targetPrice: number;
      note?: string;
      actionType: 'notify' | 'trade';
      tradeDirection?: 'LONG' | 'SHORT';
      leverage?: number;
      marginMode?: 'cross' | 'isolated';
      sl?: number;
      tp?: number;
      confidence?: 'LOW' | 'MEDIUM' | 'HIGH';
      reasoning?: string;
      strategySource?: string;
      timeframe?: string;
    };

    if (actionType === 'trade' && (!tradeDirection || !sl || !tp)) {
      throw new Error('actionType=trade requires tradeDirection, sl, and tp.');
    }

    const currentPrice = await fetchLastPrice(symbol, exchange ?? 'binance', marketType ?? 'spot');
    const direction: 'above' | 'below' = targetPrice >= currentPrice ? 'above' : 'below';

    const [watch] = await db
      .insert(priceWatches)
      .values({
        userId,
        symbol,
        exchange: exchange ?? 'binance',
        marketType: marketType ?? 'spot',
        targetPrice: String(targetPrice),
        direction,
        note: note ?? null,
        actionType,
        tradeDirection: tradeDirection ?? null,
        leverage: leverage ?? 1,
        marginMode: marginMode ?? 'cross',
        stopLoss: sl != null ? String(sl) : null,
        takeProfit: tp != null ? String(tp) : null,
        confidence: confidence ?? null,
        reasoning: reasoning ?? null,
        strategySource: strategySource ?? null,
        timeframe: timeframe ?? null,
      })
      .returning({ id: priceWatches.id });

    return {
      watchId: watch.id,
      symbol,
      targetPrice,
      direction,
      currentPrice,
      actionType,
      message:
        `Watching ${symbol} for price to go ${direction} ${targetPrice} (currently ${currentPrice}). ` +
        (actionType === 'trade'
          ? `Will create a ${tradeDirection} signal when hit.`
          : `You'll be notified when hit.`),
    };
  },
});

// ---------------------------------------------------------------------------
// list-price-watches-tool
// ---------------------------------------------------------------------------

export const listPriceWatchesTool = createTool({
  id: 'list-price-watches-tool',
  description: "List the user's price watches (active and/or recently triggered/cancelled).",
  inputSchema: z.object({
    userId: z.string().describe('Clerk user ID — read from the system context message'),
    status: z.enum(['active', 'triggered', 'cancelled', 'all']).default('active'),
  }),
  outputSchema: z.object({
    watches: z.array(
      z.object({
        id: z.string(),
        symbol: z.string(),
        exchange: z.string(),
        marketType: z.string(),
        targetPrice: z.number(),
        direction: z.string(),
        note: z.string().nullable(),
        actionType: z.string(),
        status: z.string(),
        triggeredPrice: z.number().nullable(),
        createdAt: z.string().nullable(),
      }),
    ),
  }),
  execute: async (inputData) => {
    const { userId, status } = inputData as { userId: string; status: 'active' | 'triggered' | 'cancelled' | 'all' };

    const rows = await db
      .select()
      .from(priceWatches)
      .where(
        status === 'all'
          ? eq(priceWatches.userId, userId)
          : and(eq(priceWatches.userId, userId), eq(priceWatches.status, status)),
      )
      .orderBy(priceWatches.createdAt);

    return {
      watches: rows.map((w) => ({
        id: w.id,
        symbol: w.symbol,
        exchange: w.exchange,
        marketType: w.marketType,
        targetPrice: Number(w.targetPrice),
        direction: w.direction,
        note: w.note,
        actionType: w.actionType,
        status: w.status,
        triggeredPrice: w.triggeredPrice != null ? Number(w.triggeredPrice) : null,
        createdAt: w.createdAt ? w.createdAt.toISOString() : null,
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// cancel-price-watch-tool
// ---------------------------------------------------------------------------

export const cancelPriceWatchTool = createTool({
  id: 'cancel-price-watch-tool',
  description: "Cancel one of the user's active price watches by its watchId (from list-price-watches-tool).",
  inputSchema: z.object({
    userId: z.string().describe('Clerk user ID — read from the system context message'),
    watchId: z.string(),
  }),
  outputSchema: z.object({
    cancelled: z.boolean(),
    message: z.string(),
  }),
  execute: async (inputData) => {
    const { userId, watchId } = inputData as { userId: string; watchId: string };

    const result = await db
      .update(priceWatches)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(priceWatches.id, watchId),
          eq(priceWatches.userId, userId),
          eq(priceWatches.status, 'active'),
        ),
      )
      .returning({ id: priceWatches.id });

    if (result.length === 0) {
      return { cancelled: false, message: 'No active watch found with that ID.' };
    }
    return { cancelled: true, message: 'Watch cancelled.' };
  },
});
