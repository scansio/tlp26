'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Card } from '@/components/ui/card';

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
  stats: PublisherStats;
  createdAt: string | null;
}

// ---------------------------------------------------------------------------
// Stat card
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

export default function PublisherPublicPage() {
  const params = useParams();
  const publisherId = params?.publisherId as string | undefined;

  const [profile, setProfile] = useState<PublisherProfile | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!publisherId) return;

    fetch(`/api/copy/publishers/${publisherId}`)
      .then(async (r) => {
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
      })
      .catch(() => setError('Network error. Please try again.'))
      .finally(() => setLoading(false));
  }, [publisherId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center space-y-2">
          <p className="text-lg font-medium">{error ?? 'Publisher not found.'}</p>
          <p className="text-sm text-muted-foreground">
            This profile may have been removed or the link may be incorrect.
          </p>
        </div>
      </div>
    );
  }

  const memberSince = profile.createdAt
    ? new Date(profile.createdAt).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
      })
    : null;

  return (
    <div className="max-w-2xl mx-auto py-10 px-4 space-y-8">
      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-bold">{profile.displayName ?? 'Anonymous Publisher'}</h1>
          {profile.isActive === false && (
            <span className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium text-yellow-700 border-yellow-300 bg-yellow-50 dark:bg-yellow-950/20 dark:text-yellow-400">
              Inactive
            </span>
          )}
          {profile.isPublic && (
            <span className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium text-green-700 border-green-300 bg-green-50 dark:bg-green-950/20 dark:text-green-400">
              Public
            </span>
          )}
        </div>
        {memberSince && (
          <p className="text-sm text-muted-foreground">Member since {memberSince}</p>
        )}
      </div>

      {/* Strategy description */}
      {profile.strategyDescription && (
        <Card className="p-6">
          <h2 className="text-lg font-semibold mb-2">Strategy</h2>
          <p className="text-sm leading-relaxed whitespace-pre-line">
            {profile.strategyDescription}
          </p>
        </Card>
      )}

      {/* Performance stats */}
      <Card className="p-6 space-y-4">
        <h2 className="text-lg font-semibold">Performance</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <StatCard label="Total Signals" value={profile.stats.totalSignals ?? 0} />
          <StatCard label="Win Rate" value={formatPct(profile.stats.winRate)} />
          <StatCard label="Avg R:R" value={formatRatio(profile.stats.avgRR)} />
          <StatCard label="Sharpe Ratio" value={formatRatio(profile.stats.sharpeRatio)} />
          <StatCard label="Max Drawdown" value={formatPct(profile.stats.maxDrawdown)} />
          <StatCard label="Subscribers" value={profile.stats.subscriberCount ?? 0} />
        </div>
      </Card>

      {/* Individual trade history — only shown when publisher opts in */}
      {profile.shareIndividualTrades ? (
        <Card className="p-6">
          <h2 className="text-lg font-semibold mb-2">Trade History</h2>
          <p className="text-sm text-muted-foreground">
            Detailed trade history will be available in a future update.
          </p>
        </Card>
      ) : (
        <Card className="p-6">
          <h2 className="text-lg font-semibold mb-2">Trade History</h2>
          <p className="text-sm text-muted-foreground">
            This publisher has not opted in to share individual trade details.
          </p>
        </Card>
      )}

      {/* Inactive notice */}
      {profile.isActive === false && (
        <Card className="p-4 border-yellow-500 bg-yellow-50 dark:bg-yellow-950/20">
          <p className="text-sm text-yellow-800 dark:text-yellow-300">
            This publisher has deactivated their profile. New subscriptions are currently unavailable.
          </p>
        </Card>
      )}
    </div>
  );
}
