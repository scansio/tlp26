/**
 * Single source of truth for "what does this user's trading config say" —
 * reads user_risk_profiles + the active row in user_exchanges and derives
 * one canonical context object. Every entry point that needs a user's
 * exchange/marketType/leverage/etc (the scheduled worker, finalizeForUser,
 * the TradingView webhook) must go through this instead of re-deriving its
 * own subset, so a field added or defaulted here can't drift between paths.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { userExchanges, userRiskProfiles } from '@/db/schema';
import { normalizeSymbolList } from '@/lib/symbols';

export type ExchangeName = 'binance' | 'bybit' | 'bingx';
export type MarketType = 'spot' | 'swap';

const VALID_EXCHANGES: readonly ExchangeName[] = ['binance', 'bybit', 'bingx'];

function isValidExchange(name: string): name is ExchangeName {
  return (VALID_EXCHANGES as readonly string[]).includes(name);
}

export interface UserTradingContext {
  userId: string;
  symbols: string[];
  exchange: ExchangeName;
  marketType: MarketType;
  leverage: number;
  marginMode: 'cross' | 'isolated';
  riskPerTradePct: number;
  slippagePct: number;
  executionMode: string; // 'paper' | 'live'
  tradingMode: string; // 'auto' | 'manual'
  paperBalanceUsd: string | null;
  /** User's minimum acceptable R:R for a trade — used to derive this user's own TP (see finalizeForUser). */
  minRiskRewardRatio: number;
}

type RiskProfileRow = typeof userRiskProfiles.$inferSelect;

/** Pure derivation — no I/O — so bulk callers (the worker) can reuse rows they already fetched. */
export function deriveTradingContext(
  profile: RiskProfileRow,
  exchangeRow: { exchangeName: string } | undefined,
  defaultSymbols: string[] = [],
): UserTradingContext {
  const configuredSymbols = normalizeSymbolList(profile.allowedSymbols ?? []);
  const symbols = configuredSymbols.length > 0 ? configuredSymbols : defaultSymbols;
  const exchange: ExchangeName =
    exchangeRow && isValidExchange(exchangeRow.exchangeName) ? exchangeRow.exchangeName : 'binance';

  return {
    userId: profile.userId,
    symbols,
    exchange,
    marketType: (profile.marketType as MarketType) ?? 'spot',
    leverage: profile.defaultLeverage ?? 1,
    marginMode: (profile.marginMode as 'cross' | 'isolated') ?? 'cross',
    riskPerTradePct: parseFloat(profile.riskPerTradePct ?? '1.0'),
    slippagePct: profile.slippagePct ? parseFloat(profile.slippagePct) : 0.05,
    executionMode: profile.executionMode ?? 'paper',
    tradingMode: profile.tradingMode ?? 'manual',
    paperBalanceUsd: profile.paperBalanceUsd ?? null,
    minRiskRewardRatio: profile.minRiskRewardRatio ? parseFloat(profile.minRiskRewardRatio) : 1.5,
  };
}

/** DB-fetching wrapper for single-user callers (finalizeForUser, the TradingView webhook). */
export async function resolveUserTradingContext(
  userId: string,
  defaultSymbols: string[] = [],
): Promise<UserTradingContext | null> {
  const [profile] = await db
    .select()
    .from(userRiskProfiles)
    .where(eq(userRiskProfiles.userId, userId))
    .limit(1);
  if (!profile) return null;

  const [exchangeRow] = await db
    .select({ exchangeName: userExchanges.exchangeName })
    .from(userExchanges)
    .where(and(eq(userExchanges.userId, userId), eq(userExchanges.status, 'active')))
    .limit(1);

  return deriveTradingContext(profile, exchangeRow, defaultSymbols);
}
