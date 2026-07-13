/**
 * GET /api/cron/expire-signals
 *
 * Marks pending signals as 'expired' when:
 *   (a) expiresAt is set and is in the past, OR
 *   (b) createdAt is more than 1 hour ago and status is still 'pending'
 *
 * Authentication: Bearer token via CRON_SECRET environment variable.
 * The middleware excludes /api/cron/* from Clerk auth.
 *
 * Recommended schedule: every 5 minutes
 * Example: { "path": "/api/cron/expire-signals", "schedule": "every 5 minutes" }
 */

import { NextResponse } from 'next/server';
import { sql, and, eq, or, lt, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { tradeSignals } from '@/db/schema';

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

  // Expire signals where:
  // - status = 'pending' AND
  // - (expiresAt <= now) OR (expiresAt IS NULL AND createdAt <= oneHourAgo)
  const updated = await db
    .update(tradeSignals)
    .set({ status: 'expired', updatedAt: now })
    .where(
      and(
        eq(tradeSignals.status, 'pending'),
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
    )
    .returning({ id: tradeSignals.id });

  return NextResponse.json({
    ok: true,
    expired: updated.length,
    expiredIds: updated.map((r) => r.id),
  });
}
