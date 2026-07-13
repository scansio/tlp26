/**
 * GET /api/cron/position-monitor
 *
 * Bootstraps or re-syncs position monitor WebSocket connections for all
 * users with open trade_executions records. Calls positionMonitor.syncMonitors()
 * which starts missing connections and stops stale ones.
 *
 * Authentication: Bearer token via CRON_SECRET environment variable.
 * The middleware excludes this path from Clerk auth so external schedulers
 * can call it without a user session.
 *
 * IMPORTANT: On serverless runtimes (e.g. Vercel) WebSocket connections do
 * not persist across cold-starts. This cron tick re-bootstraps paper-mode
 * REST pollers on each invocation. For live WebSocket monitoring, run this
 * application on a persistent Node.js process (Railway, Fly.io, Docker, etc.).
 *
 * Recommended schedule: every 30 seconds for paper mode coverage.
 * Example Vercel cron.json entry (minimum 1-minute granularity on Vercel):
 *   { "path": "/api/cron/position-monitor", "schedule": "* * * * *" }
 *
 * Example cron invocation:
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://yourdomain.com/api/cron/position-monitor
 */

import { NextResponse } from 'next/server';
import { positionMonitor } from '@/lib/position-monitor';

export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: 'CRON_SECRET is not configured on this server' },
      { status: 500 },
    );
  }

  const authHeader = req.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (token !== cronSecret) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  try {
    await positionMonitor.syncMonitors();

    const status = positionMonitor.getStatus();
    return NextResponse.json({
      ok: true,
      activeMonitors: status.length,
      monitors: status,
      syncedAt: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[cron/position-monitor] syncMonitors error:', err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
