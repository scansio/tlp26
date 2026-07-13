/**
 * GET /api/cron/prune-audit
 *
 * Prunes audit trace spans older than 90 days from mastra_ai_spans.
 *
 * This route must be called by an external cron job or scheduler
 * (e.g. Vercel Cron, GitHub Actions, or a system cron).
 *
 * Authentication: Bearer token via CRON_SECRET environment variable.
 * The middleware deliberately excludes this path from Clerk auth so that
 * an external job can call it without a user session.
 *
 * Example cron invocation:
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://yourdomain.com/api/cron/prune-audit
 *
 * Example Vercel cron.json entry:
 *   { "path": "/api/cron/prune-audit", "schedule": "0 3 * * *" }
 *   (Vercel will forward the CRON_SECRET header automatically)
 */

import { NextResponse } from 'next/server';
import { pool } from '@/db';

const RETENTION_DAYS = 90;

export async function GET(req: Request) {
  // Verify CRON_SECRET header — prevents unauthorised pruning
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

  const client = await pool.connect();
  try {
    // Prune mastra_ai_spans
    const spansResult = await client.query(
      `
      DELETE FROM mastra_ai_spans
      WHERE "createdAt" < NOW() - INTERVAL '${RETENTION_DAYS} days'
      `,
    );

    const deletedSpans = spansResult.rowCount ?? 0;

    console.info(`[prune-audit] Deleted ${deletedSpans} spans older than ${RETENTION_DAYS} days`);

    return NextResponse.json({
      ok: true,
      deleted: { spans: deletedSpans },
      retentionDays: RETENTION_DAYS,
      prunedAt: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Table may not exist yet (Mastra storage not yet initialised)
    if (message.includes('does not exist') || message.includes('relation')) {
      return NextResponse.json({
        ok: true,
        deleted: { spans: 0 },
        retentionDays: RETENTION_DAYS,
        note: 'mastra_ai_spans table does not exist yet — no pruning required',
        prunedAt: new Date().toISOString(),
      });
    }

    console.error('[prune-audit] Failed to prune audit spans:', err);
    return NextResponse.json({ error: 'Internal server error', detail: message }, { status: 500 });
  } finally {
    client.release();
  }
}
