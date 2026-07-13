'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PublisherStats {
  totalSignals: number | null;
  winRate: string | null;
  avgRR: string | null;
  sharpeRatio: string | null;
  maxDrawdown: string | null;
  subscriberCount: number | null;
}

interface PublisherProfile {
  id: string;
  displayName: string | null;
  strategyDescription: string | null;
  isPublic: boolean | null;
  isActive: boolean | null;
  shareIndividualTrades: boolean | null;
  feePercent: string | null;
  stats: PublisherStats;
  createdAt: string | null;
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
// Stat card
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
}: {
  label: string;
  value: string | number | null | undefined;
}) {
  return (
    <div className="rounded-lg border bg-card p-4 text-center">
      <p className="text-2xl font-bold">{value ?? '—'}</p>
      <p className="text-sm text-muted-foreground mt-1">{label}</p>
    </div>
  );
}

function formatPct(v: string | null | undefined): string {
  if (v == null) return '—';
  const n = parseFloat(v);
  return isNaN(n) ? '—' : `${n.toFixed(1)}%`;
}

function formatRatio(v: string | null | undefined): string {
  if (v == null) return '—';
  const n = parseFloat(v);
  return isNaN(n) ? '—' : n.toFixed(2);
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
            Configure how copied trades are sized and executed relative to your risk
            profile.
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
            {submitting ? 'Subscribing...' : 'Subscribe'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function PublisherPublicPage() {
  const params = useParams();
  const publisherId = params?.publisherId as string | undefined;

  const [profile, setProfile] = useState<PublisherProfile | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  async function loadProfile(id: string) {
    const r = await fetch(`/api/copy/publishers/${id}`);
    if (r.status === 404) {
      setError('Publisher not found.');
      return;
    }
    if (!r.ok) {
      setError('Failed to load publisher profile.');
      return;
    }
    const data: PublisherProfile = await r.json();
    setProfile(data);
  }

  useEffect(() => {
    if (!publisherId) return;

    loadProfile(publisherId)
      .catch(() => setError('Network error. Please try again.'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publisherId]);

  async function handleSubscribe(form: SubscribeFormState) {
    if (!publisherId) return;
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
      await loadProfile(publisherId);
    } catch {
      setSubmitError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-red-600">{error ?? 'Publisher not found.'}</p>
      </div>
    );
  }

  const isSubscribed = !!profile.subscription?.isActive;
  const isPaused = profile.subscription && !profile.subscription.isActive;

  return (
    <>
      <div className="max-w-2xl mx-auto py-10 px-4 space-y-8">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-bold">
                {profile.displayName ?? 'Anonymous Publisher'}
              </h1>
              {profile.isSelf && <Badge variant="secondary">Your profile</Badge>}
              {isSubscribed && (
                <Badge className="bg-green-100 text-green-800 border-green-300">
                  Subscribed
                </Badge>
              )}
              {isPaused && <Badge variant="outline">Paused</Badge>}
            </div>
            {profile.strategyDescription && (
              <p className="text-muted-foreground mt-2 max-w-prose">
                {profile.strategyDescription}
              </p>
            )}
          </div>
        </div>

        {successMessage && (
          <div className="rounded-md bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
            {successMessage}
          </div>
        )}

        {/* Stats */}
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            Performance
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <StatCard label="Win Rate" value={formatPct(profile.stats.winRate)} />
            <StatCard label="Avg R:R" value={formatRatio(profile.stats.avgRR)} />
            <StatCard label="Sharpe Ratio" value={formatRatio(profile.stats.sharpeRatio)} />
            <StatCard label="Max Drawdown" value={formatPct(profile.stats.maxDrawdown)} />
            <StatCard label="Total Signals" value={profile.stats.totalSignals} />
            <StatCard label="Subscribers" value={profile.stats.subscriberCount} />
          </div>
          {profile.feePercent && Number(profile.feePercent) > 0 && (
            <p className="text-sm text-muted-foreground mt-3">
              Performance fee:{' '}
              <strong>{Number(profile.feePercent).toFixed(2)}%</strong> of profits
            </p>
          )}
        </div>

        {/* Current subscription config */}
        {profile.subscription && (
          <Card className="p-5 space-y-2 border-primary/40">
            <h2 className="font-semibold text-sm">Your Subscription Settings</h2>
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <p className="text-muted-foreground text-xs">Copy Ratio</p>
                <p className="font-medium">{profile.subscription.copyRatioPct}%</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">Mode</p>
                <p className="font-medium capitalize">
                  {profile.subscription.executionMode.replace('-', ' ')}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">Status</p>
                <p className="font-medium">
                  {profile.subscription.isActive ? 'Active' : 'Paused'}
                </p>
              </div>
            </div>
            <div className="pt-1">
              <Link
                href="/copy/subscriptions"
                className="text-sm text-primary underline underline-offset-2"
              >
                Manage subscription
              </Link>
            </div>
          </Card>
        )}

        {/* Subscribe button -- hidden for self or already subscribed */}
        {!profile.isSelf && !profile.subscription && (
          <Button size="lg" className="w-full" onClick={() => setModalOpen(true)}>
            Subscribe
          </Button>
        )}
      </div>

      <SubscribeModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        publisherName={profile.displayName ?? 'this publisher'}
        onSubmit={handleSubscribe}
        submitting={submitting}
        error={submitError}
      />
    </>
  );
}
