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
import { fetchEligibleUsers } from './eligibility';
import { groupIntoConfluenceGroups } from './grouping';
import { processAutoTradeJobs } from './job-queue';
import { withGlobalTickLock } from './lock';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function runTick(mastra: any): Promise<void> {
  await withGlobalTickLock(async () => {
    const eligibleUsers = await fetchEligibleUsers();
    if (eligibleUsers.length === 0) {
      console.log('[worker] tick: no eligible users');
    } else {
      const groups = groupIntoConfluenceGroups(eligibleUsers);
      console.log(
        `[worker] tick: ${eligibleUsers.length} eligible user(s) -> ${groups.length} confluence group(s)`,
      );

      for (const group of groups) {
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
            console.log(
              `[worker] group=${group.key} -> HOLD, no jobs enqueued for ${group.users.length} user(s)`,
            );
            continue;
          }

          const jobs = group.users.map((user) => ({
            userId: user.userId,
            analysisRunId,
            symbol: group.symbol,
            exchange: user.exchange,
            marketType: group.referenceMarketType,
            status: 'pending' as const,
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
