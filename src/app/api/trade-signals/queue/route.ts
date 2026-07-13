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
import { eq, desc, and, or } from 'drizzle-orm';
import { db } from '@/db';
import { tradeSignals, userRiskProfiles } from '@/db/schema';

// Per-exchange taker fee rates — mirrors risk-tool.ts and main trade-signals route
const DEFAULT_TAKER_FEE = 0.0004;
const DEFAULT_SLIPPAGE_PCT = 0.05;

function computeFeeData(
  direction: string,
  entryPrice: string | null,
  stopLoss: string | null,
  takeProfit: string | null,
  slippagePct: number,
  accountBalance: number | null,
  riskPerTradePct: number | null,
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

  // Position sizing — mirrors risk-tool.ts and backtester.ts formula:
  // N = (balance × riskPerTradePct%) / (slDistanceRate + totalDragRate)
  let positionSizeUsdt: number | null = null;
  let positionSizeUnits: number | null = null;
  if (accountBalance && accountBalance > 0 && riskPerTradePct && riskPerTradePct > 0) {
    const totalDragRate = roundTripFeeRate + slippageRate;
    const maxRiskUsdt = accountBalance * (riskPerTradePct / 100);
    const rawPositionSizeUsdt = maxRiskUsdt / (slDistanceRate + totalDragRate);
    if (rawPositionSizeUsdt > 0) {
      positionSizeUsdt = r(rawPositionSizeUsdt, 2);
      positionSizeUnits = r(rawPositionSizeUsdt / entry, 6);
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
  const slippagePct = profile?.slippagePct
    ? Number(profile.slippagePct)
    : DEFAULT_SLIPPAGE_PCT;
  const riskPerTradePct = profile?.riskPerTradePct ? Number(profile.riskPerTradePct) : 1;
  const accountBalance = profile?.paperBalanceUsd ? Number(profile.paperBalanceUsd) : 10_000;

  // For auto-execution users: return history (last 50 signals, any status)
  // For manual users: return only pending signals
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
      createdAt: tradeSignals.createdAt,
      updatedAt: tradeSignals.updatedAt,
      expiresAt: tradeSignals.expiresAt,
    })
    .from(tradeSignals)
    .where(
      tradingMode === 'auto'
        ? eq(tradeSignals.userId, userId)
        : and(
            eq(tradeSignals.userId, userId),
            or(eq(tradeSignals.status, 'pending')),
          ),
    )
    .orderBy(desc(tradeSignals.createdAt))
    .limit(tradingMode === 'auto' ? 50 : 100);

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
    rawPayload: row.rawPayload,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
    feeData: computeFeeData(
      row.direction,
      row.entryPrice,
      row.stopLoss,
      row.takeProfit,
      slippagePct,
      accountBalance,
      riskPerTradePct,
    ),
  }));

  return NextResponse.json({
    signals,
    tradingMode,
    executionMode: profile?.executionMode ?? 'paper',
  });
}
