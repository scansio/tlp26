/**
 * GET /api/copy/subscriber/fees
 *
 * Returns the authenticated subscriber's performance fee summary:
 * - byPublisher: grouped fees paid per publisher
 * - byMonth: monthly fee totals for P&L deduction display
 *
 * Used by the trade history page to show net P&L after fees.
 */

import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { eq, desc, sql } from 'drizzle-orm';
import { db } from '@/db';
import { publisherEarnings } from '@/db/schema';

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const [byPublisherRows, byMonthRows, totalRow] = await Promise.all([
    // Per-publisher fee breakdown
    db
      .select({
        publisherId: publisherEarnings.publisherId,
        tradeCount: sql<number>`COUNT(*)::int`,
        totalFee: sql<string>`SUM(${publisherEarnings.feeAmount})`,
      })
      .from(publisherEarnings)
      .where(eq(publisherEarnings.subscriberId, userId))
      .groupBy(publisherEarnings.publisherId)
      .orderBy(desc(sql`SUM(${publisherEarnings.feeAmount})`)),

    // Monthly fee totals
    db
      .select({
        period: publisherEarnings.period,
        tradeCount: sql<number>`COUNT(*)::int`,
        totalFee: sql<string>`SUM(${publisherEarnings.feeAmount})`,
      })
      .from(publisherEarnings)
      .where(eq(publisherEarnings.subscriberId, userId))
      .groupBy(publisherEarnings.period)
      .orderBy(publisherEarnings.period),

    // Grand total
    db
      .select({
        totalFee: sql<string>`COALESCE(SUM(${publisherEarnings.feeAmount}), 0)`,
        totalTrades: sql<number>`COUNT(*)::int`,
      })
      .from(publisherEarnings)
      .where(eq(publisherEarnings.subscriberId, userId)),
  ]);

  const total = totalRow[0] ?? { totalFee: '0', totalTrades: 0 };

  return NextResponse.json({
    totals: {
      totalFeePaid: parseFloat(total.totalFee),
      totalTrades: total.totalTrades,
    },
    byPublisher: byPublisherRows.map((r) => ({
      publisherId: r.publisherId,
      tradeCount: r.tradeCount,
      totalFee: parseFloat(r.totalFee ?? '0'),
    })),
    byMonth: byMonthRows.map((r) => ({
      period: r.period,
      tradeCount: r.tradeCount,
      totalFee: parseFloat(r.totalFee ?? '0'),
    })),
  });
}
