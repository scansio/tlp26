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

const DEFAULT_TAKER_FEE = 0.0004;
const DEFAULT_SLIPPAGE_PCT = 0.05;

type StoredRiskCalculation = {
  positionSizeUsdt?: number;
  positionSizeUnits?: number;
  marginUsdt?: number;
  leverage?: number;
  maxSymbolLeverage?: number;
  leverageCapped?: boolean;
  takerFeePct?: number;
  accountBalance?: number;
  riskPerTradePct?: number;
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
    riskReward: r(rr, 2),
    positionSizeUsdt: riskCalculation?.positionSizeUsdt ?? null,
    positionSizeUnits: riskCalculation?.positionSizeUnits ?? null,
    marginUsdt: riskCalculation?.marginUsdt ?? null,
    leverage: riskCalculation?.leverage ?? null,
    maxSymbolLeverage: riskCalculation?.maxSymbolLeverage ?? null,
    leverageCapped: riskCalculation?.leverageCapped ?? null,
    takerFeePct: riskCalculation?.takerFeePct ?? null,
    accountBalanceUsed: riskCalculation?.accountBalance ?? null,
    riskPerTradePctUsed: riskCalculation?.riskPerTradePct ?? null,
    riskCapitalUsdt: riskCapitalUsdt != null ? Number(riskCapitalUsdt) : null,
    riskCalculatedAt: riskCalculatedAt ? riskCalculatedAt.toISOString() : null,
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
  }));

  return NextResponse.json({
    signals,
    tradingMode,
    executionMode,
    connectedExchange,
  });
}
