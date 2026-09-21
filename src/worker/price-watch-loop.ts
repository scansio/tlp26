/**
 * Periodic driver for user-created price watches (src/db/schema.ts: priceWatches).
 * Polls active watches, groups by (exchange, symbol) to minimize ticker fetches,
 * and fires notifications / trade actions when a target price is crossed.
 *
 * Runs independently of the position-monitor loop: watches exist for symbols
 * with no open position and for users with no exchange connected (paper-only),
 * so this cannot reuse position-monitor's per-{userId,exchangeName} singletons.
 */

import ccxt, { type Exchange } from 'ccxt';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { priceWatches } from '@/db/schema';
import { applyPublicDataMirror } from '@/mastra/tools/exchange-public-client';
import { toExchangeSymbol, type MarketType } from '@/mastra/tools/market-symbol';
import { finalizePriceWatchTrade } from '@/lib/analysis/finalize-price-watch';
import { sendNotification } from '@/lib/notifications';
import { mastra } from '@/mastra';

const DEFAULT_POLL_INTERVAL_MS = 20_000;

type PriceWatchRow = typeof priceWatches.$inferSelect;

async function fetchLastPrice(client: Exchange, symbol: string): Promise<number | null> {
  try {
    const ticker = await client.fetchTicker(symbol);
    const price = ticker.last ?? ticker.close;
    return typeof price === 'number' ? price : null;
  } catch (err) {
    console.error(`[worker] price-watch ticker fetch failed for ${symbol}`, err);
    return null;
  }
}

function isTriggered(watch: PriceWatchRow, price: number): boolean {
  const target = Number(watch.targetPrice);
  return watch.direction === 'above' ? price >= target : price <= target;
}

// Atomically claim a watch so overlapping ticks (a slow fetch outliving the
// next interval) never process the same trigger twice. Stamps triggeredPrice/
// triggeredAt in the same statement so a crash mid-trade-action still leaves
// a diagnosable row instead of a blank "triggered" one.
async function claimWatch(id: string, price: number): Promise<boolean> {
  const result = await db
    .update(priceWatches)
    .set({ status: 'triggered', triggeredPrice: String(price), triggeredAt: new Date() })
    .where(and(eq(priceWatches.id, id), eq(priceWatches.status, 'active')))
    .returning({ id: priceWatches.id });
  return result.length > 0;
}

async function handleTrigger(watch: PriceWatchRow, price: number): Promise<void> {
  const claimed = await claimWatch(watch.id, price);
  if (!claimed) return; // already handled by a concurrent tick

  let actionSummary = "You'll see this reflected in your Price Watches list.";

  if (watch.actionType === 'trade') {
    try {
      const result = await finalizePriceWatchTrade(watch, price, mastra);
      actionSummary = result.summary;
      await db
        .update(priceWatches)
        .set({ resultSignalId: result.signalId, resultMessage: result.summary })
        .where(eq(priceWatches.id, watch.id));
    } catch (err) {
      console.error(`[worker] price-watch trade action failed for watch ${watch.id}`, err);
      actionSummary = 'Trade action failed unexpectedly — check the Signals queue.';
      await db
        .update(priceWatches)
        .set({ resultMessage: actionSummary })
        .where(eq(priceWatches.id, watch.id));
    }
  }

  void sendNotification(watch.userId, {
    event: 'price_watch_triggered',
    symbol: watch.symbol,
    targetPrice: String(watch.targetPrice),
    triggeredPrice: String(price),
    actionSummary,
  });
}

async function pollOnce(): Promise<void> {
  const active = await db.select().from(priceWatches).where(eq(priceWatches.status, 'active'));
  if (active.length === 0) return;

  const groups = new Map<string, PriceWatchRow[]>();
  for (const watch of active) {
    const key = `${watch.exchange}:${watch.marketType}:${watch.symbol}`;
    const list = groups.get(key) ?? [];
    list.push(watch);
    groups.set(key, list);
  }

  await Promise.all(
    Array.from(groups.entries()).map(async ([key, watches]) => {
      const [exchangeId, marketType, symbol] = key.split(':') as [string, MarketType, string];
      try {
        const ExchangeClass = ccxt[exchangeId as keyof typeof ccxt] as new (config?: object) => Exchange;
        if (!ExchangeClass) return;
        const client = new ExchangeClass({ enableRateLimit: true });
        applyPublicDataMirror(client, exchangeId, marketType);

        const price = await fetchLastPrice(client, toExchangeSymbol(symbol, marketType));
        if (price == null) return;

        const fired = watches.filter((w) => isTriggered(w, price));
        await Promise.all(fired.map((w) => handleTrigger(w, price)));
      } catch (err) {
        console.error(`[worker] price-watch group ${key} failed`, err);
      }
    }),
  );
}

export function startPriceWatchLoop(): void {
  const intervalMs = process.env.PRICE_WATCH_POLL_INTERVAL_MS
    ? Number(process.env.PRICE_WATCH_POLL_INTERVAL_MS)
    : DEFAULT_POLL_INTERVAL_MS;

  const tick = () => {
    // The worker container may boot before the web container has run
    // migrations (each deploys/restarts independently) — never crash-loop.
    pollOnce().catch((err) => console.error('[worker] price-watch poll error', err));
  };

  tick();
  setInterval(tick, intervalMs);
  console.log(`[worker] price-watch poll loop started (every ${intervalMs}ms)`);
}
