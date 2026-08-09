/**
 * Worker entrypoint — confluence-group scheduled signal generation and
 * SL/TP position monitoring. Runs in its own Docker container
 * (Dockerfile.worker), no Next.js runtime, no external queue/scheduler.
 * See src/worker/tick.ts for the per-tick signal-generation logic and
 * src/worker/position-monitor-loop.ts for the position-monitor driver.
 */

import { mastra } from '@/mastra';
import { scheduleWorkerTicks } from './schedule';
import { runTick } from './tick';
import { startPositionMonitorLoop } from './position-monitor-loop';

console.log('[worker] starting — confluence-group trade-analysis worker');
scheduleWorkerTicks(mastra);
startPositionMonitorLoop();

if (process.env.WORKER_RUN_ON_BOOT === 'true') {
  console.log('[worker] WORKER_RUN_ON_BOOT=true — running one tick immediately');
  runTick(mastra).catch((err) => console.error('[worker] boot tick error', err));
}
