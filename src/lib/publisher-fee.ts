/**
 * Publisher performance-fee accrual (TLP-35)
 *
 * Called whenever a subscriber's copied trade closes with positive realizedPnl.
 * Idempotent: the unique index on publisher_earnings.trade_id prevents
 * duplicate accruals if the position monitor revisits the same closed trade.
 *
 * Platform cut is read from PLATFORM_FEE_CUT_PCT env var (default 20).
 * Publisher net = feeAmount - platformCutAmount.
 */

import { eq } from 'drizzle-orm';
import { db } from '@/db';
import {
  tradeExecutions,
  tradeSignals,
  signalPublishers,
  publisherEarnings,
} from '@/db/schema';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the platform cut fraction from env (default 20%). */
function platformCutFraction(): number {
  const raw = process.env.PLATFORM_FEE_CUT_PCT;
  if (!raw) return 0.2; // default: 20%
  const n = parseFloat(raw);
  return isNaN(n) || n < 0 || n > 100 ? 0.2 : n / 100;
}

/** Format a number to a fixed-8 decimal string for Drizzle numeric columns. */
function toNumericStr(n: number): string {
  return n.toFixed(8);
}

/** Build a YYYY-MM period string from a Date. */
function toPeriod(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}`;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Accrue a performance fee for a publisher when a subscriber's copied trade closes.
 *
 * @param executionId  - ID of the closed trade_execution record
 * @param realizedPnl  - Gross realised P&L of the subscriber's trade (USDT)
 *
 * If the trade is not a copy trade, or the profit is zero or negative, or the
 * publisher has a zero fee, this is a no-op.
 *
 * Returns `true` if a fee was accrued, `false` otherwise.
 */
export async function accruePublisherFee(
  executionId: string,
  realizedPnl: number,
): Promise<boolean> {
  // Only accrue on profitable trades
  if (realizedPnl <= 0) return false;

  try {
    // Load the execution + its signal to find publisherId + subscriberId
    const rows = await db
      .select({
        executionId: tradeExecutions.id,
        subscriberId: tradeExecutions.userId,
        signalId: tradeExecutions.signalId,
        signalSource: tradeSignals.source,
        publisherId: tradeSignals.publisherId,
      })
      .from(tradeExecutions)
      .leftJoin(tradeSignals, eq(tradeExecutions.signalId, tradeSignals.id))
      .where(eq(tradeExecutions.id, executionId))
      .limit(1);

    if (rows.length === 0) return false;

    const row = rows[0];

    // Only process copy trades with a resolved publisher
    if (row.signalSource !== 'copy' || !row.publisherId) return false;

    // Load the publisher's fee percentage
    const [publisher] = await db
      .select({ feePercent: signalPublishers.feePercent, isActive: signalPublishers.isActive })
      .from(signalPublishers)
      .where(eq(signalPublishers.id, row.publisherId))
      .limit(1);

    if (!publisher) return false;

    const feePct = parseFloat(publisher.feePercent ?? '0');
    if (feePct <= 0) return false;

    // Compute amounts
    const feeAmount = realizedPnl * (feePct / 100);
    const platformCut = feeAmount * platformCutFraction();
    const publisherNet = feeAmount - platformCut;
    const period = toPeriod(new Date());

    // Insert — ON CONFLICT DO NOTHING via the unique index on trade_id
    await db
      .insert(publisherEarnings)
      .values({
        publisherId: row.publisherId,
        subscriberId: row.subscriberId,
        tradeId: executionId,
        profitAmount: toNumericStr(realizedPnl),
        feeAmount: toNumericStr(feeAmount),
        platformCutAmount: toNumericStr(platformCut),
        publisherNetAmount: toNumericStr(publisherNet),
        period,
      })
      .onConflictDoNothing({ target: publisherEarnings.tradeId });

    return true;
  } catch (err) {
    // Non-fatal: log but never throw back to the caller
    console.error('[publisher-fee] failed to accrue fee', { executionId, err });
    return false;
  }
}
