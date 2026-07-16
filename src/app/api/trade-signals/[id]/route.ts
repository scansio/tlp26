/**
 * PATCH /api/trade-signals/[id]
 *
 * Approves or rejects a pending trade signal.
 *
 * Body: { action: 'approve' | 'reject' }
 *
 * Approve behaviour:
 *  - Runs circuit-breaker checks (applies to both paper and live mode).
 *  - In paper mode: simulates a fill at the signal's entry price with slippage applied,
 *    inserts a trade_execution with mode='paper', does NOT call any exchange API.
 *  - In live mode: decrypts user exchange credentials and places a market order via CCXT,
 *    inserts a trade_execution with mode='live' and the exchange order ID.
 *  - Updates signal status to 'executed' on success.
 *
 * DELETE /api/trade-signals/[id]
 *  - Cancels a pending signal (sets status='cancelled').
 */

import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import ccxt, { type Exchange } from 'ccxt';
import { db } from '@/db';
import { tradeSignals, tradeExecutions, userRiskProfiles } from '@/db/schema';
import { checkCircuitBreaker } from '@/lib/circuit-breaker';
import { executeTradeTool } from '@/mastra/tools/execute-trade-tool';
import { noopObserve } from '@mastra/core/tools';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Apply slippage to the simulated fill price.
 * LONG entries: price increases by slippagePct (worse fill — buying higher).
 * SHORT entries: price decreases by slippagePct (worse fill — selling lower).
 */
function applySlippage(
  entryPrice: number,
  direction: string,
  slippagePct: number,
): number {
  const factor = slippagePct / 100;
  return direction === 'LONG'
    ? entryPrice * (1 + factor)
    : entryPrice * (1 - factor);
}

/**
 * Fetch the current public ticker price for a symbol using the exchange name
 * stored on the signal (falls back to binance if not found).
 */
