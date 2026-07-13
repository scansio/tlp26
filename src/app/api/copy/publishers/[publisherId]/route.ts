import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { signalPublishers, signalSubscriptions } from '@/db/schema';

// ---------------------------------------------------------------------------
// GET /api/copy/publishers/[publisherId]
// Returns the publisher's public profile plus the current user's subscription
// status (if any). Merges public-safe fields from TLP-31 with the
// subscription-awareness added in TLP-33.
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

  if (!publisherId) {
    return NextResponse.json({ error: 'publisherId is required' }, { status: 400 });
  }

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
    isPublic: publisher.isPublic,
    isActive: publisher.isActive,
    shareIndividualTrades: publisher.shareIndividualTrades,
    feePercent: publisher.feePercent,
    stats: {
      totalSignals: publisher.totalSignals,
      winRate: publisher.winRate,
      avgRR: publisher.avgRR,
      sharpeRatio: publisher.sharpeRatio,
      maxDrawdown: publisher.maxDrawdown,
      subscriberCount: publisher.subscriberCount,
    },
    createdAt: publisher.createdAt,
    isSelf: publisher.userId === userId,
    subscription: existingSubscription ?? null,
  });
}
