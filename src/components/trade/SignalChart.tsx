'use client';

import { useEffect, useRef, useState } from 'react';
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  ColorType,
  LineStyle,
  type IChartApi,
} from 'lightweight-charts';

interface Props {
  symbol: string;
  timeframe: string;
  entry?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  direction?: string | null;
}

const TF_MAP: Record<string, string> = {
  '1m': '1m', '3m': '5m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1h', '2h': '2h', '4h': '4h', '6h': '6h', '8h': '8h', '12h': '12h',
  '1d': '1d', '1w': '1w',
};


function pct(a: number, b: number) {
  return (((b - a) / Math.abs(a)) * 100).toFixed(2);
}

export function SignalChart({ symbol, timeframe, entry, stopLoss, takeProfit, direction }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [errorMsg, setErrorMsg] = useState('');

  const isLong = direction !== 'SHORT';
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

    async function init() {
      try {
        const res = await fetch(
          `/api/ohlcv?symbol=${encodeURIComponent(symbol)}&timeframe=${tf}&limit=300`,
          { signal: controller.signal },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as {
          candles: Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }>;
        };

        if (controller.signal.aborted || !containerRef.current) return;

        const candles = data.candles.map((c) => ({
          time: Math.floor(c.timestamp / 1000) as unknown as import('lightweight-charts').Time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }));

        const volumes = data.candles.map((c) => ({
          time: Math.floor(c.timestamp / 1000) as unknown as import('lightweight-charts').Time,
          value: c.volume,
          color: c.close >= c.open ? '#26a69a30' : '#ef535030',
        }));

        // ── Chart instance ──────────────────────────────────────────────────
        chart = createChart(containerRef.current, {
          layout: {
            background: { type: ColorType.Solid, color: '#131722' },
            textColor: '#9598a1',
            fontFamily: "'Inter', 'SF Pro Display', system-ui, sans-serif",
            fontSize: 11,
          },
          grid: {
            vertLines: { visible: false },
            horzLines: { visible: false },
          },
          crosshair: {
            mode: 1,
            vertLine: { color: '#758696', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#2a2e39' },
            horzLine: { color: '#758696', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#2a2e39' },
          },
          rightPriceScale: {
            borderColor: '#2a2e39',
            scaleMargins: { top: 0.08, bottom: 0.22 },
          },
          timeScale: {
            borderColor: '#2a2e39',
            timeVisible: true,
            secondsVisible: false,
          },
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });

        // ── Candlestick series ──────────────────────────────────────────────
        const candleSeries = chart.addSeries(CandlestickSeries, {
          upColor: '#26a69a',
          downColor: '#ef5350',
          borderUpColor: '#26a69a',
          borderDownColor: '#ef5350',
          wickUpColor: '#26a69a',
          wickDownColor: '#ef5350',
        });
        candleSeries.setData(candles);

        // ── Volume series (sub-pane via scaleMargins) ───────────────────────
        const volSeries = chart.addSeries(HistogramSeries, {
          priceScaleId: 'vol',
          color: '#26a69a30',
          lastValueVisible: false,
          priceLineVisible: false,
        });
        volSeries.priceScale().applyOptions({
          scaleMargins: { top: 0.82, bottom: 0 },
          borderVisible: false,
        });
        volSeries.setData(volumes);

        // ── Entry / SL / TP price lines ─────────────────────────────────────
        if (entry != null) {
          candleSeries.createPriceLine({
            price: entry,
            color: '#2962ff',
            lineWidth: 2,
            lineStyle: LineStyle.Solid,
            axisLabelVisible: true,
            title: 'Entry',
          });
        }

        if (stopLoss != null) {
          candleSeries.createPriceLine({
            price: stopLoss,
            color: '#f23645',
            lineWidth: 2,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: 'SL',
          });
        }

        if (takeProfit != null) {
          candleSeries.createPriceLine({
            price: takeProfit,
            color: '#089981',
            lineWidth: 2,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: 'TP',
          });
        }


        chart.timeScale().fitContent();

        // ── Resize observer ──────────────────────────────────────────────────
        observer = new ResizeObserver(() => {
          if (containerRef.current && chart) {
            chart.applyOptions({
              width: containerRef.current.clientWidth,
              height: containerRef.current.clientHeight,
            });
          }
        });
        observer.observe(containerRef.current);

        setStatus('ready');
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setErrorMsg((err as Error).message ?? 'Failed to load chart');
        setStatus('error');
      }
    }

    void init();

    return () => {
      controller.abort();
      observer?.disconnect();
      chart?.remove();
    };
  }, [symbol, timeframe, entry, stopLoss, takeProfit, direction, isLong]);

  return (
    <div className="relative w-full h-full" style={{ background: '#131722' }}>

      {/* ── Legend ────────────────────────────────────────────────────── */}
      {status === 'ready' && (
        <div
          className="absolute top-3 left-3 z-10 rounded-md text-[11px] leading-relaxed"
          style={{ background: 'rgba(19,23,34,0.85)', backdropFilter: 'blur(6px)', border: '1px solid #2a2e39', padding: '8px 12px', minWidth: 170 }}
        >
          {/* Direction badge */}
          <div className="flex items-center gap-2 mb-1.5">
            <span
              className="text-[10px] font-bold rounded px-1.5 py-0.5"
              style={{ background: isLong ? '#0d2818' : '#2d0d0d', color: isLong ? '#089981' : '#f23645' }}
            >
              {direction ?? 'LONG'}
            </span>
            <span style={{ color: '#9598a1' }}>{symbol} · {timeframe}</span>
          </div>

          {/* Levels */}
          {entry != null && (
            <div className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5" style={{ color: '#9598a1' }}>
                <span className="inline-block w-4 rounded-full" style={{ height: 2, background: '#2962ff' }} />
                Entry
              </span>
              <span style={{ color: '#d1d4dc' }}>${entry.toLocaleString()}</span>
            </div>
          )}
          {stopLoss != null && (
            <div className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5" style={{ color: '#9598a1' }}>
                <span className="inline-block w-4 rounded-full" style={{ height: 2, background: '#f23645' }} />
                Stop
              </span>
              <span style={{ color: '#f23645' }}>
                ${stopLoss.toLocaleString()}
                {entry != null && (
                  <span style={{ color: '#758696', fontSize: 10 }}> ({pct(entry, stopLoss)}%)</span>
                )}
              </span>
            </div>
          )}
          {takeProfit != null && (
            <div className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5" style={{ color: '#9598a1' }}>
                <span className="inline-block w-4 rounded-full" style={{ height: 2, background: '#089981' }} />
                Target
              </span>
              <span style={{ color: '#089981' }}>
                ${takeProfit.toLocaleString()}
                {entry != null && (
                  <span style={{ color: '#758696', fontSize: 10 }}> (+{pct(entry, takeProfit)}%)</span>
                )}
              </span>
            </div>
          )}

          {/* R:R + Fibonacci key */}
          {rr && (
            <div className="mt-1.5 pt-1.5 flex items-center justify-between" style={{ borderTop: '1px solid #2a2e39' }}>
              <span style={{ color: '#758696' }}>R:R</span>
              <span style={{ color: '#d1d4dc', fontWeight: 600 }}>{rr}:1</span>
            </div>
          )}
        </div>
      )}

      {/* ── Loading ───────────────────────────────────────────────────── */}
      {status === 'loading' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3" style={{ background: '#131722' }}>
          <svg className="animate-spin h-6 w-6" style={{ color: '#2962ff' }} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          <span style={{ color: '#758696', fontSize: 13 }}>Loading {symbol} {timeframe}…</span>
        </div>
      )}

      {/* ── Error ─────────────────────────────────────────────────────── */}
      {status === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center" style={{ background: '#131722' }}>
          <p style={{ color: '#f23645', fontSize: 13 }}>{errorMsg || 'Failed to load chart data'}</p>
        </div>
      )}

      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}
