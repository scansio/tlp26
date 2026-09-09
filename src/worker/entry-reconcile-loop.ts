/**
 * Periodic driver for src/lib/reconcile-entries.ts.
 *
 * /api/cron/reconcile-entries only fires when an external scheduler hits
 * it — nothing in this deployment does, so 'approved' signals (resting
 * limit orders) never got checked for a fill: no fill detection meant no
 * finalizeLiveFill, which meant no protective SL/TP orders and a signal
 * stuck showing "awaiting fill" forever even after the order filled on the
 * exchange. This worker is the one long-lived process in the deployment,
 * so it owns the tick too.
 */

import { reconcileApprovedEntries } from '@/lib/reconcile-entries';

const DEFAULT_INTERVAL_MS = 60_000;

export function startEntryReconcileLoop(): void {
  const intervalMs = process.env.ENTRY_RECONCILE_INTERVAL_MS
    ? Number(process.env.ENTRY_RECONCILE_INTERVAL_MS)
    : DEFAULT_INTERVAL_MS;

  // finalizeLiveFill is not idempotent (inserts a trade_execution + places
  // real protective orders) — an overlapping tick re-selecting the same
  // still-'approved' signal before the previous tick flips its status would
  // double-execute it. A slow exchange call (rate limit, timeout) is exactly
  // when two ticks would otherwise overlap, so guard with an in-flight flag
  // rather than assuming one tick always finishes within intervalMs.
  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await reconcileApprovedEntries();
    } catch (err) {
      console.error('[worker] entry-reconcile error', err);
    } finally {
      inFlight = false;
    }
  };

  tick();
  setInterval(tick, intervalMs);
  console.log(`[worker] entry-reconcile loop started (every ${intervalMs}ms)`);
}
