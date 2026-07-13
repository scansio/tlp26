'use client';

import { useEffect, useState, use } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PublisherProfile {
  id: string;
  displayName: string | null;
  strategyDescription: string | null;
  totalSignals: number | null;
  winRate: string | null;
  sharpeRatio: string | null;
  avgRR: string | null;
  feePercent: string | null;
  subscriberCount: number | null;
  createdAt: string;
  isSelf: boolean;
  subscription: {
    id: string;
    isActive: boolean;
    copyRatioPct: number;
    executionMode: string;
  } | null;
}

interface SubscribeFormState {
  copyRatioPct: number;
  executionMode: 'auto-copy' | 'review-copy';
  maxPositionSizeCap: string;
}

// ---------------------------------------------------------------------------
// Stat card helper
// ---------------------------------------------------------------------------

function StatItem({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div className="text-center">
      <p className="text-2xl font-bold">{value ?? '—'}</p>
      <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subscribe modal
// ---------------------------------------------------------------------------

interface SubscribeModalProps {
  open: boolean;
  onClose: () => void;
  publisherName: string;
  onSubmit: (form: SubscribeFormState) => Promise<void>;
  submitting: boolean;
  error: string;
}

function SubscribeModal({
  open,
  onClose,
  publisherName,
  onSubmit,
  submitting,
  error,
}: SubscribeModalProps) {
  const [form, setForm] = useState<SubscribeFormState>({
    copyRatioPct: 50,
    executionMode: 'review-copy',
    maxPositionSizeCap: '',
  });

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background rounded-lg shadow-xl w-full max-w-md p-6 space-y-5">
        <div>
          <h2 className="text-xl font-bold">Subscribe to {publisherName}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Configure how copied trades are sized and executed relative to your risk profile.
          </p>
        </div>

        {/* Copy ratio slider */}
        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <label className="text-sm font-medium">Copy Ratio</label>
            <span className="text-sm font-semibold">{form.copyRatioPct}%</span>
          </div>
          <input
            type="range"
            min={1}
            max={100}
            step={1}
            value={form.copyRatioPct}
            onChange={(e) =>
              setForm((f) => ({ ...f, copyRatioPct: Number(e.target.value) }))
            }
            className="w-full accent-primary"
          />
          <p className="text-xs text-muted-foreground">
            If publisher opens a $1,000 position, you open a{' '}
            <strong>${(1000 * form.copyRatioPct) / 100}</strong> equivalent based on your
            risk profile.
          </p>
        </div>

        {/* Execution mode */}
        <div className="space-y-2">
          <label className="text-sm font-medium">Execution Mode</label>
          <div className="flex gap-2">
            <button
              type="button"
              className={`flex-1 rounded-md border px-3 py-2 text-sm ${
                form.executionMode === 'review-copy'
                  ? 'border-primary bg-primary/10 font-medium'
                  : 'border-input'
              }`}
              onClick={() => setForm((f) => ({ ...f, executionMode: 'review-copy' }))}
            >
              Review &amp; Approve
            </button>
            <button
              type="button"
              className={`flex-1 rounded-md border px-3 py-2 text-sm ${
                form.executionMode === 'auto-copy'
                  ? 'border-primary bg-primary/10 font-medium'
                  : 'border-input'
              }`}
              onClick={() => setForm((f) => ({ ...f, executionMode: 'auto-copy' }))}
            >
              Auto-Copy
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            {form.executionMode === 'auto-copy'
              ? 'Signals are executed immediately without your approval.'
              : 'Signals go to your approval queue before execution.'}
          </p>
        </div>

        {/* Max position size cap */}
        <div className="space-y-2">
          <label className="text-sm font-medium">
            Max Position Size Cap{' '}
            <span className="text-muted-foreground font-normal">(optional, USD)</span>
          </label>
          <input
            type="number"
            min={1}
            step={1}
            placeholder="e.g. 500 — leave blank for no cap"
            value={form.maxPositionSizeCap}
            onChange={(e) =>
              setForm((f) => ({ ...f, maxPositionSizeCap: e.target.value }))
            }
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex gap-3 pt-1">
          <Button
            variant="outline"
            className="flex-1"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            className="flex-1"
            onClick={() => onSubmit(form)}
            disabled={submitting}
          >
            {submitting ? <Spinner className="mr-2 h-4 w-4" /> : null}
            {submitting ? 'Subscribing…' : 'Subscribe'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Publisher profile page
// ---------------------------------------------------------------------------

export default function PublisherProfilePage({
  params,
}: {
  params: Promise<{ publisherId: string }>;
}) {
  const { publisherId } = use(params);

  const [publisher, setPublisher] = useState<PublisherProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  useEffect(() => {
    fetch(`/api/copy/publishers/${publisherId}`)
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error ?? 'Failed to load publisher');
        }
        return res.json();
      })
      .then((data: PublisherProfile) => setPublisher(data))
      .catch((err: Error) => setLoadError(err.message))
      .finally(() => setLoading(false));
  }, [publisherId]);

  async function handleSubscribe(form: SubscribeFormState) {
    setSubmitting(true);
    setSubmitError('');

    const body: Record<string, unknown> = {
      publisherId,
      copyRatioPct: form.copyRatioPct,
      executionMode: form.executionMode,
    };
    if (form.maxPositionSizeCap) {
      body.maxPositionSizeCap = Number(form.maxPositionSizeCap);
    }

    try {
      const res = await fetch('/api/copy/subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setSubmitError(data.error ?? 'Failed to subscribe');
        return;
      }
      setModalOpen(false);
      setSuccessMessage(data.message ?? 'Subscribed successfully!');
      // Refresh publisher data to update subscription state
      const updated = await fetch(`/api/copy/publishers/${publisherId}`).then((r) =>
        r.json(),
      );
      setPublisher(updated);
    } catch {
      setSubmitError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  if (loadError || !publisher) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-red-600">{loadError || 'Publisher not found.'}</p>
      </div>
    );
  }

  const isSubscribed = !!publisher.subscription?.isActive;
  const isPaused = publisher.subscription && !publisher.subscription.isActive;

  return (
    <>
      <div className="max-w-2xl mx-auto py-10 px-4 space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">
              {publisher.displayName ?? 'Anonymous Publisher'}
            </h1>
            {publisher.strategyDescription && (
              <p className="text-muted-foreground mt-1 text-sm max-w-prose">
                {publisher.strategyDescription}
              </p>
            )}
          </div>

          {publisher.isSelf ? (
            <Badge variant="secondary">Your profile</Badge>
          ) : isSubscribed ? (
            <Badge className="bg-green-100 text-green-800 border-green-300">
              Subscribed
            </Badge>
          ) : isPaused ? (
            <Badge variant="outline">Paused</Badge>
          ) : null}
        </div>

        {successMessage && (
          <div className="rounded-md bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
            {successMessage}
          </div>
        )}

        {/* Stats */}
        <Card className="p-6">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 divide-x divide-border">
            <StatItem
              label="Win Rate"
              value={
                publisher.winRate != null ? `${Number(publisher.winRate).toFixed(1)}%` : null
              }
            />
            <StatItem label="Total Signals" value={publisher.totalSignals} />
            <StatItem
              label="Avg R:R"
              value={
                publisher.avgRR != null ? `${Number(publisher.avgRR).toFixed(2)}` : null
              }
            />
            <StatItem
              label="Sharpe Ratio"
              value={
                publisher.sharpeRatio != null
                  ? Number(publisher.sharpeRatio).toFixed(2)
                  : null
              }
            />
          </div>
          <div className="mt-4 flex gap-6 text-sm text-muted-foreground pt-4 border-t border-border">
            <span>
              <strong>{publisher.subscriberCount ?? 0}</strong> subscribers
            </span>
            {publisher.feePercent && Number(publisher.feePercent) > 0 && (
              <span>
                Performance fee: <strong>{Number(publisher.feePercent).toFixed(2)}%</strong>
              </span>
            )}
          </div>
        </Card>

        {/* Current subscription config */}
        {publisher.subscription && (
          <Card className="p-6 space-y-2 border-primary/40">
            <h2 className="font-semibold text-sm">Your Subscription Settings</h2>
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <p className="text-muted-foreground text-xs">Copy Ratio</p>
                <p className="font-medium">{publisher.subscription.copyRatioPct}%</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">Mode</p>
                <p className="font-medium capitalize">
                  {publisher.subscription.executionMode.replace('-', ' ')}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">Status</p>
                <p className="font-medium">
                  {publisher.subscription.isActive ? 'Active' : 'Paused'}
                </p>
              </div>
            </div>
            <div className="pt-2">
              <Link
                href="/copy/subscriptions"
                className="text-sm text-primary underline underline-offset-2"
              >
                Manage subscription
              </Link>
            </div>
          </Card>
        )}

        {/* Subscribe button — hidden if self, shown otherwise */}
        {!publisher.isSelf && !publisher.subscription && (
          <Button
            size="lg"
            className="w-full"
            onClick={() => setModalOpen(true)}
          >
            Subscribe
          </Button>
        )}
      </div>

      <SubscribeModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        publisherName={publisher.displayName ?? 'this publisher'}
        onSubmit={handleSubscribe}
        submitting={submitting}
        error={submitError}
      />
    </>
  );
}
