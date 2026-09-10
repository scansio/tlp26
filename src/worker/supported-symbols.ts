/**
 * Allowlist gating which (symbol, exchange, marketType) combinations the
 * scheduled worker will generate automated signals for — see the
 * `auto_trade_supported_symbols` table (src/db/schema.ts) and the Phase 1
 * migration's seed data. Enforced in src/worker/eligibility.ts, upstream of
 * src/worker/grouping.ts — grouping never needs its own DB check because
 * every symbol reaching it has already passed this filter.
 */

import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { autoTradeSupportedSymbols } from '@/db/schema';

export function buildSupportedSymbolKey(symbol: string, exchange: string, marketType: string): string {
  return `${symbol}::${exchange}::${marketType}`;
}

/** One query per tick for the whole active allowlist, checked in-memory per user — cheap table, no per-user query. */
export async function fetchActiveSupportedSymbolKeySet(): Promise<Set<string>> {
  const rows = await db
    .select({
      symbol: autoTradeSupportedSymbols.symbol,
      exchange: autoTradeSupportedSymbols.exchange,
      marketType: autoTradeSupportedSymbols.marketType,
    })
    .from(autoTradeSupportedSymbols)
    .where(eq(autoTradeSupportedSymbols.status, 'active'));

  return new Set(rows.map((r) => buildSupportedSymbolKey(r.symbol, r.exchange, r.marketType)));
}
