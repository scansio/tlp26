import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { signalPublishers } from '@/db/schema';

// ---------------------------------------------------------------------------
// GET /api/copy/publishers/[publisherId] — public publisher profile endpoint
// No auth required — returns public-safe fields only.
// ---------------------------------------------------------------------------
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ publisherId: string }> },
) {
  const { publisherId } = await params;

  if (!publisherId) {
    return NextResponse.json({ error: 'publisherId is required' }, { status: 400 });
  }

  const rows = await db
    .select()
    .from(signalPublishers)
    .where(eq(signalPublishers.id, publisherId))
    .limit(1);

  if (rows.length === 0) {
    return NextResponse.json({ error: 'Publisher not found' }, { status: 404 });
  }

  const p = rows[0];

  // Return public-safe fields — no userId, no internal identifiers
  return NextResponse.json({
    id: p.id,
    displayName: p.displayName,
    strategyDescription: p.strategyDescription,
    isPublic: p.isPublic,
    isActive: p.isActive,
    shareIndividualTrades: p.shareIndividualTrades,
    stats: {
      totalSignals: p.totalSignals,
      winRate: p.winRate,
      avgRR: p.avgRR,
      sharpeRatio: p.sharpeRatio,
      maxDrawdown: p.maxDrawdown,
      subscriberCount: p.subscriberCount,
    },
    createdAt: p.createdAt,
  });
}
