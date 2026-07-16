'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  DollarSign,
  TrendingUp,
  TrendingDown,
  Activity,
  RefreshCw,
  AlertTriangle,
  ShieldAlert,
  Zap,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CircuitBreakerPanel } from '@/components/circuit-breaker/circuit-breaker-panel';
import { PositionDrawer } from '@/components/trade/position-drawer';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OpenPosition {
  id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  exchangeName: string;
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

function formatPrice(value: number | null): string {
  if (value === null) return '—';
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 });
}

function formatPct(value: number | null): string {
  if (value === null || value === undefined) return 'N/A';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

function StatCard({
  title,
  value,
  sub,
  icon: Icon,
  trend,
  accent,
}: {
  title: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  icon: React.ElementType;
  trend?: 'up' | 'down' | 'neutral';
  accent?: 'green' | 'red' | 'blue' | 'default';
}) {
  const iconBg = {
    green: 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-400',
    red: 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-400',
    blue: 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-400',
    default: 'bg-muted text-muted-foreground',
  }[accent ?? 'default'];

  const TrendIcon = trend === 'up' ? ArrowUpRight : trend === 'down' ? ArrowDownRight : Minus;
  const trendColor = trend === 'up'
    ? 'text-green-600 dark:text-green-400'
    : trend === 'down'
      ? 'text-red-600 dark:text-red-400'
      : 'text-muted-foreground';

  return (
    <Card className="p-5 gap-0">
      <div className="flex items-start justify-between">
        <div className="space-y-1.5 flex-1 min-w-0">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider truncate">{title}</p>
          <p className="text-2xl font-bold tabular-nums leading-none">{value}</p>
          {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
        </div>
        <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl ml-3', iconBg)}>
          <Icon className="size-4" />
        </div>
      </div>
      {trend && (
        <div className={cn('mt-3 flex items-center gap-1 text-xs font-medium', trendColor)}>
          <TrendIcon className="size-3.5" />
          <span>{trend === 'up' ? 'Profitable today' : trend === 'down' ? 'Loss today' : 'Flat today'}</span>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Position row
// ---------------------------------------------------------------------------

function PositionRow({ pos, onOpen }: { pos: OpenPosition; onOpen: () => void }) {
  const pnlPositive = pos.unrealizedPnlUsd !== null && pos.unrealizedPnlUsd >= 0;

  return (
    <tr
      className="border-b last:border-0 hover:bg-accent/50 transition-colors cursor-pointer"
      onClick={onOpen}
    >
      <td className="py-3 px-4">
        <span className="font-semibold text-sm">{pos.symbol}</span>
      </td>
      <td className="py-3 px-4">
        <Badge
          variant={pos.direction === 'LONG' ? 'default' : 'destructive'}
          className="text-xs font-semibold"
        >
          {pos.direction === 'LONG' ? '↑ LONG' : '↓ SHORT'}
        </Badge>
      </td>
      <td className="py-3 px-4 text-sm tabular-nums text-muted-foreground">{formatPrice(pos.entryPrice)}</td>
      <td className="py-3 px-4 text-sm tabular-nums">
        {pos.currentPrice !== null ? formatPrice(pos.currentPrice) : <span className="text-muted-foreground">—</span>}
      </td>
      <td className="py-3 px-4 text-sm tabular-nums">
        <span className={pos.unrealizedPnlUsd === null ? 'text-muted-foreground' : pnlPositive ? 'text-green-600 dark:text-green-400 font-medium' : 'text-red-600 dark:text-red-400 font-medium'}>
          {pos.unrealizedPnlUsd === null ? '—' : formatCurrency(pos.unrealizedPnlUsd)}
        </span>
      </td>
      <td className="py-3 px-4 text-sm tabular-nums">
        {pos.unrealizedPnlPct !== null ? (
          <span className={pos.unrealizedPnlPct >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>
            {formatPct(pos.unrealizedPnlPct)}
          </span>
        ) : <span className="text-muted-foreground">—</span>}
      </td>
      <td className="py-3 px-4 text-sm tabular-nums text-red-400">{pos.stopLoss !== null ? formatPrice(pos.stopLoss) : '—'}</td>
      <td className="py-3 px-4 text-sm tabular-nums text-green-400">{pos.takeProfit !== null ? formatPrice(pos.takeProfit) : '—'}</td>
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
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [selectedPosition, setSelectedPosition] = useState<OpenPosition | null>(null);

  const fetchData = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true);
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
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
    const interval = setInterval(() => void fetchData(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center space-y-2">
          <RefreshCw className="size-6 animate-spin text-muted-foreground mx-auto" />
          <p className="text-sm text-muted-foreground">Loading dashboard…</p>
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="p-6">
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="p-6 space-y-3">
            <div className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="size-4" />
              <p className="font-semibold">Failed to load dashboard</p>
            </div>
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void fetchData()}>Retry</Button>
          </CardContent>
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
  const isHalted = cbState === 'red' || cbState === 'locked';
  const pnlTrend = realizedPnlToday > 0 ? 'up' : realizedPnlToday < 0 ? 'down' : 'neutral';
  const unrealizedTrend = openPositions.length === 0 ? undefined : unrealizedPnl > 0 ? 'up' : unrealizedPnl < 0 ? 'down' : 'neutral';
  const tradeRatio = maxTradesPerDay > 0 ? tradesToday / maxTradesPerDay : 0;
  const tradesAccent = tradeRatio >= 0.8 ? 'red' : 'default';

  return (
    <div className="p-4 sm:p-6 space-y-6">

      {/* Alert banners */}
      {(isPaper || isHalted) && (
        <div className="space-y-2">
          {isPaper && (
            <div className="flex items-center gap-2.5 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 dark:bg-blue-950/50 dark:border-blue-800">
              <ShieldAlert className="size-4 text-blue-600 dark:text-blue-400 shrink-0" />
              <p className="text-sm font-medium text-blue-800 dark:text-blue-200">
                Paper Trading Mode — No real funds at risk
              </p>
            </div>
          )}
          {isHalted && (
            <div className="flex items-center gap-2.5 rounded-lg border border-red-300 bg-red-50 px-4 py-2.5 dark:bg-red-950/50 dark:border-red-700">
              <AlertTriangle className="size-4 text-red-600 dark:text-red-400 shrink-0" />
              <p className="text-sm font-semibold text-red-800 dark:text-red-200">
                {cbState === 'locked'
                  ? 'Kill switch ON — all trading halted'
                  : 'Daily risk limit reached — trading halted until midnight UTC'}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Portfolio overview{lastRefreshed && <> · Updated {lastRefreshed.toLocaleTimeString()}</>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {pendingSignalsCount > 0 && (
            <Link href="/signals">
              <Button variant="outline" size="sm" className="gap-2">
                <Zap className="size-3.5" />
                Signals
                <Badge className="h-5 min-w-5 rounded-full px-1.5 text-xs font-bold">
                  {pendingSignalsCount}
                </Badge>
              </Button>
            </Link>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void fetchData(true)}
            disabled={refreshing}
            className="gap-2"
          >
            <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Stale data warning */}
      {error && data && (
        <div className="flex items-center gap-2 rounded-md border border-yellow-200 bg-yellow-50 px-3 py-2 dark:bg-yellow-950/50 dark:border-yellow-700">
          <AlertTriangle className="size-3.5 text-yellow-600 shrink-0" />
          <p className="text-xs text-yellow-800 dark:text-yellow-200">Refresh failed: {error}</p>
        </div>
      )}

      {/* Stat cards */}
      <div data-tour="stat-cards" className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Account Equity"
          icon={DollarSign}
          accent="blue"
          value={
            equity !== null
              ? <>${equity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</>
              : <span className="text-muted-foreground text-base">{isPaper ? 'Paper' : 'N/A'}</span>
          }
          sub={isPaper ? 'Simulated account' : 'Live balance'}
        />
        <StatCard
          title="Realized P&L Today"
          icon={realizedPnlToday >= 0 ? TrendingUp : TrendingDown}
          accent={realizedPnlToday > 0 ? 'green' : realizedPnlToday < 0 ? 'red' : 'default'}
          trend={pnlTrend}
          value={
            <span className={realizedPnlToday > 0 ? 'text-green-600 dark:text-green-400' : realizedPnlToday < 0 ? 'text-red-600 dark:text-red-400' : ''}>
              {formatCurrency(realizedPnlToday)}
            </span>
          }
          sub="Closed trades (UTC day)"
        />
        <StatCard
          title="Unrealized P&L"
          icon={Activity}
          accent={openPositions.length === 0 ? 'default' : unrealizedPnl >= 0 ? 'green' : 'red'}
          trend={unrealizedTrend}
          value={
            openPositions.length === 0
              ? <span className="text-muted-foreground text-lg">No positions</span>
              : <span className={unrealizedPnl >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>
                  {formatCurrency(unrealizedPnl)}
                </span>
          }
          sub="Floating P&L on open positions"
        />
        <StatCard
          title="Trades Today"
          icon={Zap}
          accent={tradesAccent}
          value={`${tradesToday} / ${maxTradesPerDay}`}
          sub={tradeRatio >= 1 ? 'Daily limit reached' : `${maxTradesPerDay - tradesToday} remaining`}
        />
      </div>

      {/* Open positions */}
      <div className="space-y-3">
        <h2 className="text-base font-semibold">
          Open Positions
          {openPositions.length > 0 && (
            <span className="ml-2 text-sm font-normal text-muted-foreground">({openPositions.length})</span>
          )}
        </h2>

        {openPositions.length === 0 ? (
          <Card>
            <CardContent className="p-10 text-center">
              <Activity className="size-8 mx-auto text-muted-foreground/30 mb-3" />
              <p className="text-sm font-medium text-muted-foreground">No open positions</p>
              <p className="text-xs text-muted-foreground/60 mt-1">Positions will appear here when trades are executed</p>
            </CardContent>
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/30">
                    {['Symbol', 'Side', 'Entry', 'Current', 'P&L ($)', 'P&L (%)', 'SL', 'TP'].map((h) => (
                      <th key={h} className="py-3 px-4 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {openPositions.map((pos) => (
                    <PositionRow key={pos.id} pos={pos} onOpen={() => setSelectedPosition(pos)} />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>

      {/* Circuit breaker + signal queue */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div data-tour="circuit-breaker">
          <CircuitBreakerPanel />
        </div>

        <Card data-tour="signal-queue">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Zap className="size-4 text-primary" />
              Signal Approval Queue
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Pending AI signals awaiting manual review or auto-execution
            </p>
          </CardHeader>
          <CardContent>
            {pendingSignalsCount === 0 ? (
              <div className="py-6 text-center">
                <Zap className="size-6 mx-auto text-muted-foreground/30 mb-2" />
                <p className="text-sm text-muted-foreground">No pending signals</p>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-2xl font-bold tabular-nums">{pendingSignalsCount}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    signal{pendingSignalsCount !== 1 ? 's' : ''} awaiting review
                  </p>
                </div>
                <Link href="/signals">
                  <Button size="sm" className="gap-1.5">
                    View Signals
                    <ArrowUpRight className="size-3.5" />
                  </Button>
                </Link>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <PositionDrawer
        position={selectedPosition}
        open={selectedPosition !== null}
        onClose={() => setSelectedPosition(null)}
        onAction={() => { void fetchData(); setSelectedPosition(null); }}
      />
    </div>
  );
}
