/**
 * Kill Switch & Circuit Breaker API
 *
 * GET  /api/kill-switch  — Returns the current circuit breaker state for the authenticated user.
 * POST /api/kill-switch  — Toggles the kill switch ON or OFF.
 *                          When turned ON: all pending signals are cancelled immediately.
 *                          Only the authenticated user can toggle their own kill switch.
 */

import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCircuitBreakerState, setKillSwitch } from '@/lib/circuit-breaker';

// ---------------------------------------------------------------------------
// GET /api/kill-switch
// ---------------------------------------------------------------------------
export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await getCircuitBreakerState(userId);

  return NextResponse.json(result);
}

// ---------------------------------------------------------------------------
// POST /api/kill-switch
// ---------------------------------------------------------------------------
const toggleSchema = z.object({
  active: z.boolean(),
});

export async function POST(req: Request) {
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

  const parsed = toggleSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const result = await setKillSwitch(userId, parsed.data.active);

  return NextResponse.json(result);
}
