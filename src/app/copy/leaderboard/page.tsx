'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Publisher {
  rank: number;
  id: string;
  displayName: string | null;
  strategyDescription: string | null;
  timeframeFocus: string | null;
  strategyType: string | null;
  maxDrawdown: number | null;
  subscriberCount: number;
  feePercent: number;
  winRate: number | null;
  avgRR: number | null;
  totalSignals90d: number;
  totalReturn90d: number | null;
  sharpeRatio: number | null;
}

interface LeaderboardResponse {
  publishers: Publisher[];
  windowDays: number;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(value: number | null, decimals = 2, suffix = ''): string {
  if (value == null) return '—';
  return `${value.toFixed(decimals)}${suffix}`;
}

// ---------------------------------------------------------------------------
// Filter/sort controls
// ---------------------------------------------------------------------------

const TIMEFRAME_OPTIONS = [
  { value: '', label: 'All Timeframes' },
  { value: 'scalp', label: 'Scalp' },
  { value: 'swing', label: 'Swing' },
  { value: 'position', label: 'Position' },
];

const STRATEGY_OPTIONS = [
  { value: '', label: 'All Strategies' },
  { value: 'SMC', label: 'SMC' },
  { value: 'technical', label: 'Technical' },
  { value: 'pattern', label: 'Pattern' },
];

const MAX_DRAWDOWN_OPTIONS = [
  { value: '', label: 'Any Drawdown' },
  { value: '10', label: 'Max 10%' },
  { value: '20', label: 'Max 20%' },
  { value: '30', label: 'Max 30%' },
  { value: '50', label: 'Max 50%' },
];

const SORT_OPTIONS = [
  { value: 'sharpe', label: 'Sharpe Ratio' },
  { value: 'winRate', label: 'Win Rate' },
  { value: 'totalReturn', label: 'Total Return' },
  { value: 'subscribers', label: 'Subscriber Count' },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function LeaderboardPage() {
  const [publishers, setPublishers] = useState<Publisher[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);

  // Filter/sort state
  const [timeframeFocus, setTimeframeFocus] = useState('');
  const [strategyType, setStrategyType] = useState('');
  const [maxDrawdownMax, setMaxDrawdownMax] = useState('');
  const [sortBy, setSortBy] = useState('sharpe');

  const fetchLeaderboard = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (timeframeFocus) params.set('timeframeFocus', timeframeFocus);
      if (strategyType)   params.set('strategyType', strategyType);
      if (maxDrawdownMax) params.set('maxDrawdownMax', maxDrawdownMax);
      if (sortBy)         params.set('sortBy', sortBy);

      const res = await fetch(`/api/copy/leaderboard?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to load leaderboard');
      const data: LeaderboardResponse = await res.json();
      setPublishers(data.publishers);
      setGeneratedAt(data.generatedAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [timeframeFocus, strategyType, maxDrawdownMax, sortBy]);

  useEffect(() => {
    void fetchLeaderboard();
  }, [fetchLeaderboard]);

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black py-10 px-4">
      <div className="mx-auto max-w-7xl">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
            Signal Publisher Leaderboard
          </h1>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
            Ranked by risk-adjusted performance (Sharpe ratio primary, win rate secondary).
            Stats shown are based on the last <strong>90 days</strong> of closed trades.
            Only publishers with ≥&nbsp;20 closed trades and ≥&nbsp;30 days of history are shown.
          </p>
          {generatedAt && (
            <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-600">
              Last updated: {new Date(generatedAt).toLocaleString()}
            </p>
          )}
        </div>

        {/* Filters */}
        <Card className="mb-6 p-4">
          <div className="flex flex-wrap gap-3 items-center">
            <div className="flex flex-col gap-1 min-w-[160px]">
              <label className="text-xs font-medium text-zinc-500">Timeframe Focus</label>
              <select
                value={timeframeFocus}
                onChange={(e) => setTimeframeFocus(e.target.value)}
                className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              >
                {TIMEFRAME_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1 min-w-[160px]">
              <label className="text-xs font-medium text-zinc-500">Strategy Type</label>
              <select
                value={strategyType}
                onChange={(e) => setStrategyType(e.target.value)}
                className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              >
                {STRATEGY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1 min-w-[160px]">
              <label className="text-xs font-medium text-zinc-500">Max Drawdown</label>
              <select
                value={maxDrawdownMax}
                onChange={(e) => setMaxDrawdownMax(e.target.value)}
                className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              >
                {MAX_DRAWDOWN_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1 min-w-[160px]">
              <label className="text-xs font-medium text-zinc-500">Sort By</label>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>
        </Card>

        {/* Table */}
        {loading ? (
          <div className="flex justify-center py-20">
            <Spinner />
          </div>
        ) : error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-center text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
            {error}
          </div>
        ) : publishers.length === 0 ? (
          <div className="rounded-lg border border-zinc-200 bg-white p-10 text-center text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900">
            No publishers meet the eligibility criteria yet (≥ 20 closed trades, ≥ 30 days history).
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800">
                  <th className="px-4 py-3 font-semibold text-zinc-600 dark:text-zinc-300 w-12">Rank</th>
                  <th className="px-4 py-3 font-semibold text-zinc-600 dark:text-zinc-300">Publisher</th>
                  <th className="px-4 py-3 font-semibold text-zinc-600 dark:text-zinc-300">Strategy</th>
                  <th className="px-4 py-3 font-semibold text-zinc-600 dark:text-zinc-300 text-right">Win Rate</th>
                  <th className="px-4 py-3 font-semibold text-zinc-600 dark:text-zinc-300 text-right">Sharpe</th>
                  <th className="px-4 py-3 font-semibold text-zinc-600 dark:text-zinc-300 text-right">Max DD</th>
                  <th className="px-4 py-3 font-semibold text-zinc-600 dark:text-zinc-300 text-right">Avg R:R</th>
                  <th className="px-4 py-3 font-semibold text-zinc-600 dark:text-zinc-300 text-right">Signals (90d)</th>
                  <th className="px-4 py-3 font-semibold text-zinc-600 dark:text-zinc-300 text-right">Subscribers</th>
                </tr>
              </thead>
              <tbody>
                {publishers.map((pub) => (
                  <tr
                    key={pub.id}
                    className="border-b border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
                  >
                    <td className="px-4 py-3 font-bold text-zinc-700 dark:text-zinc-300">
                      #{pub.rank}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/copy/${pub.id}`}
                        className="font-medium text-zinc-900 dark:text-zinc-100 hover:underline"
                      >
                        {pub.displayName ?? 'Anonymous'}
                      </Link>
                      <div className="flex gap-1 mt-1 flex-wrap">
                        {pub.timeframeFocus && (
                          <Badge variant="secondary" className="text-xs capitalize">
                            {pub.timeframeFocus}
                          </Badge>
                        )}
                        {pub.strategyType && (
                          <Badge variant="outline" className="text-xs">
                            {pub.strategyType}
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 max-w-[200px]">
                      <p className="text-zinc-600 dark:text-zinc-400 text-xs line-clamp-2">
                        {pub.strategyDescription ?? '—'}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {fmt(pub.winRate, 1, '%')}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {fmt(pub.sharpeRatio, 2)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {pub.maxDrawdown != null ? (
                        <span className={pub.maxDrawdown > 30 ? 'text-red-500' : pub.maxDrawdown > 15 ? 'text-yellow-500' : 'text-green-600'}>
                          {fmt(pub.maxDrawdown, 1, '%')}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {fmt(pub.avgRR, 2)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {pub.totalSignals90d}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {pub.subscriberCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Disclaimer */}
        <p className="mt-6 text-xs text-zinc-400 dark:text-zinc-600 text-center">
          Performance shown is historical and does not guarantee future results. Past performance
          is not indicative of future performance. Copy trading carries risk — only copy traders
          whose strategy you understand and whose risk level you can tolerate.
        </p>
      </div>
    </div>
  );
}
