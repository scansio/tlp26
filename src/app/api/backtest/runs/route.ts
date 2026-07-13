/**
 * GET /api/backtest/runs
 *
 * Lists the authenticated user's past backtest runs (summary only — no equityCurve).
 * Returns up to 50 most recent runs, ordered newest first.
 */

import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { backtestRuns } from '@/db/schema';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const runs = await db
    .select({
      id: backtestRuns.id,
      config: backtestRuns.config,
      createdAt: backtestRuns.createdAt,
    })
    .from(backtestRuns)
    .where(eq(backtestRuns.userId, userId))
    .orderBy(desc(backtestRuns.createdAt))
    .limit(50);

  return NextResponse.json(runs);
}
