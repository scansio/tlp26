/**
 * Historical OHLCV Data Fetcher
 *
 * Utility (not a Mastra tool) that fetches and caches large amounts of
 * historical OHLCV data from a crypto exchange via CCXT.  Data is stored
 * in the `ohlcv_cache` table so subsequent calls for the same range read
 * from the cache and only fetch the missing date windows from the API.
 */

import ccxt, { type Exchange, type OHLCV, RateLimitExceeded, DDoSProtection, NetworkError } from 'ccxt';
import { and, eq, gte, lte, asc } from 'drizzle-orm';
import { db } from '@/db';
import { ohlcvCache } from '@/db/schema';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OHLCVCandle {
  timestamp: number; // Unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ProgressInfo {
  fetched: number;
  total: number;
  percentComplete: number;
}

export interface FetchHistoricalOHLCVOptions {
  symbol: string;
  timeframe: string;
  startDate: Date;
  endDate: Date;
  /** Default: 'binance' */
  exchange?: string;
  /** Optional progress callback for UI progress bars */
  onProgress?: (progress: ProgressInfo) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CANDLES_PER_REQUEST = 1000;
const RATE_LIMIT_DELAY_MS = 500;
const MAX_RETRIES = 5;
const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;

/** Map of common timeframe strings to their duration in milliseconds */
const TIMEFRAME_MS: Record<string, number> = {
  '1m': 60_000,
  '3m': 3 * 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '2h': 2 * 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '8h': 8 * 60 * 60_000,
  '12h': 12 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '3d': 3 * 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTimeframeMs(timeframe: string): number {
  const ms = TIMEFRAME_MS[timeframe];
  if (!ms) {
    throw new Error(`Unknown timeframe '${timeframe}'. Supported: ${Object.keys(TIMEFRAME_MS).join(', ')}`);
  }
  return ms;
}

function createExchangeClient(exchangeId: string): Exchange {
  const ccxtAny = ccxt as unknown as Record<string, new (config?: object) => Exchange>;
  const ExchangeClass = ccxtAny[exchangeId];
  if (!ExchangeClass) {
    throw new Error(`Exchange '${exchangeId}' is not supported by CCXT.`);
  }
  return new ExchangeClass({ enableRateLimit: true });
}

/**
 * Fetch a single page of OHLCV candles with exponential-backoff retry on
 * rate-limit and 429 errors.
 */
async function fetchWithRetry(
  client: Exchange,
  symbol: string,
  timeframe: string,
  since: number,
  limit: number,
): Promise<OHLCV[]> {
  let attempt = 0;

  while (true) {
    try {
      const raw = await client.fetchOHLCV(symbol, timeframe, since, limit);
      // Filter out any incomplete rows before returning
      return raw.filter(
        (c): c is OHLCV =>
          Array.isArray(c) &&
          c.length >= 6 &&
          c[0] !== null &&
          c[1] !== null &&
          c[2] !== null &&
          c[3] !== null &&
          c[4] !== null &&
          c[5] !== null,
      );
    } catch (err: unknown) {
      const isRateLimit =
        err instanceof RateLimitExceeded ||
        err instanceof DDoSProtection ||
        (err instanceof NetworkError &&
          (err as Error).message.includes('429'));

      if (!isRateLimit || attempt >= MAX_RETRIES) {
        throw err;
      }

      const backoffMs = Math.pow(2, attempt) * 1000;
      await sleep(backoffMs);
      attempt++;
    }
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Fetch historical OHLCV data for a symbol/timeframe date range.
 *
 * - Reads from `ohlcv_cache` first; only fetches missing windows from the API.
 * - Paginates with 1,000 candles per request and a 500 ms inter-request delay.
 * - Applies exponential backoff on 429 / rate-limit responses.
 * - Supports up to 2 years of data per call.
 * - Invokes `onProgress` with `{ fetched, total, percentComplete }` as each
 *   page is processed.
 */
export async function fetchHistoricalOHLCV(
  options: FetchHistoricalOHLCVOptions,
): Promise<OHLCVCandle[]> {
  const {
    symbol,
    timeframe,
    startDate,
    endDate,
    exchange: exchangeId = 'binance',
    onProgress,
  } = options;

  const startMs = startDate.getTime();
  const endMs = endDate.getTime();

  if (endMs <= startMs) {
    throw new Error('endDate must be after startDate');
  }

  const spanMs = endMs - startMs;
  if (spanMs > TWO_YEARS_MS) {
    throw new Error('Date range exceeds the maximum of 2 years per request');
  }

  const tfMs = getTimeframeMs(timeframe);
  const totalCandles = Math.ceil(spanMs / tfMs);

  // -------------------------------------------------------------------------
  // 1. Load cached rows for this symbol/timeframe in the requested range
  // -------------------------------------------------------------------------
  const cachedRows = await db
    .select()
    .from(ohlcvCache)
    .where(
      and(
        eq(ohlcvCache.symbol, symbol),
        eq(ohlcvCache.timeframe, timeframe),
        gte(ohlcvCache.timestamp, startMs),
        lte(ohlcvCache.timestamp, endMs),
      ),
    )
    .orderBy(asc(ohlcvCache.timestamp));

  // Build a Set of cached timestamps for O(1) lookup
  const cachedTimestamps = new Set(cachedRows.map((r) => r.timestamp));

  // -------------------------------------------------------------------------
  // 2. Identify missing windows (contiguous gaps)
  // -------------------------------------------------------------------------
  interface Gap {
    since: number;
    until: number;
  }

  const gaps: Gap[] = [];
  let windowStart: number | null = null;

  for (let ts = startMs; ts <= endMs; ts += tfMs) {
    if (!cachedTimestamps.has(ts)) {
      if (windowStart === null) windowStart = ts;
    } else {
      if (windowStart !== null) {
        gaps.push({ since: windowStart, until: ts - tfMs });
        windowStart = null;
      }
    }
  }
  // Close any trailing gap
  if (windowStart !== null) {
    gaps.push({ since: windowStart, until: endMs });
  }

  // -------------------------------------------------------------------------
  // 3. Fetch missing windows from the exchange
  // -------------------------------------------------------------------------
  let fetchedCount = cachedRows.length;

  const reportProgress = (extra: number = 0) => {
    if (!onProgress) return;
    const fetched = Math.min(fetchedCount + extra, totalCandles);
    onProgress({
      fetched,
      total: totalCandles,
      percentComplete: Math.round((fetched / totalCandles) * 100),
    });
  };

  // Emit initial progress reflecting cache hits
  reportProgress();

  if (gaps.length > 0) {
    const client = createExchangeClient(exchangeId);
    await client.loadMarkets();

    if (!client.markets[symbol]) {
      throw new Error(
        `Symbol '${symbol}' not found on ${exchangeId}. Check the trading pair format (e.g. BTC/USDT).`,
      );
    }

    const newCandles: OHLCVCandle[] = [];

    for (const gap of gaps) {
      let since = gap.since;

      while (since <= gap.until) {
        const page = await fetchWithRetry(client, symbol, timeframe, since, CANDLES_PER_REQUEST);

        if (page.length === 0) break;

        for (const c of page) {
          const ts = c[0] as number;
          if (ts > gap.until) break;
          if (ts < since) continue; // skip any candle returned before our window

          newCandles.push({
            timestamp: ts,
            open: c[1] as number,
            high: c[2] as number,
            low: c[3] as number,
            close: c[4] as number,
            volume: c[5] as number,
          });
        }

        // Advance since to one interval past the last candle received
        const lastTs = page[page.length - 1][0] as number;
        const nextSince = lastTs + tfMs;

        fetchedCount += page.length;
        reportProgress();

        if (nextSince >= gap.until || page.length < CANDLES_PER_REQUEST) break;

        since = nextSince;
        await sleep(RATE_LIMIT_DELAY_MS);
      }
    }

    // -----------------------------------------------------------------------
    // 4. Upsert new candles into cache (batch to avoid huge queries)
    // -----------------------------------------------------------------------
    const BATCH_SIZE = 500;
    for (let i = 0; i < newCandles.length; i += BATCH_SIZE) {
      const batch = newCandles.slice(i, i + BATCH_SIZE);
      if (batch.length === 0) continue;

      await db
        .insert(ohlcvCache)
        .values(
          batch.map((c) => ({
            symbol,
            timeframe,
            timestamp: c.timestamp,
            open: String(c.open),
            high: String(c.high),
            low: String(c.low),
            close: String(c.close),
            volume: String(c.volume),
          })),
        )
        .onConflictDoNothing();
    }
  }

  // -------------------------------------------------------------------------
  // 5. Re-query cache to get the merged, sorted result set
  // -------------------------------------------------------------------------
  const allRows = await db
    .select()
    .from(ohlcvCache)
    .where(
      and(
        eq(ohlcvCache.symbol, symbol),
        eq(ohlcvCache.timeframe, timeframe),
        gte(ohlcvCache.timestamp, startMs),
        lte(ohlcvCache.timestamp, endMs),
      ),
    )
    .orderBy(asc(ohlcvCache.timestamp));

  // Final progress report at 100 %
  if (onProgress) {
    onProgress({ fetched: allRows.length, total: totalCandles, percentComplete: 100 });
  }

  return allRows.map((r) => ({
    timestamp: r.timestamp,
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  }));
}
