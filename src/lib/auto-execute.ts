/**
 * Attempts to execute a single pending signal for a user in auto trading mode.
 *
 * A signal in 'auto' mode previously only got one execution attempt, at the
 * moment it was created (see finalize-for-user.ts / finalize-price-watch.ts) —
 * if that attempt failed or was skipped (unknown balance, invalid sizing), the
 * signal was left 'pending' forever with no record of why, until
 * expire-signals eventually killed it. This is the shared retry path: called
 * again by src/worker/auto-execute-retry-loop.ts on an interval, and by the same
 * finalize-*.ts callers right after creation, so a first attempt and a later
 * retry behave identically and persist the same error to trade_signals.
 *
 * Signal stays 'pending' on failure (not a terminal 'failed' status) — this
 * is a visible "why hasn't this filled yet" reason, not a terminal state, so
 * both this loop and manual Approve remain able to act on it.
 *
 * Guards against the same race a manual Approve click can hit: this loop
 * ticks every 90s and Approve can fire at any moment, so both could
 * otherwise read status='pending' and both place an order for the same
 * signal. claimPendingSignal atomically flips 'pending' -> 'executing'
 * first; if that fails (already claimed elsewhere), this bails out
 * immediately without touching anything.
 */

import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { tradeSignals } from '@/db/schema';
import { resolveUserTradingContext } from '@/lib/user-trading-context';
import { resolveAccountBalance } from '@/lib/analysis/finalize-for-user';
import { checkCircuitBreaker } from '@/lib/circuit-breaker';
import { claimPendingSignal, releaseSignalClaim } from '@/lib/signal-claim';
import { riskTool } from '@/mastra/tools/risk-tool';
import { executeTradeTool } from '@/mastra/tools/execute-trade-tool';
import { noopObserve } from '@mastra/core/tools';
import type { MarketType } from '@/mastra/tools/market-symbol';

export interface AutoExecuteAttemptResult {
  /** false when the signal wasn't eligible at all (not pending, not auto mode) — not an error. */
  attempted: boolean;
  success: boolean;
  message: string;
}

async function persistOutcome(signalId: string, error: string | null, blocked = false): Promise<void> {
  await db
    .update(tradeSignals)
    .set({
      lastError: error,
      lastErrorAt: error ? new Date() : null,
      executionAttempts: sql`${tradeSignals.executionAttempts} + 1`,
      autoExecutionBlocked: blocked,
      updatedAt: new Date(),
    })
    .where(eq(tradeSignals.id, signalId));
}

