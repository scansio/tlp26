import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { eq, desc } from 'drizzle-orm';
import { db } from '@/db';
import { tradeSignals, signalPublishers, userRiskProfiles } from '@/db/schema';

// ---------------------------------------------------------------------------
// Per-exchange taker fee rates (as decimals) — mirrors risk-tool.ts
// ---------------------------------------------------------------------------
const TAKER_FEES: Record<string, number> = {
  binance: 0.0004,
  bybit: 0.00055,
  bingx: 0.0005,
};
const DEFAULT_TAKER_FEE = 0.0004; // Binance rate as fallback
const DEFAULT_SLIPPAGE_PCT = 0.05; // 0.05%

function computeFeeData(
  signal: {
    direction: string;
    entryPrice: string | null;
    stopLoss: string | null;
    takeProfit: string | null;
    // exchange is not stored on trade_signals; use default taker fee
  },
  slippagePct: number,
) {
  const entry = Number(signal.entryPrice);
  const sl = Number(signal.stopLoss);
  const tp = Number(signal.takeProfit);
  if (!entry || !sl || !tp || isNaN(entry) || isNaN(sl) || isNaN(tp)) {
    return null;
  }

  const takerFeeRate = DEFAULT_TAKER_FEE;
  const slippageRate = slippagePct / 100;
  const roundTripFeeRate = 2 * takerFeeRate;

  // Use $1 notional to get rates, then caller can scale — or just use ratios
  const slDistanceRate =
    signal.direction === 'LONG'
      ? (entry - sl) / entry
      : (sl - entry) / entry;

  const tpDistanceRate =
    signal.direction === 'LONG'
      ? (tp - entry) / entry
      : (entry - tp) / entry;

  if (slDistanceRate <= 0 || tpDistanceRate <= 0) return null;

  // Normalised to $1 notional
  const grossExpectedLoss = slDistanceRate;
  const grossExpectedProfit = tpDistanceRate;
  const totalFeeCost = roundTripFeeRate;
  const slippageCost = slippageRate;
  const netExpectedLoss = grossExpectedLoss + totalFeeCost + slippageCost;
  const netExpectedProfit = grossExpectedProfit - totalFeeCost - slippageCost;
  const breakEvenDistance = (roundTripFeeRate + slippageRate) * 100;

  const r = (n: number, dp: number) => Math.round(n * Math.pow(10, dp)) / Math.pow(10, dp);

  return {
    // All values expressed as % of notional (consistent with risk-tool output)
    grossExpectedProfit: r(grossExpectedProfit * 100, 4),
    netExpectedProfit: r(netExpectedProfit * 100, 4),
    grossExpectedLoss: r(grossExpectedLoss * 100, 4),
    netExpectedLoss: r(netExpectedLoss * 100, 4),
    totalFeeCost: r(totalFeeCost * 100, 4),
    breakEvenDistance: r(breakEvenDistance, 4),
  };
}

// ---------------------------------------------------------------------------
// GET /api/trade-signals
// Returns the authenticated user's trade signal history with copy badge data
// and fee-adjusted P&L figures computed from the user's risk profile slippage.
// ---------------------------------------------------------------------------
export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Fetch user's slippage preference and exit mode (fallback to defaults if no profile)
  const [profile] = await db
    .select({
      slippagePct: userRiskProfiles.slippagePct,
      exitMode: userRiskProfiles.exitMode,
    })
    .from(userRiskProfiles)
    .where(eq(userRiskProfiles.userId, userId))
    .limit(1);

  const slippagePct = profile?.slippagePct
    ? Number(profile.slippagePct)
    : DEFAULT_SLIPPAGE_PCT;

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
      publisherId: tradeSignals.publisherId,
      createdAt: tradeSignals.createdAt,
      updatedAt: tradeSignals.updatedAt,
      expiresAt: tradeSignals.expiresAt,
      exitMode: tradeSignals.exitMode,
      // Publisher name (only populated for copy-sourced signals)
      publisherName: signalPublishers.displayName,
    })
    .from(tradeSignals)
    .leftJoin(signalPublishers, eq(tradeSignals.publisherId, signalPublishers.id))
    .where(eq(tradeSignals.userId, userId))
    .orderBy(desc(tradeSignals.createdAt))
    .limit(100);

  // Resolve exit mode: per-signal override → user risk profile default
  const effectiveExitMode = (
    signalExitMode: string | null | undefined,
    profileExitMode: string | null | undefined,
  ): string => signalExitMode ?? profileExitMode ?? 'fixed';

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
    source: row.source,
    status: row.status,
    publisherId: row.publisherId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
    // Resolved exit mode — drives "Trailing" badge in the signal card
    exitMode: effectiveExitMode(row.exitMode, profile?.exitMode ?? null),
    // "COPY" badge — present only for copy-sourced signals
    copyBadge:
      row.source === 'copy' && row.publisherName
        ? { label: 'COPY', publisherName: row.publisherName }
        : null,
    // Fee-adjusted P&L — computed from signal price levels + user's slippage setting
    feeData: computeFeeData(
      {
        direction: row.direction,
        entryPrice: row.entryPrice,
        stopLoss: row.stopLoss,
        takeProfit: row.takeProfit,
      },
      slippagePct,
    ),
  }));

  return NextResponse.json({ signals });
}
