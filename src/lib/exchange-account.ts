/**
 * Single source of truth for resolving a user's connected exchange into a
 * CCXT client and for reading its USDT-equivalent balance.
 *
 * Before this module existed, dashboard/route.ts, finalize-for-user.ts, and
 * trade-signals/[id]/route.ts each hand-rolled their own credential decrypt
 * + client construction + balance parsing — and only the dashboard's copy
 * called configureMarketType() before fetchBalance(). On exchanges where
 * spot and swap/futures wallets are separate (BingX, Bybit, ...), that meant
 * the same live account could read a real balance in one place and "no USDT
 * balance found" in another. Every live-money balance read must go through
 * fetchLiveUsdtBalance so they agree.
 */

import ccxt, { type Exchange, type Balances } from 'ccxt';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { exchangeBalanceCache, userExchanges } from '@/db/schema';
import { decrypt } from '@/lib/crypto';
import { configureMarketType, type MarketType } from '@/mastra/tools/market-symbol';

export interface UserExchangeClient {
  client: Exchange;
  exchangeName: string;
}

/** Resolve + decrypt the user's single active exchange connection into a CCXT client. */
export async function getUserActiveExchangeClient(userId: string): Promise<UserExchangeClient | null> {
  const [row] = await db
    .select({
      exchangeName: userExchanges.exchangeName,
      encryptedApiKey: userExchanges.encryptedApiKey,
      encryptedApiSecret: userExchanges.encryptedApiSecret,
      encryptedPassphrase: userExchanges.encryptedPassphrase,
    })
    .from(userExchanges)
    .where(and(eq(userExchanges.userId, userId), eq(userExchanges.status, 'active')))
    .limit(1);

  if (!row) {
    console.warn(`[exchange-account] no active exchange connection found for userId=${userId}`);
    return null;
  }

  try {
    const apiKey = decrypt(row.encryptedApiKey);
    const secret = decrypt(row.encryptedApiSecret);
    const password = row.encryptedPassphrase ? decrypt(row.encryptedPassphrase) : undefined;

    const ExchangeClass = (ccxt as unknown as Record<string, new (config: object) => Exchange>)[
      row.exchangeName
    ];
    if (!ExchangeClass) {
      console.error(`[exchange-account] unknown ccxt exchange "${row.exchangeName}" for userId=${userId}`);
      return null;
    }

    const client = new ExchangeClass({ apiKey, secret, ...(password ? { password } : {}) });
    return { client, exchangeName: row.exchangeName };
  } catch (err) {
    console.error(
      `[exchange-account] failed to build exchange client for userId=${userId} exchange=${row.exchangeName}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** Extract a USDT-equivalent total from a CCXT fetchBalance() result. */
export function extractUsdtBalance(balance: Balances): number | null {
  const totals = balance?.total as unknown as Record<string, number> | undefined;
  const free = balance?.free as unknown as Record<string, number> | undefined;
  const sumOf = (src?: Record<string, number>) => (src?.USDT ?? 0) + (src?.USDC ?? 0) + (src?.USD ?? 0);

  const total = sumOf(totals);
  if (total > 0) return total;

  const freeTotal = sumOf(free);
  return freeTotal > 0 ? freeTotal : null;
}

// ---------------------------------------------------------------------------
// Balance cache — this account's live balance was queried often enough
// (queue page polling every 15s, the auto-execute retry loop, the scheduled
// worker tick, manual approvals) that BingX rate-limited the endpoint and
// entered a "disabled period." Postgres-backed rather than in-memory so it's
// shared across replicas if this app is ever scaled horizontally (matching
// src/worker/lock.ts's advisory-lock approach to the same class of problem),
// not just within one process.
// ---------------------------------------------------------------------------

const SUCCESS_CACHE_TTL_MS = 30_000;
// A failure is cached too — otherwise every caller immediately retries a
// currently-rate-limited endpoint, which is exactly what causes/prolongs it.
const DEFAULT_FAILURE_CACHE_TTL_MS = 30_000;
const MIN_RATE_LIMIT_BACKOFF_MS = 10_000;
const MAX_RATE_LIMIT_BACKOFF_MS = 10 * 60_000;

/**
 * BingX's rate-limit error names the exact unix-ms timestamp it unblocks at
 * (e.g. `"...disabled period and will be unblocked after 1788969792010"`).
 * Honoring that exactly (clamped to a sane range) is the considerate thing to
 * do — anything else keeps hitting an endpoint the exchange has explicitly
 * asked callers to back off from. Falls back to a fixed TTL for any other
 * error shape or exchange.
 */
function resolveFailureExpiry(err: unknown, now: number): Date {
  const message = err instanceof Error ? err.message : String(err);
  const match = message.match(/unblocked after (\d+)/);
  if (match) {
    const unblockAt = Number(match[1]);
    if (Number.isFinite(unblockAt) && unblockAt > now) {
      const backoffMs = Math.min(Math.max(unblockAt - now, MIN_RATE_LIMIT_BACKOFF_MS), MAX_RATE_LIMIT_BACKOFF_MS);
      return new Date(now + backoffMs);
    }
  }
  return new Date(now + DEFAULT_FAILURE_CACHE_TTL_MS);
}

async function readCachedBalance(
  userId: string,
  exchangeName: string,
  marketType: MarketType,
): Promise<{ hit: true; balance: number | null } | { hit: false }> {
  const [row] = await db
    .select({ balanceUsdt: exchangeBalanceCache.balanceUsdt, expiresAt: exchangeBalanceCache.expiresAt })
    .from(exchangeBalanceCache)
    .where(
      and(
        eq(exchangeBalanceCache.userId, userId),
        eq(exchangeBalanceCache.exchangeName, exchangeName),
        eq(exchangeBalanceCache.marketType, marketType),
      ),
    )
    .limit(1);

  if (!row || row.expiresAt.getTime() <= Date.now()) return { hit: false };
  return { hit: true, balance: row.balanceUsdt !== null ? Number(row.balanceUsdt) : null };
}

async function writeCachedBalance(
  userId: string,
  exchangeName: string,
  marketType: MarketType,
  balance: number | null,
  expiresAt: Date,
): Promise<void> {
  const balanceUsdt = balance !== null ? String(balance) : null;
  await db
    .insert(exchangeBalanceCache)
    .values({ userId, exchangeName, marketType, balanceUsdt, fetchedAt: new Date(), expiresAt })
    .onConflictDoUpdate({
      target: [exchangeBalanceCache.userId, exchangeBalanceCache.exchangeName, exchangeBalanceCache.marketType],
      set: { balanceUsdt, fetchedAt: new Date(), expiresAt },
    });
}

/**
 * Fetch the user's real balance from their connected exchange, configured for
 * the given market type first — spot and swap/futures are separate wallets on
 * most exchanges, so skipping this reads the wrong (often empty) wallet.
 * Returns null if no exchange is connected or the balance can't be determined.
 * Callers must never substitute a guessed number for a null result.
 */
export async function fetchLiveUsdtBalance(
  userId: string,
  marketType: MarketType,
): Promise<number | null> {
  const resolved = await getUserActiveExchangeClient(userId);
  if (!resolved) return null;

  const cached = await readCachedBalance(userId, resolved.exchangeName, marketType);
  if (cached.hit) return cached.balance;

  try {
    configureMarketType(resolved.client, resolved.exchangeName, marketType);
    const balance = await resolved.client.fetchBalance();
    const usdt = extractUsdtBalance(balance);
    await writeCachedBalance(userId, resolved.exchangeName, marketType, usdt, new Date(Date.now() + SUCCESS_CACHE_TTL_MS));
    return usdt;
  } catch (err) {
    // Previously swallowed with no trace — indistinguishable from a
    // genuinely zero balance in every caller's "could not determine live
    // account balance" log line. Logging the real cause (network blip,
    // exchange rate-limit, credential issue) here is the only place it's
    // still available.
    console.error(
      `[exchange-account] fetchLiveUsdtBalance failed for userId=${userId} exchange=${resolved.exchangeName} marketType=${marketType}:`,
      err instanceof Error ? err.message : err,
    );
    await writeCachedBalance(userId, resolved.exchangeName, marketType, null, resolveFailureExpiry(err, Date.now()));
    return null;
  }
}
