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
 * `${symbol}:${exchange}:${marketType}:${source}` key, TTL-gated). News
 * instead reuses the pre-existing `news_cache` table (keyed by currency, per
 * its own shape — see readThroughNewsCache below).
 *
 * Fails open: any cache read/write error falls back to calling `compute()`
 * directly rather than blocking analysis on cache infrastructure.
 */

import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { deterministicDataCache, newsCache } from '@/db/schema';

/** Matches the pipeline's LTF (15m) — indicators, SMC, patterns, order book, market-data. */
export const CACHE_TTL_LTF_MS = 15 * 60_000;
/** Onchain funding-rate refresh cadence. Netflow is cached under the same key/TTL — see
 * fetchOnchainSignalsPhase's comment for why the two aren't split into separate cache rows. */
export const CACHE_TTL_FUNDING_MS = 60 * 60_000;
/** Matches news-tool.ts's own in-process cache TTL. */
export const CACHE_TTL_NEWS_MS = 5 * 60_000;

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

interface CachedNewsShape {
  items: unknown[];
  overallSentiment: string;
}

/** Read-through wrapper for the pre-existing news_cache table (keyed by currency, not the
 * `${symbol}:${exchange}:${marketType}:${source}` shape above — news isn't exchange/market-type
 * specific, and the table predates this phase's cache-key convention). */
export async function readThroughNewsCache<R extends CachedNewsShape>(
  cacheKey: string,
  ttlMs: number,
  compute: () => Promise<R>,
): Promise<R> {
  try {
    const [row] = await db.select().from(newsCache).where(eq(newsCache.cacheKey, cacheKey)).limit(1);
    if (row && row.expiresAt.getTime() > Date.now()) {
      return { items: row.items, overallSentiment: row.overallSentiment } as unknown as R;
    }
  } catch (err) {
    console.warn(`[analysis-cache] news cache read failed for cacheKey=${cacheKey}, falling back to live fetch`, err);
  }

  const result = await compute();

  try {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);
    await db
      .insert(newsCache)
      .values({
        cacheKey,
        items: result.items,
        overallSentiment: result.overallSentiment,
        fetchedAt: now,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: newsCache.cacheKey,
        set: { items: result.items, overallSentiment: result.overallSentiment, fetchedAt: now, expiresAt },
      });
  } catch (err) {
    console.warn(`[analysis-cache] news cache write failed for cacheKey=${cacheKey}`, err);
  }

  return result;
}
