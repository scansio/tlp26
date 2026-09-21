/**
 * Live ticker price lookup for a user's active exchange — shared by any route
 * that needs to mark open positions/signals to market (currently
 * /api/positions and /api/trade-signals/queue).
 *
 * Live-mode users get prices from their own connected exchange (so paper
 * quirks like a slightly different market list don't matter); paper-mode
 * users get a public (keyless) client for whichever exchange the position
 * was opened against.
 */

import ccxt, { type Exchange } from 'ccxt';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { userExchanges } from '@/db/schema';
import { decrypt } from '@/lib/crypto';

type ExchangeCtor = new (config: object) => Exchange;

export async function getUserExchangeClient(userId: string): Promise<Exchange | null> {
  const rows = await db
    .select({
      exchangeName: userExchanges.exchangeName,
      encryptedApiKey: userExchanges.encryptedApiKey,
      encryptedApiSecret: userExchanges.encryptedApiSecret,
      encryptedPassphrase: userExchanges.encryptedPassphrase,
    })
    .from(userExchanges)
    .where(and(eq(userExchanges.userId, userId), eq(userExchanges.status, 'active')))
    .limit(1);

  if (!rows[0]) return null;
  const { exchangeName, encryptedApiKey, encryptedApiSecret, encryptedPassphrase } = rows[0];

  try {
    const apiKey = decrypt(encryptedApiKey);
    const secret = decrypt(encryptedApiSecret);
    const password = encryptedPassphrase ? decrypt(encryptedPassphrase) : undefined;
    const ExClass = (ccxt as unknown as Record<string, ExchangeCtor>)[exchangeName];
    if (!ExClass) return null;
    return new ExClass({ apiKey, secret, ...(password ? { password } : {}) });
  } catch {
    return null;
  }
}

/**
 * Resolves one client to price every symbol in `exchangeSymbols` against
 * (the user's own exchange for live mode, else a public client for
 * `fallbackExchangeName`), then fetches all tickers concurrently.
 */
export async function fetchLiveTickerPrices(
  userId: string,
  exchangeSymbols: string[],
  opts: { isPaper: boolean; fallbackExchangeName?: string | null },
): Promise<Map<string, number>> {
  const tickerMap = new Map<string, number>();
  if (exchangeSymbols.length === 0) return tickerMap;

  let client: Exchange | null = null;
  if (!opts.isPaper) {
    client = await getUserExchangeClient(userId).catch(() => null);
  }
  if (!client && opts.fallbackExchangeName) {
    const ExClass = (ccxt as unknown as Record<string, ExchangeCtor>)[opts.fallbackExchangeName];
    if (ExClass) client = new ExClass({});
  }
  if (!client) return tickerMap;

  await Promise.allSettled(
    exchangeSymbols.map(async (symbol) => {
      try {
        const ticker = await (client as Exchange).fetchTicker(symbol);
        if (ticker.last) tickerMap.set(symbol, ticker.last);
      } catch {
        // skip — leaves this symbol unpriced rather than failing the batch
      }
    }),
  );

  return tickerMap;
}
