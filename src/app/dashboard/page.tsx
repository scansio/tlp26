'use client';

/**
 * Dashboard Page — Portfolio Overview, Open Positions, P&L
 *
 * Route: /dashboard (protected by Clerk middleware)
 * Polls /api/dashboard every 30 seconds for fresh data.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { CircuitBreakerPanel } from '@/components/circuit-breaker/circuit-breaker-panel';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OpenPosition {
  id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number | null;
  currentPrice: number | null;
  positionSize: number | null;
  unrealizedPnlUsd: number | null;
  unrealizedPnlPct: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  mode: string;
  entryAt: string | null;
}

interface DashboardData {
  tradingMode: string;
  isPaper: boolean;
  equity: number | null;
  realizedPnlToday: number;
  unrealizedPnl: number;
  tradesToday: number;
  maxTradesPerDay: number;
  openPositions: OpenPosition[];
  pendingSignalsCount: number;
  circuitBreaker: {
    state: 'green' | 'yellow' | 'red' | 'locked';
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatCurrency(value: number | null, fallback = 'N/A'): string {
  if (value === null || value === undefined) return fallback;
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : value > 0 ? '+' : '';
  if (abs >= 1_000) return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `${sign}$${abs.toFixed(2)}`;
}

function formatPct(value: number | null): string {
  if (value === null || value === undefined) return 'N/A';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function formatPrice(value: number | null): string {
  if (value === null) return '—';
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PnlValue({ value, suffix = '' }: { value: number | null; suffix?: string }) {
  if (value === null) return <span className="text-muted-foreground">N/A</span>;
  const positive = value >= 0;
  return (
    <span className={positive ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>
      {formatCurrency(value)}{suffix}
    </span>
  );
}

function SummaryCard({
  title,
  value,
  sub,
}: {
  title: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <Card className="p-5 space-y-1">
      <p className="text-xs text-muted-foreground uppercase tracking-wide">{title}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </Card>
  );
}

function PositionRow({ pos }: { pos: OpenPosition }) {
  const profitable = pos.unrealizedPnlUsd !== null && pos.unrealizedPnlUsd >= 0;
  const losing = pos.unrealizedPnlUsd !== null && pos.unrealizedPnlUsd < 0;

  const rowBg = profitable
    ? 'bg-green-50/60 dark:bg-green-950/30'
    : losing
      ? 'bg-red-50/60 dark:bg-red-950/30'
      : '';

  return (
    <tr className={`border-b last:border-0 transition-colors ${rowBg}`}>
      <td className="py-3 px-4 font-medium text-sm">{pos.symbol}</td>
      <td className="py-3 px-4">
        <Badge
          variant={pos.direction === 'LONG' ? 'default' : 'destructive'}
          className="text-xs"
        >
          {pos.direction}
        </Badge>
      </td>
      <td className="py-3 px-4 text-sm tabular-nums">{formatPrice(pos.entryPrice)}</td>
      <td className="py-3 px-4 text-sm tabular-nums">
        {pos.currentPrice !== null ? formatPrice(pos.currentPrice) : <span className="text-muted-foreground">—</span>}
      </td>
      <td className="py-3 px-4 text-sm tabular-nums">
        <PnlValue value={pos.unrealizedPnlUsd} />
      </td>
      <td className="py-3 px-4 text-sm tabular-nums">
        {pos.unrealizedPnlPct !== null ? (
          <span className={pos.unrealizedPnlPct >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>
            {formatPct(pos.unrealizedPnlPct)}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="py-3 px-4 text-sm tabular-nums text-muted-foreground">
        {pos.stopLoss !== null ? formatPrice(pos.stopLoss) : '—'}
      </td>
      <td className="py-3 px-4 text-sm tabular-nums text-muted-foreground">
        {pos.takeProfit !== null ? formatPrice(pos.takeProfit) : '—'}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 30_000;

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/dashboard');
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as Record<string, string>;
        throw new Error(body?.error ?? `Request failed: ${res.status}`);
      }
      const json = (await res.json()) as DashboardData;
      setData(json);
      setError(null);
      setLastRefreshed(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();

    const interval = setInterval(() => void fetchData(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchData]);

  // -------------------------------------------------------------------------
  // Loading state
  // -------------------------------------------------------------------------
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <p className="text-muted-foreground">Loading dashboard&hellip;</p>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Error state
  // -------------------------------------------------------------------------
  if (error && !data) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <Card className="p-6 border-destructive">
          <p className="text-destructive font-medium">Failed to load dashboard</p>
          <p className="text-sm text-muted-foreground mt-1">{error}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-4"
            onClick={() => void fetchData()}
          >
            Retry
          </Button>
        </Card>
      </div>
    );
  }

  if (!data) return null;

  const {
    isPaper,
    equity,
    realizedPnlToday,
    unrealizedPnl,
    tradesToday,
    maxTradesPerDay,
    openPositions,
    pendingSignalsCount,
    circuitBreaker,
  } = data;

  const cbState = circuitBreaker?.state ?? 'green';
  const showRedBanner = cbState === 'red' || cbState === 'locked';

  return (
    <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-6">

      {/* PAPER TRADING banner */}
      {isPaper && (
        <div className="rounded-lg border border-blue-300 bg-blue-50 px-4 py-3 dark:bg-blue-950 dark:border-blue-700">
          <p className="text-sm font-semibold text-blue-800 dark:text-blue-200 text-center tracking-wide uppercase">
            Paper Trading Mode — No real funds at risk
          </p>
        </div>
      )}

      {/* Circuit breaker red / locked warning banner */}
      {showRedBanner && (
        <div className="rounded-lg border border-red-400 bg-red-50 px-4 py-3 dark:bg-red-950 dark:border-red-600">
          <p className="text-sm font-semibold text-red-800 dark:text-red-200 text-center">
            {cbState === 'locked'
              ? 'Kill switch is ON — all trading halted'
              : 'Daily risk limit reached — trading halted until midnight UTC'}
          </p>
        </div>
      )}

      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Portfolio overview and open positions
            {lastRefreshed && (
              <> &mdash; last updated {lastRefreshed.toLocaleTimeString()}</>
            )}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Pending signals badge */}
          {pendingSignalsCount > 0 && (
            <Link href="/signals">
              <Button variant="outline" size="sm" className="relative">
                Signals
                <span className="ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground">
                  {pendingSignalsCount}
                </span>
              </Button>
            </Link>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void fetchData()}
            disabled={loading}
          >
            Refresh
          </Button>
        </div>
      </div>

      {/* Non-blocking error (stale data case) */}
      {error && data && (
        <Card className="p-3 border-yellow-300 bg-yellow-50 dark:bg-yellow-950 dark:border-yellow-700">
          <p className="text-sm text-yellow-800 dark:text-yellow-200">
            Could not refresh data: {error}
          </p>
        </Card>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Portfolio summary cards                                             */}
      {/* ------------------------------------------------------------------ */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SummaryCard
          title="Account Equity"
          value={
            equity !== null ? (
              <span>${equity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            ) : (
              <span className="text-muted-foreground text-base">
                {isPaper ? 'Paper mode' : 'N/A'}
              </span>
            )
          }
          sub={isPaper ? 'Simulated account' : 'Live exchange balance'}
        />
        <SummaryCard
          title="Realized P&L Today"
          value={<PnlValue value={realizedPnlToday} />}
          sub="Closed trades (UTC day)"
        />
        <SummaryCard
          title="Unrealized P&L"
          value={
            openPositions.length > 0 ? (
              <PnlValue value={unrealizedPnl} />
            ) : (
              <span className="text-muted-foreground text-base">No open positions</span>
            )
          }
          sub="Floating P&L on open positions"
        />
        <SummaryCard
          title="Trades Today"
          value={`${tradesToday} / ${maxTradesPerDay}`}
          sub="Daily trade count vs limit"
        />
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Open positions table                                                */}
      {/* ------------------------------------------------------------------ */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">
            Open Positions
            {openPositions.length > 0 && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                ({openPositions.length})
              </span>
            )}
          </h2>
        </div>

        {openPositions.length === 0 ? (
          <Card className="p-8 text-center">
            <p className="text-muted-foreground">No open positions</p>
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="py-3 px-4 text-left font-medium text-muted-foreground">Symbol</th>
                    <th className="py-3 px-4 text-left font-medium text-muted-foreground">Side</th>
                    <th className="py-3 px-4 text-left font-medium text-muted-foreground">Entry</th>
                    <th className="py-3 px-4 text-left font-medium text-muted-foreground">Current</th>
                    <th className="py-3 px-4 text-left font-medium text-muted-foreground">P&amp;L ($)</th>
                    <th className="py-3 px-4 text-left font-medium text-muted-foreground">P&amp;L (%)</th>
                    <th className="py-3 px-4 text-left font-medium text-muted-foreground">SL</th>
                    <th className="py-3 px-4 text-left font-medium text-muted-foreground">TP</th>
                  </tr>
                </thead>
                <tbody>
                  {openPositions.map((pos) => (
                    <PositionRow key={pos.id} pos={pos} />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>

      <Separator />

      {/* ------------------------------------------------------------------ */}
      {/* Circuit breaker panel                                               */}
      {/* ------------------------------------------------------------------ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <CircuitBreakerPanel />

        {/* Pending signals CTA */}
        <Card className="p-6 space-y-4">
          <div>
            <h2 className="text-base font-semibold">Signal Approval Queue</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Pending AI signals awaiting manual review or auto-execution.
            </p>
          </div>
          <Separator />
          {pendingSignalsCount === 0 ? (
            <p className="text-sm text-muted-foreground">No pending signals.</p>
          ) : (
            <div className="flex items-center justify-between">
              <p className="text-sm">
                <span className="font-semibold tabular-nums">{pendingSignalsCount}</span>
                {' '}signal{pendingSignalsCount !== 1 ? 's' : ''} awaiting review
              </p>
              <Link href="/signals">
                <Button size="sm">View Signals</Button>
              </Link>
            </div>
          )}
        </Card>
      </div>

    </div>
  );
}
