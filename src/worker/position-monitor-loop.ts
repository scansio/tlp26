/**
 * Periodic driver for the SL/TP position monitor (src/lib/position-monitor.ts).
 *
 * The monitor's own start/stop logic only fires when syncMonitors() is called —
 * nothing in the request path did that, so open positions never got watched.
 * This worker is the one long-lived process in the deployment, so it owns the tick.
 */

import { positionMonitor } from '@/lib/position-monitor';

const DEFAULT_SYNC_INTERVAL_MS = 30_000;

export function startPositionMonitorLoop(): void {
  const intervalMs = process.env.POSITION_MONITOR_SYNC_INTERVAL_MS
    ? Number(process.env.POSITION_MONITOR_SYNC_INTERVAL_MS)
    : DEFAULT_SYNC_INTERVAL_MS;

  const tick = () => {
    positionMonitor.syncMonitors().catch((err) =>
      console.error('[worker] position-monitor sync error', err),
    );
  };

  tick();
  setInterval(tick, intervalMs);
  console.log(`[worker] position-monitor sync loop started (every ${intervalMs}ms)`);
}
