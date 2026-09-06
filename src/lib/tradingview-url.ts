/** Builds a TradingView chart deep link for a given exchange/symbol/market type. */
export function buildTradingViewUrl(
  symbol: string,
  exchange?: string | null,
  marketType?: string | null,
): string {
  const tvExchange = (exchange || 'binance').toUpperCase();
  const tvSymbol = symbol.replace('/', '').toUpperCase();
  const suffix = marketType === 'swap' ? '.P' : '';
  return `https://www.tradingview.com/chart/?symbol=${tvExchange}:${tvSymbol}${suffix}`;
}
