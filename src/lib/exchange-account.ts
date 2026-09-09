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
import { userExchanges } from '@/db/schema';
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

  try {
    configureMarketType(resolved.client, resolved.exchangeName, marketType);
    const balance = await resolved.client.fetchBalance();
    return extractUsdtBalance(balance);
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
    return null;
  }
}
