'use client';

import { useEffect, useRef, useState } from 'react';
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  createSeriesMarkers,
  ColorType,
  LineStyle,
  type IChartApi,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SmcLevelInput {
  type: string;
  priceLevel: number;
  direction: 'BULLISH' | 'BEARISH';
}

interface Props {
  symbol: string;
  timeframe: string;
  entry?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  direction?: string | null;
  smcLevels?: SmcLevelInput[] | null;
}

type SmcType = 'ChoCH' | 'BOS' | 'FVG' | 'OB' | 'Sweep' | 'POI';

interface SmcLevel {
  type: SmcType;
  price: number;
  color: string;
  shape: 'circle' | 'square' | 'arrowUp' | 'arrowDown';
}

type OHLCVCandle = {
  timestamp: number; open: number; high: number;
  low: number; close: number; volume: number;
};

// ── SMC style config ──────────────────────────────────────────────────────────

const SMC_CONFIG: Record<SmcType, { color: string; shape: SmcLevel['shape'] }> = {
  ChoCH: { color: '#f59e0b', shape: 'arrowUp'   },
  BOS:   { color: '#a78bfa', shape: 'arrowUp'   },
  FVG:   { color: '#22d3ee', shape: 'circle'    },
  OB:    { color: '#fb923c', shape: 'square'    },
  Sweep: { color: '#f472b6', shape: 'arrowDown' },
  POI:   { color: '#6ee7b7', shape: 'circle'    },
};

// Maps smc-tool type strings to our internal SmcType
const SMC_TYPE_MAP: Record<string, SmcType> = {
  ChoCH:                   'ChoCH',
  BOS:                     'BOS',
  FVG:                     'FVG',
  ORDER_BLOCK:             'OB',
  LIQUIDITY_SWEEP:         'Sweep',
  LIQUIDITY_SWEEP_HIGH_PROB: 'Sweep',
};

function toSmcLevels(inputs: SmcLevelInput[] | null | undefined): SmcLevel[] {
  if (!inputs?.length) return [];
  const seen = new Set<number>();
  const result: SmcLevel[] = [];
  for (const item of inputs) {
    const smcType = SMC_TYPE_MAP[item.type];
    if (!smcType) continue;
    const key = Math.round(item.priceLevel * 10);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ type: smcType, price: item.priceLevel, ...SMC_CONFIG[smcType] });
  }
  return result;
}

// ── Find nearest candle for a price level ─────────────────────────────────────

