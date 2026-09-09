/**
 * Polls every 'approved' trade signal (a limit entry order that didn't fill
 * immediately on approval — see src/lib/entry-fill.ts) to completion:
 *  - Live (entryOrderId set): fetches the resting order's status on the
 *    exchange. Filled -> finalizeLiveFill (trade_execution + protective
 *    orders + signal marked 'executed'). Cancelled/rejected on the exchange
 *    itself (e.g. manually, or by the exchange) -> signal marked 'cancelled'.
 *    Still resting -> left untouched for the next tick.
 *  - Paper (entryOrderId null): fetches the current ticker price; once it has
 *    reached entryPrice, simulates the fill via finalizePaperFill.
 *
 * Shared by /api/cron/reconcile-entries (external scheduler) and
 * src/worker/entry-reconcile-loop.ts (in-process worker driver) so the
 * behavior is identical regardless of which one actually fires in a given
 * deployment.
 */

import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { tradeSignals, userRiskProfiles } from '@/db/schema';
import { toExchangeSymbol, resolveHedgeMode, type MarketType } from '@/mastra/tools/market-symbol';
import { riskTool } from '@/mastra/tools/risk-tool';
import { noopObserve } from '@mastra/core/tools';
import {
  fetchTickerPrice,
  isLimitMarketable,
  finalizeLiveFill,
  finalizePaperFill,
  buildExchangeClient,
} from '@/lib/entry-fill';

export type ExchangeName = 'binance' | 'bybit' | 'bingx';

// Narrow shape reconcileLiveSignal actually reads — exported so
// expire-signals.ts can reuse it to confirm a live entry's true fill status
// before ever cancelling/expiring it (see reconcileLiveSignal's docs).
export interface LiveEntryCandidate {
  id: string;
  userId: string;
  symbol: string;
  direction: string;
  stopLoss: string;
  takeProfit: string;
  marketType: string | null;
  leverage: number | null;
  marginMode: string | null;
  entryOrderId: string | null;
}

interface ApprovedSignalRow extends LiveEntryCandidate {
  entryPrice: string | null;
  rawPayload: unknown;
  riskCalculation: unknown;
}

type RiskCalcResult = {
  positionSizeUsdt: number;
  positionSizeUnits: number;
  leverage: number;
  minOrderSizeUnits: number;
  belowExchangeMinimum: boolean;
  accountBalance?: number;
};

export type ReconcileLiveOutcome =
  | { outcome: 'filled' }
  | { outcome: 'cancelled' }
  | { outcome: 'still-resting' }
  | { outcome: 'skipped'; reason?: string };

/**
 * Check one live entry's real order status on the exchange and finalize it
 * if warranted:
 *  - filled -> finalizeLiveFill (trade_execution + protective orders,
 *    signal -> 'executed')
 *  - cancelled/rejected/expired on the exchange itself -> signal ->
 *    'cancelled'
 *  - still resting, or the check itself failed/couldn't run (no
 *    credentials, fetchOrder threw) -> left untouched; 'skipped' in
 *    particular means fill status is UNKNOWN, not "not filled" — callers
 *    (see expire-signals.ts) must not treat 'skipped' as safe to expire.
 */
