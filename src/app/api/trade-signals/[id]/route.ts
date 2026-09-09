/**
 * PATCH /api/trade-signals/[id]
 *
 * Approves or rejects a pending trade signal.
 *
 * Body: { action: 'approve' | 'reject' }
 *
 * Approve behaviour — entryPrice is a limit target, not a live snapshot, so a
 * fill isn't guaranteed immediately (see src/lib/entry-fill.ts):
 *  - Runs circuit-breaker checks (applies to both paper and live mode).
 *  - Paper mode: fills immediately at entryPrice if the current price has
 *    already reached it; otherwise the signal rests as 'approved'.
 *  - Live mode: places a real limit order via execute-trade-tool. If it fills
 *    immediately the signal becomes 'executed'; otherwise it rests as
 *    'approved' with the exchange order id stored, and
 *    /api/cron/reconcile-entries polls it to completion.
 *
 * DELETE /api/trade-signals/[id]
 *  - Cancels a pending or approved signal (sets status='cancelled'), cancelling
 *    the resting exchange order first if one exists.
 */

import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { tradeSignals, userRiskProfiles } from '@/db/schema';
import { checkCircuitBreaker } from '@/lib/circuit-breaker';
import { claimPendingSignal, releaseSignalClaim } from '@/lib/signal-claim';
import { fetchLiveUsdtBalance } from '@/lib/exchange-account';
import { executeTradeTool } from '@/mastra/tools/execute-trade-tool';
import { riskTool } from '@/mastra/tools/risk-tool';
import { type MarketType } from '@/mastra/tools/market-symbol';
import { noopObserve } from '@mastra/core/tools';
import {
  fetchTickerPrice,
  isLimitMarketable,
  applySlippage,
  finalizePaperFill,
  buildExchangeClient,
  cancelEntryOrder,
} from '@/lib/entry-fill';

const fetchLivePrice = fetchTickerPrice;

// ---------------------------------------------------------------------------
// GET — fetch signal status
// ---------------------------------------------------------------------------

export async function GET(
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

  return NextResponse.json({ signalId: signal.id, status: signal.status });
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

  // Reject path — atomic status update guarded on still-pending, so this
  // can't race with the auto-retry loop claiming the signal a moment later.
  if (action === 'reject') {
    const [rejected] = await db
      .update(tradeSignals)
      .set({ status: 'rejected', updatedAt: new Date() })
      .where(and(eq(tradeSignals.id, signalId), eq(tradeSignals.status, 'pending')))
      .returning({ id: tradeSignals.id });

    if (!rejected) {
      return NextResponse.json(
        { error: 'Signal is no longer pending — it may already be executing via auto-retry. Refresh and try again.' },
        { status: 409 },
      );
    }

    return NextResponse.json({ signalId, status: 'rejected' });
  }

  // Approve path — atomically claim the signal first so this can never race
  // with src/worker/auto-execute-retry-loop.ts (or a second concurrent
  // Approve click) also picking up the same 'pending' signal and placing a
  // duplicate order. Every return below this point must go through the
  // try/finally so a failed/early-return path reliably releases the claim
  // back to 'pending' rather than leaving the signal stuck invisible.
  const claimed = await claimPendingSignal(signalId);
  if (!claimed) {
    return NextResponse.json(
      { error: 'Signal is no longer pending — it may already be executing via auto-retry. Refresh and try again.' },
      { status: 409 },
    );
  }

  try {
    return await approveSignal(signalId, userId, signal);
  } finally {
    // No-op once the signal has moved on to 'approved'/'executed' via
    // finalizePaperFill/executeTradeTool's own status update — only reverts
    // to 'pending' if still 'executing', i.e. every failure path below.
    await releaseSignalClaim(signalId);
  }
}

// ---------------------------------------------------------------------------
// Approve — sizing + execution, extracted so the claim/release above wraps
// every return path uniformly instead of needing per-branch bookkeeping.
// ---------------------------------------------------------------------------

