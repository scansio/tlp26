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
// Normalise symbol to CCXT format (e.g. BTCUSDT → BTC/USDT)
// Already-slashed inputs are kept as-is.
// ---------------------------------------------------------------------------
const QUOTE_ASSETS = ['USDT', 'USDC', 'BUSD', 'USD', 'USDT.P', 'BTC', 'ETH', 'BNB'];

export function normaliseSymbol(raw: string): string {
  const upper = raw.trim().toUpperCase().replace(/[-_]/, '/');

  // Already in CCXT format
  if (upper.includes('/')) {
    return upper;
  }

  // Try longest quote asset first to avoid partial matches (e.g. USD before USDT)
  const sortedQuotes = [...QUOTE_ASSETS].sort((a, b) => b.length - a.length);
  for (const quote of sortedQuotes) {
    if (upper.endsWith(quote)) {
      const base = upper.slice(0, upper.length - quote.length);
      if (base.length > 0) {
        return `${base}/${quote}`;
      }
    }
  }

  // Fall back: return as-is and let downstream tools handle it
  return upper;
}

// ---------------------------------------------------------------------------
// Map TradingView action to internal direction
// ---------------------------------------------------------------------------
export function actionToDirection(action: 'BUY' | 'SELL'): 'LONG' | 'SHORT' {
  return action === 'BUY' ? 'LONG' : 'SHORT';
}
