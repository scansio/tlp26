/**
 * GET /api/cron/expire-signals
 *
 * Marks pending or approved signals as 'expired' when:
 *   (a) expiresAt is set and is in the past, OR
 *   (b) createdAt is more than 1 hour ago and status is still pending/approved
 *
 * 'approved' signals may have a real limit order resting on the exchange
 * (see src/lib/entry-fill.ts) — that order is cancelled first so it can't
 * fill after the signal has already expired.
 *
 * Authentication: Bearer token via CRON_SECRET environment variable.
 * The middleware excludes /api/cron/* from Clerk auth.
 *
 * Recommended schedule: every 5 minutes
 * Example: { "path": "/api/cron/expire-signals", "schedule": "every 5 minutes" }
 */

import { NextResponse } from 'next/server';
import { sql, and, inArray, or, lt, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { tradeSignals } from '@/db/schema';
import { type MarketType } from '@/mastra/tools/market-symbol';
import { buildExchangeClient, cancelEntryOrder } from '@/lib/entry-fill';

export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: 'CRON_SECRET is not configured on this server' },
      { status: 500 },
    );
  }

  const authHeader = req.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (token !== cronSecret) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const now = new Date();
  // 1 hour ago
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1_000);

  // Find candidates first (rather than a single UPDATE) so a resting live
  // order can be cancelled on the exchange before the DB row flips to expired.
  const candidates = await db
    .select({
      id: tradeSignals.id,
      userId: tradeSignals.userId,
      symbol: tradeSignals.symbol,
      marketType: tradeSignals.marketType,
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

  for (const signal of candidates) {
    if (!signal.entryOrderId) continue;
    const rawPayload = signal.rawPayload as Record<string, unknown> | null;
    const exchangeName = (rawPayload?.exchange as string | undefined) ?? 'binance';
    try {
      const client = await buildExchangeClient(signal.userId, exchangeName);
      if (client) {
        await cancelEntryOrder(client, signal.symbol, (signal.marketType as MarketType) ?? 'spot', signal.entryOrderId);
      }
    } catch (err) {
      console.error(`[cron/expire-signals] Failed to cancel resting order for signal ${signal.id}:`, err);
    }
  }

  const ids = candidates.map((c) => c.id);
  const updated = ids.length
    ? await db
        .update(tradeSignals)
        .set({ status: 'expired', updatedAt: now, entryOrderId: null })
        .where(inArray(tradeSignals.id, ids))
        .returning({ id: tradeSignals.id })
    : [];

  return NextResponse.json({
    ok: true,
    expired: updated.length,
    expiredIds: updated.map((r) => r.id),
  });
}
