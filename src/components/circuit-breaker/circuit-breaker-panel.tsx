'use client';

/**
 * CircuitBreakerPanel
 *
 * Displays the current circuit breaker state with colour-coded indicator and
 * provides a manual kill switch toggle.
 *
 * States:
 *   green  — all checks pass
 *   yellow — approaching a limit (≥ 80 % of any limit)
 *   red    — at or over a limit, kill switch off
 *   locked — kill switch on
 */

import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';

// ---------------------------------------------------------------------------
// Types (mirror CircuitBreakerResult from src/lib/circuit-breaker.ts)
// ---------------------------------------------------------------------------

type CircuitBreakerStatus = 'green' | 'yellow' | 'red' | 'locked';

interface Diagnostics {
  dailyTradeCount: number;
  maxTradesPerDay: number;
  dailyLossPct: number;
  maxDailyLossPct: number;
  openPositions: number;
  maxOpenPositions: number;
  killSwitchActive: boolean;
}

interface CircuitBreakerResult {
  allowed: boolean;
  reason: string | null;
  state: CircuitBreakerStatus;
  diagnostics: Diagnostics;
}

// ---------------------------------------------------------------------------
// Colour definitions
// ---------------------------------------------------------------------------

const STATUS_CONFIG: Record<
  CircuitBreakerStatus,
  { label: string; dot: string; banner: string; text: string }
> = {
  green: {
    label: 'All systems go',
    dot: 'bg-green-500',
    banner: 'bg-green-50 border-green-300 dark:bg-green-950 dark:border-green-700',
    text: 'text-green-800 dark:text-green-200',
  },
  yellow: {
    label: 'Approaching limit',
    dot: 'bg-yellow-400',
    banner: 'bg-yellow-50 border-yellow-300 dark:bg-yellow-950 dark:border-yellow-700',
    text: 'text-yellow-800 dark:text-yellow-200',
  },
  red: {
    label: 'Limit reached — trading halted',
    dot: 'bg-red-500',
    banner: 'bg-red-50 border-red-300 dark:bg-red-950 dark:border-red-700',
    text: 'text-red-800 dark:text-red-200',
  },
  locked: {
    label: 'Kill switch ON — all trading locked',
    dot: 'bg-red-700',
    banner: 'bg-red-100 border-red-500 dark:bg-red-950 dark:border-red-600',
    text: 'text-red-900 dark:text-red-100',
  },
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusIndicator({ state }: { state: CircuitBreakerStatus }) {
  const cfg = STATUS_CONFIG[state];
  return (
    <div className={`flex items-center gap-2 rounded-md border px-3 py-2 ${cfg.banner}`}>
      <span className={`inline-block h-2.5 w-2.5 rounded-full ${cfg.dot} shrink-0`} />
      <span className={`text-sm font-semibold ${cfg.text}`}>{cfg.label}</span>
    </div>
  );
}

function StatRow({
  label,
  used,
  max,
  unit = '',
}: {
  label: string;
  used: number;
  max: number;
  unit?: string;
}) {
  const pct = max > 0 ? Math.min((used / max) * 100, 100) : 0;
  const barColor =
    pct >= 100
      ? 'bg-red-500'
      : pct >= 80
        ? 'bg-yellow-400'
        : 'bg-green-500';

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">
          {used.toFixed(unit === '%' ? 2 : 0)}{unit} / {max}{unit}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function CircuitBreakerPanel() {
  const [data, setData] = useState<CircuitBreakerResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch('/api/kill-switch');
      if (res.ok) {
        const json = (await res.json()) as CircuitBreakerResult;
        setData(json);
        setError(null);
      } else {
        setError('Failed to load circuit breaker state.');
      }
    } catch {
      setError('Network error loading circuit breaker state.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchState();
  }, [fetchState]);

  async function handleToggleKillSwitch() {
    if (!data) return;
    setToggling(true);
    setError(null);
    try {
      const newActive = !data.diagnostics.killSwitchActive;
      const res = await fetch('/api/kill-switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: newActive }),
      });
      if (res.ok) {
        const updated = (await res.json()) as CircuitBreakerResult;
        setData(updated);
      } else {
        const body = await res.json().catch(() => ({})) as Record<string, string>;
        setError(body?.error ?? 'Failed to toggle kill switch.');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setToggling(false);
    }
  }

  if (loading) {
    return (
      <Card className="p-6 space-y-4">
        <p className="text-sm text-muted-foreground">Loading circuit breaker state&hellip;</p>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card className="p-6 space-y-4">
        <p className="text-sm text-red-600">{error ?? 'Could not load circuit breaker state.'}</p>
      </Card>
    );
  }

  const { state, reason, diagnostics } = data;
  const killSwitchOn = diagnostics.killSwitchActive;

  return (
    <Card className="p-6 space-y-5">
      {/* Header */}
      <div>
        <h2 className="text-base font-semibold">Circuit Breaker Status</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Checked before every trade execution — including TradingView webhooks and copy-trade signals.
        </p>
      </div>

      {/* Status indicator */}
      <StatusIndicator state={state} />

      {/* Reason (if blocked) */}
      {reason && (
        <p className="text-sm text-muted-foreground">{reason}</p>
      )}

      <Separator />

      {/* Stats */}
      <div className="space-y-4">
        <StatRow
          label="Daily trades"
          used={diagnostics.dailyTradeCount}
          max={diagnostics.maxTradesPerDay}
        />
        <StatRow
          label="Daily loss"
          used={diagnostics.dailyLossPct}
          max={diagnostics.maxDailyLossPct}
          unit="%"
        />
        <StatRow
          label="Open positions"
          used={diagnostics.openPositions}
          max={diagnostics.maxOpenPositions}
        />
      </div>

      <Separator />

      {/* Kill switch toggle */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Manual Kill Switch</p>
            <p className="text-xs text-muted-foreground">
              {killSwitchOn
                ? 'All auto-execution halted. Pending signals cancelled.'
                : 'Toggle ON to halt all trading immediately.'}
            </p>
          </div>
          <Button
            variant={killSwitchOn ? 'destructive' : 'outline'}
            size="sm"
            onClick={handleToggleKillSwitch}
            disabled={toggling}
            className="min-w-[100px]"
          >
            {toggling ? 'Updating…' : killSwitchOn ? 'Switch OFF' : 'Engage Kill Switch'}
          </Button>
        </div>

        {error && (
          <p className="text-sm text-red-600">{error}</p>
        )}
      </div>

      {/* Daily reset note */}
      <p className="text-xs text-muted-foreground">
        Daily counters (trades, loss) reset automatically at midnight UTC.
      </p>
    </Card>
  );
}
