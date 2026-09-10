/**
 * Durable, priority-ordered job queue for the scheduled worker's per-user
 * finalization step (risk-sizing, signal creation, auto-execution).
 *
 * Producer: src/worker/tick.ts enqueues one `auto_trade_jobs` row per user in
 * a confluence group once that group's shared analysis resolves to a
 * non-HOLD action, instead of calling finalizeForUser directly inline. That
 * inline call used to simply vanish for an entire group if the tick got
 * skipped by withGlobalTickLock (still true today for the *analysis* half —
 * a skipped tick still runs no analysis — but a *successful* tick's jobs are
 * now durable rows, not a `for` loop's local state).
 *
 * Consumer: processAutoTradeJobs (called from tick.ts, at the end of every
 * successful tick) batch-claims pending rows with `FOR UPDATE SKIP LOCKED`,
 * atomically marking them 'processing' in the same statement, then calls
 * finalizeForUser for each. It runs inside the same withGlobalTickLock call
 * as the producer rather than as its own setInterval loop: this worker is
 * single-instance today (see CLAUDE.md's Background worker section), so a
 * second independent timer would just duplicate the overlap-guarding
 * runTick already gets for free from the advisory lock, for no benefit.
 *
 * Retry/backoff: a failed job goes back to 'pending' with attempts
 * incremented and last_error set. The claim query only reclaims a
 * previously-attempted job once `attempts` minutes have passed since its
 * last update (attempt 1 → wait 1m, attempt 2 → wait 2m, ...). This is a
 * lower bound, not a guarantee of which tick reclaims it — a batch's
 * finalizeForUser calls run with FINALIZE_CONCURRENCY-way concurrency and
 * can individually take longer than a minute, so a job could in principle be
 * reclaimed later in the *same* processAutoTradeJobs call. In practice, with
 * ticks ~15 minutes apart (src/worker/schedule.ts), a failing job is usually
 * retried on a later tick rather than hot-looped within the same one.
 * After MAX_ATTEMPTS failures it's left 'failed' for good (never retried
 * again automatically).
 *
 * Staleness: a job's payload is a point-in-time MarketAnalysisResult snapshot
 * (entry/SL/TP levels included). If a job sits pending/retrying long enough
 * that its snapshot is no longer a reasonable basis for a trade, it's marked
 * 'failed' with last_error='stale analysis snapshot' instead of being
 * processed — finalizeForUser must never act on a stale entry/SL/TP (this
 * mirrors why execution elsewhere in this codebase always uses the stored
 * risk calc shown to the user rather than a silent recompute).
 */

import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { autoTradeJobs } from '@/db/schema';
import { finalizeForUser } from '@/lib/analysis/finalize-for-user';
import type { MarketAnalysisResult } from '@/lib/analysis/market-analysis';
import { resolvePlanForUser } from '@/lib/billing/plan';
import { getUsageToday, hasAutoTradeQuota, incrementAutoTradeRunUsage } from '@/lib/billing/usage';
import { chunk } from './util';

const BATCH_SIZE = Number(process.env.WORKER_JOB_BATCH_SIZE ?? 10);
/** Safety cap so a huge backlog can't make one tick run forever. */
const MAX_BATCHES_PER_TICK = Number(process.env.WORKER_JOB_MAX_BATCHES_PER_TICK ?? 20);
const MAX_ATTEMPTS = 3;
/** Concurrency within one claimed batch — mirrors the old inline fan-out's chunk(users, 5). */
const FINALIZE_CONCURRENCY = 5;
/** ~6 ticks at the default 15m cadence. */
const STALE_JOB_MAX_AGE_MS = 90 * 60_000;