export async function attemptSignalAutoExecution(signalId: string): Promise<AutoExecuteAttemptResult> {
  const [signal] = await db.select().from(tradeSignals).where(eq(tradeSignals.id, signalId)).limit(1);
  if (!signal) return { attempted: false, success: false, message: 'Signal not found' };
  if (signal.status !== 'pending') {
    return { attempted: false, success: false, message: `Signal is ${signal.status}, not pending` };
  }

  const context = await resolveUserTradingContext(signal.userId);
  if (!context || context.tradingMode !== 'auto') {
    return { attempted: false, success: false, message: 'User is not in auto-execution mode' };
  }

  const claimed = await claimPendingSignal(signalId);
  if (!claimed) {
    return {
      attempted: false,
      success: false,
      message: 'Signal is no longer pending — already claimed by another attempt or actioned elsewhere',
    };
  }

  try {
    // This runs on a periodic retry, well outside the worker tick's
    // fetchEligibleUsers() screen — kill-switch/daily-loss/open-position
    // gates are NOT enforced upstream here, same as finalize-price-watch.ts.
    // `silent` suppresses the notification this would otherwise send every tick.
    const cb = await checkCircuitBreaker(claimed.userId, {
      signalSymbol: claimed.symbol,
      signalDirection: claimed.direction,
      silent: true,
    });
    if (!cb.allowed) {
      const message = `Blocked by risk controls: ${cb.reason ?? 'circuit breaker'}`;
      await persistOutcome(signalId, message);
      return { attempted: true, success: false, message };
    }

    const marketType = (claimed.marketType as MarketType) ?? context.marketType;
    const entryPrice = claimed.entryPrice ? Number(claimed.entryPrice) : null;
    const rawPayload = claimed.rawPayload as Record<string, unknown> | null;
    const exchange = ((rawPayload?.exchange as string | undefined) ?? context.exchange) as
      | 'binance'
      | 'bybit'
      | 'bingx';

    if (entryPrice === null) {
      const message = 'Signal has no entry price to size a position against.';
      await persistOutcome(signalId, message);
      return { attempted: true, success: false, message };
    }

    const accountBalance = await resolveAccountBalance(
      claimed.userId,
      context.executionMode,
      context.paperBalanceUsd,
      marketType,
    );
    if (accountBalance === null) {
      const message = 'Could not determine account balance for position sizing.';
      await persistOutcome(signalId, message);
      return { attempted: true, success: false, message };
    }

    const riskPerTradePct = claimed.riskOverridePct ? Number(claimed.riskOverridePct) : context.riskPerTradePct;

    let positionSizeUsdt: number;
    let leverage = claimed.leverage ?? context.leverage;
    try {
      const calc = (await riskTool.execute!(
        {
          exchange,
          symbol: claimed.symbol,
          marketType,
          accountBalance,
          riskPerTradePct,
          entryPrice,
          stopLossPrice: Number(claimed.stopLoss),
          takeProfitPrice: Number(claimed.takeProfit),
          direction: claimed.direction as 'LONG' | 'SHORT',
          slippagePct: context.slippagePct,
        },
        { observe: noopObserve },
      )) as {
        positionSizeUsdt: number;
        positionSizeUnits: number;
        leverage: number;
        minOrderSizeUnits: number;
        belowExchangeMinimum: boolean;
      };

      // Below the exchange's minimum order size — no retry will ever fix
      // this at the current balance/risk%, so stop the retry loop from
      // picking this signal up again (manual Approve can still try, and
      // will hit the same clear check rather than a cryptic CCXT error).
      if (calc.belowExchangeMinimum) {
        // Auto-retry has stopped for this signal (autoExecutionBlocked=true
        // excludes it from the retry loop's candidate query) — increasing
        // balance/risk% will NOT make it resume on its own; the message must
        // say so, since Approve is the only path left that re-sizes it.
        const message =
          `Position size (${calc.positionSizeUnits} units, $${calc.positionSizeUsdt.toFixed(2)}) is below ${exchange}'s ` +
          `minimum order size (${calc.minOrderSizeUnits} units) for ${claimed.symbol}. Auto-retry has stopped for this ` +
          `signal — increase your risk-per-trade % or account balance, then click Approve to retry manually.`;
        await persistOutcome(signalId, message, true);
        return { attempted: true, success: false, message };
      }

      positionSizeUsdt = calc.positionSizeUsdt;
      leverage = calc.leverage;
    } catch (err) {
      const message = `Risk sizing failed: ${err instanceof Error ? err.message : String(err)}`;
      await persistOutcome(signalId, message);
      return { attempted: true, success: false, message };
    }

    if (!positionSizeUsdt || positionSizeUsdt <= 0) {
      const message = 'Risk sizing produced no valid position size.';
      await persistOutcome(signalId, message);
      return { attempted: true, success: false, message };
    }

    const toolMode = context.executionMode === 'live' ? 'live' : 'paper';
    try {
      const result = (await executeTradeTool.execute!(
        {
          userId: claimed.userId,
          signalId,
          exchange,
          symbol: claimed.symbol,
          direction: claimed.direction as 'LONG' | 'SHORT',
          entryPrice,
          positionSizeUsdt,
          sl: Number(claimed.stopLoss),
          tp: Number(claimed.takeProfit),
          mode: toolMode,
          slippagePct: context.slippagePct,
          marketType,
          leverage,
          marginMode: (claimed.marginMode as 'cross' | 'isolated') ?? context.marginMode,
        },
        { observe: noopObserve },
      )) as { success: boolean; message: string };

      if (!result.success) {
        await persistOutcome(signalId, result.message);
        return { attempted: true, success: false, message: result.message };
      }

      await persistOutcome(signalId, null);
      return { attempted: true, success: true, message: result.message };
    } catch (err) {
      const message = `Execution failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`;
      await persistOutcome(signalId, message);
      return { attempted: true, success: false, message };
    }
  } finally {
    // No-op if the signal already moved on (executed/approved via
    // execute-trade-tool's own unconditional status update) — only reverts
    // to 'pending' if it's still 'executing', i.e. every failure/early-return
    // path above.
    await releaseSignalClaim(signalId);
  }
}
