/**
 * Marks pending or approved signals as 'expired' when:
 *   (a) expiresAt is set and is in the past, OR
 *   (b) createdAt is more than 1 hour ago and status is still pending/approved
 *
 * 'approved' signals may have a real limit order resting on the exchange
 * (see src/lib/entry-fill.ts). Before cancelling that order and expiring the
 * signal, its true status on the exchange is checked first via
 * reconcile-entries.ts's reconcileLiveSignal — a resting order can fill in
 * the gap between the reconcile loop's last tick and this one, and
 * cancelling+expiring on top of an already-filled order would silently
 * orphan a real live position (no trade_execution, no SL, no monitoring).
 * A signal reconcileLiveSignal reports as already filled or already
 * cancelled/rejected on the exchange is left alone here — it's already
 * terminal. One whose true status couldn't be confirmed ('skipped': no
 * credentials, or the exchange check itself errored) is also left alone
 * rather than assumed safe to expire; it's retried next tick.
 *
 * Shared by /api/cron/expire-signals (external scheduler) and
 * src/worker/signal-expiry-loop.ts (in-process worker driver) so the
 * behavior is identical regardless of which one actually fires in a given
 * deployment.
 */

import { sql, and, inArray, or, lt, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { tradeSignals } from '@/db/schema';
import { type MarketType } from '@/mastra/tools/market-symbol';
import { buildExchangeClient, cancelEntryOrder } from '@/lib/entry-fill';
import { reconcileLiveSignal, type ExchangeName } from '@/lib/reconcile-entries';

export async function expireStaleSignals(): Promise<{ expired: number; expiredIds: string[] }> {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1_000);

  // Find candidates first (rather than a single UPDATE) so a resting live
  // order can be checked/cancelled on the exchange before the DB row flips
  // to expired.
  const candidates = await db
    .select({
      id: tradeSignals.id,
      userId: tradeSignals.userId,
      symbol: tradeSignals.symbol,
      direction: tradeSignals.direction,
      stopLoss: tradeSignals.stopLoss,
      takeProfit: tradeSignals.takeProfit,
      marketType: tradeSignals.marketType,
      leverage: tradeSignals.leverage,
      marginMode: tradeSignals.marginMode,
      entryOrderId: tradeSignals.entryOrderId,
      rawPayload: tradeSignals.rawPayload,
    })
    .from(tradeSignals)
    .where(
      and(
        inArray(tradeSignals.status, ['pending', 'approved']),
        or(
          // explicit expiry date set and elapsed
          and(
            sql`${tradeSignals.expiresAt} IS NOT NULL`,
            lt(tradeSignals.expiresAt, now),
          ),
          // no explicit expiry — use 1-hour default
          and(
            isNull(tradeSignals.expiresAt),
            lt(tradeSignals.createdAt, oneHourAgo),
          ),
        ),
      ),
    );

  const idsToExpire: string[] = [];

  for (const signal of candidates) {
    if (!signal.entryOrderId) {
      // No real order was ever placed (pending, or a paper approval) —
      // nothing to confirm on an exchange, safe to expire directly.
      idsToExpire.push(signal.id);
      continue;
    }

    const rawPayload = signal.rawPayload as Record<string, unknown> | null;
    const exchangeName = ((rawPayload?.exchange as string | undefined) ?? 'binance') as ExchangeName;

    let status;
    try {
      status = await reconcileLiveSignal(signal, exchangeName);
    } catch (err) {
      console.error(`[expire-signals] Fill-status check failed for signal ${signal.id}, leaving for next cycle:`, err);
      continue;
    }

    if (status.outcome === 'filled' || status.outcome === 'cancelled') {
      // Already terminal (executed or cancelled by reconcileLiveSignal
      // itself) — nothing left to expire.
      continue;
    }
    if (status.outcome === 'skipped') {
      // True fill status unknown — do NOT expire on a guess. Retried next cycle.
      console.warn(
        `[expire-signals] Could not confirm fill status for signal ${signal.id} (${status.reason ?? 'unknown reason'}) — leaving 'approved' for next cycle instead of expiring.`,
      );
      continue;
    }

    // Confirmed still resting on the exchange — safe to cancel and expire.
    try {
      const client = await buildExchangeClient(signal.userId, exchangeName);
      if (client) {
        await cancelEntryOrder(client, signal.symbol, (signal.marketType as MarketType) ?? 'spot', signal.entryOrderId);
      }
    } catch (err) {
      console.error(`[expire-signals] Failed to cancel resting order for signal ${signal.id}:`, err);
    }
    idsToExpire.push(signal.id);
  }

  const updated = idsToExpire.length
    ? await db
        .update(tradeSignals)
        .set({ status: 'expired', updatedAt: now, entryOrderId: null })
        .where(inArray(tradeSignals.id, idsToExpire))
        .returning({ id: tradeSignals.id })
    : [];

  return { expired: updated.length, expiredIds: updated.map((r) => r.id) };
}
