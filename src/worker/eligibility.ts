/**
 * Resolves the candidate set of users the worker may generate signals for
 * on a given tick: active risk profile, kill switch off, not blocked by the
 * circuit breaker (checked silently — see src/lib/circuit-breaker.ts — so a
 * chronically blocked user doesn't get spammed with a notification every tick),
 * and restricted to symbols present and status='active' in
 * auto_trade_supported_symbols (see src/worker/supported-symbols.ts).
 *
 * A symbol dropped by that last filter is never silent: if it came from the
 * user's own `allowedSymbols` (as opposed to the WORKER_DEFAULT_SYMBOLS
 * fallback used for users with no watchlist configured, which is an operator
 * choice, not the user's), we notify them once per (userId, symbol,
 * exchange, marketType) — deduped via an in-process Set, same "don't spam
 * every tick" reasoning as the circuit-breaker check above — pointing them at
 * the chat interface (trade-analysis-workflow.ts), which isn't constrained
 * by this allowlist.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { autoTradeJobs, tradeExecutions, tradeSignals, userExchanges, userRiskProfiles } from '@/db/schema';
import { checkCircuitBreaker } from '@/lib/circuit-breaker';
import { sendNotification } from '@/lib/notifications';
import { normalizeSymbolList } from '@/lib/symbols';
import { deriveTradingContext, type ExchangeName, type MarketType } from '@/lib/user-trading-context';
import { resolvePlansForUsers } from '@/lib/billing/plan';
import { getUsageForUsersToday, hasAutoTradeQuota } from '@/lib/billing/usage';
import { buildSupportedSymbolKey, fetchActiveSupportedSymbolKeySet } from './supported-symbols';
import { chunk } from './util';

export type { ExchangeName };

export interface EligibleUser {
  userId: string;
  symbols: string[];
  /** The user's own connected execution exchange (falls back to 'binance' if none connected). */
  exchange: ExchangeName;
  marketType: MarketType;
}

function resolveDefaultSymbols(): string[] {
  const raw = process.env.WORKER_DEFAULT_SYMBOLS;
  if (!raw) return [];
  return normalizeSymbolList([raw]);
}

// In-process de-dup so a user whose watchlist references an unsupported
// symbol isn't notified again every tick (ticks fire every 15m — see
// src/worker/schedule.ts) — reset on process restart, which is fine; the
// point is avoiding a notification storm within one process's uptime, not a
// durable "have we ever told them" record.
const notifiedUnsupported = new Set<string>();

async function notifyUnsupportedSymbols(
  userId: string,
  symbols: string[],
  exchange: string,
  marketType: string,
): Promise<void> {
  const unnotified = symbols.filter((symbol) => !notifiedUnsupported.has(`${userId}:${symbol}:${exchange}:${marketType}`));
  if (unnotified.length === 0) return;

  for (const symbol of unnotified) {
    notifiedUnsupported.add(`${userId}:${symbol}:${exchange}:${marketType}`);
  }

  void sendNotification(userId, {
    event: 'signal_rejected',
    symbol: unnotified.join(', '),
    reason:
      `Not yet supported for automated trading on ${exchange} (${marketType}). ` +
      `Use the chat to analyze or trade ${unnotified.length > 1 ? 'these symbols' : 'this symbol'} manually instead.`,
  });
}

/**
 * Builds the set of `${userId}:${symbol}` pairs that already have exposure a
 * new worker-generated signal would duplicate: a trade_signal still awaiting
 * action (pending/approved), an open trade_execution (a live/paper position),
 * or an auto_trade_job still in flight (pending/processing) — the last one
 * closes a retry-window hole: without it, a job stuck in backoff after a
 * failed finalize has produced no trade_signals row yet, so the *next* tick
 * would see no exposure and enqueue a second job for the same user+symbol,
 * and both would eventually create a signal.
 *
 * Matches on symbol alone (not exchange/marketType/direction) — an open LONG
 * on one venue still blocks a new SHORT or a same-symbol signal on another
 * venue for that user, since a second concurrent signal on the same symbol
 * is the duplicate the user is complaining about either way.
 */
async function fetchExposureKeys(userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();

  const [openSignals, openExecutions, inFlightJobs] = await Promise.all([
    db
      .select({ userId: tradeSignals.userId, symbol: tradeSignals.symbol })
      .from(tradeSignals)
      .where(and(inArray(tradeSignals.userId, userIds), inArray(tradeSignals.status, ['pending', 'approved']))),
    db
      .select({ userId: tradeExecutions.userId, symbol: tradeExecutions.symbol })
      .from(tradeExecutions)
      .where(and(inArray(tradeExecutions.userId, userIds), eq(tradeExecutions.status, 'open'))),
    db
      .select({ userId: autoTradeJobs.userId, symbol: autoTradeJobs.symbol })
      .from(autoTradeJobs)
      .where(and(inArray(autoTradeJobs.userId, userIds), inArray(autoTradeJobs.status, ['pending', 'processing']))),
  ]);

  const keys = new Set<string>();
  for (const row of [...openSignals, ...openExecutions, ...inFlightJobs]) {
    keys.add(`${row.userId}:${row.symbol}`);
  }
  return keys;
}

