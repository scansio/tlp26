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
