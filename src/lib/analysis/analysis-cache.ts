/**
 * Read-through cache for the deterministic phases of market analysis.
 *
 * The scheduled worker ticks every 15 minutes across every confluence group
 * (src/worker/schedule.ts) — without this, every tick re-fetches/recomputes
 * identical data (CCXT candles, indicators, SMC/patterns, order book,
 * Coinglass/Santiment on-chain data) for a symbol whose underlying market
 * hasn't meaningfully changed since the last tick.
 *
 * Backed by the `deterministic_data_cache` table (one row per
 * `${symbol}:${exchange}:${marketType}:${source}` key, TTL-gated). News is
 * deliberately NOT wrapped here: newsTool (src/mastra/tools/news-tool.ts)
 * already reads/writes the `news_cache` table itself under the same
 * (currency-based) key — a second cache layer on top of it, keyed the same
 * way but with a different TTL, would just clobber whichever TTL was written
 * last on every round trip instead of composing with it. fetchNewsPhase
 * (market-analysis.ts) calls the tool directly for this reason.
 *
 * Fails open: any cache read/write error falls back to calling `compute()`
 * directly rather than blocking analysis on cache infrastructure.
 *
 * Known limitation: each source (`market-data`, `indicators`, `smc`,
 * `patterns`, `orderbook`, `onchain`) expires on its own independent clock,
 * per the task's own per-source-TTL design — there's a window (bounded by
 * how long the earlier phases take to run, typically seconds) where fresh
 * candles could be read alongside indicators/SMC/patterns computed from the
 * *previous* candle set's cache entry, if that entry's TTL happens to
 * outlive the candle cache's. Low-probability at a 15-minute cadence, but if
 * it ever matters, the fix is keying the derived caches on a fingerprint of
 * the candle set they were computed from instead of a plain TTL.
 */

import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { deterministicDataCache } from '@/db/schema';

/** Matches the pipeline's LTF (15m) — indicators, SMC, patterns, order book, market-data. */
export const CACHE_TTL_LTF_MS = 15 * 60_000;
/** Onchain funding-rate refresh cadence. Netflow is cached under the same key/TTL — see
 * fetchOnchainSignalsPhase's comment for why the two aren't split into separate cache rows. */
export const CACHE_TTL_FUNDING_MS = 60 * 60_000;

export function buildAnalysisCacheKey(
  symbol: string,
  exchange: string,
  marketType: string,
  source: string,
): string {
  return `${symbol}:${exchange}:${marketType}:${source}`;
}

export async function readThroughDeterministicCache<R>(
  cacheKey: string,
  source: string,
  ttlMs: number,
  compute: () => Promise<R>,
): Promise<R> {
  try {
    const [row] = await db
      .select()
      .from(deterministicDataCache)
      .where(eq(deterministicDataCache.cacheKey, cacheKey))
      .limit(1);
    if (row && row.expiresAt.getTime() > Date.now()) {
      return row.payload as R;
    }
  } catch (err) {
    console.warn(`[analysis-cache] read failed for cacheKey=${cacheKey}, falling back to live fetch`, err);
  }

  const result = await compute();

  try {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);
    await db
      .insert(deterministicDataCache)
      .values({ cacheKey, source, payload: result as unknown, computedAt: now, expiresAt })
      .onConflictDoUpdate({
        target: deterministicDataCache.cacheKey,
        set: { source, payload: result as unknown, computedAt: now, expiresAt },
      });
  } catch (err) {
    console.warn(`[analysis-cache] write failed for cacheKey=${cacheKey}`, err);
  }

  return result;
}
