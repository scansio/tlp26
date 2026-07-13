'use client';

/**
 * Backtest UI — Route: /backtest
 *
 * Allows traders to configure and run historical strategy simulations,
 * visualise equity curves with drawdown shading, inspect per-trade breakdowns,
 * compare two runs side-by-side, and reload past saved runs from the sidebar.
 *
 * DISCLAIMER: Past performance does not guarantee future results.
 * This simulation does not account for all market conditions.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

// ---------------------------------------------------------------------------
// Types (mirrors BacktestResult from src/lib/backtester.ts)
// ---------------------------------------------------------------------------

interface EquityPoint {
  date: string;
  portfolioValue: number;
}

interface TradeRecord {
  date: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entry: number;
  exit: number;
  pnl: number;
  strategy: string;
}

interface StrategyMetrics {
  strategy: string;
  totalTrades: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  maxDrawdownPct: number;
  maxDrawdownUsdt: number;
  sharpeRatio: number;
  totalReturnPct: number;
  equityCurve: EquityPoint[];
}

interface BacktestMetrics {
  totalTrades: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  maxDrawdownPct: number;
  maxDrawdownUsdt: number;
  sharpeRatio: number;
  totalReturnPct: number;
  equityCurve: EquityPoint[];
  perStrategy: StrategyMetrics[];
  trades: TradeRecord[];
}

interface BacktestConfig {
  symbol: string;
  timeframe: string;
  startDate: string | Date;
  endDate: string | Date;
  exchange?: string;
  initialBalance?: number;
}

interface BacktestResult {
  id: string;
  config: BacktestConfig;
  metrics: BacktestMetrics;
  equityCurve: EquityPoint[];
  createdAt: string | Date;
}

interface PastRun {
  id: string;
  config: BacktestConfig;
  createdAt: string | Date;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POPULAR_SYMBOLS = [
  'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT',
  'ADA/USDT', 'DOGE/USDT', 'AVAX/USDT', 'MATIC/USDT', 'LINK/USDT',
  'DOT/USDT', 'UNI/USDT', 'ATOM/USDT', 'LTC/USDT', 'FIL/USDT',
];

const TIMEFRAMES = [
  { label: '15m', value: '15m' },
  { label: '1h', value: '1h' },
  { label: '4h', value: '4h' },
  { label: '1d', value: '1d' },
];

const ALL_STRATEGIES = ['SMC', 'Technical Indicators', 'Chart Patterns', 'Trend Following'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(n: number | null | undefined, decimals = 2): string {
  if (n === null || n === undefined) return 'N/A';
  if (!isFinite(n)) return n > 0 ? '+∞' : '0';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : n > 0 ? '+' : '';
  return `${sign}${abs.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

function fmtCurrency(n: number | null | undefined): string {
  if (n === null || n === undefined) return 'N/A';
  const sign = n < 0 ? '-' : n > 0 ? '+' : '';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtShortDate(d: string): string {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface MetricCardProps {
  label: string;
  value: string;
  positive?: boolean | null;
}

function MetricCard({ label, value, positive }: MetricCardProps) {
  const colorClass =
    positive === true
      ? 'text-emerald-400'
      : positive === false
        ? 'text-red-400'
        : 'text-white';
  return (
    <div className="rounded-lg bg-zinc-800/60 p-3 flex flex-col gap-1">
      <span className="text-xs text-zinc-400 uppercase tracking-wide">{label}</span>
      <span className={`text-lg font-semibold ${colorClass}`}>{value}</span>
    </div>
  );
}

interface EquityChartProps {
  primaryCurve: EquityPoint[];
  compareCurve?: EquityPoint[];
  primaryLabel?: string;
  compareLabel?: string;
}

function EquityChart({ primaryCurve, compareCurve, primaryLabel = 'Run A', compareLabel = 'Run B' }: EquityChartProps) {
  // Build unified time axis
  const allDates = Array.from(
    new Set([
      ...primaryCurve.map((p) => p.date),
      ...(compareCurve ?? []).map((p) => p.date),
    ]),
  ).sort();

  const primaryMap = new Map(primaryCurve.map((p) => [p.date, p.portfolioValue]));
  const compareMap = compareCurve ? new Map(compareCurve.map((p) => [p.date, p.portfolioValue])) : null;

  // Compute running peak for drawdown shading — build via reduce to avoid
  // post-render mutation lint errors
  const data = allDates.reduce<
    Array<{
      date: string;
      drawdownFloor?: number;
      drawdownCeiling?: number;
      [key: string]: number | string | undefined;
    }>
  >((acc, date) => {
    const prevPeak = acc.length > 0
      ? (acc[acc.length - 1].drawdownCeiling ?? (acc[acc.length - 1][primaryLabel] as number | undefined) ?? (primaryCurve[0]?.portfolioValue ?? 0))
      : (primaryCurve[0]?.portfolioValue ?? 0);
    const pv = primaryMap.get(date);
    const runningPeak = pv !== undefined && pv > prevPeak ? pv : prevPeak;
    const drawdownFloor = pv !== undefined && pv < runningPeak ? pv : undefined;
    acc.push({
      date,
      [primaryLabel]: pv,
      drawdownFloor,
      drawdownCeiling: drawdownFloor !== undefined ? runningPeak : undefined,
      ...(compareMap ? { [compareLabel]: compareMap.get(date) } : {}),
    });
    return acc;
  }, []);

  const initialBalance = primaryCurve[0]?.portfolioValue ?? 10000;

  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={data} margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" />
        <XAxis
          dataKey="date"
          tickFormatter={fmtShortDate}
          tick={{ fontSize: 11, fill: '#a1a1aa' }}
          tickLine={false}
          axisLine={false}
          minTickGap={40}
        />
        <YAxis
          tickFormatter={(v) => `$${(v / 1000).toFixed(1)}k`}
          tick={{ fontSize: 11, fill: '#a1a1aa' }}
          tickLine={false}
          axisLine={false}
          width={56}
        />
        <Tooltip
          contentStyle={{ backgroundColor: '#18181b', border: '1px solid #3f3f46', borderRadius: 6 }}
          labelStyle={{ color: '#a1a1aa', fontSize: 11 }}
          formatter={(value, name) => [fmtCurrency(typeof value === 'number' ? value : null), String(name)]}
          labelFormatter={(label) => fmtShortDate(String(label))}
        />
        <Legend wrapperStyle={{ fontSize: 12, color: '#a1a1aa' }} />
        {/* Drawdown shading */}
        <Area
          dataKey="drawdownCeiling"
          stroke="none"
          fill="#ef4444"
          fillOpacity={0.15}
          legendType="none"
          connectNulls={false}
          isAnimationActive={false}
          dot={false}
          activeDot={false}
          name=""
          hide={false}
        />
        <Area
          dataKey="drawdownFloor"
          stroke="none"
          fill="#18181b"
          fillOpacity={1}
          legendType="none"
          connectNulls={false}
          isAnimationActive={false}
          dot={false}
          activeDot={false}
          name=""
          hide={false}
        />
        <ReferenceLine y={initialBalance} stroke="#52525b" strokeDasharray="4 2" />
        {/* Primary curve */}
        <Area
          type="monotone"
          dataKey={primaryLabel}
          stroke="#10b981"
          fill="#10b981"
          fillOpacity={0.08}
          strokeWidth={2}
          dot={false}
          connectNulls
        />
        {/* Compare curve */}
        {compareCurve && (
          <Area
            type="monotone"
            dataKey={compareLabel}
            stroke="#f59e0b"
            fill="#f59e0b"
            fillOpacity={0.08}
            strokeWidth={2}
            dot={false}
            connectNulls
          />
        )}
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function BacktestPage() {
  // Configuration state
  const [symbol, setSymbol] = useState('BTC/USDT');
  const [symbolSearch, setSymbolSearch] = useState('');
  const [timeframe, setTimeframe] = useState('1h');
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 3);
    return d.toISOString().slice(0, 10);
  });
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [selectedStrategies, setSelectedStrategies] = useState<string[]>([]);
  const [userStrategies, setUserStrategies] = useState<string[]>([]);

  // Run state
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Results state — slot A and slot B for comparison
  const [resultA, setResultA] = useState<BacktestResult | null>(null);
  const [resultB, setResultB] = useState<BacktestResult | null>(null);
  const [activeSlot, setActiveSlot] = useState<'A' | 'B'>('A');

  // Past runs sidebar
  const [pastRuns, setPastRuns] = useState<PastRun[]>([]);
  const [pastRunsLoading, setPastRunsLoading] = useState(false);

  // UI state
  const [activeTab, setActiveTab] = useState<'metrics' | 'strategies' | 'trades'>('metrics');
  const [showSymbolPicker, setShowSymbolPicker] = useState(false);
  const symbolPickerRef = useRef<HTMLDivElement>(null);

  // ---------------------------------------------------------------------------
  // Fetch user strategies from risk profile
  // ---------------------------------------------------------------------------
  useEffect(() => {
    fetch('/api/risk-profile')
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data?.strategies) && data.strategies.length > 0) {
          setUserStrategies(data.strategies);
          setSelectedStrategies(data.strategies);
        } else {
          setUserStrategies(ALL_STRATEGIES);
          setSelectedStrategies(ALL_STRATEGIES);
        }
      })
      .catch(() => {
        setUserStrategies(ALL_STRATEGIES);
        setSelectedStrategies(ALL_STRATEGIES);
      });
  }, []);

  // ---------------------------------------------------------------------------
  // Fetch past runs
  // ---------------------------------------------------------------------------
  const fetchPastRuns = useCallback(async () => {
    setPastRunsLoading(true);
    try {
      const r = await fetch('/api/backtest/runs');
      if (r.ok) {
        const data = await r.json();
        setPastRuns(Array.isArray(data) ? data : []);
      }
    } catch {
      // non-fatal
    } finally {
      setPastRunsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPastRuns();
  }, [fetchPastRuns]);

  // Close symbol picker on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (symbolPickerRef.current && !symbolPickerRef.current.contains(e.target as Node)) {
        setShowSymbolPicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // ---------------------------------------------------------------------------
  // Strategy multi-select toggle
  // ---------------------------------------------------------------------------
  const toggleStrategy = (s: string) => {
    setSelectedStrategies((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
    );
  };

  // ---------------------------------------------------------------------------
  // Run backtest via SSE
  // ---------------------------------------------------------------------------
  const runBacktest = useCallback(async () => {
    if (selectedStrategies.length === 0) {
      setError('Select at least one strategy.');
      return;
    }
    setIsRunning(true);
    setProgress(0);
    setError(null);

    try {
      const res = await fetch('/api/backtest/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol,
          timeframe,
          startDate,
          endDate,
          strategies: selectedStrategies,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        setError(text || 'Server error');
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        setError('Failed to open SSE stream');
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n\n');
        buffer = lines.pop() ?? '';

        for (const chunk of lines) {
          const line = chunk.replace(/^data: /, '').trim();
          if (!line) continue;
          try {
            const event = JSON.parse(line) as {
              type: string;
              percentComplete?: number;
              data?: BacktestResult;
              message?: string;
            };
            if (event.type === 'progress' && typeof event.percentComplete === 'number') {
              setProgress(event.percentComplete);
            } else if (event.type === 'result' && event.data) {
              if (activeSlot === 'A') {
                setResultA(event.data);
              } else {
                setResultB(event.data);
              }
              await fetchPastRuns();
            } else if (event.type === 'error') {
              setError(event.message ?? 'Unknown error');
            }
          } catch {
            // malformed SSE line — skip
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsRunning(false);
      setProgress(0);
    }
  }, [symbol, timeframe, startDate, endDate, selectedStrategies, activeSlot, fetchPastRuns]);

  // ---------------------------------------------------------------------------
  // Load a past run into the active slot
  // ---------------------------------------------------------------------------
  const loadPastRun = useCallback(
    async (id: string) => {
      try {
        const r = await fetch(`/api/backtest/runs/${id}`);
        if (!r.ok) return;
        const full = await r.json();
        // Reconstruct a BacktestResult shape from raw DB row
        const result: BacktestResult = {
          id: full.id,
          config: full.config as BacktestConfig,
          metrics: full.metrics as BacktestMetrics,
          equityCurve: full.equityCurve as EquityPoint[],
          createdAt: full.createdAt,
        };
        if (activeSlot === 'A') {
          setResultA(result);
        } else {
          setResultB(result);
        }
      } catch {
        // non-fatal
      }
    },
    [activeSlot],
  );

  const filteredSymbols = symbolSearch
    ? POPULAR_SYMBOLS.filter((s) => s.toLowerCase().includes(symbolSearch.toLowerCase()))
    : POPULAR_SYMBOLS;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      {/* Disclaimer banner */}
      <div className="bg-amber-950/60 border-b border-amber-800/50 px-4 py-2 flex items-center gap-3">
        <span className="text-amber-400 font-semibold text-sm">DISCLAIMER</span>
        <p className="text-amber-200/80 text-xs">
          Past performance does not guarantee future results. This simulation does not account for all
          market conditions. Backtest results do not trigger real trades and are fully isolated from
          the live trading system.
        </p>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* ------------------------------------------------------------------ */}
        {/* Sidebar — past runs                                                 */}
        {/* ------------------------------------------------------------------ */}
        <aside className="w-64 border-r border-zinc-800 flex flex-col shrink-0 overflow-y-auto">
          <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-300">Past Runs</h2>
            {pastRunsLoading && (
              <span className="text-xs text-zinc-500 animate-pulse">loading…</span>
            )}
          </div>

          {/* Slot selector */}
          <div className="px-4 py-2 border-b border-zinc-800 flex gap-2">
            <button
              onClick={() => setActiveSlot('A')}
              className={`flex-1 rounded py-1 text-xs font-medium transition-colors ${
                activeSlot === 'A'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
              }`}
            >
              Slot A
            </button>
            <button
              onClick={() => setActiveSlot('B')}
              className={`flex-1 rounded py-1 text-xs font-medium transition-colors ${
                activeSlot === 'B'
                  ? 'bg-amber-600 text-white'
                  : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
              }`}
            >
              Slot B (compare)
            </button>
          </div>

          <div className="flex-1 overflow-y-auto py-2">
            {pastRuns.length === 0 && !pastRunsLoading && (
              <p className="px-4 py-6 text-xs text-zinc-500 text-center">No past runs yet.</p>
            )}
            {pastRuns.map((run) => {
              const cfg = run.config;
              return (
                <button
                  key={run.id}
                  onClick={() => loadPastRun(run.id)}
                  className="w-full text-left px-4 py-2 hover:bg-zinc-800/60 transition-colors border-b border-zinc-800/40"
                >
                  <p className="text-xs font-medium text-zinc-200 truncate">
                    {String(cfg.symbol)} · {String(cfg.timeframe)}
                  </p>
                  <p className="text-xs text-zinc-500 mt-0.5">{fmtDate(run.createdAt)}</p>
                </button>
              );
            })}
          </div>
        </aside>

        {/* ------------------------------------------------------------------ */}
        {/* Main content                                                         */}
        {/* ------------------------------------------------------------------ */}
        <main className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-bold text-white">Backtest Strategy</h1>
            {(resultA || resultB) && (
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                {resultA && (
                  <span className="flex items-center gap-1">
                    <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
                    Slot A: {String(resultA.config.symbol)}
                  </span>
                )}
                {resultB && (
                  <span className="flex items-center gap-1">
                    <span className="inline-block w-2 h-2 rounded-full bg-amber-500" />
                    Slot B: {String(resultB.config.symbol)}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* ---- Configuration Panel ---- */}
          <Card className="bg-zinc-900 border-zinc-800">
            <CardHeader className="pb-3">
              <CardTitle className="text-base text-zinc-100">Configuration</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {/* Symbol selector */}
                <div className="relative" ref={symbolPickerRef}>
                  <label className="block text-xs text-zinc-400 mb-1">Symbol</label>
                  <button
                    type="button"
                    onClick={() => setShowSymbolPicker((v) => !v)}
                    className="w-full text-left rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 hover:border-zinc-600 transition-colors"
                  >
                    {symbol}
                  </button>
                  {showSymbolPicker && (
                    <div className="absolute z-50 mt-1 w-56 rounded-md border border-zinc-700 bg-zinc-900 shadow-xl">
                      <div className="p-2">
                        <Input
                          placeholder="Search symbols…"
                          value={symbolSearch}
                          onChange={(e) => setSymbolSearch(e.target.value)}
                          className="h-8 text-sm bg-zinc-800 border-zinc-700"
                          autoFocus
                        />
                      </div>
                      <ul className="max-h-48 overflow-y-auto py-1">
                        {filteredSymbols.map((s) => (
                          <li key={s}>
                            <button
                              type="button"
                              onClick={() => {
                                setSymbol(s);
                                setShowSymbolPicker(false);
                                setSymbolSearch('');
                              }}
                              className={`w-full text-left px-3 py-1.5 text-sm hover:bg-zinc-800 transition-colors ${
                                s === symbol ? 'text-emerald-400 font-medium' : 'text-zinc-200'
                              }`}
                            >
                              {s}
                            </button>
                          </li>
                        ))}
                        {filteredSymbols.length === 0 && (
                          <li className="px-3 py-2 text-xs text-zinc-500">No matches</li>
                        )}
                      </ul>
                    </div>
                  )}
                </div>

                {/* Timeframe */}
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Timeframe</label>
                  <Select value={timeframe} onValueChange={setTimeframe}>
                    <SelectTrigger className="bg-zinc-800 border-zinc-700 text-zinc-100">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-zinc-900 border-zinc-700">
                      {TIMEFRAMES.map((tf) => (
                        <SelectItem key={tf.value} value={tf.value}>
                          {tf.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Start date */}
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Start Date</label>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>

                {/* End date */}
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">End Date</label>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
              </div>

              {/* Strategy multi-select */}
              <div>
                <label className="block text-xs text-zinc-400 mb-2">
                  Strategies — select which to simulate
                </label>
                <div className="flex flex-wrap gap-2">
                  {(userStrategies.length > 0 ? userStrategies : ALL_STRATEGIES).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => toggleStrategy(s)}
                      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors border ${
                        selectedStrategies.includes(s)
                          ? 'bg-emerald-600/30 border-emerald-600 text-emerald-300'
                          : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:border-zinc-500'
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Button
                  onClick={runBacktest}
                  disabled={isRunning || selectedStrategies.length === 0}
                  className="bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50"
                >
                  {isRunning
                    ? `Running… ${progress}%`
                    : activeSlot === 'B'
                      ? 'Run for Slot B (Compare)'
                      : 'Run Backtest'}
                </Button>
                {(resultA || resultB) && !isRunning && (
                  <span className="text-xs text-zinc-500">
                    Save this run, then switch to Slot B to compare.
                  </span>
                )}
              </div>

              {isRunning && (
                <Progress value={progress} className="h-1.5 bg-zinc-800 [&>div]:bg-emerald-500" />
              )}

              {error && (
                <div className="rounded-md bg-red-950/60 border border-red-800 px-4 py-2 text-sm text-red-300">
                  {error}
                </div>
              )}
            </CardContent>
          </Card>

          {/* ---- Results Panel ---- */}
          {(resultA ?? resultB) && (() => {
            const result = resultA ?? resultB!;
            const metrics = result.metrics;

            return (
              <>
                {/* Equity curve */}
                <Card className="bg-zinc-900 border-zinc-800">
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base text-zinc-100">
                        Equity Curve
                        {resultA && resultB && (
                          <span className="ml-2 text-xs text-zinc-400 font-normal">
                            — comparison mode
                          </span>
                        )}
                      </CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <EquityChart
                      primaryCurve={resultA?.equityCurve ?? []}
                      compareCurve={resultB?.equityCurve}
                      primaryLabel={`Slot A${resultA ? ` (${String(resultA.config.symbol)})` : ''}`}
                      compareLabel={`Slot B${resultB ? ` (${String(resultB.config.symbol)})` : ''}`}
                    />
                  </CardContent>
                </Card>

                {/* Tabs: Metrics / Per-strategy / Trades */}
                <div className="flex gap-1 border-b border-zinc-800">
                  {(['metrics', 'strategies', 'trades'] as const).map((tab) => (
                    <button
                      key={tab}
                      onClick={() => setActiveTab(tab)}
                      className={`px-4 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
                        activeTab === tab
                          ? 'border-emerald-500 text-emerald-400'
                          : 'border-transparent text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      {tab === 'strategies' ? 'Per-Strategy' : tab === 'metrics' ? 'Summary' : 'Trades'}
                    </button>
                  ))}
                </div>

                {/* Summary metrics grid */}
                {activeTab === 'metrics' && (
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                    <MetricCard
                      label="Total Trades"
                      value={String(metrics.totalTrades)}
                    />
                    <MetricCard
                      label="Win Rate"
                      value={`${fmt(metrics.winRate, 1)}%`}
                      positive={metrics.winRate > 50 ? true : metrics.winRate < 40 ? false : null}
                    />
                    <MetricCard
                      label="Max Drawdown"
                      value={`${fmt(metrics.maxDrawdownPct, 1)}%`}
                      positive={metrics.maxDrawdownPct < 10 ? true : metrics.maxDrawdownPct > 25 ? false : null}
                    />
                    <MetricCard
                      label="Sharpe Ratio"
                      value={fmt(metrics.sharpeRatio, 2)}
                      positive={metrics.sharpeRatio > 1 ? true : metrics.sharpeRatio < 0 ? false : null}
                    />
                    <MetricCard
                      label="Profit Factor"
                      value={isFinite(metrics.profitFactor) ? fmt(metrics.profitFactor, 2) : '+∞'}
                      positive={metrics.profitFactor > 1.5 ? true : metrics.profitFactor < 1 ? false : null}
                    />
                    <MetricCard
                      label="Total Return"
                      value={`${fmt(metrics.totalReturnPct, 2)}%`}
                      positive={metrics.totalReturnPct > 0 ? true : metrics.totalReturnPct < 0 ? false : null}
                    />
                  </div>
                )}

                {/* Per-strategy breakdown table */}
                {activeTab === 'strategies' && (
                  <Card className="bg-zinc-900 border-zinc-800">
                    <CardContent className="p-0">
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-zinc-800">
                              {['Strategy', 'Trades', 'Win%', 'Avg Win', 'Avg Loss', 'P.Factor', 'Drawdown', 'Sharpe', 'Return%'].map((h) => (
                                <th key={h} className="px-4 py-3 text-left text-xs text-zinc-400 font-medium">
                                  {h}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {metrics.perStrategy.map((s) => (
                              <tr key={s.strategy} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                                <td className="px-4 py-2.5 text-zinc-200 font-medium">{s.strategy}</td>
                                <td className="px-4 py-2.5 text-zinc-300">{s.totalTrades}</td>
                                <td className={`px-4 py-2.5 ${s.winRate > 50 ? 'text-emerald-400' : 'text-red-400'}`}>
                                  {fmt(s.winRate, 1)}%
                                </td>
                                <td className="px-4 py-2.5 text-emerald-400">{fmtCurrency(s.avgWin)}</td>
                                <td className="px-4 py-2.5 text-red-400">{fmtCurrency(-s.avgLoss)}</td>
                                <td className={`px-4 py-2.5 ${isFinite(s.profitFactor) && s.profitFactor > 1 ? 'text-emerald-400' : 'text-zinc-300'}`}>
                                  {isFinite(s.profitFactor) ? fmt(s.profitFactor, 2) : '+∞'}
                                </td>
                                <td className={`px-4 py-2.5 ${s.maxDrawdownPct > 20 ? 'text-red-400' : 'text-zinc-300'}`}>
                                  {fmt(s.maxDrawdownPct, 1)}%
                                </td>
                                <td className={`px-4 py-2.5 ${s.sharpeRatio > 1 ? 'text-emerald-400' : s.sharpeRatio < 0 ? 'text-red-400' : 'text-zinc-300'}`}>
                                  {fmt(s.sharpeRatio, 2)}
                                </td>
                                <td className={`px-4 py-2.5 font-medium ${s.totalReturnPct > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                  {fmt(s.totalReturnPct, 2)}%
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Individual trades table */}
                {activeTab === 'trades' && (
                  <Card className="bg-zinc-900 border-zinc-800">
                    <CardContent className="p-0">
                      <div className="overflow-x-auto max-h-96 overflow-y-auto">
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 bg-zinc-900">
                            <tr className="border-b border-zinc-800">
                              {['Date', 'Symbol', 'Direction', 'Entry', 'Exit', 'P&L', 'Strategy'].map((h) => (
                                <th key={h} className="px-4 py-3 text-left text-xs text-zinc-400 font-medium">
                                  {h}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {(metrics.trades ?? []).length === 0 && (
                              <tr>
                                <td colSpan={7} className="px-4 py-8 text-center text-zinc-500 text-xs">
                                  No trades in this backtest period.
                                </td>
                              </tr>
                            )}
                            {(metrics.trades ?? []).map((t, idx) => (
                              <tr key={idx} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                                <td className="px-4 py-2.5 text-zinc-400 text-xs">{fmtDate(t.date)}</td>
                                <td className="px-4 py-2.5 text-zinc-200">{t.symbol}</td>
                                <td className="px-4 py-2.5">
                                  <Badge className={t.direction === 'LONG' ? 'bg-emerald-900/60 text-emerald-400 border-emerald-800' : 'bg-red-900/60 text-red-400 border-red-800'}>
                                    {t.direction}
                                  </Badge>
                                </td>
                                <td className="px-4 py-2.5 text-zinc-300">${t.entry.toLocaleString()}</td>
                                <td className="px-4 py-2.5 text-zinc-300">${t.exit.toLocaleString()}</td>
                                <td className={`px-4 py-2.5 font-medium ${t.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                  {fmtCurrency(t.pnl)}
                                </td>
                                <td className="px-4 py-2.5 text-zinc-400 text-xs">{t.strategy}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </CardContent>
                  </Card>
                )}
              </>
            );
          })()}
        </main>
      </div>
    </div>
  );
}
