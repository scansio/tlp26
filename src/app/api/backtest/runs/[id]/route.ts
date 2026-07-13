/**
 * GET /api/backtest/runs/[id]
 *
 * Returns the full backtest result (including equityCurve and trades) for a
 * specific run. Only the owner can access their own runs.
 */

import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { backtestRuns } from '@/db/schema';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  const [run] = await db
    .select()
    .from(backtestRuns)
    .where(and(eq(backtestRuns.id, id), eq(backtestRuns.userId, userId)))
    .limit(1);

  if (!run) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json(run);
}
