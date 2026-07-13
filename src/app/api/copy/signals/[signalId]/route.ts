/**
 * PATCH /api/copy/signals/[signalId]
 *
 * Update the status of a publisher signal and, when the new status is
 * 'rejected' or 'cancelled', cascade-cancel all mirrored subscriber signals
 * that were created from it.
 *
 * Only the signal owner (publisher) may call this endpoint.
 */

import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { tradeSignals } from '@/db/schema';
import { cancelMirroredSignals } from '@/lib/copy-mirror-engine';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const patchSignalSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'executed', 'cancelled', 'expired']),
});

// ---------------------------------------------------------------------------
// PATCH /api/copy/signals/[signalId]
// ---------------------------------------------------------------------------

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ signalId: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { signalId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = patchSignalSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const { status } = parsed.data;

  // --- Load the signal and verify ownership ---
  const [signal] = await db
    .select({ id: tradeSignals.id, status: tradeSignals.status })
    .from(tradeSignals)
    .where(
      and(
        eq(tradeSignals.id, signalId),
        eq(tradeSignals.userId, userId),
      ),
    )
    .limit(1);

  if (!signal) {
    return NextResponse.json({ error: 'Signal not found' }, { status: 404 });
  }

  // --- Apply status update ---
  const [updated] = await db
    .update(tradeSignals)
    .set({ status, updatedAt: new Date() })
    .where(eq(tradeSignals.id, signalId))
    .returning({ id: tradeSignals.id, status: tradeSignals.status });

  // --- Cascade-cancel mirrored subscriber signals when publisher rejects/cancels ---
  if (status === 'rejected' || status === 'cancelled') {
    // Fire-and-forget — subscriber cleanup must not block the response
    void cancelMirroredSignals(signalId);
  }

  return NextResponse.json({ id: updated.id, status: updated.status });
}
