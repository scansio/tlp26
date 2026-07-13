'use client';

import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SignalFeeData {
  grossExpectedProfit: number;
  netExpectedProfit: number;
  grossExpectedLoss: number;
  netExpectedLoss: number;
  totalFeeCost: number;
  breakEvenDistance: number;
}

export interface TradeSignal {
  id: string;
  symbol: string;
  timeframe: string;
  direction: string; // LONG | SHORT
  entryPrice: string | number | null;
  stopLoss: string | number | null;
  takeProfit: string | number | null;
  confidence: string | null; // LOW | MEDIUM | HIGH
  reasoning: string | null;
  strategySource: string | null;
  source: string | null;
  status: string | null;
  createdAt: string | Date | null;
  copyBadge?: { label: string; publisherName: string } | null;
  // Optional fee data — present when the risk-tool was run for this signal
  feeData?: SignalFeeData | null;
  // Exit mode — 'trailing' shows the Trailing badge
  exitMode?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(value: string | number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (isNaN(n)) return '—';
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function directionColor(direction: string): string {
  return direction === 'LONG'
    ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
    : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400';
}

function confidenceVariant(
  confidence: string | null,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (confidence === 'HIGH') return 'default';
  if (confidence === 'LOW') return 'destructive';
  return 'secondary';
}

function statusVariant(
  status: string | null,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'executed') return 'default';
  if (status === 'rejected' || status === 'cancelled' || status === 'expired')
    return 'destructive';
  if (status === 'approved') return 'secondary';
  return 'outline';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SignalCard({ signal }: { signal: TradeSignal }) {
  const { feeData } = signal;
  const hasFeeData = !!feeData;

  return (
    <Card className="w-full">
      <CardHeader className="pb-2">
        {/* Top row: symbol / direction / confidence / status */}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="font-bold text-lg">{signal.symbol}</span>
            <span className="text-muted-foreground text-sm">{signal.timeframe}</span>
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${directionColor(signal.direction)}`}
            >
              {signal.direction}
            </span>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {signal.exitMode === 'trailing' && (
              <Badge
                variant="outline"
                className="text-xs border-blue-400 text-blue-600 dark:border-blue-500 dark:text-blue-400"
              >
                Trailing
              </Badge>
            )}
            {signal.copyBadge && (
              <Badge variant="outline" className="text-xs">
                {signal.copyBadge.label} · {signal.copyBadge.publisherName}
              </Badge>
            )}
            {signal.confidence && (
              <Badge variant={confidenceVariant(signal.confidence)} className="text-xs">
                {signal.confidence}
              </Badge>
            )}
            {signal.status && (
              <Badge variant={statusVariant(signal.status)} className="text-xs">
                {signal.status}
              </Badge>
            )}
          </div>
        </div>

        {/* Strategy source & timestamp */}
        {(signal.strategySource || signal.createdAt) && (
          <p className="text-xs text-muted-foreground mt-1">
            {signal.strategySource && <span>{signal.strategySource}</span>}
            {signal.strategySource && signal.createdAt && <span className="mx-1">·</span>}
            {signal.createdAt && (
              <span>{new Date(signal.createdAt).toLocaleString()}</span>
            )}
          </p>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Price levels */}
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div>
            <p className="text-muted-foreground text-xs">Entry</p>
            <p className="font-medium">${fmt(signal.entryPrice)}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Stop Loss</p>
            <p className="font-medium text-red-600 dark:text-red-400">
              ${fmt(signal.stopLoss)}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Take Profit</p>
            <p className="font-medium text-green-600 dark:text-green-400">
              ${fmt(signal.takeProfit)}
            </p>
          </div>
        </div>

        {/* Fee-adjusted P&L — only shown when risk-tool data is available */}
        {hasFeeData && (
          <div className="rounded-lg border border-dashed p-3 space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Expected P&amp;L
            </p>
            <div className="grid grid-cols-2 gap-3 text-sm">
              {/* Profit */}
              <div>
                <p className="text-muted-foreground text-xs">Gross Profit</p>
                <p className="font-medium text-green-600 dark:text-green-400">
                  +${fmt(feeData.grossExpectedProfit)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs flex items-center gap-1">
                  Net Profit
                  <span className="text-[10px] bg-muted rounded px-1 py-0.5">after fees</span>
                </p>
                <p className="font-medium text-green-600 dark:text-green-400">
                  +${fmt(feeData.netExpectedProfit)}
                </p>
              </div>
              {/* Loss */}
              <div>
                <p className="text-muted-foreground text-xs">Gross Loss</p>
                <p className="font-medium text-red-600 dark:text-red-400">
                  -${fmt(feeData.grossExpectedLoss)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs flex items-center gap-1">
                  Net Loss
                  <span className="text-[10px] bg-muted rounded px-1 py-0.5">after fees</span>
                </p>
                <p className="font-medium text-red-600 dark:text-red-400">
                  -${fmt(feeData.netExpectedLoss)}
                </p>
              </div>
            </div>
            {/* Fee summary row */}
            <div className="border-t pt-2 flex items-center justify-between text-xs text-muted-foreground">
              <span>
                Total fee cost:{' '}
                <span className="font-medium text-foreground">${fmt(feeData.totalFeeCost, 4)}</span>
              </span>
              <span>
                Break-even:{' '}
                <span className="font-medium text-foreground">
                  {fmt(feeData.breakEvenDistance, 4)}%
                </span>{' '}
                move
              </span>
            </div>
          </div>
        )}

        {/* Reasoning */}
        {signal.reasoning && (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer hover:text-foreground transition-colors">
              AI reasoning
            </summary>
            <p className="mt-2 leading-relaxed">{signal.reasoning}</p>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
