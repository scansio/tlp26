/**
 * PATCH /api/trade-signals/[id]
 *
 * Approve or reject a pending trade signal.
 *
 * Body: { action: 'approve' | 'reject' }
 *
 * - approve → sets status = 'approved', triggers paper/live execution
 * - reject  → sets status = 'cancelled'
 *
 * Only the owning user may act on their own signals.
 * Only signals with status = 'pending' can be approved or rejected.
 */

import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db } from '@/db';
import { tradeSignals, userRiskProfiles, userExchanges } from '@/db/schema';

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (
    typeof body !== 'object' ||
    body === null ||
    !('action' in body) ||
    (body as Record<string, unknown>).action !== 'approve' &&
    (body as Record<string, unknown>).action !== 'reject'
  ) {
    return NextResponse.json(
      { error: 'action must be "approve" or "reject"' },
      { status: 400 },
    );
  }

  const action = (body as { action: 'approve' | 'reject' }).action;

  // Load the signal — must belong to this user and be pending
  const [signal] = await db
    .select()
    .from(tradeSignals)
    .where(and(eq(tradeSignals.id, id), eq(tradeSignals.userId, userId)))
    .limit(1);

  if (!signal) {
    return NextResponse.json({ error: 'Signal not found' }, { status: 404 });
  }

  if (signal.status !== 'pending') {
    return NextResponse.json(
      { error: `Signal is already ${signal.status}` },
      { status: 409 },
    );
  }

  if (action === 'reject') {
    const [updated] = await db
      .update(tradeSignals)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(tradeSignals.id, id))
      .returning({ id: tradeSignals.id, status: tradeSignals.status });

    return NextResponse.json({ signal: updated });
  }

  // --- action === 'approve' ---

  // Fetch user's risk profile to determine paper vs live
  const [profile] = await db
    .select({
      executionMode: userRiskProfiles.executionMode, // paper | live
      tradingMode: userRiskProfiles.tradingMode,     // manual | auto
    })
    .from(userRiskProfiles)
    .where(eq(userRiskProfiles.userId, userId))
    .limit(1);

  const isPaper = !profile || profile.executionMode !== 'live';

  if (!isPaper) {
    // Live mode: verify a connected exchange exists
    const [exchange] = await db
      .select({ id: userExchanges.id, exchangeName: userExchanges.exchangeName })
      .from(userExchanges)
      .where(and(eq(userExchanges.userId, userId), eq(userExchanges.status, 'active')))
      .limit(1);

    if (!exchange) {
      return NextResponse.json(
        { error: 'No active exchange connected. Add an exchange in Settings.' },
        { status: 422 },
      );
    }
  }

  // Mark approved — execution is handled by the workflow / position monitor
  const [updated] = await db
    .update(tradeSignals)
    .set({ status: 'approved', updatedAt: new Date() })
    .where(eq(tradeSignals.id, id))
    .returning({
      id: tradeSignals.id,
      status: tradeSignals.status,
      symbol: tradeSignals.symbol,
      direction: tradeSignals.direction,
    });

  return NextResponse.json({
    signal: updated,
    mode: isPaper ? 'paper' : 'live',
    message: isPaper
      ? 'Signal approved — paper trade queued.'
      : 'Signal approved — live order will be placed.',
  });
}
