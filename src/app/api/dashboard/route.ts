/**
 * GET /api/dashboard
 *
 * Returns a consolidated payload for the dashboard page:
 *  - Portfolio summary (equity, realized P&L today, unrealized P&L, trades today / limit)
 *  - Open positions with current price, floating P&L, SL, TP
 *  - Circuit breaker state
 *  - Pending signals count
 *  - Trading mode (paper | live)
 *
 * Live exchange calls are only made when executionMode === 'live' and a connected exchange exists.
 * Paper mode: equity = paperBalanceUsd (starting capital) + all-time realized P&L + current unrealized P&L.
 */

import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { and, count, eq, gte, sql } from 'drizzle-orm';
import ccxt, { type Exchange } from 'ccxt';
import { db } from '@/db';
import {
  userRiskProfiles,
  tradeExecutions,
  tradeSignals,
} from '@/db/schema';
import { getCircuitBreakerState } from '@/lib/circuit-breaker';
import { computePnlUsd, computePnlPct } from '@/lib/pnl';
import { getUserActiveExchangeClient, extractUsdtBalance } from '@/lib/exchange-account';
import { toExchangeSymbol, configureMarketType, type MarketType } from '@/mastra/tools/market-symbol';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function startOfUtcDay(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dayStart = startOfUtcDay();

  // Run independent queries in parallel
  const [riskProfile, openPositionRows, closedToday, realizedAllTime, pendingCountRow, circuitBreaker] =
    await Promise.all([
      // Risk profile — for trading mode and daily limit
      db
        .select()
        .from(userRiskProfiles)
        .where(eq(userRiskProfiles.userId, userId))
        .limit(1)
        .then((rows) => rows[0] ?? null),

      // Open positions (join with trade_signals to get SL/TP)
      db
        .select({
          id: tradeExecutions.id,
          symbol: tradeExecutions.symbol,
          entryPrice: tradeExecutions.entryPrice,
          positionSize: tradeExecutions.positionSize,
          mode: tradeExecutions.mode,
          exchangeName: tradeExecutions.exchangeName,
          marketType: tradeExecutions.marketType,
          direction: tradeSignals.direction,
          stopLoss: tradeSignals.stopLoss,
          takeProfit: tradeSignals.takeProfit,
          entryAt: tradeExecutions.entryAt,
          leverage: tradeExecutions.leverage,
        })
        .from(tradeExecutions)
        .leftJoin(tradeSignals, eq(tradeExecutions.signalId, tradeSignals.id))
        .where(
          and(
            eq(tradeExecutions.userId, userId),
            eq(tradeExecutions.status, 'open'),
          ),
        ),

      // Realized P&L today (closed trades)
      db
        .select({
          realizedPnlToday: sql<string>`COALESCE(SUM(${tradeExecutions.realizedPnl}), 0)`,
          tradesToday: count(),
        })
        .from(tradeExecutions)
        .where(
          and(
            eq(tradeExecutions.userId, userId),
            gte(tradeExecutions.entryAt, dayStart),
            sql`${tradeExecutions.status} != 'cancelled'`,
          ),
        )
        .then((rows) => rows[0] ?? { realizedPnlToday: '0', tradesToday: 0 }),

      // Realized P&L all-time (all closed trades, for live equity calc)
      db
        .select({
          realizedPnlAllTime: sql<string>`COALESCE(SUM(${tradeExecutions.realizedPnl}), 0)`,
        })
        .from(tradeExecutions)
        .where(
          and(
            eq(tradeExecutions.userId, userId),
            eq(tradeExecutions.status, 'closed'),
          ),
        )
        .then((rows) => rows[0]?.realizedPnlAllTime ?? '0'),

      // Pending signals count
      db
        .select({ cnt: count() })
        .from(tradeSignals)
        .where(
          and(
            eq(tradeSignals.userId, userId),
            eq(tradeSignals.status, 'pending'),
          ),
        )
        .then((rows) => rows[0]?.cnt ?? 0),

      // Circuit breaker state
      getCircuitBreakerState(userId),
    ]);

  const tradingMode = riskProfile?.executionMode ?? 'paper';
  const maxTradesPerDay = riskProfile?.maxTradesPerDay ?? 5;
  const isPaper = tradingMode === 'paper';

  // -------------------------------------------------------------------------
  // Fetch current prices for open positions
  // For live mode: attempt authenticated CCXT fetchBalance + fetchTicker per symbol.
  // For paper mode: skip balance fetch; still fetch public ticker for unrealized P&L.
  // -------------------------------------------------------------------------

  // In paper mode, equity is computed below (starting balance + realized + unrealized)
  // once unrealizedPnl has been accumulated; no exchange API call needed.
  let equity: number | null = null;
  let unrealizedPnl = 0;

  // Group open positions by (marketType, symbol) — a symbol can be open as
  // both spot and swap if the user changed their market-type setting between
  // trades — for batch ticker fetch.
  const uniquePairs = [
    ...new Map(
      openPositionRows
        .filter((p) => p.symbol)
        .map((p) => {
          const marketType = (p.marketType as MarketType) ?? 'spot';
          return [`${marketType}::${p.symbol}`, { marketType, symbol: p.symbol }] as const;
        }),
    ).values(),
  ];
  const tickerMap = new Map<string, number>(); // "marketType::symbol" -> last price

  const profileMarketType = (riskProfile?.marketType as MarketType) ?? 'spot';

  // Live-mode balance fetch must not depend on having open positions — a
  // freshly-connected live exchange with zero positions should still show
  // its real balance instead of "N/A".
  let exchangeClient: Exchange | null = null;
  if (!isPaper) {
    const resolved = await getUserActiveExchangeClient(userId).catch(() => null);
    if (resolved) {
      exchangeClient = resolved.client;
      configureMarketType(exchangeClient, resolved.exchangeName, profileMarketType);
      try {
        const balance = await exchangeClient.fetchBalance();
        const usdtTotal = extractUsdtBalance(balance);
        if (usdtTotal !== null) equity = usdtTotal;
      } catch {
        // Exchange fetch failed — leave equity as null
      }
    }
  }

  if (uniquePairs.length > 0) {
    // For live mode: reuse the authenticated client above.
    // For paper mode (or missing/invalid live credentials): use a public
    // (unauthenticated) client so ticker data is still available.
    const firstExchange = openPositionRows[0]?.exchangeName;
    const publicExchange =
      firstExchange
        ? (() => {
            const ExClass = (ccxt as unknown as Record<string, new (c: object) => Exchange>)[firstExchange];
            return ExClass ? new ExClass({}) : null;
          })()
        : null;

    const client = exchangeClient ?? publicExchange;

    if (client) {
      // Fetch tickers in parallel; skip any that fail
      await Promise.allSettled(
        uniquePairs.map(async (pair) => {
          try {
            const ticker = await client.fetchTicker(toExchangeSymbol(pair.symbol, pair.marketType));
            if (ticker.last) tickerMap.set(`${pair.marketType}::${pair.symbol}`, ticker.last);
          } catch {
            // individual symbol failure — skip silently
          }
        }),
      );
    }
  }

  // Build enriched open positions + compute unrealized P&L
  const openPositions = openPositionRows.map((pos) => {
    const entryPrice = pos.entryPrice ? parseFloat(pos.entryPrice) : null;
    const positionSize = pos.positionSize ? parseFloat(pos.positionSize) : null;
    const posMarketType = (pos.marketType as MarketType) ?? 'spot';
    const currentPrice = pos.symbol ? (tickerMap.get(`${posMarketType}::${pos.symbol}`) ?? null) : null;
    const direction = (pos.direction ?? 'LONG') as 'LONG' | 'SHORT';

    let unrealizedPnlUsd: number | null = null;
    let unrealizedPnlPct: number | null = null;

    if (entryPrice && positionSize && currentPrice) {
      unrealizedPnlUsd = computePnlUsd(entryPrice, currentPrice, positionSize, direction);
      unrealizedPnlPct = computePnlPct(entryPrice, currentPrice, positionSize, direction);
      unrealizedPnl += unrealizedPnlUsd;
    }

    return {
      id: pos.id,
      symbol: pos.symbol,
      direction,
      exchangeName: pos.exchangeName,
      entryPrice,
      currentPrice,
      positionSize,
      leverage: pos.leverage ?? 1,
      unrealizedPnlUsd,
      unrealizedPnlPct,
      stopLoss: pos.stopLoss ? parseFloat(pos.stopLoss) : null,
      takeProfit: pos.takeProfit ? parseFloat(pos.takeProfit) : null,
      mode: pos.mode ?? 'paper',
      entryAt: pos.entryAt,
    };
  });

  if (isPaper) {
    equity =
      Number(riskProfile?.paperBalanceUsd ?? '10000.00') +
      parseFloat(realizedAllTime) +
      unrealizedPnl;
  }

  return NextResponse.json({
    tradingMode,
    isPaper,
    equity,
    realizedPnlToday: parseFloat(closedToday.realizedPnlToday),
    unrealizedPnl,
    tradesToday: closedToday.tradesToday,
    maxTradesPerDay,
    openPositions,
    pendingSignalsCount: pendingCountRow,
    circuitBreaker,
  });
}