function nearestCandleTime(candles: OHLCVCandle[], price: number): number {
  // Prefer the most-recent candle whose high–low range contains the price
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].low <= price && candles[i].high >= price) {
      return Math.floor(candles[i].timestamp / 1000);
    }
  }
  // Fall back to the candle with the closest close
  let best = candles.length - 1;
  let bestDist = Infinity;
  for (let i = 0; i < candles.length; i++) {
    const d = Math.abs(candles[i].close - price);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return Math.floor(candles[best].timestamp / 1000);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const TF_MAP: Record<string, string> = {
  '1m': '1m', '3m': '5m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1h', '2h': '2h', '4h': '4h', '6h': '6h', '8h': '8h', '12h': '12h',
  '1d': '1d', '1w': '1w',
};

function pct(a: number, b: number) {
  return (((b - a) / Math.abs(a)) * 100).toFixed(2);
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SignalChart({
  symbol, timeframe, entry, stopLoss, takeProfit, direction, smcLevels: smcLevelsProp,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus]     = useState<'loading' | 'error' | 'ready'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [smcLevels, setSmcLevels] = useState<SmcLevel[]>([]);

  const isLong = direction !== 'SHORT';
  const smcKey = JSON.stringify(smcLevelsProp);
  const rr =
    entry != null && stopLoss != null && takeProfit != null
      ? Math.abs((Number(takeProfit) - Number(entry)) / (Number(entry) - Number(stopLoss))).toFixed(2)
      : null;

  useEffect(() => {
    if (!containerRef.current) return;

    let chart: IChartApi | null = null;
    let observer: ResizeObserver | null = null;
    const controller = new AbortController();

    setStatus('loading');
    setErrorMsg('');

    const tf = TF_MAP[timeframe] ?? '1h';
    const parsedSmc = toSmcLevels(smcLevelsProp);

    async function init() {
      try {
        const res = await fetch(
          `/api/ohlcv?symbol=${encodeURIComponent(symbol)}&timeframe=${tf}&limit=300`,
          { signal: controller.signal },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { candles: OHLCVCandle[] };

        if (controller.signal.aborted || !containerRef.current) return;

        type LCTime = Time;
        const toTime = (ts: number) => Math.floor(ts / 1000) as unknown as LCTime;

        const candles = data.candles.map((c) => ({
          time: toTime(c.timestamp), open: c.open, high: c.high, low: c.low, close: c.close,
        }));
        const volumes = data.candles.map((c) => ({
          time: toTime(c.timestamp),
          value: c.volume,
          color: c.close >= c.open ? '#26a69a28' : '#ef535028',
        }));

        // ── Chart ─────────────────────────────────────────────────────────
        chart = createChart(containerRef.current, {
          layout: {
            background: { type: ColorType.Solid, color: '#131722' },
            textColor: '#9598a1',
            fontFamily: "'Inter', 'SF Pro Display', system-ui, sans-serif",
            fontSize: 11,
          },
          grid: { vertLines: { visible: false }, horzLines: { visible: false } },
          crosshair: {
            mode: 1,
            vertLine: { color: '#758696', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#2a2e39' },
            horzLine: { color: '#758696', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#2a2e39' },
          },
          rightPriceScale: { borderColor: '#2a2e39', scaleMargins: { top: 0.08, bottom: 0.22 } },
          timeScale: { borderColor: '#2a2e39', timeVisible: true, secondsVisible: false },
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });

        // ── Candlesticks ───────────────────────────────────────────────────
        const candleSeries = chart.addSeries(CandlestickSeries, {
          upColor: '#26a69a', downColor: '#ef5350',
          borderUpColor: '#26a69a', borderDownColor: '#ef5350',
          wickUpColor: '#26a69a', wickDownColor: '#ef5350',
        });
        candleSeries.setData(candles);

        // ── Volume ─────────────────────────────────────────────────────────
        const volSeries = chart.addSeries(HistogramSeries, {
          priceScaleId: 'vol', color: '#26a69a28',
          lastValueVisible: false, priceLineVisible: false,
        });
        volSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, borderVisible: false });
        volSeries.setData(volumes);

        // ── Entry / SL / TP (solid price lines — major levels) ────────────
        if (entry != null) {
          candleSeries.createPriceLine({
            price: entry, color: '#2962ff', lineWidth: 2,
            lineStyle: LineStyle.Solid, axisLabelVisible: true, title: 'Entry',
          });
        }
        if (stopLoss != null) {
          candleSeries.createPriceLine({
            price: stopLoss, color: '#f23645', lineWidth: 2,
            lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'SL',
          });
        }
        if (takeProfit != null) {
          candleSeries.createPriceLine({
            price: takeProfit, color: '#089981', lineWidth: 2,
            lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'TP',
          });
        }

        // ── SMC markers (candle markers — no axis labels, no price lines) ──
        if (parsedSmc.length > 0) {
          const markers: SeriesMarker<LCTime>[] = parsedSmc.map((lvl: SmcLevel) => ({
            time: nearestCandleTime(data.candles, lvl.price) as unknown as LCTime,
            position: lvl.shape === 'arrowDown' ? 'aboveBar' : 'belowBar',
            color: lvl.color,
            shape: lvl.shape,
            text: `${lvl.type} $${lvl.price.toLocaleString()}`,
            size: 1,
          }));

          // lightweight-charts requires markers sorted by time
          markers.sort((a, b) => (a.time as number) - (b.time as number));
          createSeriesMarkers(candleSeries, markers);
        }

        chart.timeScale().fitContent();

        observer = new ResizeObserver(() => {
          if (containerRef.current && chart) {
            chart.applyOptions({
              width: containerRef.current.clientWidth,
              height: containerRef.current.clientHeight,
            });
          }
        });
        observer.observe(containerRef.current);

        setSmcLevels(parsedSmc);
        setStatus('ready');
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setErrorMsg((err as Error).message ?? 'Failed to load chart');
        setStatus('error');
      }
    }

    void init();
    return () => { controller.abort(); observer?.disconnect(); chart?.remove(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, timeframe, entry, stopLoss, takeProfit, direction, smcKey]);

  return (
    <div className="relative w-full h-full" style={{ background: '#131722' }}>

      {/* ── Legend ──────────────────────────────────────────────────────── */}
      {status === 'ready' && (
        <div
          className="absolute top-3 left-3 z-10 rounded-md text-[11px] leading-relaxed select-none"
          style={{
            background: 'rgba(19,23,34,0.88)', backdropFilter: 'blur(8px)',
            border: '1px solid #2a2e39', padding: '9px 13px', minWidth: 190,
          }}
        >
          {/* Direction + symbol */}
          <div className="flex items-center gap-2 mb-2">
            <span
              className="text-[10px] font-bold rounded px-1.5 py-0.5 tracking-wide"
              style={{ background: isLong ? '#0d2818' : '#2d0d0d', color: isLong ? '#089981' : '#f23645' }}
            >
              {direction ?? 'LONG'}
            </span>
            <span style={{ color: '#9598a1' }}>{symbol} · {timeframe}</span>
          </div>

          {/* Trade levels */}
          {entry != null && <Row swatch="#2962ff" label="Entry" value={`$${entry.toLocaleString()}`} />}
          {stopLoss != null && (
            <Row swatch="#f23645" label="Stop" valueColor="#f23645"
              value={`$${stopLoss.toLocaleString()}  ${pct(entry ?? stopLoss, stopLoss)}%`} />
          )}
          {takeProfit != null && (
            <Row swatch="#089981" label="Target" valueColor="#089981"
              value={`$${takeProfit.toLocaleString()}  +${pct(entry ?? takeProfit, takeProfit)}%`} />
          )}

          {rr && (
            <div className="flex items-center justify-between mt-1.5 pt-1.5"
              style={{ borderTop: '1px solid #2a2e39' }}>
              <span style={{ color: '#758696' }}>R:R</span>
              <span style={{ color: '#d1d4dc', fontWeight: 600 }}>{rr}:1</span>
            </div>
          )}

          {/* SMC markers key */}
          {smcLevels.length > 0 && (
            <div className="mt-2 pt-2 space-y-0.5" style={{ borderTop: '1px solid #2a2e39' }}>
              <p className="text-[10px] uppercase tracking-widest mb-1" style={{ color: '#4b5563' }}>SMC</p>
              {smcLevels.map((l, i) => (
                <div key={i} className="flex items-center justify-between gap-4">
                  <span className="flex items-center gap-1.5" style={{ color: '#9598a1' }}>
                    <SmcShape shape={l.shape} color={l.color} />
                    {l.type}
                  </span>
                  <span style={{ color: l.color, fontVariantNumeric: 'tabular-nums' }}>
                    ${l.price.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Loading ──────────────────────────────────────────────────────── */}
      {status === 'loading' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3" style={{ background: '#131722' }}>
          <svg className="animate-spin h-6 w-6" style={{ color: '#2962ff' }} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          <span style={{ color: '#758696', fontSize: 13 }}>Loading {symbol} {timeframe}…</span>
        </div>
      )}

      {/* ── Error ────────────────────────────────────────────────────────── */}
      {status === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center" style={{ background: '#131722' }}>
          <p style={{ color: '#f23645', fontSize: 13 }}>{errorMsg || 'Failed to load chart data'}</p>
        </div>
      )}

      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Row({
  swatch, label, value, valueColor = '#d1d4dc',
}: {
  swatch: string; label: string; value: string; valueColor?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="flex items-center gap-1.5" style={{ color: '#9598a1' }}>
        <span className="inline-block w-4 shrink-0" style={{ height: 2, background: swatch }} />
        {label}
      </span>
      <span style={{ color: valueColor, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

function SmcShape({ shape, color }: { shape: SmcLevel['shape']; color: string }) {
  if (shape === 'circle') {
    return <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: color }} />;
  }
  if (shape === 'square') {
    return <span className="inline-block w-2 h-2 shrink-0" style={{ background: color }} />;
  }
  // arrow
  return (
    <svg className="w-3 h-3 shrink-0" viewBox="0 0 12 12" fill={color}>
      {shape === 'arrowUp'
        ? <polygon points="6,1 11,10 1,10" />
        : <polygon points="6,11 11,2 1,2" />}
    </svg>
  );
}
