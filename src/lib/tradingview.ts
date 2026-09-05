import { z } from 'zod';

// ---------------------------------------------------------------------------
// Zod schema for TradingView webhook payload
// ---------------------------------------------------------------------------
export const tvWebhookSchema = z.object({
  token: z.string().min(1),
  symbol: z.string().min(1),
  action: z.enum(['BUY', 'SELL']),
  price: z.number().positive().optional(),
  sl: z.number().positive().describe('Stop-loss price — required'),
  tp: z.number().positive().describe('Take-profit price — required'),
});

export type TvWebhookPayload = z.infer<typeof tvWebhookSchema>;

// ---------------------------------------------------------------------------
// Normalise symbol to CCXT spot format (e.g. BTCUSDT → BTC/USDT) and detect
// TradingView's perpetual-futures ticker convention (a trailing ".P"/".PERP",
// e.g. BTCUSDT.P) as a separate marketType flag — NOT baked into the symbol
// string itself. The symbol always stays human "BASE/QUOTE"; the CCXT swap
// suffix (BASE/QUOTE:SETTLE) is applied only at the exchange-call boundary
// via toExchangeSymbol (src/mastra/tools/market-symbol.ts).
// ---------------------------------------------------------------------------
const PERP_SUFFIXES = ['.PERP', '.P'];
const QUOTE_ASSETS = ['USDT', 'USDC', 'BUSD', 'USD', 'BTC', 'ETH', 'BNB'];

export function normaliseSymbol(raw: string): { symbol: string; marketType: 'spot' | 'swap' } {
  let upper = raw.trim().toUpperCase().replace(/[-_]/, '/');
  let marketType: 'spot' | 'swap' = 'spot';

  for (const suffix of PERP_SUFFIXES) {
    if (upper.endsWith(suffix)) {
      upper = upper.slice(0, upper.length - suffix.length);
      marketType = 'swap';
      break;
    }
  }

  // Already in CCXT spot format
  if (upper.includes('/')) {
    return { symbol: upper, marketType };
  }

  // Try longest quote asset first to avoid partial matches (e.g. USD before USDT)
  const sortedQuotes = [...QUOTE_ASSETS].sort((a, b) => b.length - a.length);
  for (const quote of sortedQuotes) {
    if (upper.endsWith(quote)) {
      const base = upper.slice(0, upper.length - quote.length);
      if (base.length > 0) {
        return { symbol: `${base}/${quote}`, marketType };
      }
    }
  }

  // Fall back: return as-is and let downstream tools handle it
  return { symbol: upper, marketType };
}

// ---------------------------------------------------------------------------
// Map TradingView action to internal direction
// ---------------------------------------------------------------------------
export function actionToDirection(action: 'BUY' | 'SELL'): 'LONG' | 'SHORT' {
  return action === 'BUY' ? 'LONG' : 'SHORT';
}
