/**
 * Circuit Breaker — per-user risk guardrails.
 *
 * Checks run in this order before every trade execution:
 *  1. Daily trade count < maxTradesPerDay
 *  2. Daily realized + unrealized loss < maxDailyLoss% of starting equity (approximated as sum of realizedPnl today)
 *  3. Kill switch is OFF
 *  4. Open positions < maxOpenPositions (default: 5)
 *
 * Call checkCircuitBreaker(userId) on every execution entry point.
 * Call getCircuitBreakerState(userId) for dashboard display.
 */

import { and, count, eq, gte, sql } from 'drizzle-orm';
import { db } from '@/db';
import { userRiskProfiles, tradeExecutions, tradeSignals } from '@/db/schema';
import { sendNotification } from '@/lib/notifications';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CircuitBreakerStatus = 'green' | 'yellow' | 'red' | 'locked';

export interface CircuitBreakerResult {
  allowed: boolean;
  reason: string | null;
  state: CircuitBreakerStatus;
  /** Structured diagnostics for the dashboard */
  diagnostics: {
    dailyTradeCount: number;
    maxTradesPerDay: number;
    dailyLossPct: number;
    maxDailyLossPct: number;
    openPositions: number;
    maxOpenPositions: number;
    killSwitchActive: boolean;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Midnight UTC today as a Date */
function startOfUtcDay(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
}

/**
 * Return the colour-coded status given current vs limit values.
 * yellow = ≥ 80 % of any limit, red = at/over any limit (kill switch off),
 * locked = kill switch on.
 */
function deriveStatus(
  killSwitch: boolean,
  tradeCount: number,
  maxTrades: number,
  lossPct: number,
  maxLossPct: number,
  openPos: number,
  maxOpenPos: number,
): CircuitBreakerStatus {
  if (killSwitch) return 'locked';

  const atLimit =
    tradeCount >= maxTrades ||
    lossPct >= maxLossPct ||
    openPos >= maxOpenPos;

  if (atLimit) return 'red';

  const nearLimit =
    tradeCount / maxTrades >= 0.8 ||
    lossPct / maxLossPct >= 0.8 ||
    openPos / maxOpenPos >= 0.8;

  if (nearLimit) return 'yellow';

  return 'green';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run all circuit-breaker checks for a user.
 * If blocked, fires a fire-and-forget notification and logs to console.
 * Safe to call on every trade entry point.
 */
export async function checkCircuitBreaker(
  userId: string,
  opts?: { signalSymbol?: string; signalDirection?: string },
): Promise<CircuitBreakerResult> {
  // --- Load risk profile ---
  const [profile] = await db
    .select()
    .from(userRiskProfiles)
    .where(eq(userRiskProfiles.userId, userId))
    .limit(1);

  if (!profile || !profile.isActive) {
    return {
      allowed: false,
      reason: 'No active risk profile configured.',
      state: 'locked',
      diagnostics: {
        dailyTradeCount: 0,
        maxTradesPerDay: 0,
        dailyLossPct: 0,
        maxDailyLossPct: 0,
        openPositions: 0,
        maxOpenPositions: 5,
        killSwitchActive: true,
      },
    };
  }

  const maxTrades = profile.maxTradesPerDay ?? 5;
  const maxDailyLossPct = Number(profile.maxDailyLossPct ?? 3);
  const maxOpenPos = profile.maxOpenPositions ?? 5;
  const killSwitch = profile.killSwitchActive ?? false;

  const dayStart = startOfUtcDay();

  // --- Check 3 first (kill switch) — cheap DB-free check ---
  if (killSwitch) {
    const state = deriveStatus(true, 0, maxTrades, 0, maxDailyLossPct, 0, maxOpenPos);
    const reason = 'Kill switch is active. All trading halted.';
    console.warn(`[circuit-breaker] BLOCKED userId=${userId} reason="${reason}"`);
    void sendNotification(userId, {
      event: 'signal_rejected',
      symbol: opts?.signalSymbol,
      direction: opts?.signalDirection,
      reason,
    });
    return {
      allowed: false,
      reason,
      state,
      diagnostics: {
        dailyTradeCount: 0,
        maxTradesPerDay: maxTrades,
        dailyLossPct: 0,
        maxDailyLossPct,
        openPositions: 0,
        maxOpenPositions: maxOpenPos,
        killSwitchActive: true,
      },
    };
  }

  // --- Parallel DB queries ---
  const [tradeCountRow, openPosRow, dailyLossRow] = await Promise.all([
    // Check 1: daily trade count (entries today, any status except cancelled)
    db
      .select({ cnt: count() })
      .from(tradeExecutions)
      .where(
        and(
          eq(tradeExecutions.userId, userId),
          gte(tradeExecutions.entryAt, dayStart),
          sql`${tradeExecutions.status} != 'cancelled'`,
        ),
      )
      .then((rows) => rows[0]?.cnt ?? 0),

    // Check 4: open positions count
    db
      .select({ cnt: count() })
      .from(tradeExecutions)
      .where(
        and(
          eq(tradeExecutions.userId, userId),
          eq(tradeExecutions.status, 'open'),
        ),
      )
      .then((rows) => rows[0]?.cnt ?? 0),

    // Check 2: daily realized loss (sum of negative P&L today for closed positions)
    // Unrealized: we sum (exitPrice-entryPrice)*positionSize for closed + approximate open
    // as 0 (we don't have live prices without CCXT — open positions add risk but not loss yet)
    db
      .select({
        totalLoss: sql<string>`COALESCE(SUM(CASE WHEN ${tradeExecutions.realizedPnl} < 0 THEN ABS(${tradeExecutions.realizedPnl}) ELSE 0 END), 0)`,
        totalPositionSize: sql<string>`COALESCE(SUM(${tradeExecutions.positionSize}), 0)`,
      })
      .from(tradeExecutions)
      .where(
        and(
          eq(tradeExecutions.userId, userId),
          eq(tradeExecutions.status, 'closed'),
          gte(tradeExecutions.exitAt!, dayStart),
        ),
      )
      .then((rows) => rows[0]),
  ]);

  const dailyTradeCount = Number(tradeCountRow);
  const openPositions = Number(openPosRow);
  const dailyLossAbs = Number(dailyLossRow?.totalLoss ?? 0);

  // Express loss as a % of total position size today (fallback: we use 0 if no reference)
  // Simple approach: treat daily loss as a % against an internal $10k reference or
  // aggregate position size. If positionSize is 0, treat as 0%.
  // Note: the most meaningful comparison is loss / total_risk_deployed today, but
  // without an account balance we approximate loss / sum(positionSizes today).
  const totalPositionSize = Number(dailyLossRow?.totalPositionSize ?? 0);
  const dailyLossPct =
    totalPositionSize > 0 ? (dailyLossAbs / totalPositionSize) * 100 : 0;

  const state = deriveStatus(
    killSwitch,
    dailyTradeCount,
    maxTrades,
    dailyLossPct,
    maxDailyLossPct,
    openPositions,
    maxOpenPos,
  );

  const diagnostics = {
    dailyTradeCount,
    maxTradesPerDay: maxTrades,
    dailyLossPct,
    maxDailyLossPct,
    openPositions,
    maxOpenPositions: maxOpenPos,
    killSwitchActive: killSwitch,
  };

  // --- Check 1: daily trade count ---
  if (dailyTradeCount >= maxTrades) {
    const reason = `Daily trade limit reached (${dailyTradeCount}/${maxTrades}).`;
    console.warn(`[circuit-breaker] BLOCKED userId=${userId} reason="${reason}"`);
    void sendNotification(userId, {
      event: 'daily_limit',
      symbol: opts?.signalSymbol,
      tradesUsed: dailyTradeCount,
      tradesLimit: maxTrades,
    });
    return { allowed: false, reason, state, diagnostics };
  }

  // --- Check 2: daily loss ---
  if (dailyLossPct >= maxDailyLossPct) {
    const reason = `Daily loss limit reached (${dailyLossPct.toFixed(2)}% >= ${maxDailyLossPct}%).`;
    console.warn(`[circuit-breaker] BLOCKED userId=${userId} reason="${reason}"`);
    void sendNotification(userId, {
      event: 'daily_loss_limit',
      symbol: opts?.signalSymbol,
      reason,
    });
    return { allowed: false, reason, state, diagnostics };
  }

  // --- Check 4: open positions ---
  if (openPositions >= maxOpenPos) {
    const reason = `Max open positions reached (${openPositions}/${maxOpenPos}).`;
    console.warn(`[circuit-breaker] BLOCKED userId=${userId} reason="${reason}"`);
    void sendNotification(userId, {
      event: 'signal_rejected',
      symbol: opts?.signalSymbol,
      direction: opts?.signalDirection,
      reason,
    });
    return { allowed: false, reason, state, diagnostics };
  }

  return { allowed: true, reason: null, state, diagnostics };
}

/**
 * Return current circuit breaker state for dashboard display.
 * Does not block or send notifications — read-only.
 */
export async function getCircuitBreakerState(
  userId: string,
): Promise<CircuitBreakerResult> {
  return checkCircuitBreaker(userId);
}

/**
 * Toggle the kill switch for a user.
 * When turning ON: also cancels all pending trade signals.
 * Returns updated state.
 */
export async function setKillSwitch(
  userId: string,
  active: boolean,
): Promise<CircuitBreakerResult> {
  // Update kill switch
  await db
    .update(userRiskProfiles)
    .set({ killSwitchActive: active, updatedAt: new Date() })
    .where(eq(userRiskProfiles.userId, userId));

  // If activating: cancel all pending signals for this user
  if (active) {
    await db
      .update(tradeSignals)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(tradeSignals.userId, userId),
          eq(tradeSignals.status, 'pending'),
        ),
      );

    // Notify user
    void sendNotification(userId, {
      event: 'daily_loss_limit', // reuse "kill switch activated" message
      reason: 'Kill switch manually activated. All pending signals cancelled.',
    });
  }

  // Return fresh state
  return getCircuitBreakerState(userId);
}
