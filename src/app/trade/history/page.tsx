'use client';

/**
 * Trade History Page — Route: /trade/history
 *
 * Displays a filterable, paginated log of all closed trades with:
 *  - Summary stats bar (win rate, P&L, largest win/loss)
 *  - Trade table with expandable AI reasoning
 *  - Date range, symbol, strategy, outcome, source, paper trade filters
 *  - CSV export of current filtered view
 */

import { useCallback, useEffect, useState, useRef } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TradeIndicators {
  rsi: number | null;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  emaAlignment: string | null;
  macdLine: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
}

interface Trade {
  id: string;
  entryAt: string | null;
  exitAt: string | null;
  symbol: string;
  direction: string | null;
  strategy: string | null;
  source: string;
  entryPrice: number | null;
  exitPrice: number | null;
  positionSize: number | null;
  realizedPnl: number | null;
  realizedPnlPct: number | null;
  status: string | null;
  fillType: string | null;
  mode: string;
  reasoning: string | null;
  confidence: string | null;
  indicators: TradeIndicators | null;
  newsSentiment: null;
  onChainBias: null;
}

interface Pagination {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasMore: boolean;
}

interface Summary {
  totalTrades: number;
  winRate: number;
  avgPnlPct: number;
  totalPnl: number;
  largestWin: number;
  largestLoss: number;
}

interface FilterOptions {
  symbols: string[];
  strategies: string[];
}

interface HistoryResponse {
  trades: Trade[];
  pagination: Pagination;
  summary: Summary;
  filterOptions: FilterOptions;
}

// ---------------------------------------------------------------------------
// Filter state
// ---------------------------------------------------------------------------

interface Filters {
  dateFrom: string;
  dateTo: string;
  symbols: string[];
  strategies: string[];
  outcome: 'all' | 'profit' | 'loss';
  source: 'all' | 'ai' | 'tradingview' | 'manual';
  includePaper: boolean;
}

