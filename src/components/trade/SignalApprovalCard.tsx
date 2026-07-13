'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

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
  rawPayload: Record<string, unknown> | null;
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
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground">
                {Object.entries(indicators).map(([k, v]) => (
                  <div key={k}>
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
// Main component
// ---------------------------------------------------------------------------

interface SignalApprovalCardProps {
  signal: QueueSignal;
  showActions: boolean; // false for auto-execution users (history-only view)
  onAction: (id: string, action: 'approve' | 'reject') => Promise<void>;
}

export function SignalApprovalCard({
  signal,
  showActions,
  onAction,
}: SignalApprovalCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [actionLoading, setActionLoading] = useState<'approve' | 'reject' | null>(null);
  const [actionResult, setActionResult] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const { feeData } = signal;
  const expiryLabel = timeUntilExpiry(signal.expiresAt, signal.createdAt);
  const src = sourceLabel(signal.source);
  const isPending = signal.status === 'pending';

  async function handleAction(action: 'approve' | 'reject') {
    setActionLoading(action);
    setActionResult(null);
    try {
      await onAction(signal.id, action);
      setActionResult({
        type: 'success',
        message:
          action === 'approve'
            ? 'Signal approved and queued for execution.'
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
    <Card className="w-full">
      <CardHeader className="pb-2">
        {/* Top row */}
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-lg">{signal.symbol}</span>
            <span className="text-muted-foreground text-sm">{signal.timeframe}</span>

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

            {signal.exitMode === 'trailing' && (
              <Badge
                variant="outline"
                className="text-xs border-blue-400 text-blue-600 dark:border-blue-500 dark:text-blue-400"
              >
                Trailing
              </Badge>
            )}
          </div>

          {/* Expiry label */}
          {expiryLabel && isPending && (
            <span className="text-xs text-muted-foreground shrink-0">{expiryLabel}</span>
          )}
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

      <CardContent className="space-y-4">
        {/* Price levels grid */}
        <div className="grid grid-cols-3 gap-3 text-sm">
          {/* Entry zone */}
          <div>
            <p className="text-muted-foreground text-xs">Entry</p>
            <p className="font-medium">${fmt(signal.entryPrice)}</p>
          </div>

          {/* Stop-loss + distance */}
          <div>
            <p className="text-muted-foreground text-xs">Stop Loss</p>
            <p className="font-medium text-red-600 dark:text-red-400">
              ${fmt(signal.stopLoss)}
            </p>
            {feeData?.slDistancePct != null && (
              <p className="text-[10px] text-muted-foreground">
                {feeData.slDistancePct}% from entry
              </p>
            )}
          </div>

          {/* Take-profit + R:R */}
          <div>
            <p className="text-muted-foreground text-xs">Take Profit</p>
            <p className="font-medium text-green-600 dark:text-green-400">
              ${fmt(signal.takeProfit)}
            </p>
            {feeData?.riskReward != null && (
              <p className="text-[10px] text-muted-foreground">
                {feeData.riskReward}:1 R:R
              </p>
            )}
          </div>
        </div>

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
            className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
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

        {/* Approve / Reject buttons — only shown for pending signals in manual mode */}
        {showActions && isPending && !actionResult && (
          <div className="flex items-center gap-3 pt-1">
            <Button
              size="sm"
              className="flex-1 bg-green-600 hover:bg-green-700 text-white"
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
              className="flex-1 border-red-300 text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20"
              disabled={actionLoading !== null}
              onClick={() => void handleAction('reject')}
            >
              {actionLoading === 'reject' ? 'Rejecting…' : 'Reject'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