async function fetchLivePrice(symbol: string, exchangeName: string): Promise<number | null> {
  const name = (exchangeName ?? 'binance').toLowerCase();
  const ExchangeClass = (ccxt as unknown as Record<string, new (c: object) => Exchange>)[name];
  if (!ExchangeClass) return null;
  try {
    const ex = new ExchangeClass({});
    const ticker = await ex.fetchTicker(symbol);
    return ticker.last ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// PATCH — approve or reject
// ---------------------------------------------------------------------------

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: signalId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { action } = body as { action?: string };
  if (action !== 'approve' && action !== 'reject') {
    return NextResponse.json(
      { error: 'action must be "approve" or "reject"' },
      { status: 400 },
    );
  }

  // Load the signal (must belong to this user and be pending)
  const [signal] = await db
    .select()
    .from(tradeSignals)
    .where(
      and(
        eq(tradeSignals.id, signalId),
        eq(tradeSignals.userId, userId),
      ),
    )
    .limit(1);

  if (!signal) {
    return NextResponse.json({ error: 'Signal not found' }, { status: 404 });
  }

  if (signal.status !== 'pending') {
    return NextResponse.json(
      { error: `Signal is already ${signal.status}. Only pending signals can be actioned.` },
      { status: 422 },
    );
  }

  // Block approve if SL or TP is missing — enforce the hard requirement before any execution.
  if (action === 'approve' && (!signal.stopLoss || !signal.takeProfit)) {
    return NextResponse.json(
      { error: 'Cannot approve signal: stop-loss and take-profit are required before execution.' },
      { status: 422 },
    );
  }

  // Reject path — simple status update
  if (action === 'reject') {
    await db
      .update(tradeSignals)
      .set({ status: 'rejected', updatedAt: new Date() })
      .where(eq(tradeSignals.id, signalId));

    return NextResponse.json({ signalId, status: 'rejected' });
  }

  // Approve path — run circuit breaker first
  const cb = await checkCircuitBreaker(userId, {
    signalSymbol: signal.symbol,
    signalDirection: signal.direction,
  });

  if (!cb.allowed) {
    return NextResponse.json(
      { error: `Trade blocked by circuit breaker: ${cb.reason}`, circuitBreaker: cb },
      { status: 422 },
    );
  }

  // Load user's risk profile for executionMode + slippagePct + sizing
  const [profile] = await db
    .select({
      executionMode: userRiskProfiles.executionMode, // paper | live
      slippagePct: userRiskProfiles.slippagePct,
      paperBalanceUsd: userRiskProfiles.paperBalanceUsd,
      riskPerTradePct: userRiskProfiles.riskPerTradePct,
    })
    .from(userRiskProfiles)
    .where(eq(userRiskProfiles.userId, userId))
    .limit(1);

  const executionMode = profile?.executionMode ?? 'paper';
  const isPaper = executionMode === 'paper';
  const slippagePct = profile?.slippagePct ? Number(profile.slippagePct) : 0.05;

  // -------------------------------------------------------------------------
  // PAPER MODE: Simulate fill — no exchange API call
  // -------------------------------------------------------------------------
  if (isPaper) {
    const signalEntry = signal.entryPrice ? Number(signal.entryPrice) : null;

    // Use signal entry price; try to fetch live price if entry not available
    let fillPrice = signalEntry;
    if (!fillPrice) {
      const rawPayload = signal.rawPayload as Record<string, string> | null;
      const exchangeName = (rawPayload?.exchange as string) ?? 'binance';
      fillPrice = await fetchLivePrice(signal.symbol, exchangeName);
    }

    if (!fillPrice) {
      return NextResponse.json(
        { error: 'Cannot determine fill price — entry price missing and live price unavailable.' },
        { status: 422 },
      );
    }

    // Apply slippage model (same as live)
    const simulatedFillPrice = applySlippage(fillPrice, signal.direction, slippagePct);

    // Compute position size from virtual balance and risk parameters
    // Formula: (paperBalance × riskPerTradePct%) / |fillPrice − stopLoss|
    const paperBalance = profile?.paperBalanceUsd ? Number(profile.paperBalanceUsd) : 10_000;
    const riskPct = profile?.riskPerTradePct ? Number(profile.riskPerTradePct) : 1;
    const signalStopLoss = signal.stopLoss ? Number(signal.stopLoss) : null;
    let positionSize: number | null = null;
    if (signalStopLoss !== null && Math.abs(simulatedFillPrice - signalStopLoss) > 0) {
      const riskAmount = paperBalance * (riskPct / 100);
      const slDistance = Math.abs(simulatedFillPrice - signalStopLoss);
      positionSize = riskAmount / slDistance;
    }

    // Record paper execution in trade_executions
    const rawPayload = signal.rawPayload as Record<string, unknown> | null;
    const exchangeName = (rawPayload?.exchange as string | undefined) ?? 'paper';

    const [execution] = await db
      .insert(tradeExecutions)
      .values({
        signalId,
        userId,
        exchangeName,
        symbol: signal.symbol,
        entryPrice: String(simulatedFillPrice),
        positionSize: positionSize !== null ? String(positionSize) : null,
        mode: 'paper',
        status: 'open',
        entryAt: new Date(),
      })
      .returning({ id: tradeExecutions.id });

    // Mark signal as executed
    await db
      .update(tradeSignals)
      .set({ status: 'executed', updatedAt: new Date() })
      .where(eq(tradeSignals.id, signalId));

    return NextResponse.json({
      signalId,
      executionId: execution.id,
      status: 'executed',
      mode: 'paper',
      fillPrice: simulatedFillPrice,
      slippagePct,
      message: `Paper trade opened at simulated fill price $${simulatedFillPrice.toFixed(4)} (slippage: ${slippagePct}%).`,
    });
  }

  // -------------------------------------------------------------------------
  // LIVE MODE: place a real market order via execute-trade-tool
  // -------------------------------------------------------------------------
  const rawPayload = signal.rawPayload as Record<string, unknown> | null;
  const exchangeName = ((rawPayload?.exchange as string | undefined) ?? 'binance') as
    | 'binance'
    | 'bybit'
    | 'bingx';

  const signalEntry = signal.entryPrice ? Number(signal.entryPrice) : null;
  let liveEntryPrice = signalEntry;
  if (!liveEntryPrice) {
    liveEntryPrice = await fetchLivePrice(signal.symbol, exchangeName);
  }

  if (!liveEntryPrice) {
    return NextResponse.json(
      { error: 'Cannot determine entry price — entry price missing and live price unavailable.' },
      { status: 422 },
    );
  }

  // Compute position size in USDT from risk profile
  const paperBalance = profile?.paperBalanceUsd ? Number(profile.paperBalanceUsd) : 10_000;
  const riskPct = profile?.riskPerTradePct ? Number(profile.riskPerTradePct) : 1;
  const signalStopLoss = signal.stopLoss ? Number(signal.stopLoss) : null;
  let positionSizeUsdt = 100; // fallback
  if (signalStopLoss !== null && Math.abs(liveEntryPrice - signalStopLoss) > 0) {
    const riskAmount = paperBalance * (riskPct / 100);
    const slDistance = Math.abs(liveEntryPrice - signalStopLoss);
    positionSizeUsdt = (riskAmount / slDistance) * liveEntryPrice;
  }

  const toolResult = await executeTradeTool.execute!(
    {
      userId,
      signalId,
      exchange: exchangeName,
      symbol: signal.symbol,
      direction: signal.direction as 'LONG' | 'SHORT',
      entryPrice: liveEntryPrice,
      positionSizeUsdt,
      sl: Number(signal.stopLoss),
      tp: Number(signal.takeProfit),
      mode: 'live',
      slippagePct,
    },
    { observe: noopObserve },
  ) as {
    success: boolean;
    executionId: string | null;
    exchangeOrderId: string | null;
    fillPrice: number | null;
    mode: 'paper' | 'live';
    signalStatus: string;
    message: string;
  };

  if (!toolResult.success) {
    return NextResponse.json(
      { error: toolResult.message, signalId, mode: 'live' },
      { status: 422 },
    );
  }

  return NextResponse.json({
    signalId,
    executionId: toolResult.executionId,
    exchangeOrderId: toolResult.exchangeOrderId,
    status: 'executed',
    mode: 'live',
    fillPrice: toolResult.fillPrice,
    message: toolResult.message,
  });
}

// ---------------------------------------------------------------------------
// DELETE — cancel a pending signal
// ---------------------------------------------------------------------------

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: signalId } = await params;

  const [signal] = await db
    .select({ id: tradeSignals.id, status: tradeSignals.status })
    .from(tradeSignals)
    .where(
      and(
        eq(tradeSignals.id, signalId),
        eq(tradeSignals.userId, userId),
      ),
    )
    .limit(1);

  if (!signal) {
    return NextResponse.json({ error: 'Signal not found' }, { status: 404 });
  }

  if (signal.status === 'executed' || signal.status === 'cancelled') {
    return NextResponse.json(
      { error: `Signal cannot be cancelled — current status: ${signal.status}` },
      { status: 422 },
    );
  }

  await db
    .update(tradeSignals)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(tradeSignals.id, signalId));

  return NextResponse.json({ signalId, status: 'cancelled' });
}
