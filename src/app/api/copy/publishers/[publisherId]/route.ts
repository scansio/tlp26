import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { signalPublishers, signalSubscriptions } from '@/db/schema';

// ---------------------------------------------------------------------------
// GET /api/copy/publishers/[publisherId]
// Returns the publisher's public profile plus the current user's subscription
// status (if any).
// ---------------------------------------------------------------------------
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ publisherId: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { publisherId } = await params;

  const [publisher] = await db
    .select()
    .from(signalPublishers)
    .where(
      and(
        eq(signalPublishers.id, publisherId),
        eq(signalPublishers.isPublic, true),
      ),
    )
    .limit(1);

  if (!publisher) {
    return NextResponse.json({ error: 'Publisher not found' }, { status: 404 });
  }

  // Check if the current user is already subscribed
  const [existingSubscription] = await db
    .select({
      id: signalSubscriptions.id,
      isActive: signalSubscriptions.isActive,
      copyRatioPct: signalSubscriptions.copyRatioPct,
      executionMode: signalSubscriptions.executionMode,
    })
    .from(signalSubscriptions)
    .where(
      and(
        eq(signalSubscriptions.subscriberId, userId),
        eq(signalSubscriptions.publisherId, publisherId),
      ),
    )
    .limit(1);

  return NextResponse.json({
    id: publisher.id,
    displayName: publisher.displayName,
    strategyDescription: publisher.strategyDescription,
    totalSignals: publisher.totalSignals,
    winRate: publisher.winRate,
    sharpeRatio: publisher.sharpeRatio,
    avgRR: publisher.avgRR,
    feePercent: publisher.feePercent,
    subscriberCount: publisher.subscriberCount,
    createdAt: publisher.createdAt,
    isSelf: publisher.userId === userId,
    subscription: existingSubscription ?? null,
  });
}
