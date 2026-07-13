/**
 * PATCH /api/trading-mode
 *
 * Switches a user between paper and live trading modes.
 *
 * Rules:
 *  - paper → live: requires at least one active exchange connected AND
 *    the caller must include `{ confirmed: true }` in the body (explicit consent).
 *  - live → paper: always allowed.
 *
 * The `executionMode` column in `user_risk_profiles` stores the paper/live state
 * ('paper' | 'live'). This is distinct from `tradingMode` which stores auto/manual.
 */

import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { eq, and, count } from 'drizzle-orm';
import { db } from '@/db';
import { userRiskProfiles, userExchanges } from '@/db/schema';

export async function PATCH(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { mode, confirmed } = body as { mode?: string; confirmed?: boolean };

  if (mode !== 'paper' && mode !== 'live') {
    return NextResponse.json(
      { error: 'mode must be "paper" or "live"' },
      { status: 400 },
    );
  }

  // Load current profile
  const [profile] = await db
    .select({
      id: userRiskProfiles.id,
      executionMode: userRiskProfiles.executionMode,
      killSwitchActive: userRiskProfiles.killSwitchActive,
    })
    .from(userRiskProfiles)
    .where(eq(userRiskProfiles.userId, userId))
    .limit(1);

  if (!profile) {
    return NextResponse.json(
      { error: 'Risk profile not found. Complete setup first.' },
      { status: 404 },
    );
  }

  // Switching paper → live: enforce safety gates
  if (mode === 'live') {
    // Gate 1: explicit confirmation required
    if (!confirmed) {
      return NextResponse.json(
        {
          error:
            'Explicit confirmation required to switch to live trading. ' +
            'Include { "confirmed": true } to acknowledge you are switching to live trading with real funds.',
        },
        { status: 422 },
      );
    }

    // Gate 2: at least one active exchange must be connected
    const [{ connectedCount }] = await db
      .select({ connectedCount: count() })
      .from(userExchanges)
      .where(
        and(
          eq(userExchanges.userId, userId),
          eq(userExchanges.status, 'active'),
        ),
      );

    if (Number(connectedCount) === 0) {
      return NextResponse.json(
        {
          error:
            'No active exchange connected. Connect at least one exchange before switching to live trading.',
        },
        { status: 422 },
      );
    }
  }

  // Persist the mode change
  await db
    .update(userRiskProfiles)
    .set({ executionMode: mode, updatedAt: new Date() })
    .where(eq(userRiskProfiles.userId, userId));

  return NextResponse.json({
    tradingMode: mode,
    isPaper: mode === 'paper',
    message: mode === 'live'
      ? 'Switched to live trading. Real funds will be used.'
      : 'Switched to paper trading. No real funds at risk.',
  });
}

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [profile] = await db
    .select({ executionMode: userRiskProfiles.executionMode })
    .from(userRiskProfiles)
    .where(eq(userRiskProfiles.userId, userId))
    .limit(1);

  const mode = profile?.executionMode ?? 'paper';

  return NextResponse.json({ tradingMode: mode, isPaper: mode === 'paper' });
}
