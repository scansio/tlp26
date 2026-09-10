/**
 * Next.js instrumentation hook — register() runs once when the server
 * process boots, before it starts accepting requests. This is where the
 * confluence-group trading worker used to live as a separate long-running
 * process (Dockerfile.worker / `npm run worker`); it's merged in here so a
 * single Next.js container/process is the whole deployment.
 *
 * Guarded to the Node.js runtime (register() also fires once for the Edge
 * runtime, which can't run any of this) and to firing once per process —
 * Next re-evaluates modules across HMR reloads in dev, but `globalThis`
 * survives that, same pattern as src/db/index.ts's pool singleton.
 *
 * Off by default outside production so `next dev` never starts placing
 * trades / polling exchanges unless you opt in — set WORKER_ENABLED=true to
 * run it locally (this is what docker-compose.yml's worker service used to
 * be for).
 */

declare global {
  var __tradingWorkerStarted: boolean | undefined;
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const enabled = process.env.WORKER_ENABLED
    ? process.env.WORKER_ENABLED === 'true'
    : process.env.NODE_ENV === 'production';

  if (!enabled) {
    console.log('[worker] disabled in this environment (set WORKER_ENABLED=true to run it)');
    return;
  }

  if (globalThis.__tradingWorkerStarted) return;
  globalThis.__tradingWorkerStarted = true;

  const { mastra } = await import('@/mastra');
  const { scheduleWorkerTicks } = await import('@/worker/schedule');
  const { runTick } = await import('@/worker/tick');
  const { startPositionMonitorLoop } = await import('@/worker/position-monitor-loop');
  const { startPriceWatchLoop } = await import('@/worker/price-watch-loop');
  const { startSignalExpiryLoop } = await import('@/worker/signal-expiry-loop');
  const { startAutoExecuteRetryLoop } = await import('@/worker/auto-execute-retry-loop');
  const { startEntryReconcileLoop } = await import('@/worker/entry-reconcile-loop');
  const { startOxapayRenewalLoop } = await import('@/worker/oxapay-renewal-loop');

  console.log('[worker] starting — confluence-group trading worker (in-process)');
  scheduleWorkerTicks(mastra);
  startPositionMonitorLoop();
  startPriceWatchLoop();
  startSignalExpiryLoop();
  startAutoExecuteRetryLoop();
  startEntryReconcileLoop();
  startOxapayRenewalLoop();

  if (process.env.WORKER_RUN_ON_BOOT === 'true') {
    console.log('[worker] WORKER_RUN_ON_BOOT=true — running one tick immediately');
    runTick(mastra).catch((err) => console.error('[worker] boot tick error', err));
  }
}
