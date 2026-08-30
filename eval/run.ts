/**
 * Eval runner bootstrap.
 *
 * market-analysis.ts reads WORKER_AGENT_RETRY_* at module load, so the
 * defaults must be set before any static import pulls it in — hence the
 * dynamic import. Production keeps its 60s retry delay; the eval defaults to
 * 5s so a transient LLM error doesn't stall a run for minutes.
 *
 * Usage:
 *   node --env-file-if-exists=.env --env-file-if-exists=.env.local \
 *     ./node_modules/.bin/tsx eval/run.ts --system workflow|baseline [--runs N] [caseId ...]
 */

process.env.WORKER_AGENT_RETRY_DELAY_MS ??= '5000';
process.env.WORKER_AGENT_RETRY_ATTEMPTS ??= '2';

import('./lib/run-impl');
