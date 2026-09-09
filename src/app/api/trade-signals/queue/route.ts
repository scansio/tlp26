/**
 * GET /api/trade-signals/queue
 *
 * Returns pending trade signals for the authenticated user's approval queue.
 * Includes raw payload data for the expandable reasoning section (indicators,
 * news sentiment, on-chain bias).
 *
 * Also returns the user's tradingMode ('auto' | 'manual') so the UI can
 * switch between queue mode (manual) and history-only mode (auto).
 */

import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { eq, desc, and } from 'drizzle-orm';
import { db } from '@/db';
import { tradeSignals, userRiskProfiles, userExchanges } from '@/db/schema';
import { riskTool } from '@/mastra/tools/risk-tool';
import { noopObserve } from '@mastra/core/tools';
import { fetchLiveUsdtBalance } from '@/lib/exchange-account';

const DEFAULT_TAKER_FEE = 0.0004;
const DEFAULT_SLIPPAGE_PCT = 0.05;

async function computeFeeData(
  direction: string,
  entryPrice: string | null,
  stopLoss: string | null,
  takeProfit: string | null,
  slippagePct: number,
  accountBalance: number | null,
  riskPerTradePct: number | null,
  exchange: 'binance' | 'bybit' | 'bingx',
  symbol: string,
  marketType: 'spot' | 'swap',
  riskOverridePct: string | null,
) {
  const entry = Number(entryPrice);
  const sl = Number(stopLoss);
  const tp = Number(takeProfit);
  if (!entry || !sl || !tp || isNaN(entry) || isNaN(sl) || isNaN(tp)) return null;

  const takerFeeRate = DEFAULT_TAKER_FEE;
  const slippageRate = slippagePct / 100;
  const roundTripFeeRate = 2 * takerFeeRate;

  const slDistanceRate =
    direction === 'LONG' ? (entry - sl) / entry : (sl - entry) / entry;
  const tpDistanceRate =
    direction === 'LONG' ? (tp - entry) / entry : (entry - tp) / entry;

  if (slDistanceRate <= 0 || tpDistanceRate <= 0) return null;

  const grossExpectedProfit = tpDistanceRate;
  const netExpectedProfit = grossExpectedProfit - roundTripFeeRate - slippageRate;
  const grossExpectedLoss = slDistanceRate;
  const netExpectedLoss = grossExpectedLoss + roundTripFeeRate + slippageRate;
  const rr = tpDistanceRate / slDistanceRate;

  const r = (n: number, dp: number) =>
    Math.round(n * Math.pow(10, dp)) / Math.pow(10, dp);

  // Position/margin/leverage sizing — delegates to risk-tool.ts (the same
  // tool finalizeForUser calls before execution) instead of re-deriving the
  // formula here, so this display figure can never drift from what actually
  // gets executed. Uses the signal's own risk override when set (manually-
  // created signals may specify a per-trade risk % instead of the profile
  // default) so the displayed calculation matches what auto-execution will
  // actually size against.
  const effectiveRiskPct = riskOverridePct ? Number(riskOverridePct) : riskPerTradePct;

  let positionSizeUsdt: number | null = null;
  let positionSizeUnits: number | null = null;
  let marginUsdt: number | null = null;
  let leverage: number | null = null;
  let maxSymbolLeverage: number | null = null;
  let leverageCapped: boolean | null = null;
  let takerFeePct: number | null = null;
  if (accountBalance && accountBalance > 0 && effectiveRiskPct && effectiveRiskPct > 0) {
    try {
      const calc = (await riskTool.execute!(
        {
          exchange,
          symbol,
          marketType,
          accountBalance,
          riskPerTradePct: effectiveRiskPct,
          entryPrice: entry,
          stopLossPrice: sl,
          takeProfitPrice: tp,
          direction: direction as 'LONG' | 'SHORT',
          slippagePct,
        },
        { observe: noopObserve },
      )) as {
        positionSizeUsdt: number;
        positionSizeUnits: number;
        marginUsdt: number;
        leverage: number;
        maxSymbolLeverage: number;
        leverageCapped: boolean;
        takerFeePct: number;
      };
      positionSizeUsdt = calc.positionSizeUsdt;
      positionSizeUnits = calc.positionSizeUnits;
      marginUsdt = calc.marginUsdt;
      leverage = calc.leverage;
      maxSymbolLeverage = calc.maxSymbolLeverage;
      leverageCapped = calc.leverageCapped;
      takerFeePct = calc.takerFeePct;
    } catch (err) {
      console.warn('trade-signals/queue: riskTool failed', err);
    }
  }

  return {
    grossExpectedProfit: r(grossExpectedProfit * 100, 4),
    netExpectedProfit: r(netExpectedProfit * 100, 4),
    grossExpectedLoss: r(grossExpectedLoss * 100, 4),
    netExpectedLoss: r(netExpectedLoss * 100, 4),
    totalFeeCost: r(roundTripFeeRate * 100, 4),
    breakEvenDistance: r((roundTripFeeRate + slippageRate) * 100, 4),
    slDistancePct: r(slDistanceRate * 100, 2),
    riskReward: r(rr, 2),
    positionSizeUsdt,
    positionSizeUnits,
    marginUsdt,
    leverage,
    maxSymbolLeverage,
    leverageCapped,
    takerFeePct,
    accountBalanceUsed: accountBalance,
    riskPerTradePctUsed: effectiveRiskPct ?? null,
  };
}

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Fetch user's risk profile for tradingMode, slippage, and position sizing
  const [profile] = await db
    .select({
      tradingMode: userRiskProfiles.tradingMode,
      executionMode: userRiskProfiles.executionMode,
      slippagePct: userRiskProfiles.slippagePct,
      riskPerTradePct: userRiskProfiles.riskPerTradePct,
      paperBalanceUsd: userRiskProfiles.paperBalanceUsd,
    })
    .from(userRiskProfiles)
    .where(eq(userRiskProfiles.userId, userId))
    .limit(1);

  const tradingMode = profile?.tradingMode ?? 'manual'; // 'auto' | 'manual'
  const executionMode = profile?.executionMode ?? 'paper';
  const slippagePct = profile?.slippagePct
    ? Number(profile.slippagePct)
    : DEFAULT_SLIPPAGE_PCT;
  const riskPerTradePct = profile?.riskPerTradePct ? Number(profile.riskPerTradePct) : 1;
  const paperBalance = profile?.paperBalanceUsd ? Number(profile.paperBalanceUsd) : 10_000;

  // In live mode, size against the real exchange balance (cached per market
  // type — spot/swap wallets can differ) rather than the paper-balance
  // setting, so the risk-calculation display never quietly shows a paper
  // number to a live-mode user.
  const liveBalanceCache = new Map<'spot' | 'swap', number | null>();
  const resolveAccountBalanceForDisplay = async (marketType: 'spot' | 'swap'): Promise<number | null> => {
    if (executionMode !== 'live') return paperBalance;
    if (liveBalanceCache.has(marketType)) return liveBalanceCache.get(marketType)!;
    const balance = await fetchLiveUsdtBalance(userId, marketType);
    liveBalanceCache.set(marketType, balance);
    return balance;
  };

  // Signals themselves carry no exchange (only marketType) — resolve the user's
  // connected exchange once so the UI can build correct chart/TradingView links.
  const [exchangeRow] = await db
    .select({ exchangeName: userExchanges.exchangeName })
    .from(userExchanges)
    .where(and(eq(userExchanges.userId, userId), eq(userExchanges.status, 'active')))
    .limit(1);
  const connectedExchange = exchangeRow?.exchangeName ?? null;

  // Return signal history across all statuses so the UI can offer status
  // tabs (Pending/Active/Executed/Expired/Cancelled) instead of only ever
  // showing pending signals — manual-mode users still see pending front and
  // center via the default tab, they just aren't limited to it anymore.
  const rows = await db
    .select({
      id: tradeSignals.id,
      symbol: tradeSignals.symbol,
      timeframe: tradeSignals.timeframe,
      direction: tradeSignals.direction,
      entryPrice: tradeSignals.entryPrice,
      stopLoss: tradeSignals.stopLoss,
      takeProfit: tradeSignals.takeProfit,
      confidence: tradeSignals.confidence,
      reasoning: tradeSignals.reasoning,
      strategySource: tradeSignals.strategySource,
      source: tradeSignals.source,
      status: tradeSignals.status,
      rawPayload: tradeSignals.rawPayload,
      exitMode: tradeSignals.exitMode,
      marketType: tradeSignals.marketType,
      riskOverridePct: tradeSignals.riskOverridePct,
      lastError: tradeSignals.lastError,
      lastErrorAt: tradeSignals.lastErrorAt,
      executionAttempts: tradeSignals.executionAttempts,
      createdAt: tradeSignals.createdAt,
      updatedAt: tradeSignals.updatedAt,
      expiresAt: tradeSignals.expiresAt,
    })
    .from(tradeSignals)
    .where(eq(tradeSignals.userId, userId))
    .orderBy(desc(tradeSignals.createdAt))
    .limit(100);

  const resolvedExchange = (connectedExchange as 'binance' | 'bybit' | 'bingx' | null) ?? 'binance';

  const signals = await Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      symbol: row.symbol,
      timeframe: row.timeframe,
      direction: row.direction,
      entryPrice: row.entryPrice,
      stopLoss: row.stopLoss,
      takeProfit: row.takeProfit,
      confidence: row.confidence,
      reasoning: row.reasoning,
      strategySource: row.strategySource,
      source: row.source ?? 'ai',
      status: row.status,
      exitMode: row.exitMode,
      marketType: row.marketType ?? 'spot',
      rawPayload: row.rawPayload,
      riskOverridePct: row.riskOverridePct,
      lastError: row.lastError,
      lastErrorAt: row.lastErrorAt,
      executionAttempts: row.executionAttempts ?? 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      expiresAt: row.expiresAt,
      feeData: await computeFeeData(
        row.direction,
        row.entryPrice,
        row.stopLoss,
        row.takeProfit,
        slippagePct,
        await resolveAccountBalanceForDisplay((row.marketType as 'spot' | 'swap') ?? 'spot'),
        riskPerTradePct,
        resolvedExchange,
        row.symbol,
        (row.marketType as 'spot' | 'swap') ?? 'spot',
        row.riskOverridePct,
      ),
    })),
  );

  return NextResponse.json({
    signals,
    tradingMode,
    executionMode,
    connectedExchange,
  });
}
