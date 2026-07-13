'use client';

import { useEffect, useState, useCallback } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

// ---------------------------------------------------------------------------
// Types from mastra_ai_spans
// ---------------------------------------------------------------------------

interface SpanAttributes {
  userId?: string;
  workflowRunId?: string;
  symbol?: string;
  triggeredBy?: string;
  [key: string]: unknown;
}

interface AuditSpan {
  id: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: string;
  status: { code?: number; message?: string } | null;
  startTime: string;
  endTime: string | null;
  attributes: SpanAttributes | null;
  events: unknown[] | null;
  createdAt: string;
}

interface AuditResponse {
  spans: AuditSpan[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(startTime: string, endTime: string | null): string {
  if (!endTime) return 'running…';
  const ms = new Date(endTime).getTime() - new Date(startTime).getTime();
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function formatTime(ts: string): string {
  return new Date(ts).toLocaleString();
}

function getStatusBadgeVariant(
  status: AuditSpan['status'],
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (!status) return 'secondary';
  // OpenTelemetry status codes: 0=UNSET, 1=OK, 2=ERROR
  if (status.code === 2) return 'destructive';
  if (status.code === 1) return 'default';
  return 'secondary';
}

function getStatusLabel(status: AuditSpan['status']): string {
  if (!status) return 'Unknown';
  if (status.code === 2) return 'Error';
  if (status.code === 1) return 'OK';
  return status.message ?? 'Unset';
}

// ---------------------------------------------------------------------------
// Component: Expanded span detail
// ---------------------------------------------------------------------------

function SpanDetail({ span }: { span: AuditSpan }) {
  return (
    <div className="mt-3 pl-4 border-l-2 border-muted space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-muted-foreground">
        <div>
          <span className="font-medium text-foreground">Trace ID:</span>{' '}
          <span className="font-mono text-xs">{span.traceId}</span>
        </div>
        <div>
          <span className="font-medium text-foreground">Span ID:</span>{' '}
          <span className="font-mono text-xs">{span.spanId}</span>
        </div>
        {span.parentSpanId && (
          <div>
            <span className="font-medium text-foreground">Parent Span:</span>{' '}
            <span className="font-mono text-xs">{span.parentSpanId}</span>
          </div>
        )}
        <div>
          <span className="font-medium text-foreground">Kind:</span>{' '}
          {span.kind}
        </div>
        <div>
          <span className="font-medium text-foreground">Start:</span>{' '}
          {formatTime(span.startTime)}
        </div>
        <div>
          <span className="font-medium text-foreground">End:</span>{' '}
          {span.endTime ? formatTime(span.endTime) : '—'}
        </div>
        {span.status?.message && (
          <div className="col-span-2">
            <span className="font-medium text-foreground">Status message:</span>{' '}
            {span.status.message}
          </div>
        )}
      </div>

      {span.attributes && Object.keys(span.attributes).length > 0 && (
        <div>
          <p className="font-medium text-foreground mb-1">Attributes</p>
          <pre className="bg-muted rounded p-2 overflow-x-auto text-xs">
            {JSON.stringify(span.attributes, null, 2)}
          </pre>
        </div>
      )}

      {span.events && span.events.length > 0 && (
        <div>
          <p className="font-medium text-foreground mb-1">Events ({span.events.length})</p>
          <pre className="bg-muted rounded p-2 overflow-x-auto text-xs">
            {JSON.stringify(span.events, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component: Single span row
// ---------------------------------------------------------------------------

function SpanRow({ span }: { span: AuditSpan }) {
  const [expanded, setExpanded] = useState(false);

  const attrs = span.attributes ?? {};
  const symbol = typeof attrs.symbol === 'string' ? attrs.symbol : null;
  const triggeredBy = typeof attrs.triggeredBy === 'string' ? attrs.triggeredBy : null;
  const duration = formatDuration(span.startTime, span.endTime);

  return (
    <div className="border rounded-lg p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm">{span.name}</span>
            {symbol && (
              <Badge variant="outline" className="text-xs">
                {symbol}
              </Badge>
            )}
            {triggeredBy && (
              <Badge variant="secondary" className="text-xs">
                {triggeredBy}
              </Badge>
            )}
            <Badge variant={getStatusBadgeVariant(span.status)} className="text-xs">
              {getStatusLabel(span.status)}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {formatTime(span.startTime)} · {duration}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 text-xs"
        >
          {expanded ? 'Collapse' : 'Details'}
        </Button>
      </div>

      {expanded && <SpanDetail span={span} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

const PAGE_SIZE = 20;

export default function TradeHistoryPage() {
  const [spans, setSpans] = useState<AuditSpan[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSpans = useCallback(async (pageOffset: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/audit?limit=${PAGE_SIZE}&offset=${pageOffset}`,
      );
      if (!res.ok) {
        throw new Error(`Request failed: ${res.status}`);
      }
      const data: AuditResponse = await res.json();
      setSpans(data.spans);
      setTotal(data.pagination.total);
      setOffset(pageOffset);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audit log');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSpans(0);
  }, [fetchSpans]);

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Trade History &amp; Audit Log</h1>
        <p className="text-muted-foreground mt-1">
          Step-by-step breakdown of every AI trade analysis execution.
          Logs are retained for 90 days.
        </p>
      </div>

      {error && (
        <Card className="p-4 border-destructive">
          <p className="text-destructive text-sm">{error}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void fetchSpans(offset)}
          >
            Retry
          </Button>
        </Card>
      )}

      {loading && (
        <div className="text-center py-12 text-muted-foreground">
          Loading audit spans…
        </div>
      )}

      {!loading && !error && spans.length === 0 && (
        <Card className="p-8 text-center">
          <p className="text-muted-foreground">
            No workflow execution history found.
          </p>
          <p className="text-sm text-muted-foreground mt-2">
            Audit spans appear here automatically after the trade-analysis
            workflow runs.
          </p>
        </Card>
      )}

      {!loading && spans.length > 0 && (
        <>
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>{total} span{total !== 1 ? 's' : ''} total</span>
            <span>
              Page {currentPage} of {totalPages}
            </span>
          </div>

          <div className="space-y-3">
            {spans.map((span) => (
              <SpanRow key={span.id} span={span} />
            ))}
          </div>

          <div className="flex justify-between items-center pt-2">
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0 || loading}
              onClick={() => void fetchSpans(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + PAGE_SIZE >= total || loading}
              onClick={() => void fetchSpans(offset + PAGE_SIZE)}
            >
              Next
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
