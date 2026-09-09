/**
 * Periodic driver for src/lib/expire-signals.ts.
 *
 * /api/cron/expire-signals only fires when an external scheduler hits it —
 * nothing in this deployment does, so pending/approved signals past their
 * expiresAt never actually flipped to 'expired' in the DB. This worker is
 * the one long-lived process in the deployment, so it owns the tick too.
 */

import { expireStaleSignals } from '@/lib/expire-signals';

const DEFAULT_INTERVAL_MS = 5 * 60_000;

export function startSignalExpiryLoop(): void {
  const intervalMs = process.env.SIGNAL_EXPIRY_INTERVAL_MS
    ? Number(process.env.SIGNAL_EXPIRY_INTERVAL_MS)
    : DEFAULT_INTERVAL_MS;

  const tick = () => {
    expireStaleSignals().catch((err) =>
      console.error('[worker] signal-expiry error', err),
    );
  };

  tick();
  setInterval(tick, intervalMs);
  console.log(`[worker] signal-expiry loop started (every ${intervalMs}ms)`);
}
