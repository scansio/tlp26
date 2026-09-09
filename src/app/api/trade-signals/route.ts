import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { eq, desc } from 'drizzle-orm';
import { db } from '@/db';
import { tradeSignals, signalPublishers, userRiskProfiles } from '@/db/schema';
import { checkCircuitBreaker } from '@/lib/circuit-breaker';
import { resolveUserTradingContext } from '@/lib/user-trading-context';
import { attemptSignalAutoExecution } from '@/lib/auto-execute';

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

// ---------------------------------------------------------------------------
// POST /api/trade-signals
//
// Creates a manually-specified trade signal (source='manual'). Flows through
// the exact same lifecycle as an AI/TradingView signal — approve/reject,
// risk sizing, entry-fill, SL/TP monitoring, trailing — nothing downstream
// keys off `source`. If the user is in auto-execution mode, one execution
// attempt is made immediately for a responsive UI; if it fails (or the user
// is in manual mode), the signal is left 'pending' — auto mode signals are
// then retried by src/worker/auto-execute-retry-loop.ts until they succeed,
// expire, or the user acts on them.
// ---------------------------------------------------------------------------

const VALID_DIRECTIONS = ['LONG', 'SHORT'] as const;
const VALID_MARKET_TYPES = ['spot', 'swap'] as const;
const VALID_MARGIN_MODES = ['cross', 'isolated'] as const;

interface CreateSignalBody {
  symbol?: unknown;
  timeframe?: unknown;
  direction?: unknown;
  entryPrice?: unknown;
  stopLoss?: unknown;
  takeProfit?: unknown;
  marketType?: unknown;
  leverage?: unknown;
  marginMode?: unknown;
  riskPct?: unknown;
}

function positiveNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: CreateSignalBody;
  try {
    body = (await req.json()) as CreateSignalBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const symbol = typeof body.symbol === 'string' ? body.symbol.trim().toUpperCase() : '';
  if (!symbol) {
    return NextResponse.json({ error: 'symbol is required, e.g. "BTC/USDT"' }, { status: 400 });
  }

  const direction = typeof body.direction === 'string' ? body.direction.toUpperCase() : '';
  if (!VALID_DIRECTIONS.includes(direction as (typeof VALID_DIRECTIONS)[number])) {
    return NextResponse.json({ error: 'direction must be "LONG" or "SHORT"' }, { status: 400 });
  }

  const entryPrice = positiveNumber(body.entryPrice);
  const stopLoss = positiveNumber(body.stopLoss);
  const takeProfit = positiveNumber(body.takeProfit);
  if (entryPrice === null || stopLoss === null || takeProfit === null) {
    return NextResponse.json(
      { error: 'entryPrice, stopLoss, and takeProfit are all required and must be positive numbers' },
      { status: 400 },
    );
  }

  const validLevels =
    direction === 'LONG'
      ? stopLoss < entryPrice && takeProfit > entryPrice
      : stopLoss > entryPrice && takeProfit < entryPrice;
  if (!validLevels) {
    return NextResponse.json(
      {
        error:
          direction === 'LONG'
            ? 'For a LONG signal, stopLoss must be below entryPrice and takeProfit above it.'
            : 'For a SHORT signal, stopLoss must be above entryPrice and takeProfit below it.',
      },
      { status: 400 },
    );
  }

  const timeframe = typeof body.timeframe === 'string' && body.timeframe.trim() ? body.timeframe.trim() : '1h';

  const marketType =
    typeof body.marketType === 'string' && VALID_MARKET_TYPES.includes(body.marketType as (typeof VALID_MARKET_TYPES)[number])
      ? (body.marketType as 'spot' | 'swap')
      : undefined;

  const marginMode =
    typeof body.marginMode === 'string' && VALID_MARGIN_MODES.includes(body.marginMode as (typeof VALID_MARGIN_MODES)[number])
      ? (body.marginMode as 'cross' | 'isolated')
      : undefined;

  const rawLeverage = body.leverage !== undefined ? positiveNumber(body.leverage) : null;
  const leverage = rawLeverage !== null ? Math.round(rawLeverage) : null;

  let riskOverridePct: number | null = null;
  if (body.riskPct !== undefined && body.riskPct !== null && body.riskPct !== '') {
    const n = Number(body.riskPct);
    if (!Number.isFinite(n) || n <= 0 || n > 10) {
      return NextResponse.json({ error: 'riskPct must be a number between 0 and 10' }, { status: 400 });
    }
    riskOverridePct = n;
  }

  // Same guardrails any other execution entry point runs — a manually-created
  // signal shouldn't bypass kill-switch/daily-loss/open-position limits just
  // because it didn't come from the worker's eligibility screen.
  const cb = await checkCircuitBreaker(userId, { signalSymbol: symbol, signalDirection: direction });
  if (!cb.allowed) {
    return NextResponse.json(
      { error: `Trade blocked by circuit breaker: ${cb.reason}`, circuitBreaker: cb },
      { status: 422 },
    );
  }

  const context = await resolveUserTradingContext(userId);

  const [created] = await db
    .insert(tradeSignals)
    .values({
      userId,
      symbol,
      timeframe,
      direction,
      entryPrice: String(entryPrice),
      stopLoss: String(stopLoss),
      takeProfit: String(takeProfit),
      confidence: 'MEDIUM',
      reasoning: 'Manually created signal.',
      strategySource: 'Manual',
      source: 'manual',
      status: 'pending',
      marketType: marketType ?? context?.marketType ?? 'spot',
      leverage: leverage ?? context?.leverage ?? 1,
      marginMode: marginMode ?? context?.marginMode ?? 'cross',
      riskOverridePct: riskOverridePct !== null ? String(riskOverridePct) : null,
      rawPayload: { exchange: context?.exchange ?? 'binance' },
      expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
    })
    .returning({ id: tradeSignals.id });

  const signalId = created.id;

  if (context?.tradingMode !== 'auto') {
    return NextResponse.json({
      signalId,
      status: 'pending',
      autoExecuted: false,
      message: 'Signal created and pending approval in your Signals queue (auto-trading is off).',
    });
  }

  const attempt = await attemptSignalAutoExecution(signalId);
  return NextResponse.json({
    signalId,
    autoExecuted: attempt.success,
    message: attempt.success
      ? attempt.message
      : `Signal created — auto-execution will keep retrying (${attempt.message}).`,
  });
}
