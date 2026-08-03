/**
 * Resolves the candidate set of users the worker may generate signals for
 * on a given tick: active risk profile, kill switch off, not blocked by the
 * circuit breaker (checked silently — see src/lib/circuit-breaker.ts — so a
 * chronically blocked user doesn't get spammed with a notification every tick).
 */

import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { userExchanges, userRiskProfiles } from '@/db/schema';
import { checkCircuitBreaker } from '@/lib/circuit-breaker';
import { chunk } from './util';

export type ExchangeName = 'binance' | 'bybit' | 'bingx';

const VALID_EXCHANGES: readonly ExchangeName[] = ['binance', 'bybit', 'bingx'];

function isValidExchange(name: string): name is ExchangeName {
  return (VALID_EXCHANGES as readonly string[]).includes(name);
}

export interface EligibleUser {
  userId: string;
  symbols: string[];
  /** The user's own connected execution exchange (falls back to 'binance' if none connected). */
  exchange: ExchangeName;
}

function resolveDefaultSymbols(): string[] {
  const raw = process.env.WORKER_DEFAULT_SYMBOLS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function fetchEligibleUsers(): Promise<EligibleUser[]> {
  const profiles = await db
    .select()
    .from(userRiskProfiles)
    .where(and(eq(userRiskProfiles.isActive, true), eq(userRiskProfiles.killSwitchActive, false)));

  if (profiles.length === 0) return [];

  const defaultSymbols = resolveDefaultSymbols();
  let fallbackCount = 0;

  const candidates = await Promise.all(
    profiles.map(async (profile) => {
      const configuredSymbols = profile.allowedSymbols ?? [];
      const symbols = configuredSymbols.length > 0 ? configuredSymbols : defaultSymbols;
      if (configuredSymbols.length === 0 && defaultSymbols.length > 0) fallbackCount += 1;

      const [exchangeRow] = await db
        .select({ exchangeName: userExchanges.exchangeName })
        .from(userExchanges)
        .where(and(eq(userExchanges.userId, profile.userId), eq(userExchanges.status, 'active')))
        .limit(1);

      const exchange: ExchangeName =
        exchangeRow && isValidExchange(exchangeRow.exchangeName) ? exchangeRow.exchangeName : 'binance';

      return { userId: profile.userId, symbols, exchange };
    }),
  );

  if (fallbackCount > 0) {
    console.log(
      `[worker] no watchlist configured for ${fallbackCount} user(s) — falling back to default symbol universe: [${defaultSymbols.join(', ')}]`,
    );
  }

  const withSymbols = candidates.filter((c) => c.symbols.length > 0);

  // Bounded eligibility check — batched, not one unbounded Promise.all, so a
  // large user base doesn't starve the shared pg.Pool.
  const eligible: EligibleUser[] = [];
  for (const batch of chunk(withSymbols, 5)) {
    const results = await Promise.all(
      batch.map(async (candidate) => {
        const cb = await checkCircuitBreaker(candidate.userId, { silent: true });
        return cb.allowed ? candidate : null;
      }),
    );
    for (const r of results) {
      if (r) eligible.push(r);
    }
  }

  return eligible;
}