interface ClaimedJob {
  id: string;
  userId: string;
  analysisRunId: string;
  exchange: 'binance' | 'bybit' | 'bingx';
  payload: MarketAnalysisResult;
  attempts: number;
  createdAt: Date;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowsOf(result: any): any[] {
  // node-postgres's QueryResult shape (what db.execute() resolves to for raw SQL).
  return Array.isArray(result?.rows) ? result.rows : [];
}

/**
 * Atomically claims up to `limit` pending jobs (oldest-first within each
 * priority tier), marking them 'processing' in the same statement so two
 * concurrent claimers (not a real scenario today — single worker instance —
 * but cheap correctness insurance) never grab the same row.
 */
async function claimBatch(limit: number): Promise<ClaimedJob[]> {
  const result = await db.execute(sql`
    WITH claimed AS (
      SELECT id
      FROM auto_trade_jobs
      WHERE status = 'pending'
        AND (attempts = 0 OR updated_at <= now() - (attempts * interval '1 minute'))
      ORDER BY priority DESC, created_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE auto_trade_jobs
    SET status = 'processing', updated_at = now()
    FROM claimed
    WHERE auto_trade_jobs.id = claimed.id
    RETURNING
      auto_trade_jobs.id,
      auto_trade_jobs.user_id,
      auto_trade_jobs.analysis_run_id,
      auto_trade_jobs.exchange,
      auto_trade_jobs.payload,
      auto_trade_jobs.attempts,
      auto_trade_jobs.created_at
  `);

  return rowsOf(result).map((r) => ({
    id: r.id as string,
    userId: r.user_id as string,
    analysisRunId: r.analysis_run_id as string,
    exchange: r.exchange as 'binance' | 'bybit' | 'bingx',
    payload: r.payload as MarketAnalysisResult,
    attempts: r.attempts as number,
    createdAt: new Date(r.created_at as string),
  }));
}

async function markDone(id: string): Promise<void> {
  await db.update(autoTradeJobs).set({ status: 'done', updatedAt: new Date() }).where(eq(autoTradeJobs.id, id));
}

async function markFailed(id: string, attempts: number, lastError: string, terminal: boolean): Promise<void> {
  await db
    .update(autoTradeJobs)
    .set({
      status: terminal ? 'failed' : 'pending',
      attempts,
      lastError: lastError.slice(0, 2000),
      updatedAt: new Date(),
    })
    .where(eq(autoTradeJobs.id, id));
}

async function processJob(job: ClaimedJob, mastra: unknown): Promise<void> {
  const ageMs = Date.now() - job.createdAt.getTime();
  if (ageMs > STALE_JOB_MAX_AGE_MS) {
    console.warn(
      `[worker] job ${job.id} (userId=${job.userId}) is ${Math.round(ageMs / 60_000)}m old — ` +
        `failing without processing rather than trading on a stale analysis snapshot`,
    );
    await markFailed(job.id, job.attempts, 'stale analysis snapshot', true);
    return;
  }

  // Re-check the daily auto-trade run quota right before finalizing — the
  // durable queue means a job can sit pending long enough that the user hits
  // their cap (via another job) between enqueue and claim. eligibility.ts's
  // check at enqueue time alone isn't enough for that race.
  const plan = await resolvePlanForUser(job.userId);
  const usage = await getUsageToday(job.userId);
  if (!hasAutoTradeQuota(usage, plan)) {
    console.log(
      `[worker] job ${job.id} (userId=${job.userId}) skipped — daily auto-trade quota reached ` +
        `(${usage.autoTradeRunsUsed}/${plan.autoTradeRunsPerDay}, plan=${plan.name})`,
    );
    await markFailed(job.id, job.attempts, 'daily auto-trade quota reached', true);
    return;
  }

  try {
    const result = await finalizeForUser({
      userId: job.userId,
      analysis: job.payload,
      analysisRunId: job.analysisRunId,
      executionExchange: job.exchange,
      mastra,
    });
    // Only counts as a "run" once a signal was actually produced — a HOLD
    // (no signal) or an aborted finalize (missing SL/TP) never increments.
    if (result.signalId) {
      await incrementAutoTradeRunUsage(job.userId);
    }
    await markDone(job.id);
  } catch (err) {
    const attempts = job.attempts + 1;
    const terminal = attempts >= MAX_ATTEMPTS;
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[worker] job ${job.id} (userId=${job.userId}) failed (attempt ${attempts}/${MAX_ATTEMPTS})` +
        (terminal ? ' — giving up' : ' — will retry on a later tick'),
      err,
    );
    await markFailed(job.id, attempts, message, terminal);
  }
}

/**
 * Drains the auto_trade_jobs queue: claims and processes batches of
 * BATCH_SIZE pending jobs (bounded concurrency within each batch) until a
 * claim comes back short of a full batch (queue empty for now) or
 * MAX_BATCHES_PER_TICK is hit (backlog safety valve).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function processAutoTradeJobs(mastra: any): Promise<void> {
  for (let batchNum = 0; batchNum < MAX_BATCHES_PER_TICK; batchNum++) {
    const claimed = await claimBatch(BATCH_SIZE);
    if (claimed.length === 0) break;

    console.log(`[worker] job-queue: claimed ${claimed.length} job(s) (batch ${batchNum + 1})`);

    for (const group of chunk(claimed, FINALIZE_CONCURRENCY)) {
      await Promise.all(group.map((job) => processJob(job, mastra)));
    }

    if (claimed.length < BATCH_SIZE) break;
  }
}
