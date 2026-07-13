import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  signalSubscriptions,
  signalPublishers,
  userRiskProfiles,
  tradeExecutions,
} from '@/db/schema';

// ---------------------------------------------------------------------------
// Validation schema for creating a subscription
// ---------------------------------------------------------------------------
const createSubscriptionSchema = z.object({
  publisherId: z.string().uuid('publisherId must be a valid UUID'),
  copyRatioPct: z.number().int().min(1).max(100).default(100),
  executionMode: z.enum(['auto-copy', 'review-copy']).default('review-copy'),
  maxPositionSizeCap: z.number().positive().optional().nullable(),
});

const MAX_SUBSCRIPTIONS = 10;

// ---------------------------------------------------------------------------
// Helper — check circuit breaker (daily loss limit)
// ---------------------------------------------------------------------------
async function isDailyLossLimitHit(userId: string): Promise<boolean> {
  const [profile] = await db
    .select({
      maxDailyLossPct: userRiskProfiles.maxDailyLossPct,
    })
    .from(userRiskProfiles)
    .where(eq(userRiskProfiles.userId, userId))
    .limit(1);

  if (!profile || profile.maxDailyLossPct == null) return false;

  const maxLossPct = Number(profile.maxDailyLossPct);

  // Sum realized P&L for today's closed trades (negative = loss)
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const rows = await db
    .select({
      totalPnl: sql<string>`COALESCE(SUM(${tradeExecutions.realizedPnl}), 0)`,
    })
    .from(tradeExecutions)
    .where(
      and(
        eq(tradeExecutions.userId, userId),
        eq(tradeExecutions.status, 'closed'),
        sql`${tradeExecutions.exitAt} >= ${today.toISOString()}`,
      ),
    );

  const totalPnl = Number(rows[0]?.totalPnl ?? 0);
  // For simplicity: if total daily P&L is negative and its absolute value exceeds
  // maxDailyLossPct% of a notional $10,000 account — circuit breaker trips.
  // In production this would be account-equity-aware.
  if (totalPnl < 0 && Math.abs(totalPnl) / 10_000 * 100 >= maxLossPct) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// POST /api/copy/subscriptions — subscribe to a publisher
// ---------------------------------------------------------------------------
export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = createSubscriptionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const { publisherId, copyRatioPct, executionMode, maxPositionSizeCap } = parsed.data;

  // --- Fetch publisher record ---
  const [publisher] = await db
    .select()
    .from(signalPublishers)
    .where(eq(signalPublishers.id, publisherId))
    .limit(1);

  if (!publisher) {
    return NextResponse.json({ error: 'Publisher not found' }, { status: 404 });
  }

  // --- Self-subscription guard ---
  if (publisher.userId === userId) {
    return NextResponse.json(
      { error: 'You cannot subscribe to your own publisher profile' },
      { status: 400 },
    );
  }

  // --- Publisher must be public ---
  if (!publisher.isPublic) {
    return NextResponse.json({ error: 'Publisher is not public' }, { status: 400 });
  }

  // --- Max 10 subscriptions per user ---
  const [countRow] = await db
    .select({ count: sql<string>`COUNT(*)` })
    .from(signalSubscriptions)
    .where(
      and(
        eq(signalSubscriptions.subscriberId, userId),
        eq(signalSubscriptions.isActive, true),
      ),
    );

  const activeCount = Number(countRow?.count ?? 0);
  if (activeCount >= MAX_SUBSCRIPTIONS) {
    return NextResponse.json(
      {
        error: `Maximum of ${MAX_SUBSCRIPTIONS} active subscriptions allowed. Unsubscribe from one before adding another.`,
      },
      { status: 400 },
    );
  }

  // --- Check for existing active subscription to this publisher ---
  const [existing] = await db
    .select({ id: signalSubscriptions.id })
    .from(signalSubscriptions)
    .where(
      and(
        eq(signalSubscriptions.subscriberId, userId),
        eq(signalSubscriptions.publisherId, publisherId),
        eq(signalSubscriptions.isActive, true),
      ),
    )
    .limit(1);

  if (existing) {
    return NextResponse.json(
      { error: 'You are already subscribed to this publisher' },
      { status: 400 },
    );
  }

  // --- Insert subscription ---
  const [subscription] = await db
    .insert(signalSubscriptions)
    .values({
      subscriberId: userId,
      publisherId,
      copyRatioPct,
      executionMode,
      maxPositionSizeCap: maxPositionSizeCap != null ? String(maxPositionSizeCap) : null,
      isActive: true,
      updatedAt: new Date(),
    })
    .returning();

  // Increment subscriber count on publisher
  await db
    .update(signalPublishers)
    .set({ subscriberCount: sql`${signalPublishers.subscriberCount} + 1` })
    .where(eq(signalPublishers.id, publisherId));

  return NextResponse.json(
    {
      id: subscription.id,
      publisherId: subscription.publisherId,
      publisherName: publisher.displayName,
      copyRatioPct: subscription.copyRatioPct,
      executionMode: subscription.executionMode,
      maxPositionSizeCap: subscription.maxPositionSizeCap,
      isActive: subscription.isActive,
      createdAt: subscription.createdAt,
      message: `Successfully subscribed to ${publisher.displayName ?? 'publisher'}`,
    },
    { status: 201 },
  );
}

// ---------------------------------------------------------------------------
// GET /api/copy/subscriptions — list the authenticated user's subscriptions
// ---------------------------------------------------------------------------
export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rows = await db
    .select({
      id: signalSubscriptions.id,
      publisherId: signalSubscriptions.publisherId,
      copyRatioPct: signalSubscriptions.copyRatioPct,
      executionMode: signalSubscriptions.executionMode,
      maxPositionSizeCap: signalSubscriptions.maxPositionSizeCap,
      isActive: signalSubscriptions.isActive,
      createdAt: signalSubscriptions.createdAt,
      updatedAt: signalSubscriptions.updatedAt,
      // Publisher fields
      publisherName: signalPublishers.displayName,
      publisherWinRate: signalPublishers.winRate,
      publisherTotalSignals: signalPublishers.totalSignals,
      publisherAvgRR: signalPublishers.avgRR,
      publisherSharpe: signalPublishers.sharpeRatio,
    })
    .from(signalSubscriptions)
    .innerJoin(signalPublishers, eq(signalSubscriptions.publisherId, signalPublishers.id))
    .where(eq(signalSubscriptions.subscriberId, userId));

  // Circuit breaker status
  const circuitBreakerActive = await isDailyLossLimitHit(userId);

  return NextResponse.json({
    subscriptions: rows.map((row) => ({
      id: row.id,
      publisherId: row.publisherId,
      publisherName: row.publisherName,
      copyRatioPct: row.copyRatioPct,
      executionMode: row.executionMode,
      maxPositionSizeCap: row.maxPositionSizeCap,
      isActive: row.isActive,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      stats: {
        winRate: row.publisherWinRate,
        totalSignals: row.publisherTotalSignals,
        avgRR: row.publisherAvgRR,
        sharpeRatio: row.publisherSharpe,
      },
    })),
    circuitBreakerActive,
    activeCount: rows.filter((r) => r.isActive).length,
    maxSubscriptions: MAX_SUBSCRIPTIONS,
  });
}
