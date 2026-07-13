/**
 * Exchange API Rate Limiter
 *
 * Per-user, per-exchange token-bucket queue with:
 * - FIFO ordering (circuit-breaker checks get priority)
 * - Exponential backoff on 429: 1s → 2s → 4s → 8s → fail
 * - In-memory state per Node.js process (acceptable for MVP single-instance)
 * - globalThis singleton to survive Next.js HMR hot reloads
 *
 * Usage:
 *   import { withRateLimit } from '@/lib/rate-limiter';
 *   const balance = await withRateLimit(userId, 'binance', false, () => exchange.fetchBalance());
 */

import pino from 'pino';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
const logger = pino({ name: 'RateLimiter' });

// ---------------------------------------------------------------------------
// Exchange rate limits (requests per minute → tokens per 60 000 ms window)
// ---------------------------------------------------------------------------
export const EXCHANGE_RATE_LIMITS: Record<string, number> = {
  binance: 1_200,
  bybit: 600,
  bingx: 600,
};

// Milliseconds per token for each exchange
function msPerToken(exchange: string): number {
  const rpm = EXCHANGE_RATE_LIMITS[exchange.toLowerCase()] ?? 600;
  return Math.ceil(60_000 / rpm);
}

// ---------------------------------------------------------------------------
// Queue item type
// ---------------------------------------------------------------------------
interface QueueItem {
  priority: boolean; // true = circuit-breaker (runs first)
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  fn: () => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// BucketState per (userId, exchange) pair
// ---------------------------------------------------------------------------
interface BucketState {
  lastTokenTime: number;   // epoch ms when last token was consumed
  queue: QueueItem[];
  processing: boolean;
  consecutiveThrottles: number;
  throttleAlertSentAt: number | null;
}

// ---------------------------------------------------------------------------
// HMR-safe singleton map
// ---------------------------------------------------------------------------
declare global {

  var __rateLimiterBuckets: Map<string, BucketState> | undefined;
}

function getBuckets(): Map<string, BucketState> {
  if (!globalThis.__rateLimiterBuckets) {
    globalThis.__rateLimiterBuckets = new Map<string, BucketState>();
  }
  return globalThis.__rateLimiterBuckets;
}

function getBucket(userId: string, exchange: string): BucketState {
  const key = `${userId}:${exchange.toLowerCase()}`;
  const buckets = getBuckets();
  if (!buckets.has(key)) {
    buckets.set(key, {
      lastTokenTime: 0,
      queue: [],
      processing: false,
      consecutiveThrottles: 0,
      throttleAlertSentAt: null,
    });
  }
  return buckets.get(key)!;
}

function getBucketKey(userId: string, exchange: string): string {
  return `${userId}:${exchange.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Process queue FIFO (priority items first)
// ---------------------------------------------------------------------------
async function processQueue(userId: string, exchange: string): Promise<void> {
  const key = getBucketKey(userId, exchange);
  const bucket = getBuckets().get(key);
  if (!bucket || bucket.processing) return;

  bucket.processing = true;

  while (bucket.queue.length > 0) {
    // Sort: priority items (circuit-breaker) run before normal items
    bucket.queue.sort((a, b) => {
      if (a.priority === b.priority) return 0;
      return a.priority ? -1 : 1;
    });

    const item = bucket.queue.shift()!;

    // Rate-limit: wait until the next token slot is available
    const interval = msPerToken(exchange);
    const now = Date.now();
    const wait = Math.max(0, bucket.lastTokenTime + interval - now);
    if (wait > 0) {
      await delay(wait);
    }
    bucket.lastTokenTime = Date.now();

    // Execute with exponential backoff on 429
    try {
      const result = await executeWithBackoff(userId, exchange, bucket, item.fn);
      item.resolve(result);
    } catch (err) {
      item.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  bucket.processing = false;
}

// ---------------------------------------------------------------------------
// Exponential backoff: 1s → 2s → 4s → 8s → throw
// ---------------------------------------------------------------------------
const BACKOFF_DELAYS_MS = [1_000, 2_000, 4_000, 8_000];

async function executeWithBackoff(
  userId: string,
  exchange: string,
  bucket: BucketState,
  fn: () => Promise<unknown>,
): Promise<unknown> {
  for (let attempt = 0; attempt <= BACKOFF_DELAYS_MS.length; attempt++) {
    try {
      const result = await fn();
      // Success — reset throttle counter
      if (bucket.consecutiveThrottles > 0) {
        logger.info({ userId, exchange }, 'Rate limit cleared after backoff');
      }
      bucket.consecutiveThrottles = 0;
      bucket.throttleAlertSentAt = null;
      return result;
    } catch (err) {
      const isThrottle = is429(err);
      if (!isThrottle || attempt === BACKOFF_DELAYS_MS.length) {
        // Not a 429, or we've exhausted retries
        if (isThrottle) {
          bucket.consecutiveThrottles++;
          await maybeNotifyThrottle(userId, exchange, bucket);
          logger.error(
            { userId, exchange, consecutiveThrottles: bucket.consecutiveThrottles },
            'Exchange API rate limit exceeded after maximum retries — request failed',
          );
        }
        throw err;
      }

      bucket.consecutiveThrottles++;
      const backoffMs = BACKOFF_DELAYS_MS[attempt];
      logger.warn(
        { userId, exchange, attempt: attempt + 1, backoffMs, consecutiveThrottles: bucket.consecutiveThrottles },
        'Exchange 429 received, backing off',
      );
      await maybeNotifyThrottle(userId, exchange, bucket);
      await delay(backoffMs);
    }
  }
  // Should be unreachable
  throw new Error(`Rate limit backoff exhausted for ${exchange}`);
}

// ---------------------------------------------------------------------------
// Notify user if sustained throttling detected (>=3 consecutive 429s)
// ---------------------------------------------------------------------------
const THROTTLE_ALERT_THRESHOLD = 3;
const THROTTLE_ALERT_COOLDOWN_MS = 5 * 60 * 1_000; // 5 minutes

async function maybeNotifyThrottle(
  userId: string,
  exchange: string,
  bucket: BucketState,
): Promise<void> {
  if (bucket.consecutiveThrottles < THROTTLE_ALERT_THRESHOLD) return;

  const now = Date.now();
  if (
    bucket.throttleAlertSentAt !== null &&
    now - bucket.throttleAlertSentAt < THROTTLE_ALERT_COOLDOWN_MS
  ) {
    return; // Already alerted recently
  }

  bucket.throttleAlertSentAt = now;

  logger.warn(
    { userId, exchange, consecutiveThrottles: bucket.consecutiveThrottles },
    'Sustained exchange API throttling detected — user should be notified',
  );

  // Fire-and-forget notification; import lazily to avoid circular deps
  try {
    const { sendUserThrottleAlert } = await import('@/lib/rate-limiter-notify');
    await sendUserThrottleAlert(userId, exchange, bucket.consecutiveThrottles);
  } catch {
    // Notification failure is non-fatal
    logger.warn({ userId, exchange }, 'Failed to send throttle notification');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function is429(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes('429') ||
      msg.includes('rate limit') ||
      msg.includes('too many requests') ||
      msg.includes('ratelimit')
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Wrap any exchange API call with per-user, per-exchange rate limiting.
 *
 * @param userId       Clerk user ID
 * @param exchange     Exchange name (binance | bybit | bingx)
 * @param priority     Set true for circuit-breaker health checks (runs ahead of normal queue)
 * @param fn           Async function to execute (e.g. () => ccxtExchange.fetchBalance())
 */
export function withRateLimit<T>(
  userId: string,
  exchange: string,
  priority: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  const bucket = getBucket(userId, exchange);

  return new Promise<T>((resolve, reject) => {
    bucket.queue.push({
      priority,
      resolve: resolve as (value: unknown) => void,
      reject,
      fn: fn as () => Promise<unknown>,
    });

    // Kick off processing (no-op if already running)
    void processQueue(userId, exchange);
  });
}

/**
 * Get current rate-limiter state for a user/exchange (for status endpoints).
 */
export function getRateLimitStatus(
  userId: string,
  exchange: string,
): {
  queueDepth: number;
  consecutiveThrottles: number;
  msPerToken: number;
} {
  const bucket = getBucket(userId, exchange);
  return {
    queueDepth: bucket.queue.length,
    consecutiveThrottles: bucket.consecutiveThrottles,
    msPerToken: msPerToken(exchange),
  };
}
