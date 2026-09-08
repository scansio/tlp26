/**
 * Worker tick scheduling: a plain interval tick (default every 15m, matching
 * the pipeline's LTF) is the primary driver, configurable via
 * WORKER_TICK_INTERVAL_MINUTES so operators can tune cadence without a
 * redeploy. Layered on top are fixed-clock UTC cron ticks for session events
 * an interval alone would miss between fires — funding settlement, London
 * open, and the London/NY overlap window — configurable via
 * WORKER_CRON_SCHEDULES (semicolon-separated cron expressions; pass an empty
 * string to disable them entirely).
 */

import cron from 'node-cron';
import { runTick } from './tick';

const DEFAULT_TICK_INTERVAL_MINUTES = 15;

const DEFAULT_CRON_SCHEDULES = [
  '0 0,8,16 * * *', // funding settlement — 00:00 / 08:00 / 16:00 UTC
  '0 7 * * *', // London open — ~07:00 UTC
  '0 12-16 * * *', // London/NY overlap — hourly 12:00-16:00 UTC
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function scheduleWorkerTicks(mastra: any): void {
  scheduleIntervalTick(mastra);
  scheduleCronTicks(mastra);
}

/** Primary driver: fire a tick every N minutes, default 15 (the pipeline's LTF). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scheduleIntervalTick(mastra: any): void {
  const raw = process.env.WORKER_TICK_INTERVAL_MINUTES;
  const minutes = raw ? Number(raw) : DEFAULT_TICK_INTERVAL_MINUTES;

  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`WORKER_TICK_INTERVAL_MINUTES must be a positive number, got "${raw}"`);
  }

  setInterval(
    () => {
      runTick(mastra).catch((err) => console.error('[worker] tick error', err));
    },
    minutes * 60_000,
  );
  console.log(`[worker] scheduled: interval tick every ${minutes}m`);
}

/** Secondary: session-aware cron fires that an interval alone could straddle. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scheduleCronTicks(mastra: any): void {
  const schedules =
    process.env.WORKER_CRON_SCHEDULES?.split(';')
      .map((s) => s.trim())
      .filter(Boolean) ?? DEFAULT_CRON_SCHEDULES;

  for (const expr of schedules) {
    cron.schedule(
      expr,
      () => {
        runTick(mastra).catch((err) => console.error('[worker] tick error', err));
      },
      { timezone: 'UTC' },
    );
    console.log(`[worker] scheduled: "${expr}" (UTC)`);
  }
}
