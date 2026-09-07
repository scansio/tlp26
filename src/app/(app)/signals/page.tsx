'use client';

import { useEffect, useState, useCallback } from 'react';
import { Eye, X, Loader2 } from 'lucide-react';
import { SignalApprovalCard, type QueueSignal } from '@/components/trade/SignalApprovalCard';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface SignalsResponse {
  signals: QueueSignal[];
  connectedExchange: string | null;
}

interface PriceWatch {
  id: string;
  symbol: string;
  exchange: string;
  targetPrice: number;
  direction: 'above' | 'below';
  note: string | null;
  actionType: 'notify' | 'trade';
  tradeDirection: 'LONG' | 'SHORT' | null;
  status: 'active' | 'triggered' | 'cancelled';
  triggeredPrice: number | null;
  resultMessage: string | null;
  createdAt: string | null;
}

interface PriceWatchesResponse {
  watches: PriceWatch[];
}

function WatchStatusBadge({ status }: { status: PriceWatch['status'] }) {
  if (status === 'active') return <Badge variant="outline">Watching</Badge>;
  if (status === 'triggered') {
    return (
      <Badge variant="default" className="bg-green-100 text-green-700 border-green-200">
        Triggered
      </Badge>
    );
  }
  return <Badge variant="outline">Cancelled</Badge>;
}

export default function SignalsPage() {
  const [signals, setSignals] = useState<QueueSignal[]>([]);
  const [connectedExchange, setConnectedExchange] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [watches, setWatches] = useState<PriceWatch[]>([]);
  const [watchesLoading, setWatchesLoading] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const fetchSignals = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/trade-signals/queue');
      if (!res.ok) {
        throw new Error(`Request failed: ${res.status}`);
      }
      const data: SignalsResponse = await res.json();
      setSignals(data.signals);
      setConnectedExchange(data.connectedExchange ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load signals');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleAction = useCallback(async (id: string, action: 'approve' | 'reject') => {
    const res = await fetch(`/api/trade-signals/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as { error?: string }).error ?? `Action failed: ${res.status}`);
    }

    setSignals((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const fetchWatches = useCallback(async () => {
    setWatchesLoading(true);
    try {
      const res = await fetch('/api/price-watches');
      if (res.ok) {
        const data: PriceWatchesResponse = await res.json();
        setWatches(data.watches);
      }
    } catch {
      // silently ignore — non-critical supplementary panel
    } finally {
      setWatchesLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSignals();
    void fetchWatches();
  }, [fetchSignals, fetchWatches]);

  async function handleCancelWatch(id: string) {
    setCancellingId(id);
    try {
      const res = await fetch(`/api/price-watches/${id}`, { method: 'DELETE' });
      if (res.ok) {
        await fetchWatches();
      }
    } finally {
      setCancellingId(null);
    }
  }

  return (
    <div className="max-w-3xl mx-auto p-4 md:p-6 space-y-4 md:space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">Trade Signals</h1>
          <p className="text-muted-foreground mt-1 text-sm md:text-base">
            AI-generated and copy-traded signals. Net P&amp;L figures account for round-trip fees and slippage.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-11 w-full sm:h-8 sm:w-auto"
          onClick={() => void fetchSignals()}
          disabled={loading}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Price watches — created via chat ("watch BTC for a retest of X")    */}
      {/* ------------------------------------------------------------------ */}
      <Card className="p-4 md:p-6 space-y-3">
        <div className="flex items-center gap-2">
          <Eye className="w-4 h-4 text-muted-foreground shrink-0" />
          <h2 className="text-lg font-semibold">Price Watches</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Set up in AI Chat — e.g. &quot;watch BTC for a retest of 78,000&quot;. Ask the agent to cancel one
          any time.
        </p>

        {watchesLoading && watches.length === 0 && (
          <p className="text-sm text-muted-foreground py-2">Loading…</p>
        )}

        {!watchesLoading && watches.length === 0 && (
          <p className="text-sm text-muted-foreground py-2 text-center">
            No price watches yet. Ask the AI Chat agent to watch a level for you.
          </p>
        )}

        {watches.length > 0 && (
          <ul className="divide-y">
            {watches.map((w) => (
              <li key={w.id} className="flex items-center gap-3 py-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{w.symbol}</span>
                    <span className="text-xs text-muted-foreground">
                      {w.direction} {w.targetPrice}
                      {w.actionType === 'trade' && w.tradeDirection ? ` · ${w.tradeDirection} on trigger` : ''}
                    </span>
                    <WatchStatusBadge status={w.status} />
                  </div>
                  {w.note && <p className="text-xs text-muted-foreground mt-0.5">{w.note}</p>}
                  {w.status === 'triggered' && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Hit at {w.triggeredPrice}
                      {w.resultMessage ? ` — ${w.resultMessage}` : ''}
                    </p>
                  )}
                </div>
                {w.status === 'active' && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-11 w-11 p-0 shrink-0 md:h-8 md:w-8"
                    disabled={cancellingId === w.id}
                    onClick={() => void handleCancelWatch(w.id)}
                    aria-label="Cancel watch"
                  >
                    {cancellingId === w.id ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <X className="w-4 h-4" />
                    )}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {error && (
        <Card className="p-4 border-destructive">
          <p className="text-destructive text-sm">{error}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2 h-11 w-full sm:h-8 sm:w-auto"
            onClick={() => void fetchSignals()}
          >
            Retry
          </Button>
        </Card>
      )}

      {loading && signals.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">Loading signals…</div>
      )}

      {!loading && !error && signals.length === 0 && (
        <Card className="p-6 md:p-8 text-center">
          <p className="text-muted-foreground">No trade signals yet.</p>
          <p className="text-sm text-muted-foreground mt-2">
            Signals appear here after the AI trading agent runs an analysis or a
            TradingView webhook is received.
          </p>
        </Card>
      )}

      {signals.length > 0 && (
        <div className="space-y-4">
          {signals.map((signal) => (
            <SignalApprovalCard
              key={signal.id}
              signal={signal}
              showActions
              onAction={handleAction}
              connectedExchange={connectedExchange}
            />
          ))}
        </div>
      )}
    </div>
  );
}
