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
 * Paper mode: equity is shown as N/A; unrealized P&L is estimated from entry prices only.
 */

import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { and, count, eq, gte, sql } from 'drizzle-orm';
import ccxt, { type Exchange } from 'ccxt';
import { db } from '@/db';
import {
  userExchanges,
  userRiskProfiles,
  tradeExecutions,
  tradeSignals,
} from '@/db/schema';
import { decrypt } from '@/lib/crypto';
import { getCircuitBreakerState } from '@/lib/circuit-breaker';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function startOfUtcDay(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
}

async function getExchangeClient(userId: string): Promise<Exchange | null> {
  const rows = await db
    .select({
      exchangeName: userExchanges.exchangeName,
      encryptedApiKey: userExchanges.encryptedApiKey,
      encryptedApiSecret: userExchanges.encryptedApiSecret,
      encryptedPassphrase: userExchanges.encryptedPassphrase,
    })
    .from(userExchanges)
    .where(
      and(
        eq(userExchanges.userId, userId),
        eq(userExchanges.status, 'active'),
      ),
    )
    .limit(1);

  if (!rows[0]) return null;

  const { exchangeName, encryptedApiKey, encryptedApiSecret, encryptedPassphrase } = rows[0];

  let apiKey: string;
  let secret: string;
  let password: string | undefined;

  try {
    apiKey = decrypt(encryptedApiKey);
    secret = decrypt(encryptedApiSecret);
    password = encryptedPassphrase ? decrypt(encryptedPassphrase) : undefined;
  } catch {
    return null;
  }

  const ExchangeClass = (ccxt as unknown as Record<string, new (config: object) => Exchange>)[exchangeName];
  if (!ExchangeClass) return null;

  return new ExchangeClass({
    apiKey,
    secret,
    ...(password ? { password } : {}),
  });
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
  const [riskProfile, openPositionRows, closedToday, pendingCountRow, circuitBreaker] =
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
          direction: tradeSignals.direction,
          stopLoss: tradeSignals.stopLoss,
          takeProfit: tradeSignals.takeProfit,
          entryAt: tradeExecutions.entryAt,
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

  let equity: number | null = null;
  let unrealizedPnl = 0;

  // Deduplicate symbols for batch ticker fetch
  const uniqueSymbols = [...new Set(openPositionRows.map((p) => p.symbol).filter(Boolean))];
  const tickerMap = new Map<string, number>(); // symbol -> last price

  if (uniqueSymbols.length > 0) {
    // For live mode: try authenticated client first; fall back to public on error.
    // For paper mode: always use public (unauthenticated) client.
    let exchangeClient: Exchange | null = null;

    if (!isPaper) {
      exchangeClient = await getExchangeClient(userId).catch(() => null);
    }

    // If we still have no client (paper mode or credentials missing), use first open
    // position's exchange with no auth for public ticker data
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
        uniqueSymbols.map(async (symbol) => {
          try {
            const ticker = await client.fetchTicker(symbol);
            if (ticker.last) tickerMap.set(symbol, ticker.last);
          } catch {
            // individual symbol failure — skip silently
          }
        }),
      );

      // Fetch balance for live mode equity
      if (!isPaper && exchangeClient) {
        try {
          const balance = await exchangeClient.fetchBalance();
          // Total equity = total USDT/USDC free + used (including margin)
          const usdtTotal =
            (balance['USDT']?.total ?? 0) +
            (balance['USDC']?.total ?? 0) +
            (balance['USD']?.total ?? 0);
          if (usdtTotal > 0) equity = usdtTotal;
        } catch {
          // Exchange fetch failed — leave equity as null
        }
      }
    }
  }

  // Build enriched open positions + compute unrealized P&L
  const openPositions = openPositionRows.map((pos) => {
    const entryPrice = pos.entryPrice ? parseFloat(pos.entryPrice) : null;
    const positionSize = pos.positionSize ? parseFloat(pos.positionSize) : null;
    const currentPrice = pos.symbol ? (tickerMap.get(pos.symbol) ?? null) : null;

    let unrealizedPnlUsd: number | null = null;
    let unrealizedPnlPct: number | null = null;

    if (entryPrice && positionSize && currentPrice) {
      unrealizedPnlUsd = (currentPrice - entryPrice) * positionSize;
      unrealizedPnlPct = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : null;
      unrealizedPnl += unrealizedPnlUsd;
    }

    return {
      id: pos.id,
      symbol: pos.symbol,
      direction: (pos.direction ?? 'LONG') as 'LONG' | 'SHORT',
      entryPrice,
      currentPrice,
      positionSize,
      unrealizedPnlUsd,
      unrealizedPnlPct,
      stopLoss: pos.stopLoss ? parseFloat(pos.stopLoss) : null,
      takeProfit: pos.takeProfit ? parseFloat(pos.takeProfit) : null,
      mode: pos.mode ?? 'paper',
      entryAt: pos.entryAt,
    };
  });

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
