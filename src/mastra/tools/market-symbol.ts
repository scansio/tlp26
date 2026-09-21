import type { Exchange } from 'ccxt';

/**
 * Shared spot/swap symbol + market-type helpers.
 *
 * Every CCXT unified swap (perpetual) symbol is BASE/QUOTE:SETTLE (e.g.
 * BTC/USDT:USDT for a USDT-margined linear perpetual) — different from the
 * spot BASE/QUOTE format. Tools and DB rows always store/pass the plain
 * human "BTC/USDT" form; only the CCXT-call boundary needs the swap suffix,
 * which is what these two functions apply.
 */

export type MarketType = 'spot' | 'swap';

/** Convert a human "BASE/QUOTE" symbol to the CCXT unified symbol for marketType. */
export function toExchangeSymbol(symbol: string, marketType: MarketType): string {
  if (marketType !== 'swap') return symbol;
  if (symbol.includes(':')) return symbol; // already a swap symbol
  const quote = symbol.split('/')[1];
  if (!quote) return symbol;
  return `${symbol}:${quote}`;
}

/**
 * Point a freshly-constructed CCXT client at the right wallet/market-type for
 * calls that don't take an explicit symbol (fetchBalance, primarily).
 * Market data (fetchTicker/fetchOHLCV/fetchOrderBook) and order placement
 * resolve type from the symbol itself via loadMarkets() and need no option —
 * loadMarkets() already fetches spot + linear + inverse markets by default on
 * binance/bybit/bingx, regardless of this option.
 *
 * Per-exchange quirks (see research, not guesswork):
 *  - binance: fetchBalance reads options.defaultType, needs 'future' for the
 *    USDT-M wallet.
 *  - bingx: fetchBalance reads options.defaultType, needs 'swap'.
 *  - bybit: Unified Trading Accounts return spot+derivatives combined
 *    regardless of defaultType — no-op, but harmless to set anyway.
 */
export function configureMarketType(client: Exchange, exchangeId: string, marketType: MarketType): void {
  if (marketType !== 'swap') return;
  const typed = client as unknown as { options: Record<string, unknown> };
  const options = typed.options ?? {};
  if (exchangeId === 'binance') {
    options.defaultType = 'future';
  } else {
    options.defaultType = 'swap';
  }
  typed.options = options;
}

/**
 * Resolve whether the account is in dual-side/hedge position mode, so swap
 * order calls can pass the unified ccxt `hedged` param and get the correct
 * `positionSide` computed for them. Needed because BingX (and binance) reject
 * swap orders that omit `positionSide` while the account is in hedge mode
 * (BingX error 109400: "In the Hedge mode, the 'PositionSide' field can only
 * be set to LONG or SHORT."). Exchanges without `fetchPositionMode` (e.g.
 * bybit in this ccxt version) fall back to one-way (false) — same as the
 * unaware behavior before this existed.
 */
export async function resolveHedgeMode(client: Exchange, symbol: string): Promise<boolean> {
  if (!client.has['fetchPositionMode']) return false;
  try {
    const mode = (await client.fetchPositionMode(symbol)) as { hedged?: boolean };
    return Boolean(mode?.hedged);
  } catch {
    return false;
  }
}