export async function reconcileLiveSignal(
  signal: LiveEntryCandidate,
  exchangeName: ExchangeName,
): Promise<ReconcileLiveOutcome> {
  if (!signal.entryOrderId) return { outcome: 'skipped' as const };

  const client = await buildExchangeClient(signal.userId, exchangeName);
  if (!client) return { outcome: 'skipped' as const, reason: 'no exchange credentials' };

  const marketType = (signal.marketType as MarketType) ?? 'spot';
  const exchangeSymbol = toExchangeSymbol(signal.symbol, marketType);

  let order;
  try {
    order = await client.fetchOrder(signal.entryOrderId, exchangeSymbol);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      `[reconcile-entries] fetchOrder failed for signal ${signal.id} (order ${signal.entryOrderId} on ${exchangeName}/${exchangeSymbol}): ${reason}`,
    );
    return { outcome: 'skipped' as const, reason };
  }

  if (order.status === 'closed' && (order.filled ?? 0) > 0) {
    try {
      await client.loadMarkets();
    } catch {
      return { outcome: 'skipped' as const, reason: 'failed to load markets for fill finalization' };
    }
    const market = client.markets[exchangeSymbol];
    const contractSize =
      marketType === 'swap' && typeof market?.contractSize === 'number' && market.contractSize > 0
        ? market.contractSize
        : null;
    const hedged = marketType === 'swap' ? await resolveHedgeMode(client, exchangeSymbol) : false;

    await finalizeLiveFill({
      client,
      order,
      signalId: signal.id,
      userId: signal.userId,
      exchange: exchangeName,
      symbol: signal.symbol,
      direction: signal.direction as 'LONG' | 'SHORT',
      marketType,
      leverage: signal.leverage ?? 1,
      marginMode: (signal.marginMode as 'cross' | 'isolated') ?? 'cross',
      sl: Number(signal.stopLoss),
      tp: Number(signal.takeProfit),
      contractSize,
      hedged,
    });
    return { outcome: 'filled' as const };
  }

  if (order.status === 'canceled' || order.status === 'rejected' || order.status === 'expired') {
    await db
      .update(tradeSignals)
      .set({ status: 'cancelled', updatedAt: new Date(), entryOrderId: null })
      .where(eq(tradeSignals.id, signal.id));
    return { outcome: 'cancelled' as const };
  }

  return { outcome: 'still-resting' as const };
}

async function reconcilePaperSignal(signal: ApprovedSignalRow, exchangeName: ExchangeName) {
  const marketType = (signal.marketType as MarketType) ?? 'spot';
  const entryPrice = Number(signal.entryPrice);
  const currentPrice = await fetchTickerPrice(signal.symbol, exchangeName, marketType);
  if (currentPrice === null || !isLimitMarketable(signal.direction, entryPrice, currentPrice)) {
    return { outcome: 'still-resting' as const };
  }

  const [profile] = await db
    .select({
      paperBalanceUsd: userRiskProfiles.paperBalanceUsd,
      riskPerTradePct: userRiskProfiles.riskPerTradePct,
      slippagePct: userRiskProfiles.slippagePct,
    })
    .from(userRiskProfiles)
    .where(eq(userRiskProfiles.userId, signal.userId))
    .limit(1);

  const paperBalance = profile?.paperBalanceUsd ? Number(profile.paperBalanceUsd) : 10_000;
  const riskPct = profile?.riskPerTradePct ? Number(profile.riskPerTradePct) : 1;
  const slippagePct = profile?.slippagePct ? Number(profile.slippagePct) : 0.05;
  const stopLoss = Number(signal.stopLoss);

  // Size against the risk calculation already computed at signal-creation
  // time (or a later Recompute) — never a fresh recompute here, same
  // "what the user saw is what executes" rule as manual Approve. Only falls
  // back to computing fresh for a signal that legitimately has none yet.
  let positionSize: number | null = null;
  let leverage = signal.leverage ?? 1;
  let calc = signal.riskCalculation as RiskCalcResult | null;
  if (!calc && Math.abs(entryPrice - stopLoss) > 0) {
    try {
      calc = (await riskTool.execute!(
        {
          exchange: exchangeName,
          symbol: signal.symbol,
          marketType,
          accountBalance: paperBalance,
          riskPerTradePct: riskPct,
          entryPrice,
          stopLossPrice: stopLoss,
          takeProfitPrice: Number(signal.takeProfit),
          direction: signal.direction as 'LONG' | 'SHORT',
          slippagePct,
        },
        { observe: noopObserve },
      )) as unknown as RiskCalcResult;
      await db
        .update(tradeSignals)
        .set({
          riskCalculation: calc,
          riskCapitalUsdt: calc.accountBalance != null ? String(calc.accountBalance) : null,
          riskCalculatedAt: new Date(),
        })
        .where(eq(tradeSignals.id, signal.id));
    } catch (err) {
      console.warn('[reconcile-entries] riskTool failed for paper fill', err);
    }
  }
  if (calc) {
    positionSize = calc.positionSizeUnits;
    leverage = calc.leverage;
  }

  await finalizePaperFill({
    signalId: signal.id,
    userId: signal.userId,
    exchange: exchangeName,
    symbol: signal.symbol,
    marketType,
    fillPrice: entryPrice,
    positionSizeUnits: positionSize,
    leverage,
    marginMode: (signal.marginMode as 'cross' | 'isolated') ?? 'cross',
  });

  return { outcome: 'filled' as const };
}

