'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';

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
  updatedAt: string | null;
}

interface FormState {
  displayName: string;
  strategyDescription: string;
  isPublic: boolean;
  shareIndividualTrades: boolean;
  feePercent: string;
}

interface GateError {
  error: string;
  closedTrades?: number;
  required?: number;
}

// ---------------------------------------------------------------------------
// Stat display helpers
// ---------------------------------------------------------------------------

function StatCard({ label, value }: { label: string; value: string | number | null | undefined }) {
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
// Component
// ---------------------------------------------------------------------------

export default function PublisherProfilePage() {
  const [profile, setProfile] = useState<PublisherProfile | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [gateError, setGateError] = useState<GateError | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const [form, setForm] = useState<FormState>({
    displayName: '',
    strategyDescription: '',
    isPublic: false,
    shareIndividualTrades: false,
    feePercent: '0.00',
  });

  // Load existing profile on mount
  useEffect(() => {
    fetch('/api/copy/publisher')
      .then((r) => r.json())
      .then((data: PublisherProfile | null) => {
        setProfile(data);
        if (data) {
          setForm({
            displayName: data.displayName ?? '',
            strategyDescription: data.strategyDescription ?? '',
            isPublic: data.isPublic ?? false,
            shareIndividualTrades: data.shareIndividualTrades ?? false,
            feePercent: data.feePercent ?? '0.00',
          });
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setSaveMessage('');
  }

  async function handleCreate() {
    setSaving(true);
    setSaveMessage('');
    setGateError(null);
    setIsCreating(true);

    try {
      const res = await fetch('/api/copy/publisher', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: form.displayName,
          strategyDescription: form.strategyDescription || null,
          isPublic: form.isPublic,
          shareIndividualTrades: form.shareIndividualTrades,
        }),
      });

      const data = await res.json();

      if (res.status === 403) {
        setGateError(data as GateError);
        return;
      }

      if (!res.ok) {
        setSaveMessage(data.error ?? 'Failed to create publisher profile.');
        return;
      }

      setProfile(data as PublisherProfile);
      setSaveMessage('Publisher profile created successfully.');
    } catch {
      setSaveMessage('Network error. Please try again.');
    } finally {
      setSaving(false);
      setIsCreating(false);
    }
  }

  async function handleUpdate() {
    if (!profile) return;
    setSaving(true);
    setSaveMessage('');

    try {
      const res = await fetch('/api/copy/publisher', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: form.displayName,
          strategyDescription: form.strategyDescription || null,
          isPublic: form.isPublic,
          shareIndividualTrades: form.shareIndividualTrades,
          feePercent: form.feePercent,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setSaveMessage(data.error ?? 'Failed to update publisher profile.');
        return;
      }

      setProfile(data as PublisherProfile);
      setSaveMessage('Profile updated successfully.');
    } catch {
      setSaveMessage('Network error. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeactivate() {
    if (!profile) return;
    const confirmed = window.confirm(
      'Deactivating your profile will stop new subscriptions. Existing subscribers will no longer receive your signals. Continue?',
    );
    if (!confirmed) return;

    setSaving(true);
    setSaveMessage('');

    try {
      const res = await fetch('/api/copy/publisher', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: false }),
      });

      const data = await res.json();

      if (!res.ok) {
        setSaveMessage(data.error ?? 'Failed to deactivate profile.');
        return;
      }

      setProfile(data as PublisherProfile);
      setSaveMessage('Profile deactivated. New subscriptions are now blocked.');
    } catch {
      setSaveMessage('Network error. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function handleReactivate() {
    if (!profile) return;
    setSaving(true);
    setSaveMessage('');

    try {
      const res = await fetch('/api/copy/publisher', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: true }),
      });

      const data = await res.json();

      if (!res.ok) {
        setSaveMessage(data.error ?? 'Failed to reactivate profile.');
        return;
      }

      setProfile(data as PublisherProfile);
      setSaveMessage('Profile reactivated. New subscriptions are open.');
    } catch {
      setSaveMessage('Network error. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-muted-foreground">Loading…</p>
      </div>
    );
  }

  const isProfileActive = profile?.isActive ?? true;

  return (
    <div className="max-w-2xl mx-auto py-10 px-4 space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Publisher Profile</h1>
          <p className="text-muted-foreground mt-1">
            Share your AI signals publicly and build a track record for performance-fee income.
          </p>
        </div>
        {profile && (
          <Link href="/copy/publisher/earnings">
            <Button variant="outline" size="sm" className="shrink-0">
              View Earnings
            </Button>
          </Link>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Gate error — not enough closed trades                               */}
      {/* ------------------------------------------------------------------ */}
      {gateError && (
        <Card className="p-6 border-destructive bg-destructive/5">
          <p className="font-semibold text-destructive">Track record requirement not met</p>
          <p className="text-sm mt-1">{gateError.error}</p>
          {gateError.closedTrades !== undefined && gateError.required !== undefined && (
            <div className="mt-3 w-full bg-secondary rounded-full h-2">
              <div
                className="bg-primary h-2 rounded-full transition-all"
                style={{
                  width: `${Math.min(100, (gateError.closedTrades / gateError.required) * 100)}%`,
                }}
              />
            </div>
          )}
          {gateError.closedTrades !== undefined && gateError.required !== undefined && (
            <p className="text-xs text-muted-foreground mt-2">
              {gateError.closedTrades} / {gateError.required} closed trades
            </p>
          )}
        </Card>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Deactivated banner                                                   */}
      {/* ------------------------------------------------------------------ */}
      {profile && !isProfileActive && (
        <Card className="p-4 border-yellow-500 bg-yellow-50 dark:bg-yellow-950/20">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="font-medium text-yellow-800 dark:text-yellow-300">Profile deactivated</p>
              <p className="text-sm text-yellow-700 dark:text-yellow-400 mt-0.5">
                New subscriptions are blocked. Your existing profile data is preserved.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={handleReactivate}
              disabled={saving}
            >
              Reactivate
            </Button>
          </div>
        </Card>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Live performance stats (read-only)                                  */}
      {/* ------------------------------------------------------------------ */}
      {profile && (
        <Card className="p-6 space-y-4">
          <div>
            <h2 className="text-lg font-semibold">Performance Stats</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Computed from your published signals. Read-only.
            </p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <StatCard label="Total Signals" value={profile.stats.totalSignals ?? 0} />
            <StatCard label="Win Rate" value={formatPct(profile.stats.winRate)} />
            <StatCard label="Avg R:R" value={formatRatio(profile.stats.avgRR)} />
            <StatCard label="Sharpe Ratio" value={formatRatio(profile.stats.sharpeRatio)} />
            <StatCard label="Max Drawdown" value={formatPct(profile.stats.maxDrawdown)} />
            <StatCard label="Subscribers" value={profile.stats.subscriberCount ?? 0} />
          </div>
          <p className="text-xs text-muted-foreground">
            Public profile link:{' '}
            <a
              href={`/copy/${profile.id}`}
              className="underline underline-offset-2 hover:text-foreground"
              target="_blank"
              rel="noopener noreferrer"
            >
              /copy/{profile.id}
            </a>
          </p>
        </Card>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Profile form                                                         */}
      {/* ------------------------------------------------------------------ */}
      <Card className="p-6 space-y-6">
        <div>
          <h2 className="text-lg font-semibold">
            {profile ? 'Edit Profile' : 'Create Publisher Profile'}
          </h2>
          {!profile && (
            <p className="text-sm text-muted-foreground mt-0.5">
              You need at least 20 closed trades to publish. Your profile will appear on the
              leaderboard if set to Public.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Display Name (public-facing)</label>
          <Input
            placeholder="e.g. CryptoTrader Pro"
            value={form.displayName}
            onChange={(e) => setField('displayName', e.target.value)}
            maxLength={100}
          />
          <p className="text-xs text-muted-foreground">{form.displayName.length}/100</p>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Strategy Description</label>
          <textarea
            className="flex min-h-[100px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder="Describe your trading strategy: what you trade, timeframes, technical approach…"
            value={form.strategyDescription}
            onChange={(e) => setField('strategyDescription', e.target.value)}
          />
        </div>

        <Separator />

        <div className="space-y-4">
          <h3 className="font-medium">Visibility</h3>

          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-input"
              checked={form.isPublic}
              onChange={(e) => setField('isPublic', e.target.checked)}
            />
            <div>
              <p className="text-sm font-medium">Public — listed on leaderboard</p>
              <p className="text-xs text-muted-foreground">
                Anyone can discover and follow your profile. Uncheck for invite-only via direct link.
              </p>
            </div>
          </label>

          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-input"
              checked={form.shareIndividualTrades}
              onChange={(e) => setField('shareIndividualTrades', e.target.checked)}
            />
            <div>
              <p className="text-sm font-medium">Share individual trade history</p>
              <p className="text-xs text-muted-foreground">
                Show individual signal entries and exits on your public profile page.
              </p>
            </div>
          </label>
        </div>

        {profile && (
          <>
            <Separator />
            <div className="space-y-2">
              <label className="text-sm font-medium">Performance Fee (%)</label>
              <Input
                type="number"
                min="0"
                max="30"
                step="0.01"
                placeholder="0.00"
                value={form.feePercent}
                onChange={(e) => setField('feePercent', e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Fee charged on profitable copied trades only. Range: 0–30%.
              </p>
            </div>
          </>
        )}

        <div className="flex flex-wrap items-center gap-4 pt-2">
          <Button
            onClick={profile ? handleUpdate : handleCreate}
            disabled={saving || !form.displayName.trim()}
          >
            {saving && isCreating
              ? 'Creating…'
              : saving
              ? 'Saving…'
              : profile
              ? 'Save Changes'
              : 'Create Profile'}
          </Button>

          {profile && isProfileActive && (
            <Button
              variant="destructive"
              onClick={handleDeactivate}
              disabled={saving}
            >
              Deactivate Profile
            </Button>
          )}

          {saveMessage && (
            <span
              className={`text-sm ${
                saveMessage.includes('success') || saveMessage.includes('reactivated')
                  ? 'text-green-600'
                  : saveMessage.includes('deactivated')
                  ? 'text-yellow-600'
                  : 'text-red-600'
              }`}
            >
              {saveMessage}
            </span>
          )}
        </div>
      </Card>
    </div>
  );
}
