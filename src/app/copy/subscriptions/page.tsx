'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SubscriptionStats {
  winRate: string | null;
  totalSignals: number | null;
  avgRR: string | null;
  sharpeRatio: string | null;
}

interface Subscription {
  id: string;
  publisherId: string;
  publisherName: string | null;
  copyRatioPct: number;
  executionMode: string;
  maxPositionSizeCap: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  stats: SubscriptionStats;
}

interface SubscriptionsResponse {
  subscriptions: Subscription[];
  circuitBreakerActive: boolean;
  activeCount: number;
  maxSubscriptions: number;
}

// ---------------------------------------------------------------------------
// Subscription card
// ---------------------------------------------------------------------------

interface SubscriptionCardProps {
  sub: Subscription;
  onToggle: (id: string, active: boolean) => Promise<void>;
  onUnsubscribe: (id: string) => Promise<void>;
  toggling: boolean;
  unsubscribing: boolean;
}

function SubscriptionCard({
  sub,
  onToggle,
  onUnsubscribe,
  toggling,
  unsubscribing,
}: SubscriptionCardProps) {
  const [confirmUnsubscribe, setConfirmUnsubscribe] = useState(false);

  return (
    <Card className="p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold">
              {sub.publisherName ?? 'Unknown Publisher'}
            </h3>
            {sub.isActive ? (
              <Badge className="bg-green-100 text-green-800 border-green-300 text-xs">
                Active
              </Badge>
            ) : (
              <Badge variant="outline" className="text-xs">
                Paused
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Subscribed {new Date(sub.createdAt).toLocaleDateString()}
          </p>
        </div>

        <div className="flex gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            disabled={toggling}
            onClick={() => onToggle(sub.id, !sub.isActive)}
          >
            {toggling ? (
              <Spinner className="h-3 w-3 mr-1" />
            ) : null}
            {sub.isActive ? 'Pause' : 'Resume'}
          </Button>

          {confirmUnsubscribe ? (
            <div className="flex gap-1">
              <Button
                variant="destructive"
                size="sm"
                disabled={unsubscribing}
                onClick={() => onUnsubscribe(sub.id)}
              >
                {unsubscribing ? <Spinner className="h-3 w-3 mr-1" /> : null}
                Confirm
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmUnsubscribe(false)}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="text-red-600 hover:text-red-700 hover:bg-red-50"
              onClick={() => setConfirmUnsubscribe(true)}
            >
              Unsubscribe
            </Button>
          )}
        </div>
      </div>

      {/* Settings row */}
      <div className="grid grid-cols-3 gap-4 text-sm border-t border-border pt-3">
        <div>
          <p className="text-xs text-muted-foreground">Copy Ratio</p>
          <p className="font-medium">{sub.copyRatioPct}%</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Mode</p>
          <p className="font-medium capitalize">
            {sub.executionMode.replace('-', ' ')}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Max Cap</p>
          <p className="font-medium">
            {sub.maxPositionSizeCap ? `$${Number(sub.maxPositionSizeCap).toFixed(0)}` : 'None'}
          </p>
        </div>
      </div>

      {/* Publisher stats since subscribed */}
      <div className="grid grid-cols-4 gap-2 text-sm border-t border-border pt-3">
        <div className="text-center">
          <p className="font-semibold">
            {sub.stats.winRate != null
              ? `${Number(sub.stats.winRate).toFixed(1)}%`
              : '—'}
          </p>
          <p className="text-xs text-muted-foreground">Win Rate</p>
        </div>
        <div className="text-center">
          <p className="font-semibold">{sub.stats.totalSignals ?? '—'}</p>
          <p className="text-xs text-muted-foreground">Signals</p>
        </div>
        <div className="text-center">
          <p className="font-semibold">
            {sub.stats.avgRR != null ? Number(sub.stats.avgRR).toFixed(2) : '—'}
          </p>
          <p className="text-xs text-muted-foreground">Avg R:R</p>
        </div>
        <div className="text-center">
          <p className="font-semibold">
            {sub.stats.sharpeRatio != null
              ? Number(sub.stats.sharpeRatio).toFixed(2)
              : '—'}
          </p>
          <p className="text-xs text-muted-foreground">Sharpe</p>
        </div>
      </div>

      {/* Link to publisher profile */}
      <div className="pt-1">
        <Link
          href={`/copy/${sub.publisherId}`}
          className="text-xs text-primary underline underline-offset-2"
        >
          View publisher profile
        </Link>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Subscriptions management page
// ---------------------------------------------------------------------------

export default function SubscriptionsPage() {
  const [data, setData] = useState<SubscriptionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [unsubscribingId, setUnsubscribingId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState('');

  async function loadData() {
    setLoading(true);
    setLoadError('');
    try {
      const res = await fetch('/api/copy/subscriptions');
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? 'Failed to load subscriptions');
      }
      const json: SubscriptionsResponse = await res.json();
      setData(json);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  async function handleToggle(id: string, active: boolean) {
    setTogglingId(id);
    setActionMessage('');
    try {
      const res = await fetch(`/api/copy/subscriptions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: active }),
      });
      if (!res.ok) {
        const err = await res.json();
        setActionMessage(err.error ?? 'Failed to update subscription');
        return;
      }
      setActionMessage(active ? 'Subscription resumed.' : 'Subscription paused.');
      await loadData();
    } catch {
      setActionMessage('Network error. Please try again.');
    } finally {
      setTogglingId(null);
    }
  }

  async function handleUnsubscribe(id: string) {
    setUnsubscribingId(id);
    setActionMessage('');
    try {
      const res = await fetch(`/api/copy/subscriptions/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const err = await res.json();
        setActionMessage(err.error ?? 'Failed to unsubscribe');
        return;
      }
      setActionMessage('Unsubscribed successfully.');
      await loadData();
    } catch {
      setActionMessage('Network error. Please try again.');
    } finally {
      setUnsubscribingId(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-red-600">{loadError}</p>
      </div>
    );
  }

  const subscriptions = data?.subscriptions ?? [];

  return (
    <div className="max-w-2xl mx-auto py-10 px-4 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">My Copy Subscriptions</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {data?.activeCount ?? 0} of {data?.maxSubscriptions ?? 10} active subscriptions.
          </p>
        </div>
        <Link href="/copy">
          <Button variant="outline" size="sm">
            Browse Publishers
          </Button>
        </Link>
      </div>

      {/* Circuit breaker banner */}
      {data?.circuitBreakerActive && (
        <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">
          <strong>Circuit breaker active:</strong> Your daily loss limit has been reached.
          All copied signals are blocked until the next trading day.
        </div>
      )}

      {actionMessage && (
        <div
          className={`rounded-md px-4 py-3 text-sm border ${
            actionMessage.toLowerCase().includes('fail') ||
            actionMessage.toLowerCase().includes('error')
              ? 'bg-red-50 border-red-200 text-red-800'
              : 'bg-green-50 border-green-200 text-green-800'
          }`}
        >
          {actionMessage}
        </div>
      )}

      {subscriptions.length === 0 ? (
        <Card className="p-8 text-center space-y-3">
          <p className="text-muted-foreground">You have no copy subscriptions yet.</p>
          <Link href="/copy">
            <Button>Find Publishers to Follow</Button>
          </Link>
        </Card>
      ) : (
        <div className="space-y-4">
          {subscriptions.map((sub) => (
            <SubscriptionCard
              key={sub.id}
              sub={sub}
              onToggle={handleToggle}
              onUnsubscribe={handleUnsubscribe}
              toggling={togglingId === sub.id}
              unsubscribing={unsubscribingId === sub.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}
