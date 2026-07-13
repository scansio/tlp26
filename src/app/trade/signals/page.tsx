'use client';

/**
 * /trade/signals — Signal Approval Queue
 *
 * Manual execution users: see pending signals with Approve / Reject buttons.
 * Auto execution users: see history-only view — signals execute automatically.
 *
 * Queue auto-refreshes every 15 seconds.
 * Signals expire after 1 hour (enforced by /api/cron/expire-signals).
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import {
  SignalApprovalCard,
  type QueueSignal,
} from '@/components/trade/SignalApprovalCard';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const POLL_INTERVAL_MS = 15_000; // 15 seconds

interface QueueResponse {
  signals: QueueSignal[];
  tradingMode: string; // 'auto' | 'manual'
  executionMode: string; // 'paper' | 'live'
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SignalQueuePage() {
  const [signals, setSignals] = useState<QueueSignal[]>([]);
  const [tradingMode, setTradingMode] = useState<string>('manual');
  const [executionMode, setExecutionMode] = useState<string>('paper');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/trade-signals/queue');
      if (!res.ok) {
        throw new Error(`Request failed: ${res.status}`);
      }
      const data: QueueResponse = await res.json();
      setSignals(data.signals);
      setTradingMode(data.tradingMode ?? 'manual');
      setExecutionMode(data.executionMode ?? 'paper');
      setLastRefreshed(new Date());
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to load signal queue',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + 15-second auto-refresh
  useEffect(() => {
    void fetchQueue();

    intervalRef.current = setInterval(() => {
      void fetchQueue();
    }, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
      }
    };
  }, [fetchQueue]);

  // Handle approve / reject — optimistically removes from pending list on success
  const handleAction = useCallback(
    async (id: string, action: 'approve' | 'reject') => {
      const res = await fetch(`/api/trade-signals/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `Action failed: ${res.status}`,
        );
      }

      // Remove signal from queue after successful action
      setSignals((prev) => prev.filter((s) => s.id !== id));
    },
    [],
  );

  const isAutoMode = tradingMode === 'auto';
  const isManualMode = !isAutoMode;
  const pendingCount = signals.filter((s) => s.status === 'pending').length;

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold">
              {isAutoMode ? 'Signal History' : 'Signal Approval Queue'}
            </h1>

            {/* Pending count badge (manual only) */}
            {isManualMode && pendingCount > 0 && (
              <Badge className="text-sm">
                {pendingCount} pending
              </Badge>
            )}

            {/* Mode badge */}
            <Badge variant="outline" className="text-xs capitalize">
              {tradingMode} mode
            </Badge>
            <Badge
              variant="outline"
              className={`text-xs ${
                executionMode === 'live'
                  ? 'border-amber-500 text-amber-600 dark:text-amber-400'
                  : 'border-muted-foreground'
              }`}
            >
              {executionMode}
            </Badge>
          </div>

          <p className="text-muted-foreground mt-1 text-sm">
            {isAutoMode
              ? 'You are on auto-execution mode. Signals execute automatically — this is a read-only history view.'
              : 'Review AI-generated and webhook trade signals before they are executed. Signals expire after 1 hour.'}
          </p>

          {lastRefreshed && (
            <p className="text-xs text-muted-foreground mt-1">
              Last refreshed: {lastRefreshed.toLocaleTimeString()} · auto-refreshes
              every 15s
            </p>
          )}
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={() => void fetchQueue()}
          disabled={loading}
          className="shrink-0"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      {/* Error state */}
      {error && (
        <Card className="p-4 border-destructive">
          <p className="text-destructive text-sm">{error}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void fetchQueue()}
          >
            Retry
          </Button>
        </Card>
      )}

      {/* Loading skeleton (first load only) */}
      {loading && signals.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          Loading signal queue…
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && signals.length === 0 && (
        <Card className="p-10 text-center">
          <div className="flex flex-col items-center gap-3">
            {/* Brain / monitor icon */}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-10 w-10 text-muted-foreground/40"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path d="M12 2a4 4 0 0 1 4 4v1h1a3 3 0 0 1 0 6h-1v1a4 4 0 0 1-8 0v-1H7a3 3 0 0 1 0-6h1V6a4 4 0 0 1 4-4z" />
            </svg>
            <p className="text-muted-foreground font-medium">
              No pending signals. The AI is monitoring the market.
            </p>
            <p className="text-sm text-muted-foreground">
              New signals will appear here automatically. The queue refreshes
              every 15 seconds.
            </p>
          </div>
        </Card>
      )}

      {/* Signal list */}
      {signals.length > 0 && (
        <>
          {/* Auto-execution notice */}
          {isAutoMode && (
            <Card className="p-4 bg-muted/50 border-dashed">
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">Auto-execution is active.</span>{' '}
                Signals listed below were or will be executed automatically.
                Switch to manual mode in your{' '}
                <a
                  href="/risk-profile"
                  className="text-primary underline underline-offset-2"
                >
                  risk profile
                </a>{' '}
                to review signals before execution.
              </p>
            </Card>
          )}

          <div className="space-y-4">
            {signals.map((signal) => (
              <SignalApprovalCard
                key={signal.id}
                signal={signal}
                showActions={isManualMode}
                onAction={handleAction}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
