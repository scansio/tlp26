/**
 * GET  /api/monitor — return position monitor connection status
 * POST /api/monitor — trigger sync of monitors to current open positions
 *
 * Used by the cron tick and by the frontend to display connection health.
 * Admin/internal use only — requires authenticated user.
 */

import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { positionMonitor } from '@/lib/position-monitor';

// ---------------------------------------------------------------------------
// GET — return current monitor status (all entries visible to the admin user)
// ---------------------------------------------------------------------------

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const status = positionMonitor.getStatus();
  // Filter to only show the requesting user's monitors (multi-tenant safety)
  const userStatus = status.filter((s) => s.userId === userId);

  return NextResponse.json({ monitors: userStatus });
}

// ---------------------------------------------------------------------------
// POST — sync monitors to DB state (start missing, stop stale)
// ---------------------------------------------------------------------------

export async function POST() {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  try {
    await positionMonitor.syncMonitors();
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/monitor] syncMonitors error:', err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
