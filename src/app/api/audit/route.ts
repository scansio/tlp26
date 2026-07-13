/**
 * GET /api/audit
 *
 * Returns paginated workflow trace spans from mastra_ai_spans for the
 * authenticated user. Mastra's observability layer (DefaultExporter) writes
 * spans to this table automatically for every workflow/agent execution.
 *
 * Query params:
 *   limit  - max rows to return (default 50, max 200)
 *   offset - pagination offset (default 0)
 *   runId  - filter to a specific workflow run ID
 */

import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { pool } from '@/db';

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const url = new URL(req.url);
  const limitParam = Math.min(
    parseInt(url.searchParams.get('limit') ?? '50', 10),
    200,
  );
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10));
  const runId = url.searchParams.get('runId');

  const limit = isNaN(limitParam) ? 50 : limitParam;

  try {
    const client = await pool.connect();
    try {
      // mastra_ai_spans is managed by @mastra/pg PostgresStore.
      // Columns: id, traceId, spanId, parentSpanId, name, kind, status,
      //          startTime, endTime, attributes, events, links, resource,
      //          scope, createdAt, updatedAt
      //
      // The `attributes` JSONB column stores userId and other workflow context
      // set via Mastra's observability telemetry.
      //
      // We filter by userId stored in attributes to scope results per user.
      // Spans without a userId attribute (e.g. internal Mastra spans) are excluded.

      let query: string;
      let values: (string | number)[];

      if (runId) {
        query = `
          SELECT
            id,
            "traceId",
            "spanId",
            "parentSpanId",
            name,
            kind,
            status,
            "startTime",
            "endTime",
            attributes,
            events,
            "createdAt",
            "updatedAt"
          FROM mastra_ai_spans
          WHERE
            attributes->>'userId' = $1
            AND "traceId" = $2
          ORDER BY "startTime" ASC
          LIMIT $3
          OFFSET $4
        `;
        values = [userId, runId, limit, offset];
      } else {
        query = `
          SELECT
            id,
            "traceId",
            "spanId",
            "parentSpanId",
            name,
            kind,
            status,
            "startTime",
            "endTime",
            attributes,
            events,
            "createdAt",
            "updatedAt"
          FROM mastra_ai_spans
          WHERE
            attributes->>'userId' = $1
          ORDER BY "startTime" DESC
          LIMIT $2
          OFFSET $3
        `;
        values = [userId, limit, offset];
      }

      // Count query for pagination
      let countQuery: string;
      let countValues: string[];

      if (runId) {
        countQuery = `
          SELECT COUNT(*) FROM mastra_ai_spans
          WHERE attributes->>'userId' = $1 AND "traceId" = $2
        `;
        countValues = [userId, runId];
      } else {
        countQuery = `
          SELECT COUNT(*) FROM mastra_ai_spans
          WHERE attributes->>'userId' = $1
        `;
        countValues = [userId];
      }

      const [spanResult, countResult] = await Promise.all([
        client.query(query, values),
        client.query(countQuery, countValues),
      ]);

      const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

      return NextResponse.json({
        spans: spanResult.rows,
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + limit < total,
        },
      });
    } finally {
      client.release();
    }
  } catch (err) {
    // Table may not exist yet if Mastra storage hasn't been initialized
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('does not exist') || message.includes('relation')) {
      return NextResponse.json(
        { spans: [], pagination: { total: 0, limit, offset, hasMore: false } },
      );
    }
    console.error('[audit] Failed to query mastra_ai_spans:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
