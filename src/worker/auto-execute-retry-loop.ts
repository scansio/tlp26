/**
 * Periodic driver for src/lib/auto-execute.ts.
 *
 * A signal in 'auto' mode previously only got one execution attempt, at
 * creation time (finalize-for-user.ts / finalize-price-watch.ts) — if that
 * attempt failed or was skipped, nothing ever came back to it; it just sat
 * 'pending' until signal-expiry-loop.ts eventually killed it, despite the
 * Signal Approval Queue page's copy promising it "will execute automatically
 * if left untouched." This loop is that promise, made real: it periodically
 * retries every pending signal belonging to an auto-mode user (regardless of
 * which path created it — AI, TradingView, copy, or manual) until it
 * succeeds, the user acts on it, or it expires.
 */

import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { db } from '@/db';
import { tradeSignals, userRiskProfiles } from '@/db/schema';
import { attemptSignalAutoExecution } from '@/lib/auto-execute';

const DEFAULT_INTERVAL_MS = 90_000;

export function startAutoExecuteRetryLoop(): void {
  const intervalMs = process.env.AUTO_EXECUTE_RETRY_INTERVAL_MS
    ? Number(process.env.AUTO_EXECUTE_RETRY_INTERVAL_MS)
    : DEFAULT_INTERVAL_MS;

  const tick = async () => {
    const now = new Date();
    const candidates = await db
      .select({ id: tradeSignals.id })
      .from(tradeSignals)
      .innerJoin(userRiskProfiles, eq(userRiskProfiles.userId, tradeSignals.userId))
      .where(
        and(
          eq(tradeSignals.status, 'pending'),
          eq(userRiskProfiles.tradingMode, 'auto'),
          or(isNull(tradeSignals.expiresAt), gt(tradeSignals.expiresAt, now)),
        ),
      );

    for (const { id } of candidates) {
      try {
        await attemptSignalAutoExecution(id);
      } catch (err) {
        console.error(`[worker] auto-execute-retry failed for signal ${id}`, err);
      }
    }
  };

  tick().catch((err) => console.error('[worker] auto-execute-retry tick error', err));
  setInterval(() => {
    tick().catch((err) => console.error('[worker] auto-execute-retry tick error', err));
  }, intervalMs);
  console.log(`[worker] auto-execute-retry loop started (every ${intervalMs}ms)`);
}
