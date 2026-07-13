'use client';

import { useEffect, useState, useCallback } from 'react';
import { SignalCard, type TradeSignal } from '@/components/trade/SignalCard';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

interface SignalsResponse {
  signals: TradeSignal[];
}

export default function SignalsPage() {
  const [signals, setSignals] = useState<TradeSignal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSignals = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/trade-signals');
      if (!res.ok) {
        throw new Error(`Request failed: ${res.status}`);
      }
      const data: SignalsResponse = await res.json();
      setSignals(data.signals);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load signals');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSignals();
  }, [fetchSignals]);

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Trade Signals</h1>
          <p className="text-muted-foreground mt-1">
            AI-generated and copy-traded signals. Net P&amp;L figures account for round-trip fees and slippage.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void fetchSignals()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      {error && (
        <Card className="p-4 border-destructive">
          <p className="text-destructive text-sm">{error}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
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
        <Card className="p-8 text-center">
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
            <SignalCard key={signal.id} signal={signal} />
          ))}
        </div>
      )}
    </div>
  );
}
