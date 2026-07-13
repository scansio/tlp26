import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { eq, and, count } from 'drizzle-orm';
import { db } from '@/db';
import { signalPublishers, tradeExecutions, signalSubscriptions } from '@/db/schema';

// ---------------------------------------------------------------------------
// Minimum closed trades required before publishing
// ---------------------------------------------------------------------------
const MIN_CLOSED_TRADES = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Count the number of closed trade executions for a user.
 * Paper-mode trades are included — the requirement is about track record volume.
 */
async function countClosedTrades(userId: string): Promise<number> {
  const rows = await db
    .select({ c: count() })
    .from(tradeExecutions)
    .where(and(eq(tradeExecutions.userId, userId), eq(tradeExecutions.status, 'closed')));
  return Number(rows[0]?.c ?? 0);
}

/**
 * Check whether a user is currently subscribed to any publisher (active copy-trade subscription).
 * A subscriber cannot become a publisher — prevents circular copy chains.
 */
async function isActiveSubscriber(userId: string): Promise<boolean> {
  const rows = await db
    .select({ c: count() })
    .from(signalSubscriptions)
    .where(and(eq(signalSubscriptions.subscriberId, userId), eq(signalSubscriptions.isActive, true)));
  return Number(rows[0]?.c ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// GET /api/copy/publisher — fetch the authenticated user's publisher profile
// ---------------------------------------------------------------------------
export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const rows = await db
    .select()
    .from(signalPublishers)
    .where(eq(signalPublishers.userId, userId))
    .limit(1);

  if (rows.length === 0) {
    return NextResponse.json(null);
  }

  const p = rows[0];
  return NextResponse.json({
    id: p.id,
    displayName: p.displayName,
    strategyDescription: p.strategyDescription,
    isPublic: p.isPublic,
    isActive: p.isActive,
    shareIndividualTrades: p.shareIndividualTrades,
    feePercent: p.feePercent,
    stats: {
      totalSignals: p.totalSignals,
      winRate: p.winRate,
      avgRR: p.avgRR,
      sharpeRatio: p.sharpeRatio,
      maxDrawdown: p.maxDrawdown,
      subscriberCount: p.subscriberCount,
    },
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  });
}

// ---------------------------------------------------------------------------
// POST /api/copy/publisher — create a publisher profile
// ---------------------------------------------------------------------------
export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  // Check track record gate
  const closedTrades = await countClosedTrades(userId);
  if (closedTrades < MIN_CLOSED_TRADES) {
    return NextResponse.json(
      {
        error: `Minimum track record required: ${MIN_CLOSED_TRADES} closed trades. You have ${closedTrades}.`,
        closedTrades,
        required: MIN_CLOSED_TRADES,
      },
      { status: 403 },
    );
  }

  // Publisher cannot also be a copy-trade subscriber (no circular chains)
  if (await isActiveSubscriber(userId)) {
    return NextResponse.json(
      {
        error:
          'Publishers cannot be active copy-trade subscribers. Cancel your subscriptions before publishing.',
      },
      { status: 403 },
    );
  }

  // Check if profile already exists
  const existing = await db
    .select({ id: signalPublishers.id })
    .from(signalPublishers)
    .where(eq(signalPublishers.userId, userId))
    .limit(1);

  if (existing.length > 0) {
    return NextResponse.json(
      { error: 'Publisher profile already exists. Use PATCH to update it.' },
      { status: 409 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { displayName, strategyDescription, isPublic, shareIndividualTrades } = body as {
    displayName?: unknown;
    strategyDescription?: unknown;
    isPublic?: unknown;
    shareIndividualTrades?: unknown;
  };

  if (!displayName || typeof displayName !== 'string' || displayName.trim() === '') {
    return NextResponse.json({ error: 'displayName is required' }, { status: 400 });
  }
  if (displayName.trim().length > 100) {
    return NextResponse.json({ error: 'displayName must be 100 characters or fewer' }, { status: 400 });
  }

  const [row] = await db
    .insert(signalPublishers)
    .values({
      userId,
      displayName: displayName.trim(),
      strategyDescription:
        typeof strategyDescription === 'string' ? strategyDescription.trim() || null : null,
      isPublic: typeof isPublic === 'boolean' ? isPublic : false,
      isActive: true,
      shareIndividualTrades:
        typeof shareIndividualTrades === 'boolean' ? shareIndividualTrades : false,
    })
    .returning();

  return NextResponse.json(
    {
      id: row.id,
      displayName: row.displayName,
      strategyDescription: row.strategyDescription,
      isPublic: row.isPublic,
      isActive: row.isActive,
      shareIndividualTrades: row.shareIndividualTrades,
      feePercent: row.feePercent,
      stats: {
        totalSignals: row.totalSignals,
        winRate: row.winRate,
        avgRR: row.avgRR,
        sharpeRatio: row.sharpeRatio,
        maxDrawdown: row.maxDrawdown,
        subscriberCount: row.subscriberCount,
      },
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    { status: 201 },
  );
}

// ---------------------------------------------------------------------------
// PATCH /api/copy/publisher — update publisher profile or deactivate
// ---------------------------------------------------------------------------
export async function PATCH(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const rows = await db
    .select()
    .from(signalPublishers)
    .where(eq(signalPublishers.userId, userId))
    .limit(1);

  if (rows.length === 0) {
    return NextResponse.json({ error: 'Publisher profile not found' }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const updates: Partial<{
    displayName: string;
    strategyDescription: string | null;
    isPublic: boolean;
    isActive: boolean;
    shareIndividualTrades: boolean;
    feePercent: string;
    updatedAt: Date;
  }> = { updatedAt: new Date() };

  const {
    displayName,
    strategyDescription,
    isPublic,
    isActive,
    shareIndividualTrades,
    feePercent,
  } = body as Record<string, unknown>;

  if (displayName !== undefined) {
    if (typeof displayName !== 'string' || displayName.trim() === '') {
      return NextResponse.json({ error: 'displayName must be a non-empty string' }, { status: 400 });
    }
    if (displayName.trim().length > 100) {
      return NextResponse.json({ error: 'displayName must be 100 characters or fewer' }, { status: 400 });
    }
    updates.displayName = displayName.trim();
  }

  if (strategyDescription !== undefined) {
    updates.strategyDescription =
      typeof strategyDescription === 'string' ? strategyDescription.trim() || null : null;
  }

  if (typeof isPublic === 'boolean') {
    updates.isPublic = isPublic;
  }

  if (typeof isActive === 'boolean') {
    updates.isActive = isActive;
  }

  if (typeof shareIndividualTrades === 'boolean') {
    updates.shareIndividualTrades = shareIndividualTrades;
  }

  if (feePercent !== undefined) {
    const fee = Number(feePercent);
    if (isNaN(fee) || fee < 0 || fee > 50) {
      return NextResponse.json({ error: 'feePercent must be between 0 and 50' }, { status: 400 });
    }
    updates.feePercent = fee.toFixed(2);
  }

  const [updated] = await db
    .update(signalPublishers)
    .set(updates)
    .where(eq(signalPublishers.userId, userId))
    .returning();

  return NextResponse.json({
    id: updated.id,
    displayName: updated.displayName,
    strategyDescription: updated.strategyDescription,
    isPublic: updated.isPublic,
    isActive: updated.isActive,
    shareIndividualTrades: updated.shareIndividualTrades,
    feePercent: updated.feePercent,
    stats: {
      totalSignals: updated.totalSignals,
      winRate: updated.winRate,
      avgRR: updated.avgRR,
      sharpeRatio: updated.sharpeRatio,
      maxDrawdown: updated.maxDrawdown,
      subscriberCount: updated.subscriberCount,
    },
    createdAt: updated.createdAt,
    updatedAt: updated.updatedAt,
  });
}
