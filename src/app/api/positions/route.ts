/**
 * GET /api/positions
 *
 * Returns all open trade executions enriched with current ticker price, floating P&L,
 * and the SL/TP values from the linked signal.
 *
 * Mirrors the open-positions section of /api/dashboard but includes exchangeName
 * so the position management UI can dispatch live-mode close/adjust orders.
 */

import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { tradeExecutions, tradeSignals } from '@/db/schema';
import { computePnlUsd, computePnlPct, computeLeveragedPnlPct } from '@/lib/pnl';
import { fetchLiveTickerPrices } from '@/lib/live-price';
import { toExchangeSymbol, type MarketType } from '@/mastra/tools/market-symbol';

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const rows = await db
    .select({
      id: tradeExecutions.id,
      symbol: tradeExecutions.symbol,
      entryPrice: tradeExecutions.entryPrice,
      positionSize: tradeExecutions.positionSize,
      mode: tradeExecutions.mode,
      exchangeName: tradeExecutions.exchangeName,
      marketType: tradeExecutions.marketType,
      entryAt: tradeExecutions.entryAt,
      leverage: tradeExecutions.leverage,
      direction: tradeSignals.direction,
      stopLoss: tradeSignals.stopLoss,
      takeProfit: tradeSignals.takeProfit,
      timeframe: tradeSignals.timeframe,
    })
    .from(tradeExecutions)
    .leftJoin(tradeSignals, eq(tradeExecutions.signalId, tradeSignals.id))
    .where(and(eq(tradeExecutions.userId, userId), eq(tradeExecutions.status, 'open')));

  // Fetch live prices — dedupe by the CCXT exchange symbol (spot vs swap resolve
  // to different markets, e.g. BTC/USDT vs BTC/USDT:USDT, so plain symbol isn't a safe key).
  const uniqueExchangeSymbols = [
    ...new Set(
      rows
        .filter((r) => r.symbol)
        .map((r) => toExchangeSymbol(r.symbol, (r.marketType as MarketType) ?? 'spot')),
    ),
  ];
  const isPaper = rows.every((r) => r.mode === 'paper');
  const tickerMap = await fetchLiveTickerPrices(userId, uniqueExchangeSymbols, {
    isPaper,
    fallbackExchangeName: rows[0]?.exchangeName ?? null,
  });

  const positions = rows.map((pos) => {
    const entryPrice = pos.entryPrice ? parseFloat(pos.entryPrice) : null;
    const positionSize = pos.positionSize ? parseFloat(pos.positionSize) : null;
    const marketType = (pos.marketType as MarketType) ?? 'spot';
    const currentPrice = pos.symbol ? (tickerMap.get(toExchangeSymbol(pos.symbol, marketType)) ?? null) : null;
    const direction = (pos.direction ?? 'LONG') as 'LONG' | 'SHORT';

    let unrealizedPnlUsd: number | null = null;
    let unrealizedPnlPct: number | null = null;

    if (entryPrice && positionSize && currentPrice) {
      unrealizedPnlUsd = computePnlUsd(entryPrice, currentPrice, positionSize, direction);
      unrealizedPnlPct = computePnlPct(entryPrice, currentPrice, positionSize, direction);
    }

    return {
      id: pos.id,
      symbol: pos.symbol,
      direction,
      exchangeName: pos.exchangeName,
      marketType,
      mode: pos.mode ?? 'paper',
      entryPrice,
      currentPrice,
      positionSize,
      leverage: pos.leverage ?? 1,
      unrealizedPnlUsd,
      unrealizedPnlPct,
      // ROI on margin (price move % × leverage) — what exchanges show as the
      // headline percentage on an open position, vs. unrealizedPnlPct above
      // which is % of notional.
      unrealizedPnlPctLeveraged: computeLeveragedPnlPct(unrealizedPnlPct, pos.leverage),
      stopLoss: pos.stopLoss ? parseFloat(pos.stopLoss) : null,
      takeProfit: pos.takeProfit ? parseFloat(pos.takeProfit) : null,
      entryAt: pos.entryAt?.toISOString() ?? null,
      timeframe: pos.timeframe ?? null,
    };
  });

  return NextResponse.json({ positions });
}