async function approveSignal(
  signalId: string,
  userId: string,
  signal: typeof tradeSignals.$inferSelect,
) {
  // Circuit breaker
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
  // PAPER MODE: Simulate a limit fill at entryPrice — no exchange API call.
  // entryPrice is a target (often an SMC retest zone), not a live snapshot:
  // only fill now if the current price has actually reached it; otherwise
  // rest as 'approved' for /api/cron/reconcile-entries to fill later.
  // -------------------------------------------------------------------------
  if (isPaper) {
    const signalEntry = signal.entryPrice ? Number(signal.entryPrice) : null;
    const rawPayload = signal.rawPayload as Record<string, unknown> | null;
    const exchangeName = ((rawPayload?.exchange as string | undefined) ?? 'binance') as
      | 'binance'
      | 'bybit'
      | 'bingx';
    const signalMarketType = (signal.marketType as MarketType) ?? 'spot';

    let fillPrice: number;
    if (signalEntry) {
      const currentPrice = await fetchLivePrice(signal.symbol, exchangeName, signalMarketType);

      if (currentPrice !== null && !isLimitMarketable(signal.direction, signalEntry, currentPrice)) {
        await db
          .update(tradeSignals)
          .set({ status: 'approved', updatedAt: new Date() })
          .where(eq(tradeSignals.id, signalId));

        return NextResponse.json({
          signalId,
          status: 'approved',
          mode: 'paper',
          message: `Paper limit order resting at $${signalEntry.toFixed(4)} (current price $${currentPrice.toFixed(4)}) — will fill once price is reached.`,
        });
      }

      // Marketable now (or ticker unavailable — fill at entry rather than get stuck)
      fillPrice = signalEntry;
    } else {
      // No entry target at all (e.g. a webhook signal without one) — this is
      // effectively a market fill, so the slippage model applies.
      const livePrice = await fetchLivePrice(signal.symbol, exchangeName, signalMarketType);
      if (!livePrice) {
        return NextResponse.json(
          { error: 'Cannot determine fill price — entry price missing and live price unavailable.' },
          { status: 422 },
        );
      }
      fillPrice = applySlippage(livePrice, signal.direction, slippagePct);
    }

    // Margin/leverage sizing — delegates to risk-tool.ts (the same tool the
    // auto-trading worker uses) rather than a separate formula, so a manual
    // approval never diverges from what auto-execution would have done.
    const paperBalance = profile?.paperBalanceUsd ? Number(profile.paperBalanceUsd) : 10_000;
    const riskPct = profile?.riskPerTradePct ? Number(profile.riskPerTradePct) : 1;
    const signalStopLoss = signal.stopLoss ? Number(signal.stopLoss) : null;
    let positionSize: number | null = null;
    let paperLeverage = signal.leverage ?? 1;
    if (signalStopLoss !== null && Math.abs(fillPrice - signalStopLoss) > 0) {
      try {
        const calc = (await riskTool.execute!(
          {
            exchange: exchangeName,
            symbol: signal.symbol,
            marketType: signalMarketType,
            accountBalance: paperBalance,
            riskPerTradePct: riskPct,
            entryPrice: fillPrice,
            stopLossPrice: signalStopLoss,
            takeProfitPrice: Number(signal.takeProfit),
            direction: signal.direction as 'LONG' | 'SHORT',
            slippagePct,
          },
          { observe: noopObserve },
        )) as { positionSizeUnits: number; leverage: number };
        positionSize = calc.positionSizeUnits;
        paperLeverage = calc.leverage;
      } catch (err) {
        console.warn('trade-signals/[id]: riskTool failed for paper approval', err);
      }
    }

    const { executionId } = await finalizePaperFill({
      signalId,
      userId,
      exchange: exchangeName,
      symbol: signal.symbol,
      marketType: signalMarketType,
      fillPrice,
      positionSizeUnits: positionSize,
      leverage: paperLeverage,
      marginMode: (signal.marginMode as 'cross' | 'isolated') ?? 'cross',
    });

    return NextResponse.json({
      signalId,
      executionId,
      status: 'executed',
      mode: 'paper',
      fillPrice,
      message: `Paper trade filled at $${fillPrice.toFixed(4)}.`,
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

  const signalMarketType = (signal.marketType as MarketType) ?? 'spot';

  const signalEntry = signal.entryPrice ? Number(signal.entryPrice) : null;
  let liveEntryPrice = signalEntry;
  if (!liveEntryPrice) {
    liveEntryPrice = await fetchLivePrice(signal.symbol, exchangeName, signalMarketType);
  }

  if (!liveEntryPrice) {
    return NextResponse.json(
      { error: 'Cannot determine entry price — entry price missing and live price unavailable.' },
      { status: 422 },
    );
  }

  // Margin/leverage sizing — delegates to risk-tool.ts (the same tool the
  // auto-trading worker uses via finalizeForUser) rather than a separate
  // formula, so a manual approval can never diverge from — or under-margin
  // relative to — what auto-execution would have done. Sized against the
  // real exchange balance — never the paper-trading balance setting. This
  // route fails closed: an unknown live balance must never silently fall
  // back to a paper number and produce a wrong-sized real order.
  const riskPct = profile?.riskPerTradePct ? Number(profile.riskPerTradePct) : 1;
  const signalStopLoss = signal.stopLoss ? Number(signal.stopLoss) : null;

  const liveBalance = await fetchLiveUsdtBalance(userId, signalMarketType);
  if (liveBalance === null) {
    return NextResponse.json(
      {
        error: `Could not determine a valid USDT balance on ${exchangeName}. Connect your exchange or check its balance, then retry. Refusing to size a live position from an unknown balance.`,
      },
      { status: 422 },
    );
  }

  if (signalStopLoss === null || Math.abs(liveEntryPrice - signalStopLoss) <= 0) {
    return NextResponse.json(
      { error: 'Cannot size a live position: stop-loss is missing or equal to the entry price.' },
      { status: 422 },
    );
  }

  let positionSizeUsdt: number;
  let leverage = signal.leverage ?? 1;
  try {
    const calc = (await riskTool.execute!(
      {
        exchange: exchangeName,
        symbol: signal.symbol,
        marketType: signalMarketType,
        accountBalance: liveBalance,
        riskPerTradePct: riskPct,
        entryPrice: liveEntryPrice,
        stopLossPrice: signalStopLoss,
        takeProfitPrice: Number(signal.takeProfit),
        direction: signal.direction as 'LONG' | 'SHORT',
        slippagePct,
      },
      { observe: noopObserve },
    )) as {
      positionSizeUsdt: number;
      positionSizeUnits: number;
      leverage: number;
      minOrderSizeUnits: number;
      belowExchangeMinimum: boolean;
    };

    // Fails fast with a clear reason instead of letting CCXT's own
    // amountToPrecision() reject it with a cryptic "amount... must be
    // greater than minimum amount precision" error at order-placement time.
    if (calc.belowExchangeMinimum) {
      return NextResponse.json(
        {
          error:
            `Position size (${calc.positionSizeUnits} units, $${calc.positionSizeUsdt.toFixed(2)}) is below ` +
            `${exchangeName}'s minimum order size (${calc.minOrderSizeUnits} units) for ${signal.symbol}. ` +
            `Increase your risk-per-trade % or account balance, then retry.`,
        },
        { status: 422 },
      );
    }

    positionSizeUsdt = calc.positionSizeUsdt;
    leverage = calc.leverage;
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to size position: ${err instanceof Error ? err.message : String(err)}` },
      { status: 422 },
    );
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
      marketType: signalMarketType,
      leverage,
      marginMode: (signal.marginMode as 'cross' | 'isolated') ?? 'cross',
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

  // toolResult.signalStatus is 'executed' (filled immediately) or 'approved'
  // (limit order resting on the exchange, awaiting fill via reconcile-entries).
  return NextResponse.json({
    signalId,
    executionId: toolResult.executionId,
    exchangeOrderId: toolResult.exchangeOrderId,
    status: toolResult.signalStatus,
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
    .select({
      id: tradeSignals.id,
      status: tradeSignals.status,
      symbol: tradeSignals.symbol,
      marketType: tradeSignals.marketType,
      entryOrderId: tradeSignals.entryOrderId,
      rawPayload: tradeSignals.rawPayload,
    })
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

  // 'executing' means an approve/auto-retry attempt currently holds the
  // claim (see src/lib/signal-claim.ts) — cancelling underneath it would
  // race with that attempt's own release-back-to-'pending', potentially
  // resurrecting a signal the user just cancelled. Ask them to retry once
  // the in-flight attempt (sub-few-seconds) resolves.
  if (signal.status === 'executed' || signal.status === 'cancelled' || signal.status === 'executing') {
    return NextResponse.json(
      {
        error:
          signal.status === 'executing'
            ? 'Signal is currently being processed — try cancelling again in a moment.'
            : `Signal cannot be cancelled — current status: ${signal.status}`,
      },
      { status: 422 },
    );
  }

  // 'approved' means a real limit order may be resting on the exchange —
  // cancel it before flipping the DB status, so it doesn't fill unexpectedly
  // after the user thinks they've cancelled.
  if (signal.status === 'approved' && signal.entryOrderId) {
    const rawPayload = signal.rawPayload as Record<string, unknown> | null;
    const exchangeName = (rawPayload?.exchange as string | undefined) ?? 'binance';
    const client = await buildExchangeClient(userId, exchangeName);
    if (client) {
      await cancelEntryOrder(
        client,
        signal.symbol,
        (signal.marketType as MarketType) ?? 'spot',
        signal.entryOrderId,
      );
    }
  }

  await db
    .update(tradeSignals)
    .set({ status: 'cancelled', updatedAt: new Date(), entryOrderId: null })
    .where(eq(tradeSignals.id, signalId));

  return NextResponse.json({ signalId, status: 'cancelled' });
}
