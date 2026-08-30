import type { Exchange } from 'ccxt';

/**
 * Optional public market-data mirror for Binance.
 *
 * api.binance.com is geo-blocked in several regions, but Binance operates a
 * public read-only mirror of the spot market-data API at
 * https://data-api.binance.vision/api/v3 (candles, order book, tickers).
 *
 * Set BINANCE_MARKET_DATA_MIRROR to that URL to route the read-only tools
 * (market-data-tool, orderbook-tool) through the mirror. The mirror only
 * serves spot endpoints, so market loading is restricted to spot when it is
 * active. Trading/authenticated calls are unaffected — execute-trade-tool
 * never uses the mirror.
 */
export function applyPublicDataMirror(client: Exchange, exchangeId: string): void {
  const mirror = process.env.BINANCE_MARKET_DATA_MIRROR?.trim();
  if (!mirror || exchangeId !== 'binance') return;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).urls.api.public = mirror;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).options = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(client as any).options,
    defaultType: 'spot',
    fetchMarkets: ['spot'],
  };
}
