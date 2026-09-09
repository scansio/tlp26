'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SignalChart } from '@/components/trade/SignalChart';
import { buildTradingViewUrl } from '@/lib/tradingview-url';
import { Dialog as DialogPrimitive } from 'radix-ui';
import {
  Dialog,
  DialogOverlay,
  DialogPortal,
} from '@/components/ui/dialog';

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
  slDistancePct?: number;
  riskReward?: number;
  positionSizeUsdt?: number | null;
  positionSizeUnits?: number | null;
  marginUsdt?: number | null;
  leverage?: number | null;
  maxSymbolLeverage?: number | null;
  leverageCapped?: boolean | null;
  takerFeePct?: number | null;
  accountBalanceUsed?: number | null;
  riskPerTradePctUsed?: number | null;
}

export interface QueueSignal {
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
  source: string | null; // ai | tradingview | manual | copy
  status: string | null;
  exitMode: string | null;
  marketType?: string | null;
  rawPayload: Record<string, unknown> | null;
  riskOverridePct?: string | number | null;
  lastError?: string | null;
  lastErrorAt?: string | Date | null;
  executionAttempts?: number | null;
  createdAt: string | Date | null;
  updatedAt: string | Date | null;
  expiresAt: string | Date | null;
  feeData?: SignalFeeData | null;
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

function directionClass(direction: string): string {
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

function confidenceClass(confidence: string | null): string {
  if (confidence === 'HIGH') return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400';
  if (confidence === 'LOW') return 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';
  return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400';
}

function statusBadge(status: string | null): { label: string; className: string } | null {
  switch (status) {
    case 'executing':
      return { label: 'Executing…', className: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400' };
    case 'approved':
      return { label: 'Awaiting Fill', className: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400' };
    case 'executed':
      return { label: 'Executed', className: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400' };
    case 'expired':
      return { label: 'Expired', className: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' };
    case 'cancelled':
      return { label: 'Cancelled', className: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' };
    case 'rejected':
      return { label: 'Rejected', className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' };
    default:
      return null; // 'pending' — no badge, actions speak for themselves
  }
}

function sourceLabel(source: string | null): { label: string; title: string } {
  if (source === 'tradingview') return { label: 'TV', title: 'TradingView webhook signal' };
  if (source === 'copy') return { label: 'COPY', title: 'Copy trade from publisher' };
  if (source === 'manual') return { label: 'MAN', title: 'Manually created signal' };
  return { label: 'AI', title: 'AI-generated signal' };
}


function timeUntilExpiry(expiresAt: string | Date | null, createdAt: string | Date | null): string | null {
  const expiry = expiresAt
    ? new Date(expiresAt)
    : createdAt
    ? new Date(new Date(createdAt).getTime() + 60 * 60 * 1_000)
    : null;
  if (!expiry) return null;
  const diffMs = expiry.getTime() - Date.now();
  if (diffMs <= 0) return 'Expired';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'Expires soon';
  if (mins < 60) return `Expires in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `Expires in ${hrs}h ${rem}m` : `Expires in ${hrs}h`;
}

// ---------------------------------------------------------------------------
// Expandable reasoning section
// ---------------------------------------------------------------------------

function ReasoningSection({ signal }: { signal: QueueSignal }) {
  const raw = signal.rawPayload;

  // Extract indicators, news, on-chain from rawPayload if present
  const indicators = raw?.indicators as Record<string, unknown> | undefined;
  const news = raw?.news as Record<string, unknown> | undefined;
  const onchain = raw?.onchain as Record<string, unknown> | undefined;
  const decision = raw?.agentDecision as Record<string, unknown> | undefined;

  const hasRich = !!(indicators || news || onchain || decision);

  return (
    <div className="mt-3 pl-4 border-l-2 border-muted space-y-4 text-sm">
      {/* Full AI reasoning */}
      {signal.reasoning && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
            AI Reasoning
          </p>
          <p className="text-muted-foreground leading-relaxed whitespace-pre-wrap">
            {signal.reasoning}
          </p>
        </div>
      )}

      {hasRich && (
        <>
          {/* Indicators at time of signal */}
          {indicators && Object.keys(indicators).length > 0 && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                Indicators at Signal Time
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground">
                {Object.entries(indicators).map(([k, v]) => (
                  <div key={k} className="min-w-0 break-words">
                    <span className="font-medium text-foreground capitalize">{k}:</span>{' '}
                    {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* News sentiment */}
          {news && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                News Sentiment
              </p>
              <pre className="bg-muted rounded p-2 overflow-x-auto text-xs">
                {JSON.stringify(news, null, 2)}
              </pre>
            </div>
          )}

          {/* On-chain bias */}
          {onchain && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                On-Chain Bias
              </p>
              <pre className="bg-muted rounded p-2 overflow-x-auto text-xs">
                {JSON.stringify(onchain, null, 2)}
              </pre>
            </div>
          )}

          {/* Agent decision context */}
          {decision && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                Agent Decision Context
              </p>
              <pre className="bg-muted rounded p-2 overflow-x-auto text-xs">
                {JSON.stringify(decision, null, 2)}
              </pre>
            </div>
          )}
        </>
      )}

      {!signal.reasoning && !hasRich && (
        <p className="text-xs text-muted-foreground italic">
          No detailed reasoning available for this signal.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expandable risk calculation section
// ---------------------------------------------------------------------------

function RiskCalculationSection({ signal }: { signal: QueueSignal }) {
  const fee = signal.feeData;
  const riskOverride = signal.riskOverridePct != null ? Number(signal.riskOverridePct) : null;

  if (!fee || fee.positionSizeUsdt == null) {
    return (
      <div className="mt-3 pl-4 border-l-2 border-muted text-sm">
        <p className="text-xs text-muted-foreground italic">
          Could not compute a risk calculation for this signal (unknown account balance or invalid sizing).
        </p>
      </div>
    );
  }

  const rows: Array<{ label: string; value: string }> = [
    {
      label: 'Risk per trade',
      value: fee.riskPerTradePctUsed != null ? `${fmt(fee.riskPerTradePctUsed, 2)}%${riskOverride != null ? ' (custom)' : ''}` : '—',
    },
    { label: 'Account balance used', value: fee.accountBalanceUsed != null ? `$${fmt(fee.accountBalanceUsed, 2)}` : '—' },
    { label: 'Margin required', value: fee.marginUsdt != null ? `$${fmt(fee.marginUsdt, 2)}` : '—' },
    {
      label: 'Leverage',
      value:
        fee.leverage != null
          ? `${fmt(fee.leverage, 0)}x${fee.leverageCapped ? ` (capped at exchange max ${fmt(fee.maxSymbolLeverage ?? 0, 0)}x)` : ''}`
          : '—',
    },
    { label: 'Position size', value: fee.positionSizeUsdt != null ? `$${fmt(fee.positionSizeUsdt, 2)}` : '—' },
    {
      label: 'Position units',
      value: fee.positionSizeUnits != null ? fmt(fee.positionSizeUnits, fee.positionSizeUnits >= 1 ? 2 : 6) : '—',
    },
    { label: 'Taker fee (per side)', value: fee.takerFeePct != null ? `${fmt(fee.takerFeePct, 4)}%` : '—' },
  ];

  return (
    <div className="mt-3 pl-4 border-l-2 border-muted text-sm">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1.5">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between md:justify-start md:gap-2 text-xs">
            <span className="text-muted-foreground">{row.label}</span>
            <span className="font-medium text-foreground">{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Copyable signal id — short code with copy-to-clipboard, full id on hover
// ---------------------------------------------------------------------------

function CopyableSignalId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const shortCode = id.slice(0, 8);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard unavailable — ignore
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={copied ? 'Copied!' : `Click to copy signal ID: ${id}`}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
    >
      #{shortCode}
      {copied ? (
        <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface SignalApprovalCardProps {
  signal: QueueSignal;
  showActions: boolean;
  onAction: (id: string, action: 'approve' | 'reject' | 'cancel') => Promise<void>;
  connectedExchange?: string | null;
}

export function SignalApprovalCard({
  signal,
  showActions,
  onAction,
  connectedExchange,
}: SignalApprovalCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [showRisk, setShowRisk] = useState(false);
  const [showChart, setShowChart] = useState(false);
  const [actionLoading, setActionLoading] = useState<'approve' | 'reject' | 'cancel' | null>(null);
  const [actionResult, setActionResult] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const { feeData } = signal;
  const expiryLabel = timeUntilExpiry(signal.expiresAt, signal.createdAt);
  const src = sourceLabel(signal.source);
  const status = statusBadge(signal.status);
  const isPending = signal.status === 'pending';
  // 'approved' = a limit order is resting (live) or a paper fill is waiting
  // for price to reach entry — see src/lib/entry-fill.ts.
  const isApproved = signal.status === 'approved';

  async function handleAction(action: 'approve' | 'reject' | 'cancel') {
    setActionLoading(action);
    setActionResult(null);
    try {
      await onAction(signal.id, action);
      setActionResult({
        type: 'success',
        message:
          action === 'approve'
            ? 'Signal approved and queued for execution.'
            : action === 'cancel'
              ? 'Order cancelled.'
              : 'Signal rejected and removed from queue.',
      });
    } catch (err) {
      setActionResult({
        type: 'error',
        message: err instanceof Error ? err.message : 'Action failed. Please retry.',
      });
    } finally {
      setActionLoading(null);
    }
  }

  return (
    <>
    <Card className="w-full">
      <CardHeader className="px-4 md:px-6 pb-2">
        {/* Top row */}
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-base md:text-lg">{signal.symbol}</span>
            <span className="text-muted-foreground text-sm">{signal.timeframe}</span>
            <CopyableSignalId id={signal.id} />

            {/* Direction badge */}
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${directionClass(signal.direction)}`}
            >
              {signal.direction}
            </span>

            {/* Confidence badge */}
            {signal.confidence && (
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${confidenceClass(signal.confidence)}`}
                title={`${signal.confidence} confidence`}
              >
                {signal.confidence}
              </span>
            )}

            {/* Source icon/badge */}
            <span
              className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold bg-muted text-muted-foreground border"
              title={src.title}
            >
              {src.label === 'AI' ? (
                <>
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-3 w-3 mr-0.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path d="M12 2a4 4 0 0 1 4 4v1h1a3 3 0 0 1 0 6h-1v1a4 4 0 0 1-8 0v-1H7a3 3 0 0 1 0-6h1V6a4 4 0 0 1 4-4z" />
                  </svg>
                  AI
                </>
              ) : (
                src.label
              )}
            </span>

            {/* Status badge — pending has none (actions speak for it) */}
            {status && (
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${status.className}`}
              >
                {status.label}
              </span>
            )}

            {signal.exitMode === 'trailing' && (
              <Badge
                variant="outline"
                className="text-xs border-blue-400 text-blue-600 dark:border-blue-500 dark:text-blue-400"
              >
                Trailing
              </Badge>
            )}
          </div>

          {/* Right-side: expiry + chart toggle */}
          <div className="flex items-center gap-2 shrink-0">
            {expiryLabel && (isPending || isApproved) && (
              <span className="text-xs text-muted-foreground">{expiryLabel}</span>
            )}
            <button
              type="button"
              onClick={() => setShowChart((v) => !v)}
              className="inline-flex items-center justify-center gap-1 rounded-md border px-3 py-2.5 md:px-2 md:py-1 min-h-11 md:min-h-0 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title="Show signal on TradingView chart"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
              {showChart ? 'Hide Chart' : 'Show on Chart'}
            </button>
          </div>
        </div>

        {/* Strategy source + timestamp */}
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

      <CardContent className="px-4 md:px-6 space-y-4">
        {/* Price levels grid */}
        <div className="grid grid-cols-3 gap-2 md:gap-3 text-sm">
          {/* Entry zone */}
          <div className="min-w-0">
            <p className="text-muted-foreground text-xs">Entry</p>
            <p className="font-medium truncate">${fmt(signal.entryPrice)}</p>
          </div>

          {/* Stop-loss + distance */}
          <div className="min-w-0">
            <p className="text-muted-foreground text-xs">Stop Loss</p>
            <p className="font-medium text-red-600 dark:text-red-400 truncate">
              ${fmt(signal.stopLoss)}
            </p>
            {feeData?.slDistancePct != null && (
              <p className="text-[10px] text-muted-foreground">
                {feeData.slDistancePct}% from entry
              </p>
            )}
          </div>

          {/* Take-profit + R:R */}
          <div className="min-w-0">
            <p className="text-muted-foreground text-xs">Take Profit</p>
            <p className="font-medium text-green-600 dark:text-green-400 truncate">
              ${fmt(signal.takeProfit)}
            </p>
            {feeData?.riskReward != null && (
              <p className="text-[10px] text-muted-foreground">
                {feeData.riskReward}:1 R:R
              </p>
            )}
          </div>
        </div>

        {/* Estimated position size */}
        {feeData?.positionSizeUsdt != null && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground text-xs">Est. Position</span>
            <span className="font-medium">
              ${fmt(feeData.positionSizeUsdt, 2)}
              {feeData.positionSizeUnits != null && (
                <span className="text-muted-foreground font-normal">
                  {' '}({fmt(feeData.positionSizeUnits, feeData.positionSizeUnits >= 1 ? 2 : 6)} units)
                </span>
              )}
            </span>
          </div>
        )}

        {/* Expected P&L net of fees */}
        {feeData && (
          <div className="rounded-lg border border-dashed p-3 space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Expected P&amp;L (% of notional)
            </p>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-muted-foreground text-xs">Net Profit (after fees)</p>
                <p className="font-medium text-green-600 dark:text-green-400">
                  +{fmt(feeData.netExpectedProfit)}%
                </p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">Net Loss (after fees)</p>
                <p className="font-medium text-red-600 dark:text-red-400">
                  -{fmt(feeData.netExpectedLoss)}%
                </p>
              </div>
            </div>
            <div className="border-t pt-2 flex items-center justify-between text-xs text-muted-foreground">
              <span>
                Fees:{' '}
                <span className="font-medium text-foreground">
                  {fmt(feeData.totalFeeCost, 4)}%
                </span>
              </span>
              <span>
                Break-even:{' '}
                <span className="font-medium text-foreground">
                  {fmt(feeData.breakEvenDistance, 4)}%
                </span>
              </span>
            </div>
          </div>
        )}

        {/* Expandable reasoning section */}
        <div>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1 py-3 -my-3"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className={`h-3 w-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
            {expanded ? 'Hide' : 'Show'} reasoning &amp; analysis
          </button>

          {expanded && <ReasoningSection signal={signal} />}
        </div>

        {/* Expandable risk calculation section */}
        <div>
          <button
            type="button"
            onClick={() => setShowRisk((v) => !v)}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1 py-3 -my-3"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className={`h-3 w-3 transition-transform ${showRisk ? 'rotate-90' : ''}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
            {showRisk ? 'Hide' : 'Show'} risk calculation
          </button>

          {showRisk && <RiskCalculationSection signal={signal} />}
        </div>

        {/* Execution error — persists across refreshes; auto-mode signals keep
            retrying (src/worker/auto-execute-retry-loop.ts) until this clears
            or the signal expires. */}
        {isPending && signal.lastError && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">
            <p className="font-medium">
              Last execution attempt failed{signal.executionAttempts ? ` (attempt ${signal.executionAttempts})` : ''}
            </p>
            <p className="mt-0.5 text-red-700 dark:text-red-400">{signal.lastError}</p>
          </div>
        )}

        {/* Action result feedback */}
        {actionResult && (
          <div
            className={`rounded-md p-3 text-sm ${
              actionResult.type === 'success'
                ? 'bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-300'
                : 'bg-red-50 text-red-800 dark:bg-red-900/20 dark:text-red-300'
            }`}
          >
            {actionResult.message}
          </div>
        )}

        {/* Approve / Reject buttons — shown for any pending signal, regardless of trading mode */}
        {showActions && isPending && !actionResult && (
          <div className="flex items-center gap-3 pt-1">
            <Button
              size="sm"
              className="flex-1 h-11 md:h-8 bg-green-600 hover:bg-green-700 text-white"
              disabled={actionLoading !== null}
              onClick={() => void handleAction('approve')}
            >
              {actionLoading === 'approve' ? (
                <span className="flex items-center gap-2">
                  <svg
                    className="animate-spin h-3 w-3"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8v8H4z"
                    />
                  </svg>
                  Approving…
                </span>
              ) : (
                'Approve'
              )}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="flex-1 h-11 md:h-8 border-red-300 text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20"
              disabled={actionLoading !== null}
              onClick={() => void handleAction('reject')}
            >
              {actionLoading === 'reject' ? 'Rejecting…' : 'Reject'}
            </Button>
          </div>
        )}

        {/* Cancel button — approved signals have a resting entry order (live)
            or a waiting paper fill; cancelling stops it before it fills. */}
        {showActions && isApproved && !actionResult && (
          <div className="flex items-center gap-3 pt-1">
            <p className="flex-1 text-xs text-muted-foreground">
              Awaiting fill at ${fmt(signal.entryPrice)} — order resting.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="h-11 md:h-8 border-red-300 text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20"
              disabled={actionLoading !== null}
              onClick={() => void handleAction('cancel')}
            >
              {actionLoading === 'cancel' ? 'Cancelling…' : 'Cancel Order'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>

    {/* Chart modal — true fullscreen via raw Radix primitive */}
    <Dialog open={showChart} onOpenChange={setShowChart}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 50,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--color-background)',
            outline: 'none',
          }}
        >
          {/* Title bar */}
          <div className="shrink-0 flex items-center justify-between gap-2 px-3 md:px-4 py-2 border-b bg-background">
            <div className="flex items-center gap-2 text-sm font-semibold min-w-0">
              <span className="truncate">{signal.symbol}</span>
              <span className="text-muted-foreground font-normal shrink-0">{signal.timeframe}</span>
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold shrink-0 ${directionClass(signal.direction)}`}
              >
                {signal.direction}
              </span>
              {signal.entryPrice && (
                <span className="hidden md:inline text-muted-foreground font-normal text-xs truncate">
                  Entry ${fmt(signal.entryPrice)} · SL ${fmt(signal.stopLoss)} · TP ${fmt(signal.takeProfit)}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1 md:gap-2 shrink-0">
              <a
                href={buildTradingViewUrl(signal.symbol, connectedExchange, signal.marketType)}
                target="_blank"
                rel="noopener noreferrer"
                title="Open in TradingView"
                className="inline-flex items-center justify-center gap-1.5 rounded-md border p-2.5 md:px-2.5 md:py-1 min-h-11 min-w-11 md:min-h-0 md:min-w-0 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5 md:h-3 md:w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
                </svg>
                <span className="hidden md:inline">TradingView</span>
              </a>
              <button
                type="button"
                onClick={() => setShowChart(false)}
                className="rounded-md p-2.5 md:p-1.5 min-h-11 min-w-11 md:min-h-0 md:min-w-0 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                aria-label="Close chart"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>
          {/* Mobile-only price line, wraps below the title row */}
          {signal.entryPrice && (
            <div className="md:hidden shrink-0 px-3 py-1.5 border-b bg-background text-xs text-muted-foreground truncate">
              Entry ${fmt(signal.entryPrice)} · SL ${fmt(signal.stopLoss)} · TP ${fmt(signal.takeProfit)}
            </div>
          )}
          {/* Chart fills remaining height */}
          <div style={{ flex: 1, minHeight: 0 }}>
            <SignalChart
              symbol={signal.symbol}
              timeframe={signal.timeframe}
              entry={signal.entryPrice != null ? Number(signal.entryPrice) : null}
              stopLoss={signal.stopLoss != null ? Number(signal.stopLoss) : null}
              takeProfit={signal.takeProfit != null ? Number(signal.takeProfit) : null}
              direction={signal.direction}
              marketType={signal.marketType}
              exchange={connectedExchange}
              smcLevels={
                Array.isArray(signal.rawPayload?.smcLevels)
                  ? (signal.rawPayload!.smcLevels as Array<{ type: string; priceLevel: number; direction: 'BULLISH' | 'BEARISH' }>)
                  : null
              }
            />
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
    </>
  );
}
