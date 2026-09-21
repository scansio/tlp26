/**
 * GET /api/cron/expire-signals
 *
 * Marks pending or approved signals as 'expired' — see src/lib/expire-signals.ts
 * for the shared logic. Also driven in-process every 5 minutes by
 * src/worker/signal-expiry-loop.ts, so this route mainly exists for an
 * external scheduler to trigger it on deployments that don't run the worker.
 *
 * Authentication: Bearer token via CRON_SECRET environment variable.
 * The middleware excludes /api/cron/* from Clerk auth.
 *
 * Recommended schedule: every 5 minutes
 * Example: { "path": "/api/cron/expire-signals", "schedule": "every 5 minutes" }
 */

import { NextResponse } from 'next/server';
import { expireStaleSignals } from '@/lib/expire-signals';

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

  const { expired, expiredIds } = await expireStaleSignals();

  return NextResponse.json({ ok: true, expired, expiredIds });
}
