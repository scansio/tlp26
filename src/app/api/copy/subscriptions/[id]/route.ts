import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '@/db';
import { signalSubscriptions, signalPublishers } from '@/db/schema';

// ---------------------------------------------------------------------------
// PATCH /api/copy/subscriptions/[id] — pause, resume, or update a subscription
// ---------------------------------------------------------------------------
const patchSchema = z.object({
  isActive: z.boolean().optional(),
  copyRatioPct: z.number().int().min(1).max(100).optional(),
  executionMode: z.enum(['auto-copy', 'review-copy']).optional(),
  maxPositionSizeCap: z.number().positive().nullable().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  // Verify ownership
  const [subscription] = await db
    .select()
    .from(signalSubscriptions)
    .where(
      and(
        eq(signalSubscriptions.id, id),
        eq(signalSubscriptions.subscriberId, userId),
      ),
    )
    .limit(1);

  if (!subscription) {
    return NextResponse.json({ error: 'Subscription not found' }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };

  if (parsed.data.isActive !== undefined) {
    updates.isActive = parsed.data.isActive;
  }
  if (parsed.data.copyRatioPct !== undefined) {
    updates.copyRatioPct = parsed.data.copyRatioPct;
  }
  if (parsed.data.executionMode !== undefined) {
    updates.executionMode = parsed.data.executionMode;
  }
  if ('maxPositionSizeCap' in parsed.data) {
    updates.maxPositionSizeCap =
      parsed.data.maxPositionSizeCap != null
        ? String(parsed.data.maxPositionSizeCap)
        : null;
  }

  const [updated] = await db
    .update(signalSubscriptions)
    .set(updates)
    .where(eq(signalSubscriptions.id, id))
    .returning();

  return NextResponse.json({
    id: updated.id,
    publisherId: updated.publisherId,
    copyRatioPct: updated.copyRatioPct,
    executionMode: updated.executionMode,
    maxPositionSizeCap: updated.maxPositionSizeCap,
    isActive: updated.isActive,
    updatedAt: updated.updatedAt,
  });
}

// ---------------------------------------------------------------------------
// DELETE /api/copy/subscriptions/[id] — unsubscribe (hard delete + decrement count)
// ---------------------------------------------------------------------------
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  // Verify ownership before deleting
  const [subscription] = await db
    .select()
    .from(signalSubscriptions)
    .where(
      and(
        eq(signalSubscriptions.id, id),
        eq(signalSubscriptions.subscriberId, userId),
      ),
    )
    .limit(1);

  if (!subscription) {
    return NextResponse.json({ error: 'Subscription not found' }, { status: 404 });
  }

  await db.delete(signalSubscriptions).where(eq(signalSubscriptions.id, id));

  // Decrement subscriber count only if subscription was active (guard against going negative)
  if (subscription.isActive) {
    await db
      .update(signalPublishers)
      .set({
        subscriberCount: sql`GREATEST(${signalPublishers.subscriberCount} - 1, 0)`,
      })
      .where(eq(signalPublishers.id, subscription.publisherId));
  }

  return NextResponse.json({ message: 'Unsubscribed successfully' });
}
