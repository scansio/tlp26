/**
 * GET /api/cron/reconcile-entries
 *
 * Polls every 'approved' trade signal (a resting limit entry order) to
 * completion — see src/lib/reconcile-entries.ts for the shared logic. Also
 * driven in-process every minute by src/worker/entry-reconcile-loop.ts, so
 * this route mainly exists for an external scheduler to trigger it on
 * deployments that don't run the worker.
 *
 * Authentication: Bearer token via CRON_SECRET environment variable.
 * The middleware excludes /api/cron/* from Clerk auth.
 *
 * Recommended schedule: every 1 minute
 * Example: { "path": "/api/cron/reconcile-entries", "schedule": "every 1 minute" }
 */

import { NextResponse } from 'next/server';
import { reconcileApprovedEntries } from '@/lib/reconcile-entries';

export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET is not configured on this server' }, { status: 500 });
  }

  const authHeader = req.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (token !== cronSecret) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const result = await reconcileApprovedEntries();

  return NextResponse.json({ ok: true, ...result });
}
