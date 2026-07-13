import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { eq, desc } from 'drizzle-orm';
import { db } from '@/db';
import { tradeSignals, signalPublishers } from '@/db/schema';

// ---------------------------------------------------------------------------
// GET /api/trade-signals
// Returns the authenticated user's trade signal history with copy badge data.
// Signals sourced from copy trading include a `copyBadge` field with the
// publisher's display name.
// ---------------------------------------------------------------------------
export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rows = await db
    .select({
      id: tradeSignals.id,
      symbol: tradeSignals.symbol,
      timeframe: tradeSignals.timeframe,
      direction: tradeSignals.direction,
      entryPrice: tradeSignals.entryPrice,
      stopLoss: tradeSignals.stopLoss,
      takeProfit: tradeSignals.takeProfit,
      confidence: tradeSignals.confidence,
      reasoning: tradeSignals.reasoning,
      strategySource: tradeSignals.strategySource,
      source: tradeSignals.source,
      status: tradeSignals.status,
      publisherId: tradeSignals.publisherId,
      createdAt: tradeSignals.createdAt,
      updatedAt: tradeSignals.updatedAt,
      expiresAt: tradeSignals.expiresAt,
      // Publisher name (only populated for copy-sourced signals)
      publisherName: signalPublishers.displayName,
    })
    .from(tradeSignals)
    .leftJoin(signalPublishers, eq(tradeSignals.publisherId, signalPublishers.id))
    .where(eq(tradeSignals.userId, userId))
    .orderBy(desc(tradeSignals.createdAt))
    .limit(100);

  const signals = rows.map((row) => ({
    id: row.id,
    symbol: row.symbol,
    timeframe: row.timeframe,
    direction: row.direction,
    entryPrice: row.entryPrice,
    stopLoss: row.stopLoss,
    takeProfit: row.takeProfit,
    confidence: row.confidence,
    reasoning: row.reasoning,
    strategySource: row.strategySource,
    source: row.source,
    status: row.status,
    publisherId: row.publisherId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
    // "COPY" badge — present only for copy-sourced signals
    copyBadge:
      row.source === 'copy' && row.publisherName
        ? { label: 'COPY', publisherName: row.publisherName }
        : null,
  }));

  return NextResponse.json({ signals });
}
