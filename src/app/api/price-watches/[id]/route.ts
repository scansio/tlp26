/**
 * DELETE /api/price-watches/[id] — cancel an active price watch.
 */

import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { priceWatches } from '@/db/schema';

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const { id } = await params;

  const result = await db
    .update(priceWatches)
    .set({ status: 'cancelled' })
    .where(
      and(
        eq(priceWatches.id, id),
        eq(priceWatches.userId, userId),
        eq(priceWatches.status, 'active'),
      ),
    )
    .returning({ id: priceWatches.id });

  if (result.length === 0) {
    return NextResponse.json({ error: 'Active watch not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
