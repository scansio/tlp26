import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { priceWatches } from '@/db/schema';

// ---------------------------------------------------------------------------
// GET /api/price-watches — list the current user's price watches
// ---------------------------------------------------------------------------
export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const rows = await db
    .select()
    .from(priceWatches)
    .where(eq(priceWatches.userId, userId))
    .orderBy(desc(priceWatches.createdAt))
    .limit(50);

  return NextResponse.json({
    watches: rows.map((w) => ({
      id: w.id,
      symbol: w.symbol,
      exchange: w.exchange,
      targetPrice: Number(w.targetPrice),
      direction: w.direction,
      note: w.note,
      actionType: w.actionType,
      tradeDirection: w.tradeDirection,
      status: w.status,
      triggeredPrice: w.triggeredPrice != null ? Number(w.triggeredPrice) : null,
      triggeredAt: w.triggeredAt,
      resultMessage: w.resultMessage,
      createdAt: w.createdAt,
    })),
  });
}
