/**
 * Worker entrypoint — confluence-group scheduled signal generation,
 * SL/TP position monitoring, and signal expiry. Runs in its own Docker
 * container (Dockerfile.worker), no Next.js runtime, no external
 * queue/scheduler. See src/worker/tick.ts for the per-tick signal-generation
 * logic, src/worker/position-monitor-loop.ts for the position-monitor
 * driver, and src/worker/signal-expiry-loop.ts for the expiry driver.
 */

import { mastra } from '@/mastra';
import { scheduleWorkerTicks } from './schedule';
import { runTick } from './tick';
import { startPositionMonitorLoop } from './position-monitor-loop';
import { startPriceWatchLoop } from './price-watch-loop';
import { startSignalExpiryLoop } from './signal-expiry-loop';

console.log('[worker] starting — confluence-group trade-analysis worker');
scheduleWorkerTicks(mastra);
startPositionMonitorLoop();
startPriceWatchLoop();
startSignalExpiryLoop();

if (process.env.WORKER_RUN_ON_BOOT === 'true') {
  console.log('[worker] WORKER_RUN_ON_BOOT=true — running one tick immediately');
  runTick(mastra).catch((err) => console.error('[worker] boot tick error', err));
}
