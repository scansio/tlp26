/**
 * Fixed-clock UTC cron schedule — no external economic calendar (that would
 * require external infra). Defaults cover: funding settlement, London open,
 * the London/NY overlap window, and the daily UTC close. Configurable via
 * WORKER_CRON_SCHEDULES (semicolon-separated cron expressions) so operators
 * can tune timing without a redeploy.
 */

import cron from 'node-cron';
import { runTick } from './tick';

const DEFAULT_SCHEDULES = [
  '0 0,8,16 * * *', // funding settlement — 00:00 / 08:00 / 16:00 UTC
  '0 7 * * *', // London open — ~07:00 UTC
  '0 12-16 * * *', // London/NY overlap — hourly 12:00-16:00 UTC
  '0 0 * * *', // daily UTC close
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function scheduleWorkerTicks(mastra: any): void {
  const schedules =
    process.env.WORKER_CRON_SCHEDULES?.split(';')
      .map((s) => s.trim())
      .filter(Boolean) ?? DEFAULT_SCHEDULES;

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
