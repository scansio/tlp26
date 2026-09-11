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
import { eq, desc, and, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { tradeSignals, userRiskProfiles, userExchanges, tradeExecutions } from '@/db/schema';
import { computePnlPct, computeLeveragedPnlPct, computeSignalOutcome, type SignalOutcome } from '@/lib/pnl';
import { fetchLiveTickerPrices } from '@/lib/live-price';
import { toExchangeSymbol, type MarketType } from '@/mastra/tools/market-symbol';

const DEFAULT_TAKER_FEE = 0.0004;
const DEFAULT_SLIPPAGE_PCT = 0.05;

type StoredRiskCalculation = {
  positionSizeUsdt?: number;
  positionSizeUnits?: number;
  marginUsdt?: number;
  leverage?: number;
  takerFeePct?: number;
  slippagePct?: number;
  roundTripFeePct?: number;
  accountBalance?: number;
  riskPerTradePct?: number;
  maxRiskUsdt?: number;
  slDistancePct?: number;
  tpDistancePct?: number;
  effectiveLossPct?: number;
  leverageRaw?: number;
  grossExpectedLoss?: number;
  grossExpectedProfit?: number;
  netExpectedLoss?: number;
  netExpectedProfit?: number;
  // Appended by execute-trade-tool.ts only if the exchange rejected the
  // solved `leverage` and it fell back to the account's default — absent
  // otherwise, meaning the solved leverage above is what actually executed.
  executedLeverage?: number;
  executedMarginUsdt?: number;
  leverageFallbackReason?: string;
};

// Pure rate math (no I/O) plus whatever risk-tool output was stored on the
// signal at creation time (or by a later Recompute) — never a live riskTool
// call here. This is what makes the Signal Queue's 15s poll cheap: no
// exchange balance fetch, no risk-tool invocation, just reading columns
// already selected below. See risk_calculation column comment in
// src/db/schema.ts for why display and execution both read the same value.
function computeFeeData(
  direction: string,
  entryPrice: string | null,
  stopLoss: string | null,
  takeProfit: string | null,
  slippagePct: number,
  riskCalculation: StoredRiskCalculation | null,
  riskCapitalUsdt: string | null,
  riskCalculatedAt: Date | null,
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

  return {
    grossExpectedProfit: r(grossExpectedProfit * 100, 4),
    netExpectedProfit: r(netExpectedProfit * 100, 4),
    grossExpectedLoss: r(grossExpectedLoss * 100, 4),
    netExpectedLoss: r(netExpectedLoss * 100, 4),
    totalFeeCost: r(roundTripFeeRate * 100, 4),
    breakEvenDistance: r((roundTripFeeRate + slippageRate) * 100, 4),
    slDistancePct: r(slDistanceRate * 100, 2),
    tpDistancePct: r(tpDistanceRate * 100, 2),
    riskReward: r(rr, 2),
    positionSizeUsdt: riskCalculation?.positionSizeUsdt ?? null,
    positionSizeUnits: riskCalculation?.positionSizeUnits ?? null,
    marginUsdt: riskCalculation?.marginUsdt ?? null,
    leverage: riskCalculation?.leverage ?? null,
    takerFeePct: riskCalculation?.takerFeePct ?? null,
    accountBalanceUsed: riskCalculation?.accountBalance ?? null,
    riskPerTradePctUsed: riskCalculation?.riskPerTradePct ?? null,
    riskCapitalUsdt: riskCapitalUsdt != null ? Number(riskCapitalUsdt) : null,
    riskCalculatedAt: riskCalculatedAt ? riskCalculatedAt.toISOString() : null,
    // Raw inputs/intermediate steps from the stored risk-tool calculation,
    // exposed so the "Show calculation" modal can walk through the exact
    // same worked equations step by step for manual verification.
    maxRiskUsdt: riskCalculation?.maxRiskUsdt ?? null,
    calcSlDistancePct: riskCalculation?.slDistancePct ?? null,
    calcTpDistancePct: riskCalculation?.tpDistancePct ?? null,
    effectiveLossPct: riskCalculation?.effectiveLossPct ?? null,
    leverageRaw: riskCalculation?.leverageRaw ?? null,
    slippagePctUsed: riskCalculation?.slippagePct ?? null,
    roundTripFeePct: riskCalculation?.roundTripFeePct ?? null,
    // Dollar P&L at the actual position size — distinct from the %-of-notional
    // grossExpectedLoss/netExpectedLoss above. lossUsdt/profitUsdt are before
    // fees (leverage × margin × SL%or TP%/100, exactly the worked-example
    // formula); netLossUsdt/netProfitUsdt are after fees + slippage.
    lossUsdt: riskCalculation?.grossExpectedLoss ?? null,
    profitUsdt: riskCalculation?.grossExpectedProfit ?? null,
    netLossUsdt: riskCalculation?.netExpectedLoss ?? null,
    netProfitUsdt: riskCalculation?.netExpectedProfit ?? null,
    // Present only if execute-trade-tool.ts had to fall back off the solved
    // leverage above because the exchange rejected it.
    executedLeverage: riskCalculation?.executedLeverage ?? null,
    executedMarginUsdt: riskCalculation?.executedMarginUsdt ?? null,
    leverageFallbackReason: riskCalculation?.leverageFallbackReason ?? null,
  };
}

// ---------------------------------------------------------------------------
// Live execution status for 'executed' signals — is the position currently
// working out (playingOut/losingOut) or, once closed, how did it resolve
// (playedOut/lostOut) — plus the leveraged (ROI-on-margin) % move exchanges
// show, vs. feeData's static %-of-notional projection computed at signal
// creation time above.
// ---------------------------------------------------------------------------

export interface SignalExecutionLiveData {
  status: string | null; // 'open' | 'closed' | 'cancelled'
  fillType: string | null; // 'sl_hit' | 'tp_hit' | 'manual' | 'liquidation'
  mode: string | null; // 'paper' | 'live'
  leverage: number;
  entryPrice: number | null;
  currentPrice: number | null; // live ticker price — only set while status='open'
  exitPrice: number | null; // only set while status='closed'
  pnlPct: number | null; // % of notional (unrealized while open, realized once closed)
  pnlPctLeveraged: number | null; // pnlPct × leverage — ROI on margin
  outcome: SignalOutcome | null;
}

async function fetchExecutionLiveDataBySignalId(
  userId: string,
  executedSignalIds: string[],
): Promise<Map<string, SignalExecutionLiveData>> {
  const result = new Map<string, SignalExecutionLiveData>();
  if (executedSignalIds.length === 0) return result;

  const execRows = await db
    .select({
      signalId: tradeExecutions.signalId,
      symbol: tradeExecutions.symbol,
      exchangeName: tradeExecutions.exchangeName,
      marketType: tradeExecutions.marketType,
      mode: tradeExecutions.mode,
      status: tradeExecutions.status,
      fillType: tradeExecutions.fillType,
      leverage: tradeExecutions.leverage,
      entryPrice: tradeExecutions.entryPrice,
      exitPrice: tradeExecutions.exitPrice,
      positionSize: tradeExecutions.positionSize,
      realizedPnl: tradeExecutions.realizedPnl,
      entryAt: tradeExecutions.entryAt,
      direction: tradeSignals.direction,
    })
    .from(tradeExecutions)
    .leftJoin(tradeSignals, eq(tradeExecutions.signalId, tradeSignals.id))
    .where(
      and(eq(tradeExecutions.userId, userId), inArray(tradeExecutions.signalId, executedSignalIds)),
    )
    .orderBy(desc(tradeExecutions.entryAt));

  // A signal can in principle have more than one execution row (retries) —
  // keep only the latest (rows already ordered desc by entryAt above).
  const latestBySignal = new Map<string, (typeof execRows)[number]>();
  for (const row of execRows) {
    if (row.signalId && !latestBySignal.has(row.signalId)) {
      latestBySignal.set(row.signalId, row);
    }
  }

  const openRows = [...latestBySignal.values()].filter((r) => r.status === 'open');
  const uniqueExchangeSymbols = [
    ...new Set(
      openRows
        .filter((r) => r.symbol)
        .map((r) => toExchangeSymbol(r.symbol, (r.marketType as MarketType) ?? 'spot')),
    ),
  ];
  const tickerMap = await fetchLiveTickerPrices(userId, uniqueExchangeSymbols, {
    isPaper: openRows.every((r) => r.mode === 'paper'),
    fallbackExchangeName: openRows[0]?.exchangeName ?? null,
  });

  for (const [signalId, r] of latestBySignal) {
    const direction = (r.direction ?? 'LONG') as 'LONG' | 'SHORT';
    const leverage = r.leverage && r.leverage > 0 ? r.leverage : 1;
    const entryPrice = r.entryPrice ? Number(r.entryPrice) : null;
    const positionSize = r.positionSize ? Number(r.positionSize) : null;
    const exitPrice = r.exitPrice ? Number(r.exitPrice) : null;
    const marketType = (r.marketType as MarketType) ?? 'spot';

    let currentPrice: number | null = null;
    let pnlPct: number | null = null;

    if (r.status === 'open') {
      currentPrice = r.symbol ? (tickerMap.get(toExchangeSymbol(r.symbol, marketType)) ?? null) : null;
      if (entryPrice && positionSize && currentPrice) {
        pnlPct = computePnlPct(entryPrice, currentPrice, positionSize, direction);
      }
    } else if (r.status === 'closed') {
      if (entryPrice && positionSize && exitPrice) {
        pnlPct = computePnlPct(entryPrice, exitPrice, positionSize, direction);
      } else if (r.realizedPnl != null && entryPrice && positionSize && entryPrice > 0) {
        pnlPct = (Number(r.realizedPnl) / (entryPrice * positionSize)) * 100;
      }
    }

    const round = (n: number | null) => (n != null ? Math.round(n * 100) / 100 : null);

    result.set(signalId, {
      status: r.status,
      fillType: r.fillType,
      mode: r.mode,
      leverage,
      entryPrice,
      currentPrice,
      exitPrice,
      pnlPct: round(pnlPct),
      pnlPctLeveraged: round(computeLeveragedPnlPct(pnlPct, leverage)),
      outcome: computeSignalOutcome({ executionStatus: r.status, fillType: r.fillType, pnl: pnlPct }),
    });
  }

  return result;
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
      riskCalculation: tradeSignals.riskCalculation,
      riskCapitalUsdt: tradeSignals.riskCapitalUsdt,
      riskCalculatedAt: tradeSignals.riskCalculatedAt,
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

  const executionBySignalId = await fetchExecutionLiveDataBySignalId(
    userId,
    rows.filter((r) => r.status === 'executed').map((r) => r.id),
  );

  const signals = rows.map((row) => ({
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
    feeData: computeFeeData(
      row.direction,
      row.entryPrice,
      row.stopLoss,
      row.takeProfit,
      slippagePct,
      row.riskCalculation as StoredRiskCalculation | null,
      row.riskCapitalUsdt,
      row.riskCalculatedAt,
    ),
    execution: executionBySignalId.get(row.id) ?? null,
  }));

  return NextResponse.json({
    signals,
    tradingMode,
    executionMode,
    connectedExchange,
  });
}
