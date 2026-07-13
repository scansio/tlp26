import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { signalPublishers } from '@/db/schema';

// ---------------------------------------------------------------------------
// GET /api/copy/publishers — list all public publishers
// ---------------------------------------------------------------------------
export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const publishers = await db
    .select({
      id: signalPublishers.id,
      userId: signalPublishers.userId,
      displayName: signalPublishers.displayName,
      strategyDescription: signalPublishers.strategyDescription,
      totalSignals: signalPublishers.totalSignals,
      winRate: signalPublishers.winRate,
      sharpeRatio: signalPublishers.sharpeRatio,
      avgRR: signalPublishers.avgRR,
      feePercent: signalPublishers.feePercent,
      subscriberCount: signalPublishers.subscriberCount,
      createdAt: signalPublishers.createdAt,
    })
    .from(signalPublishers)
    .where(eq(signalPublishers.isPublic, true));

  return NextResponse.json({ publishers });
}