export interface ReconcileEntriesResult {
  checked: number;
  filled: number;
  cancelled: number;
  stillResting: number;
  skipped: number;
}

export async function reconcileApprovedEntries(): Promise<ReconcileEntriesResult> {
  const rows = await db
    .select({
      id: tradeSignals.id,
      userId: tradeSignals.userId,
      symbol: tradeSignals.symbol,
      direction: tradeSignals.direction,
      entryPrice: tradeSignals.entryPrice,
      stopLoss: tradeSignals.stopLoss,
      takeProfit: tradeSignals.takeProfit,
      marketType: tradeSignals.marketType,
      leverage: tradeSignals.leverage,
      marginMode: tradeSignals.marginMode,
      entryOrderId: tradeSignals.entryOrderId,
      rawPayload: tradeSignals.rawPayload,
      riskCalculation: tradeSignals.riskCalculation,
    })
    .from(tradeSignals)
    .where(eq(tradeSignals.status, 'approved'));

  const results: ReconcileEntriesResult = { checked: rows.length, filled: 0, cancelled: 0, stillResting: 0, skipped: 0 };

  for (const signal of rows) {
    const rawPayload = signal.rawPayload as Record<string, unknown> | null;
    const exchangeName = ((rawPayload?.exchange as string | undefined) ?? 'binance') as ExchangeName;

    try {
      let result: { outcome: 'filled' | 'cancelled' | 'still-resting' | 'skipped' };
      if (signal.entryOrderId) {
        // Unambiguous: a real order id only ever gets set by the live
        // approval path in src/lib/entry-fill.ts.
        result = await reconcileLiveSignal(signal, exchangeName);
      } else {
        // No order id — could be a genuine paper "waiting for price" signal
        // (the only case entry-fill.ts's own paths produce), or a signal some
        // other writer put straight into 'approved' without ever attempting
        // order placement (e.g. copy-mirror-engine's auto-copy path, which
        // pre-dates this reconcile flow and is not yet wired to an execution
        // trigger — copy trading is schema-only/post-launch per CLAUDE.md).
        // Fail closed: only treat it as a paper fill if the account is
        // actually in paper mode, never assume.
        const [profile] = await db
          .select({ executionMode: userRiskProfiles.executionMode })
          .from(userRiskProfiles)
          .where(eq(userRiskProfiles.userId, signal.userId))
          .limit(1);

        if ((profile?.executionMode ?? 'paper') !== 'paper') {
          result = { outcome: 'skipped' };
        } else {
          result = await reconcilePaperSignal(signal, exchangeName);
        }
      }

      if (result.outcome === 'filled') results.filled += 1;
      else if (result.outcome === 'cancelled') results.cancelled += 1;
      else if (result.outcome === 'skipped') results.skipped += 1;
      else results.stillResting += 1;
    } catch (err) {
      console.error(`[reconcile-entries] Failed to reconcile signal ${signal.id}:`, err);
      results.skipped += 1;
    }
  }

  return results;
}
