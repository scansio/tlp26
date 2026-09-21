'use client';

/**
 * /trade/signals — Signal Approval Queue
 *
 * Pending signals always show Approve / Reject buttons, in both manual and
 * auto-execution mode — auto mode just means signals also execute on their
 * own if left untouched; approving/rejecting here still overrides that.
 *
 * Queue auto-refreshes every 15 seconds.
 * Signals expire after 1 hour (enforced by /api/cron/expire-signals).
 */

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  SignalApprovalCard,
  type QueueSignal,
} from '@/components/trade/SignalApprovalCard';
import { CreateSignalDialog } from '@/components/trade/CreateSignalDialog';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

const POLL_INTERVAL_MS = 15_000; // 15 seconds

// Status tabs — 'rejected' folds into Cancelled (both mean "never traded,
// by explicit user action") to match the five categories requested.
type TabKey = 'pending' | 'active' | 'executed' | 'expired' | 'cancelled';
const TAB_STATUSES: Record<TabKey, string[]> = {
  // 'executing' is the brief atomic-claim state (see src/lib/signal-claim.ts)
  // while an approve/auto-retry attempt is in flight — grouped with pending
  // so a signal doesn't flicker out of every tab during that window.
  pending: ['pending', 'executing'],
  active: ['approved'],
  executed: ['executed'],
  expired: ['expired'],
  cancelled: ['cancelled', 'rejected'],
};
const TAB_LABELS: Record<TabKey, string> = {
  pending: 'Pending',
  active: 'Active',
  executed: 'Executed',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

interface QueueResponse {
  signals: QueueSignal[];
  tradingMode: string; // 'auto' | 'manual'
  executionMode: string; // 'paper' | 'live'
  connectedExchange: string | null;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SignalQueuePage() {
  const [signals, setSignals] = useState<QueueSignal[]>([]);
  const [tradingMode, setTradingMode] = useState<string>('manual');
  const [executionMode, setExecutionMode] = useState<string>('paper');
  const [connectedExchange, setConnectedExchange] = useState<string | null>(null);
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
      setConnectedExchange(data.connectedExchange ?? null);
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

  // Handle approve / reject / cancel — optimistically removes from its
  // current tab's list; the next poll picks it up under its new status.
  const handleAction = useCallback(
    async (id: string, action: 'approve' | 'reject' | 'cancel') => {
      const res = await fetch(
        `/api/trade-signals/${id}`,
        action === 'cancel'
          ? { method: 'DELETE' }
          : {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action }),
            },
      );

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `Action failed: ${res.status}`,
        );
      }

      setSignals((prev) => prev.filter((s) => s.id !== id));
    },
    [],
  );

  // Recompute doesn't change status, so refresh the whole queue instead of
  // patching local state — keeps the recomputed feeData authoritative.
  const handleRecompute = useCallback(
    async (id: string) => {
      const res = await fetch(`/api/trade-signals/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'recompute' }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `Recompute failed: ${res.status}`,
        );
      }

      await fetchQueue();
    },
    [fetchQueue],
  );

  const isAutoMode = tradingMode === 'auto';
  const pendingCount = signals.filter((s) => s.status === 'pending').length;

  const [tab, setTab] = useState<TabKey>('pending');
  const tabCounts = useMemo(() => {
    const counts = {} as Record<TabKey, number>;
    for (const key of Object.keys(TAB_STATUSES) as TabKey[]) {
      counts[key] = signals.filter((s) => TAB_STATUSES[key].includes(s.status ?? '')).length;
    }
    return counts;
  }, [signals]);
  const visibleSignals = useMemo(
    () => signals.filter((s) => TAB_STATUSES[tab].includes(s.status ?? '')),
    [signals, tab],
  );

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4 md:p-6 md:space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <h1 className="text-xl font-bold md:text-2xl">Signal Approval Queue</h1>

            {/* Pending count badge */}
            {pendingCount > 0 && (
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
              ? 'You are on auto-execution mode — pending signals below will execute automatically if left untouched. Approve to execute now, or Reject to cancel before that happens.'
              : 'Review AI-generated and webhook trade signals before they are executed. Signals expire after 1 hour.'}
          </p>

          {lastRefreshed && (
            <p className="text-xs text-muted-foreground mt-1">
              Last refreshed: {lastRefreshed.toLocaleTimeString()} · auto-refreshes
              every 15s
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row md:shrink-0">
          <CreateSignalDialog onCreated={() => void fetchQueue()} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => void fetchQueue()}
            disabled={loading}
            className="h-11 w-full shrink-0 md:h-8 md:w-auto"
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </div>

      {/* Error state */}
      {error && (
        <Card className="p-4 border-destructive">
          <p className="text-destructive text-sm">{error}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2 h-11 w-full md:h-8 md:w-auto"
            onClick={() => void fetchQueue()}
          >
            Retry
          </Button>
        </Card>
      )}

      {/* Loading skeleton (first load only) */}
      {loading && signals.length === 0 && (
        <div className="text-center py-8 text-muted-foreground md:py-12">
          Loading signal queue…
        </div>
      )}

      {/* Empty state — no signals at all yet */}
      {!loading && !error && signals.length === 0 && (
        <Card className="p-6 text-center md:p-10">
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

      {/* Status tabs + signal list */}
      {signals.length > 0 && (
        <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
          <TabsList className="w-full overflow-x-auto sm:w-fit">
            {(Object.keys(TAB_LABELS) as TabKey[]).map((key) => (
              <TabsTrigger key={key} value={key} className="gap-1.5">
                {TAB_LABELS[key]}
                {tabCounts[key] > 0 && (
                  <span className="text-[10px] text-muted-foreground">{tabCounts[key]}</span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value={tab} className="space-y-4 pt-4">
            {/* Auto-execution notice */}
            {isAutoMode && tab === 'pending' && visibleSignals.length > 0 && (
              <Card className="p-4 bg-muted/50 border-dashed">
                <p className="text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">Auto-execution is active.</span>{' '}
                  Pending signals below will execute automatically if left untouched — use Approve
                  or Reject to override before that happens. Switch to manual mode in your{' '}
                  <a
                    href="/risk-profile"
                    className="text-primary underline underline-offset-2"
                  >
                    risk profile
                  </a>{' '}
                  to always review signals before execution.
                </p>
              </Card>
            )}

            {visibleSignals.length === 0 && (
              <p className="text-center text-sm text-muted-foreground py-8">
                No {TAB_LABELS[tab].toLowerCase()} signals.
              </p>
            )}

            {visibleSignals.map((signal) => (
              <SignalApprovalCard
                key={signal.id}
                signal={signal}
                showActions
                onAction={handleAction}
                onRecompute={handleRecompute}
                connectedExchange={connectedExchange}
              />
            ))}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
