/**
 * Atomic claim so a manual Approve click and the auto-execute retry loop
 * (src/worker/auto-execute-retry-loop.ts) — or two overlapping retry ticks —
 * can never both act on the same pending signal. Before this, every
 * execution entry point did a plain SELECT-then-UPDATE: both callers could
 * read status='pending' before either one wrote anything, and both would
 * proceed to size and place an order for the same signal.
 *
 * 'executing' is a brief, transient state between 'pending' and the real
 * outcome — never a terminal one. Every execution path must eventually move
 * the signal away from it: on success, execute-trade-tool/entry-fill's own
 * status update (unconditional on id, not on prior status) already does
 * that; on any failure or early-return path, call releaseSignalClaim.
 * releaseSignalClaim only writes when status is still 'executing', so it is
 * always safe to call unconditionally in a `finally` block — a no-op once
 * the signal has already moved on to 'executed'/'approved'.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { tradeSignals } from '@/db/schema';

type TradeSignalRow = typeof tradeSignals.$inferSelect;

/** Returns the claimed row (status now 'executing'), or null if the signal
 * wasn't 'pending' anymore — already claimed elsewhere, or moved to a
 * terminal status (approved/rejected/executed/cancelled/expired). */
export async function claimPendingSignal(signalId: string): Promise<TradeSignalRow | null> {
  const [claimed] = await db
    .update(tradeSignals)
    .set({ status: 'executing', updatedAt: new Date() })
    .where(and(eq(tradeSignals.id, signalId), eq(tradeSignals.status, 'pending')))
    .returning();
  return claimed ?? null;
}

/** Reverts a claim back to 'pending' — safe to call unconditionally; only
 * writes if the signal is still 'executing' (i.e. nothing else already
 * moved it to a terminal status or a genuine success). */
export async function releaseSignalClaim(signalId: string): Promise<void> {
  await db
    .update(tradeSignals)
    .set({ status: 'pending', updatedAt: new Date() })
    .where(and(eq(tradeSignals.id, signalId), eq(tradeSignals.status, 'executing')));
}