const DEFAULT_FILTERS: Filters = {
  dateFrom: '',
  dateTo: '',
  symbols: [],
  strategies: [],
  outcome: 'all',
  source: 'all',
  includePaper: true,
};

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatPrice(v: number | null): string {
  if (v === null) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

function formatPnl(v: number | null): string {
  if (v === null) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function formatPct(v: number | null): string {
  if (v === null) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

function formatDateTime(ts: string | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

function pnlClass(v: number | null): string {
  if (v === null) return 'text-muted-foreground';
  return v >= 0
    ? 'text-green-600 dark:text-green-400'
    : 'text-red-600 dark:text-red-400';
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

function exportToCsv(trades: Trade[]): void {
  const headers = [
    'Date/Time',
    'Symbol',
    'Direction',
    'Strategy',
    'Source',
    'Entry Price',
    'Exit Price',
    'P&L ($)',
    'P&L (%)',
    'Status',
    'Fill Type',
    'Mode',
    'Confidence',
  ];

  const rows = trades.map((t) => [
    formatDateTime(t.entryAt),
    t.symbol,
    t.direction ?? '',
    t.strategy ?? '',
    t.source,
    t.entryPrice?.toString() ?? '',
    t.exitPrice?.toString() ?? '',
    t.realizedPnl?.toFixed(4) ?? '',
    t.realizedPnlPct?.toFixed(4) ?? '',
    t.status ?? '',
    t.fillType ?? '',
    t.mode,
    t.confidence ?? '',
  ]);

  const csv =
    [headers, ...rows]
      .map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `trade-history-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Component: Summary stat card
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  className = '',
}: {
  label: string;
  value: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className="p-4 space-y-1">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-xl font-semibold tabular-nums ${className}`}>{value}</p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Component: Expandable trade detail
// ---------------------------------------------------------------------------

function TradeDetail({ trade }: { trade: Trade }) {
  const ind = trade.indicators;

  return (
    <tr>
      <td colSpan={9} className="px-4 pb-4 pt-0 bg-muted/30">
        <div className="rounded-md border bg-background p-4 space-y-4 text-sm">

          {/* AI Reasoning */}
          {trade.reasoning ? (
            <div>
              <p className="font-medium mb-1">AI Reasoning</p>
              <p className="text-muted-foreground leading-relaxed whitespace-pre-wrap text-xs">
                {trade.reasoning}
              </p>
            </div>
          ) : (
            <p className="text-muted-foreground italic text-xs">No reasoning available.</p>
          )}

          {/* Indicators */}
          {ind && (
            <>
              <Separator />
              <div>
                <p className="font-medium mb-2">Indicator Values at Signal Time</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-1 text-xs text-muted-foreground">
                  <div><span className="font-medium text-foreground">RSI:</span> {ind.rsi?.toFixed(2) ?? '—'}</div>
                  <div><span className="font-medium text-foreground">EMA 20:</span> {ind.ema20 !== null ? formatPrice(ind.ema20) : '—'}</div>
                  <div><span className="font-medium text-foreground">EMA 50:</span> {ind.ema50 !== null ? formatPrice(ind.ema50) : '—'}</div>
                  <div><span className="font-medium text-foreground">EMA 200:</span> {ind.ema200 !== null ? formatPrice(ind.ema200) : '—'}</div>
                  <div><span className="font-medium text-foreground">EMA Alignment:</span> {ind.emaAlignment ?? '—'}</div>
                  <div><span className="font-medium text-foreground">MACD Line:</span> {ind.macdLine?.toFixed(4) ?? '—'}</div>
                  <div><span className="font-medium text-foreground">MACD Signal:</span> {ind.macdSignal?.toFixed(4) ?? '—'}</div>
                  <div><span className="font-medium text-foreground">MACD Histogram:</span> {ind.macdHistogram?.toFixed(4) ?? '—'}</div>
                </div>
              </div>
            </>
          )}

          {/* News sentiment & On-chain — not yet stored in rawPayload */}
          <Separator />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <p className="font-medium mb-1">News Sentiment</p>
              <p className="text-xs text-muted-foreground italic">
                Not stored at signal time (future enhancement).
              </p>
            </div>
            <div>
              <p className="font-medium mb-1">On-Chain Bias</p>
              <p className="text-xs text-muted-foreground italic">
                Not stored at signal time (future enhancement).
              </p>
            </div>
          </div>

          {/* Confidence + source */}
          <Separator />
          <div className="flex flex-wrap gap-4 text-xs">
            <div>
              <span className="font-medium text-foreground">Confidence:</span>{' '}
              {trade.confidence ?? '—'}
            </div>
            <div>
              <span className="font-medium text-foreground">Primary Signal Source:</span>{' '}
              {trade.source}
            </div>
          </div>

        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Component: Trade table row
// ---------------------------------------------------------------------------

function TradeRow({ trade }: { trade: Trade }) {
  const [expanded, setExpanded] = useState(false);

  const pnlVal = trade.realizedPnl;
  const pnlPctVal = trade.realizedPnlPct;

  return (
    <>
      <tr
        className="border-b last:border-0 hover:bg-muted/30 cursor-pointer transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <td className="py-3 px-4 text-xs text-muted-foreground whitespace-nowrap">
          {formatDateTime(trade.entryAt)}
        </td>
        <td className="py-3 px-4 font-medium text-sm">{trade.symbol}</td>
        <td className="py-3 px-4">
          {trade.direction ? (
            <Badge
              variant={trade.direction === 'LONG' ? 'default' : 'destructive'}
              className="text-xs"
            >
              {trade.direction}
            </Badge>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </td>
        <td className="py-3 px-4 text-xs text-muted-foreground max-w-[120px] truncate">
          {trade.strategy ?? '—'}
        </td>
        <td className="py-3 px-4 text-sm tabular-nums">{formatPrice(trade.entryPrice)}</td>
        <td className="py-3 px-4 text-sm tabular-nums">{formatPrice(trade.exitPrice)}</td>
        <td className={`py-3 px-4 text-sm tabular-nums font-medium ${pnlClass(pnlVal)}`}>
          {formatPnl(pnlVal)}
        </td>
        <td className={`py-3 px-4 text-sm tabular-nums ${pnlClass(pnlPctVal)}`}>
          {formatPct(pnlPctVal)}
        </td>
        <td className="py-3 px-4">
          <div className="flex items-center gap-1 flex-wrap">
            <Badge
              variant={
                trade.status === 'closed'
                  ? 'secondary'
                  : trade.status === 'cancelled'
                    ? 'outline'
                    : 'default'
              }
              className="text-xs"
            >
              {trade.status ?? 'unknown'}
            </Badge>
            {trade.mode === 'paper' && (
              <Badge variant="outline" className="text-xs border-blue-400 text-blue-600 dark:text-blue-400">
                PAPER
              </Badge>
            )}
          </div>
        </td>
      </tr>
      {expanded && <TradeDetail trade={trade} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Component: Multi-select toggle buttons
// ---------------------------------------------------------------------------

function MultiSelect({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (vals: string[]) => void;
}) {
  if (options.length === 0) return null;

  const toggle = (val: string) => {
    onChange(
      selected.includes(val) ? selected.filter((s) => s !== val) : [...selected, val],
    );
  };

  return (
    <div className="space-y-1">
      <label className="text-xs text-muted-foreground uppercase tracking-wide">{label}</label>
      <div className="flex flex-wrap gap-1">
        {options.map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => toggle(opt)}
            className={`px-2 py-0.5 text-xs rounded border transition-colors ${
              selected.includes(opt)
                ? 'bg-primary text-primary-foreground border-primary'
                : 'border-border text-muted-foreground hover:border-foreground hover:text-foreground'
            }`}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function TradeHistoryPage() {
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [showFilters, setShowFilters] = useState(false);

  // Pending filter state (applied only on "Apply")
  const [draftFilters, setDraftFilters] = useState<Filters>(DEFAULT_FILTERS);

  const abortRef = useRef<AbortController | null>(null);

  const fetchHistory = useCallback(async (currentPage: number, activeFilters: Filters) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({ page: String(currentPage) });
      if (activeFilters.dateFrom) params.set('dateFrom', activeFilters.dateFrom);
      if (activeFilters.dateTo) params.set('dateTo', activeFilters.dateTo);
      if (activeFilters.symbols.length > 0) params.set('symbol', activeFilters.symbols.join(','));
      if (activeFilters.strategies.length > 0) params.set('strategy', activeFilters.strategies.join(','));
      if (activeFilters.outcome !== 'all') params.set('outcome', activeFilters.outcome);
      if (activeFilters.source !== 'all') params.set('source', activeFilters.source);
      if (!activeFilters.includePaper) params.set('includePaper', 'false');

      const res = await fetch(`/api/trade-history?${params.toString()}`, {
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as Record<string, string>;
        throw new Error(body?.error ?? `Request failed: ${res.status}`);
      }
      const json = (await res.json()) as HistoryResponse;
      setData(json);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Failed to load trade history');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchHistory(page, filters);
  }, [fetchHistory, page, filters]);

  function applyFilters() {
    setFilters(draftFilters);
    setPage(1);
  }

  function clearFilters() {
    setDraftFilters(DEFAULT_FILTERS);
    setFilters(DEFAULT_FILTERS);
    setPage(1);
  }

  const summary = data?.summary;
  const pagination = data?.pagination;
  const trades = data?.trades ?? [];
  const filterOptions = data?.filterOptions ?? { symbols: [], strategies: [] };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-6">

      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Trade History</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Complete log of all closed trades with AI reasoning and performance stats.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowFilters((v) => !v)}
          >
            {showFilters ? 'Hide Filters' : 'Filters'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => exportToCsv(trades)}
            disabled={trades.length === 0}
          >
            Export CSV
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void fetchHistory(page, filters)}
            disabled={loading}
          >
            Refresh
          </Button>
        </div>
      </div>

      {/* Paper trade toggle */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            const next = { ...filters, includePaper: !filters.includePaper };
            setFilters(next);
            setDraftFilters(next);
            setPage(1);
          }}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            filters.includePaper ? 'bg-primary' : 'bg-muted'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
              filters.includePaper ? 'translate-x-4' : 'translate-x-1'
            }`}
          />
        </button>
        <span className="text-sm text-muted-foreground">Show paper trades</span>
      </div>

      {/* Filter panel */}
      {showFilters && (
        <Card className="p-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">

            {/* Date range */}
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground uppercase tracking-wide">From</label>
              <input
                type="date"
                value={draftFilters.dateFrom}
                onChange={(e) => setDraftFilters((f) => ({ ...f, dateFrom: e.target.value }))}
                className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground uppercase tracking-wide">To</label>
              <input
                type="date"
                value={draftFilters.dateTo}
                onChange={(e) => setDraftFilters((f) => ({ ...f, dateTo: e.target.value }))}
                className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>

            {/* Outcome */}
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground uppercase tracking-wide">Outcome</label>
              <select
                value={draftFilters.outcome}
                onChange={(e) =>
                  setDraftFilters((f) => ({
                    ...f,
                    outcome: e.target.value as Filters['outcome'],
                  }))
                }
                className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="all">All</option>
                <option value="profit">Profit</option>
                <option value="loss">Loss</option>
              </select>
            </div>

            {/* Source */}
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground uppercase tracking-wide">Source</label>
              <select
                value={draftFilters.source}
                onChange={(e) =>
                  setDraftFilters((f) => ({
                    ...f,
                    source: e.target.value as Filters['source'],
                  }))
                }
                className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="all">All Sources</option>
                <option value="ai">AI</option>
                <option value="tradingview">TradingView</option>
                <option value="manual">Manual</option>
              </select>
            </div>

          </div>

          {/* Symbol multi-select */}
          <MultiSelect
            label="Symbol"
            options={filterOptions.symbols}
            selected={draftFilters.symbols}
            onChange={(vals) => setDraftFilters((f) => ({ ...f, symbols: vals }))}
          />

          {/* Strategy multi-select */}
          <MultiSelect
            label="Strategy"
            options={filterOptions.strategies}
            selected={draftFilters.strategies}
            onChange={(vals) => setDraftFilters((f) => ({ ...f, strategies: vals }))}
          />

          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" onClick={applyFilters}>
              Apply Filters
            </Button>
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              Clear All
            </Button>
          </div>
        </Card>
      )}

      {/* Error */}
      {error && (
        <Card className="p-4 border-destructive">
          <p className="text-destructive text-sm">{error}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void fetchHistory(page, filters)}
          >
            Retry
          </Button>
        </Card>
      )}

      {/* Summary stats */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          <StatCard label="Total Trades" value={summary.totalTrades.toLocaleString()} />
          <StatCard
            label="Win Rate"
            value={`${summary.winRate.toFixed(1)}%`}
            className={summary.winRate >= 50 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}
          />
          <StatCard
            label="Avg P&L / Trade"
            value={formatPnl(summary.avgPnlPct)}
            className={pnlClass(summary.avgPnlPct)}
          />
          <StatCard
            label="Total Realized P&L"
            value={formatPnl(summary.totalPnl)}
            className={pnlClass(summary.totalPnl)}
          />
          <StatCard
            label="Largest Win"
            value={formatPnl(summary.largestWin)}
            className="text-green-600 dark:text-green-400"
          />
          <StatCard
            label="Largest Loss"
            value={formatPnl(summary.largestLoss)}
            className="text-red-600 dark:text-red-400"
          />
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="text-center py-12 text-muted-foreground">Loading trades&hellip;</div>
      )}

      {/* Empty state */}
      {!loading && !error && trades.length === 0 && (
        <Card className="p-8 text-center">
          <p className="text-muted-foreground">No closed trades found.</p>
          <p className="text-sm text-muted-foreground mt-1">
            Trades appear here after they are closed (SL/TP hit or manually closed).
          </p>
        </Card>
      )}

      {/* Trade table */}
      {!loading && trades.length > 0 && (
        <>
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="py-3 px-4 text-left font-medium text-muted-foreground whitespace-nowrap">Date / Time</th>
                    <th className="py-3 px-4 text-left font-medium text-muted-foreground">Symbol</th>
                    <th className="py-3 px-4 text-left font-medium text-muted-foreground">Direction</th>
                    <th className="py-3 px-4 text-left font-medium text-muted-foreground">Strategy</th>
                    <th className="py-3 px-4 text-left font-medium text-muted-foreground whitespace-nowrap">Entry</th>
                    <th className="py-3 px-4 text-left font-medium text-muted-foreground whitespace-nowrap">Exit</th>
                    <th className="py-3 px-4 text-left font-medium text-muted-foreground whitespace-nowrap">P&amp;L ($)</th>
                    <th className="py-3 px-4 text-left font-medium text-muted-foreground whitespace-nowrap">P&amp;L (%)</th>
                    <th className="py-3 px-4 text-left font-medium text-muted-foreground">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((trade) => (
                    <TradeRow key={trade.id} trade={trade} />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Pagination */}
          {pagination && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                {pagination.total.toLocaleString()} trade{pagination.total !== 1 ? 's' : ''} &middot; Page {pagination.page} of {pagination.totalPages}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1 || loading}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!pagination.hasMore || loading}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
