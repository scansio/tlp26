/**
 * One worker tick: fetch eligible users, bucket them into confluence groups,
 * run the shared market analysis once per group, and fan out cheap per-user
 * finalization (risk-sizing, signal creation, auto-execution) — capped by
 * each user's own circuit-breaker limits and coordinated across replicas via
 * a single global advisory lock.
 */

import crypto from 'node:crypto';
import { runMarketAnalysis } from '@/lib/analysis/market-analysis';
import { finalizeForUser } from '@/lib/analysis/finalize-for-user';
import { fetchEligibleUsers, type ExchangeName } from './eligibility';
import { groupIntoConfluenceGroups } from './grouping';
import { withGlobalTickLock } from './lock';
import { chunk } from './util';

const VALID_EXCHANGES: readonly ExchangeName[] = ['binance', 'bybit', 'bingx'];

function resolveReferenceExchange(): ExchangeName {
  const raw = process.env.WORKER_REFERENCE_EXCHANGE ?? 'binance';
  return (VALID_EXCHANGES as readonly string[]).includes(raw) ? (raw as ExchangeName) : 'binance';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function runTick(mastra: any): Promise<void> {
  await withGlobalTickLock(async () => {
    const eligibleUsers = await fetchEligibleUsers();
    if (eligibleUsers.length === 0) {
      console.log('[worker] tick: no eligible users');
      return;
    }

    const referenceExchange = resolveReferenceExchange();
    const groups = groupIntoConfluenceGroups(eligibleUsers, referenceExchange);
    console.log(
      `[worker] tick: ${eligibleUsers.length} eligible user(s) -> ${groups.length} confluence group(s)`,
    );

    for (const group of groups) {
      const analysisRunId = crypto.randomUUID();

      try {
        const analysis = await runMarketAnalysis({
          symbol: group.symbol,
          exchange: group.referenceExchange,
          triggeredBy: 'scheduled',
          mastra,
        });

        if (analysis.action === 'HOLD') {
          console.log(
            `[worker] group=${group.key} -> HOLD, no signals created for ${group.users.length} user(s)`,
          );
          continue;
        }

        for (const batch of chunk(group.users, 5)) {
          await Promise.all(
            batch.map((user) =>
              finalizeForUser({
                userId: user.userId,
                analysis,
                analysisRunId,
                executionExchange: user.exchange,
                mastra,
              }).catch((err) => {
                console.error(`[worker] finalize failed userId=${user.userId} group=${group.key}`, err);
              }),
            ),
          );
        }
      } catch (err) {
        // One group's failure must not abort the tick for other groups.
        console.error(`[worker] runMarketAnalysis failed group=${group.key}`, err);
      }
    }
  });
}
