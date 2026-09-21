/**
 * One worker tick: fetch eligible users, bucket them into confluence groups,
 * run the shared market analysis once per group, enqueue a durable job per
 * user in every non-HOLD group, then drain the job queue.
 *
 * Producer (enqueue) and consumer (drain) both run here, inside the same
 * withGlobalTickLock call — see src/worker/job-queue.ts's header comment for
 * why that's simpler than a second independent interval for a worker that's
 * single-instance today. This replaces the old inline
 * `for (const batch of chunk(group.users, 5)) await Promise.all(...)`
 * fan-out: previously, if a tick was skipped (withGlobalTickLock is
 * non-blocking — an in-flight tick makes the next one a silent no-op), every
 * user in every group of that tick simply never got finalized. Now the
 * analysis itself still only runs on a successful tick, but every user job
 * that *is* produced is a durable row — a skipped tick just leaves last
 * tick's queue to be drained (or a straggling job retried) on the next one.
 */

import crypto from 'node:crypto';
import { db } from '@/db';
import { autoTradeJobs } from '@/db/schema';
import { runMarketAnalysis } from '@/lib/analysis/market-analysis';
import { resolvePlansForUsers } from '@/lib/billing/plan';
import { fetchEligibleUsers } from './eligibility';
import { groupIntoConfluenceGroups } from './grouping';
import { processAutoTradeJobs } from './job-queue';
import { withGlobalTickLock } from './lock';

/**
 * In-process HOLD cooldown, keyed by confluence group (symbol+exchange+
 * marketType). Ticks fire every 15m by default (see schedule.ts) plus
 * session-aware cron fires layered on top of that interval, so without this a
 * symbol sitting at HOLD gets a full re-analysis — including the
 * agentDecision LLM call, which analysis-cache.ts's deterministic-data cache
 * does NOT cover — on every single fire. This only throttles the *worker's*
 * scheduled path; runMarketAnalysis itself has no cooldown, so the chat and
 * TradingView-webhook callers (trade-analysis-workflow.ts) are unaffected.
 *
 * In-process (not persisted) so it resets on restart, same tradeoff as
 * eligibility.ts's `notifiedUnsupported` Set — the boot tick
 * (WORKER_RUN_ON_BOOT) re-populates it within one cycle regardless.
 */
const lastHoldByGroup = new Map<string, number>();

const DEFAULT_HOLD_COOLDOWN_MINUTES = 30;

function resolveHoldCooldownMs(): number {
  const raw = process.env.WORKER_HOLD_COOLDOWN_MINUTES;
  const minutes = raw ? Number(raw) : DEFAULT_HOLD_COOLDOWN_MINUTES;
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new Error(`WORKER_HOLD_COOLDOWN_MINUTES must be a non-negative number, got "${raw}"`);
  }
  return minutes * 60_000;
}

// Validated once at module load (mirrors schedule.ts's WORKER_TICK_INTERVAL_MINUTES
// check) so a bad env value fails the worker at startup, not silently every
// tick inside withGlobalTickLock's catch.
const HOLD_COOLDOWN_MS = resolveHoldCooldownMs();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function runTick(mastra: any): Promise<void> {
  await withGlobalTickLock(async () => {
    const eligibleUsers = await fetchEligibleUsers();
    if (eligibleUsers.length === 0) {
      console.log('[worker] tick: no eligible users');
    } else {
      // Resolve every eligible user's plan tier once per tick (batched, not
      // per-job) — job_priority (see subscription_plans) feeds
      // auto_trade_jobs.priority below, replacing the old hardcoded default
      // so paid/BYOK users' jobs are claimed ahead of free-tier ones (see
      // job-queue.ts's claim query: ORDER BY priority DESC, created_at ASC).
      const plansByUser = await resolvePlansForUsers(eligibleUsers.map((u) => u.userId));
      const groups = groupIntoConfluenceGroups(eligibleUsers);
      console.log(
        `[worker] tick: ${eligibleUsers.length} eligible user(s) -> ${groups.length} confluence group(s)`,
      );

      for (const group of groups) {
        const lastHoldAt = lastHoldByGroup.get(group.key);
        if (lastHoldAt !== undefined && Date.now() - lastHoldAt < HOLD_COOLDOWN_MS) {
          console.log(
            `[worker] group=${group.key} -> skipped, HOLD ${Math.round((Date.now() - lastHoldAt) / 60_000)}m ago (cooldown ${HOLD_COOLDOWN_MS / 60_000}m)`,
          );
          continue;
        }

        const analysisRunId = crypto.randomUUID();

        try {
          const analysis = await runMarketAnalysis({
            symbol: group.symbol,
            exchange: group.referenceExchange,
            marketType: group.referenceMarketType,
            triggeredBy: 'scheduled',
            mastra,
          });

          if (analysis.action === 'HOLD') {
            lastHoldByGroup.set(group.key, Date.now());
            console.log(
              `[worker] group=${group.key} -> HOLD, no jobs enqueued for ${group.users.length} user(s)`,
            );
            continue;
          }

          lastHoldByGroup.delete(group.key);

          const jobs = group.users.map((user) => ({
            userId: user.userId,
            analysisRunId,
            symbol: group.symbol,
            exchange: user.exchange,
            marketType: group.referenceMarketType,
            status: 'pending' as const,
            priority: plansByUser.get(user.userId)?.jobPriority ?? 0,
            payload: analysis,
          }));

          if (jobs.length > 0) {
            await db.insert(autoTradeJobs).values(jobs);
            console.log(`[worker] group=${group.key} -> enqueued ${jobs.length} job(s)`);
          }
        } catch (err) {
          // One group's failure must not abort the tick for other groups.
          console.error(`[worker] runMarketAnalysis failed group=${group.key}`, err);
        }
      }
    }

    // Drain the queue regardless of whether this tick's own analysis found
    // anything to enqueue — a previous tick may have left jobs pending
    // (skipped tick, or a retry backoff window that has now elapsed).
    try {
      await processAutoTradeJobs(mastra);
    } catch (err) {
      console.error('[worker] processAutoTradeJobs failed', err);
    }
  });
}