export async function fetchEligibleUsers(): Promise<EligibleUser[]> {
  const profiles = await db
    .select()
    .from(userRiskProfiles)
    .where(and(eq(userRiskProfiles.isActive, true), eq(userRiskProfiles.killSwitchActive, false)));

  if (profiles.length === 0) return [];

  const defaultSymbols = resolveDefaultSymbols();
  const supportedKeys = await fetchActiveSupportedSymbolKeySet();
  let fallbackCount = 0;

  const candidates = await Promise.all(
    profiles.map(async (profile) => {
      const [exchangeRow] = await db
        .select({ exchangeName: userExchanges.exchangeName })
        .from(userExchanges)
        .where(and(eq(userExchanges.userId, profile.userId), eq(userExchanges.status, 'active')))
        .limit(1);

      const context = deriveTradingContext(profile, exchangeRow, defaultSymbols);
      const configuredSymbols = normalizeSymbolList(profile.allowedSymbols ?? []);
      const isUserConfigured = configuredSymbols.length > 0;
      if (!isUserConfigured && defaultSymbols.length > 0) fallbackCount += 1;

      const supported: string[] = [];
      const unsupported: string[] = [];
      for (const symbol of context.symbols) {
        if (supportedKeys.has(buildSupportedSymbolKey(symbol, context.exchange, context.marketType))) {
          supported.push(symbol);
        } else {
          unsupported.push(symbol);
        }
      }

      // Only the user's own explicit watchlist entries are worth notifying
      // about — a dropped WORKER_DEFAULT_SYMBOLS fallback entry is an
      // operator configuration issue, not something the user asked for, but
      // still worth a log line so it's visible instead of just quietly
      // shrinking the fallback watchlist.
      if (isUserConfigured && unsupported.length > 0) {
        void notifyUnsupportedSymbols(context.userId, unsupported, context.exchange, context.marketType);
      } else if (!isUserConfigured && unsupported.length > 0) {
        console.warn(
          `[worker] WORKER_DEFAULT_SYMBOLS entries not in auto_trade_supported_symbols for ` +
            `exchange=${context.exchange} marketType=${context.marketType}: [${unsupported.join(', ')}]`,
        );
      }

      return {
        userId: context.userId,
        symbols: supported,
        exchange: context.exchange,
        marketType: context.marketType,
      };
    }),
  );

  if (fallbackCount > 0) {
    console.log(
      `[worker] no watchlist configured for ${fallbackCount} user(s) — falling back to default symbol universe: [${defaultSymbols.join(', ')}]`,
    );
  }

  const withSymbols = candidates.filter((c) => c.symbols.length > 0);

  // --- Auto-trade run quota (Phase 5) ---
  // Filters out users who have already used up their plan's daily auto-trade
  // run allowance (UTC calendar day boundary — see src/lib/billing/usage.ts).
  // This is a first pass, not the only enforcement point: jobs already
  // enqueued before a user hit their cap still drain from the durable queue
  // later in the same tick or a subsequent one, so src/worker/job-queue.ts's
  // processJob re-checks the same quota right before finalizing each job.
  const withSymbolsUserIds = withSymbols.map((c) => c.userId);
  const [plansByUser, usageByUser] = await Promise.all([
    resolvePlansForUsers(withSymbolsUserIds),
    getUsageForUsersToday(withSymbolsUserIds),
  ]);
  const withQuota = withSymbols.filter((candidate) => {
    const plan = plansByUser.get(candidate.userId);
    if (!plan) return true; // fail open — resolvePlansForUsers always returns an entry per requested id
    const usage = usageByUser.get(candidate.userId) ?? { autoTradeRunsUsed: 0, chatMessagesUsed: 0 };
    const allowed = hasAutoTradeQuota(usage, plan);
    if (!allowed) {
      console.log(
        `[worker] userId=${candidate.userId} at daily auto-trade quota (${usage.autoTradeRunsUsed}/${plan.autoTradeRunsPerDay}, plan=${plan.name}) — skipping this tick`,
      );
    }
    return allowed;
  });

  // Bounded eligibility check — batched, not one unbounded Promise.all, so a
  // large user base doesn't starve the shared pg.Pool.
  const eligible: EligibleUser[] = [];
  for (const batch of chunk(withQuota, 5)) {
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

  // Drop (user, symbol) pairs the user already has exposure to — see
  // fetchExposureKeys — so a confluence group whose only interested users
  // already hold a signal/position/queued job for it never gets built at
  // all (grouping.ts runs on whatever `symbols` survives here), instead of
  // running a full (LLM-costing) analysis just to produce a duplicate.
  const exposureKeys = await fetchExposureKeys(eligible.map((u) => u.userId));
  let skippedExposureCount = 0;
  const withoutExistingExposure: EligibleUser[] = [];
  for (const user of eligible) {
    const symbols = user.symbols.filter((symbol) => !exposureKeys.has(`${user.userId}:${symbol}`));
    skippedExposureCount += user.symbols.length - symbols.length;
    if (symbols.length > 0) {
      withoutExistingExposure.push({ ...user, symbols });
    }
  }
  if (skippedExposureCount > 0) {
    console.log(
      `[worker] ${skippedExposureCount} user/symbol pair(s) skipped — existing exposure (open signal, position, or queued job)`,
    );
  }

  return withoutExistingExposure;
}
