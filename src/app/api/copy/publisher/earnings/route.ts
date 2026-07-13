/**
 * GET /api/copy/publisher/earnings
 *
 * Returns the authenticated publisher's earnings summary:
 * - totalFeeAmount: gross performance fees accrued
 * - totalPlatformCut: platform's cut
 * - totalPublisherNet: publisher's net earnings
 * - bySubscriber: per-subscriber breakdown (sorted by feeAmount desc)
 * - byMonth: monthly totals for chart (YYYY-MM period)
 * - recentEarnings: last 50 individual earning records
 *
 * 401 if not authenticated.
 * 404 if user has no publisher profile.
 */

import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { eq, desc, sql } from 'drizzle-orm';
import { db } from '@/db';
import { signalPublishers, publisherEarnings } from '@/db/schema';

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  // Resolve publisher record for the authenticated user
  const [publisher] = await db
    .select({ id: signalPublishers.id, feePercent: signalPublishers.feePercent })
    .from(signalPublishers)
    .where(eq(signalPublishers.userId, userId))
    .limit(1);

  if (!publisher) {
    return NextResponse.json({ error: 'Publisher profile not found' }, { status: 404 });
  }

  const publisherId = publisher.id;

  // Run three queries in parallel
  const [totalsRows, bySubscriberRows, byMonthRows, recentRows] = await Promise.all([
    // Totals
    db
      .select({
        totalFeeAmount: sql<string>`COALESCE(SUM(${publisherEarnings.feeAmount}), 0)`,
        totalPlatformCut: sql<string>`COALESCE(SUM(${publisherEarnings.platformCutAmount}), 0)`,
        totalPublisherNet: sql<string>`COALESCE(SUM(${publisherEarnings.publisherNetAmount}), 0)`,
        totalTrades: sql<number>`COUNT(*)::int`,
      })
      .from(publisherEarnings)
      .where(eq(publisherEarnings.publisherId, publisherId)),

    // Per-subscriber breakdown
    db
      .select({
        subscriberId: publisherEarnings.subscriberId,
        tradeCount: sql<number>`COUNT(*)::int`,
        totalProfit: sql<string>`SUM(${publisherEarnings.profitAmount})`,
        totalFee: sql<string>`SUM(${publisherEarnings.feeAmount})`,
        totalNet: sql<string>`SUM(${publisherEarnings.publisherNetAmount})`,
      })
      .from(publisherEarnings)
      .where(eq(publisherEarnings.publisherId, publisherId))
      .groupBy(publisherEarnings.subscriberId)
      .orderBy(desc(sql`SUM(${publisherEarnings.feeAmount})`)),

    // Monthly totals for chart
    db
      .select({
        period: publisherEarnings.period,
        tradeCount: sql<number>`COUNT(*)::int`,
        totalFee: sql<string>`SUM(${publisherEarnings.feeAmount})`,
        totalNet: sql<string>`SUM(${publisherEarnings.publisherNetAmount})`,
      })
      .from(publisherEarnings)
      .where(eq(publisherEarnings.publisherId, publisherId))
      .groupBy(publisherEarnings.period)
      .orderBy(publisherEarnings.period),

    // Recent individual earnings
    db
      .select({
        id: publisherEarnings.id,
        subscriberId: publisherEarnings.subscriberId,
        tradeId: publisherEarnings.tradeId,
        profitAmount: publisherEarnings.profitAmount,
        feeAmount: publisherEarnings.feeAmount,
        platformCutAmount: publisherEarnings.platformCutAmount,
        publisherNetAmount: publisherEarnings.publisherNetAmount,
        period: publisherEarnings.period,
        createdAt: publisherEarnings.createdAt,
      })
      .from(publisherEarnings)
      .where(eq(publisherEarnings.publisherId, publisherId))
      .orderBy(desc(publisherEarnings.createdAt))
      .limit(50),
  ]);

  const totals = totalsRows[0] ?? {
    totalFeeAmount: '0',
    totalPlatformCut: '0',
    totalPublisherNet: '0',
    totalTrades: 0,
  };

  return NextResponse.json({
    publisherId,
    feePercent: publisher.feePercent,
    totals: {
      totalFeeAmount: parseFloat(totals.totalFeeAmount),
      totalPlatformCut: parseFloat(totals.totalPlatformCut),
      totalPublisherNet: parseFloat(totals.totalPublisherNet),
      totalTrades: totals.totalTrades,
    },
    bySubscriber: bySubscriberRows.map((r) => ({
      subscriberId: r.subscriberId,
      tradeCount: r.tradeCount,
      totalProfit: parseFloat(r.totalProfit ?? '0'),
      totalFee: parseFloat(r.totalFee ?? '0'),
      totalNet: parseFloat(r.totalNet ?? '0'),
    })),
    byMonth: byMonthRows.map((r) => ({
      period: r.period,
      tradeCount: r.tradeCount,
      totalFee: parseFloat(r.totalFee ?? '0'),
      totalNet: parseFloat(r.totalNet ?? '0'),
    })),
    recentEarnings: recentRows.map((r) => ({
      id: r.id,
      subscriberId: r.subscriberId,
      tradeId: r.tradeId,
      profitAmount: parseFloat(r.profitAmount),
      feeAmount: parseFloat(r.feeAmount),
      platformCutAmount: parseFloat(r.platformCutAmount ?? '0'),
      publisherNetAmount: parseFloat(r.publisherNetAmount ?? '0'),
      period: r.period,
      createdAt: r.createdAt,
    })),
  });
}
