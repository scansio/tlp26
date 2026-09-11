/**
 * Shared direction-aware P&L math. SHORT flips the sign of the raw
 * (exit - entry) * size delta; LONG uses it as-is.
 */

export type PositionDirection = 'LONG' | 'SHORT';

export function computePnlUsd(
  entryPrice: number,
  exitPrice: number,
  positionSize: number,
  direction: PositionDirection = 'LONG',
): number {
  const raw = (exitPrice - entryPrice) * positionSize;
  return direction === 'LONG' ? raw : -raw;
}

export function computePnlPct(
  entryPrice: number,
  exitPrice: number,
  positionSize: number,
  direction: PositionDirection = 'LONG',
): number | null {
  if (entryPrice <= 0 || positionSize <= 0) return null;
  const usd = computePnlUsd(entryPrice, exitPrice, positionSize, direction);
  return (usd / (entryPrice * positionSize)) * 100;
}

/**
 * P&L % of notional (computePnlPct above) scaled by leverage — the ROI-on-
 * margin figure exchanges (BingX/Binance/Bybit) actually show on a position,
 * since notional = margin × leverage, so usd/margin = (usd/notional) × leverage.
 */
export function computeLeveragedPnlPct(
  pnlPct: number | null,
  leverage: number | null | undefined,
): number | null {
  if (pnlPct === null) return null;
  return pnlPct * (leverage && leverage > 0 ? leverage : 1);
}

// ---------------------------------------------------------------------------
// Signal/position outcome — "is this currently working out, and how did it
// finish" — derived from the linked trade_execution's status + fill type,
// falling back to the P&L sign when fillType is missing/ambiguous (manual
// closes, or an execution row that predates fillType being recorded).
// ---------------------------------------------------------------------------

export type SignalOutcome = 'playingOut' | 'losingOut' | 'playedOut' | 'lostOut';

export function computeSignalOutcome(params: {
  executionStatus: string | null | undefined; // 'open' | 'closed' | 'cancelled'
  fillType?: string | null; // 'sl_hit' | 'tp_hit' | 'manual' | 'liquidation'
  pnl: number | null; // sign is all that matters — realized or unrealized, $ or %
}): SignalOutcome | null {
  const { executionStatus, fillType, pnl } = params;

  if (executionStatus === 'open') {
    if (pnl === null) return null;
    return pnl >= 0 ? 'playingOut' : 'losingOut';
  }

  if (executionStatus === 'closed') {
    if (fillType === 'tp_hit') return 'playedOut';
    if (fillType === 'sl_hit' || fillType === 'liquidation') return 'lostOut';
    if (pnl === null) return null;
    return pnl >= 0 ? 'playedOut' : 'lostOut';
  }

  return null;
}
