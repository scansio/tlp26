/**
 * Trigger-time handler for a fired price watch (src/db/schema.ts: priceWatches).
 *
 * For actionType='notify' this only sends a notification (the caller handles
 * that). For actionType='trade' this mirrors finalizeForUser's risk-sizing +
 * signal-creation + conditional auto-execution path, but gated first through
 * checkCircuitBreaker — the watch-trigger path runs outside the worker tick's
 * fetchEligibleUsers() screen, so kill-switch/daily-limit/open-position gates
 * are NOT enforced upstream here and must be checked explicitly.
 */

import type { priceWatches } from '@/db/schema';
import { checkCircuitBreaker } from '@/lib/circuit-breaker';
import { resolveUserTradingContext } from '@/lib/user-trading-context';
import { resolveAccountBalance } from './finalize-for-user';
import { createSignalTool } from '@/mastra/tools/create-signal-tool';
import { executeTradeTool } from '@/mastra/tools/execute-trade-tool';
import { noopObserve } from '@mastra/core/tools';

type PriceWatchRow = typeof priceWatches.$inferSelect;

export interface FinalizePriceWatchResult {
  signalId: string | null;
  executed: boolean;
  summary: string;
}

export async function finalizePriceWatchTrade(
  watch: PriceWatchRow,
  triggeredPrice: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mastra: any,
): Promise<FinalizePriceWatchResult> {
  const direction = watch.tradeDirection as 'LONG' | 'SHORT' | null;
  const sl = watch.stopLoss ? Number(watch.stopLoss) : null;
  const tp = watch.takeProfit ? Number(watch.takeProfit) : null;

  if (!direction || !sl || !tp) {
    return {
      signalId: null,
      executed: false,
      summary: 'Watch was set to trade but is missing direction/SL/TP — no signal created.',
    };
  }

  // 20s polling means the observed trigger price can be past the target in a
  // fast move — if it's already past the SL the user approved, the R:R no
  // longer holds and (in auto mode) this would auto-execute an instantly
  // losing trade. Refuse rather than create/execute a stale setup.
  const slBreached = direction === 'LONG' ? triggeredPrice <= sl : triggeredPrice >= sl;
  if (slBreached) {
    return {
      signalId: null,
      executed: false,
      summary: 'Price moved past your stop-loss before the watch fired — no signal created.',
    };
  }

  const breaker = await checkCircuitBreaker(watch.userId, {
    signalSymbol: watch.symbol,
    signalDirection: direction,
    silent: true,
  });

  if (!breaker.allowed) {
    return {
      signalId: null,
      executed: false,
      summary: `Trade action blocked by risk controls: ${breaker.reason ?? 'circuit breaker'}.`,
    };
  }

  let riskPerTradePct = 1.0;
  let slippagePct = 0.05;
  let executionMode = 'paper';
  let tradingMode = 'manual';
  let paperBalanceUsd: string | null = null;
  // Same last-resort-only fallback as finalizeForUser — riskTool derives the
  // real leverage per-trade below.
  let profileLeverageFallback = 1;
  try {
    const context = await resolveUserTradingContext(watch.userId);
    if (context) {
      riskPerTradePct = context.riskPerTradePct;
      slippagePct = context.slippagePct;
      executionMode = context.executionMode;
      tradingMode = context.tradingMode;
      paperBalanceUsd = context.paperBalanceUsd;
      profileLeverageFallback = context.leverage;
    }
  } catch (err) {
    console.warn('finalizePriceWatchTrade: could not load risk profile, using defaults', err);
  }

  // accountBalance is null only when live mode couldn't determine a real
  // balance — skip sizing entirely rather than computing against a guess.
  const accountBalance = await resolveAccountBalance(
    watch.userId,
    executionMode,
    paperBalanceUsd,
    (watch.marketType as 'spot' | 'swap') ?? 'spot',
  );

  let riskCalculation: Record<string, unknown> | null = null;
  const riskTool = mastra?.getTool('riskTool');
  if (riskTool && accountBalance !== null) {
    try {
      riskCalculation = (await riskTool.execute!(
        {
          exchange: watch.exchange,
          symbol: watch.symbol,
          marketType: (watch.marketType as 'spot' | 'swap') ?? 'spot',
          accountBalance,
          riskPerTradePct,
          entryPrice: triggeredPrice,
          stopLossPrice: sl,
          takeProfitPrice: tp,
          direction,
          slippagePct,
        },
        {},
      )) as Record<string, unknown>;
    } catch (err) {
      console.warn('finalizePriceWatchTrade: riskTool failed', err);
    }
  } else if (!riskTool) {
    console.warn('finalizePriceWatchTrade: riskTool not found in Mastra instance');
  } else {
    console.warn(
      `finalizePriceWatchTrade: live account balance unavailable for userId=${watch.userId} — creating signal without a computed position size.`,
    );
  }

  // Leverage is derived by riskTool (see risk-tool.ts) rather than the
  // watch's own rigid leverage field; only fall back when riskTool never ran.
  const leverage = (riskCalculation?.leverage as number | undefined) ?? watch.leverage ?? profileLeverageFallback;

  const created = (await createSignalTool.execute!(
    {
      userId: watch.userId,
      symbol: watch.symbol,
      timeframe: watch.timeframe ?? '1h',
      direction,
      entryPrice: triggeredPrice,
      sl,
      tp,
      confidence: (watch.confidence as 'LOW' | 'MEDIUM' | 'HIGH') ?? 'MEDIUM',
      reasoning:
        watch.reasoning ??
        `Price watch triggered: ${watch.symbol} crossed ${watch.direction} ${watch.targetPrice}.`,
      strategySource: watch.strategySource ?? 'Price Watch',
      exchange: watch.exchange,
      marketType: watch.marketType as 'spot' | 'swap',
      leverage,
      marginMode: (watch.marginMode as 'cross' | 'isolated') ?? 'cross',
      rawPayloadExtraJson: JSON.stringify({ priceWatchId: watch.id, riskCalculation }),
    },
    { observe: noopObserve },
  )) as { signalId: string };

  const signalId = created?.signalId ?? null;
  if (!signalId) {
    return { signalId: null, executed: false, summary: 'Failed to create signal from triggered watch.' };
  }

  if (tradingMode !== 'auto') {
    return {
      signalId,
      executed: false,
      summary: `Signal created and pending approval in your Signals queue (auto-trading is off).`,
    };
  }

  const positionSizeUsdt = riskCalculation?.positionSizeUsdt as number | undefined;
  if (typeof positionSizeUsdt !== 'number' || positionSizeUsdt <= 0) {
    return {
      signalId,
      executed: false,
      summary:
        'Signal created but auto-execution was skipped — could not compute a valid position size (unknown balance or invalid risk sizing). Check the Signals queue.',
    };
  }

  const toolMode = executionMode === 'live' ? 'live' : 'paper';

  try {
    await executeTradeTool.execute!(
      {
        userId: watch.userId,
        signalId,
        exchange: watch.exchange as 'binance' | 'bybit' | 'bingx',
        symbol: watch.symbol,
        direction,
        entryPrice: triggeredPrice,
        positionSizeUsdt,
        sl,
        tp,
        mode: toolMode,
        slippagePct,
        marketType: watch.marketType as 'spot' | 'swap',
        leverage,
        marginMode: (watch.marginMode as 'cross' | 'isolated') ?? 'cross',
      },
      { observe: noopObserve },
    );
    return { signalId, executed: true, summary: `Signal auto-executed (${toolMode} mode).` };
  } catch (err) {
    console.error('finalizePriceWatchTrade: execute-trade-tool threw unexpectedly', err);
    return {
      signalId,
      executed: false,
      summary: 'Signal created but auto-execution failed — check the Signals queue.',
    };
  }
}
