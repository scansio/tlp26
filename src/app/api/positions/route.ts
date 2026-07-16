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
import ccxt, { type Exchange } from 'ccxt';
import { db } from '@/db';
import { userExchanges, tradeExecutions, tradeSignals } from '@/db/schema';
import { decrypt } from '@/lib/crypto';

async function getExchangeClient(userId: string): Promise<Exchange | null> {
  const rows = await db
    .select({
      exchangeName: userExchanges.exchangeName,
      encryptedApiKey: userExchanges.encryptedApiKey,
      encryptedApiSecret: userExchanges.encryptedApiSecret,
      encryptedPassphrase: userExchanges.encryptedPassphrase,
    })
    .from(userExchanges)
    .where(and(eq(userExchanges.userId, userId), eq(userExchanges.status, 'active')))
    .limit(1);

  if (!rows[0]) return null;
  const { exchangeName, encryptedApiKey, encryptedApiSecret, encryptedPassphrase } = rows[0];

  try {
    const apiKey = decrypt(encryptedApiKey);
    const secret = decrypt(encryptedApiSecret);
    const password = encryptedPassphrase ? decrypt(encryptedPassphrase) : undefined;
    const ExClass = (ccxt as unknown as Record<string, new (c: object) => Exchange>)[exchangeName];
    if (!ExClass) return null;
    return new ExClass({ apiKey, secret, ...(password ? { password } : {}) });
  } catch {
    return null;
  }
}

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
      entryAt: tradeExecutions.entryAt,
      direction: tradeSignals.direction,
      stopLoss: tradeSignals.stopLoss,
      takeProfit: tradeSignals.takeProfit,
    })
    .from(tradeExecutions)
    .leftJoin(tradeSignals, eq(tradeExecutions.signalId, tradeSignals.id))
    .where(and(eq(tradeExecutions.userId, userId), eq(tradeExecutions.status, 'open')));

  // Fetch live prices
  const uniqueSymbols = [...new Set(rows.map((r) => r.symbol).filter(Boolean))];
  const tickerMap = new Map<string, number>();

  if (uniqueSymbols.length > 0) {
    const isPaper = rows.every((r) => r.mode === 'paper');
    let client: Exchange | null = null;

    if (!isPaper) {
      client = await getExchangeClient(userId).catch(() => null);
    }

    if (!client) {
      const firstExchange = rows[0]?.exchangeName;
      if (firstExchange) {
        const ExClass = (ccxt as unknown as Record<string, new (c: object) => Exchange>)[firstExchange];
        if (ExClass) client = new ExClass({});
      }
    }

    if (client) {
      await Promise.allSettled(
        uniqueSymbols.map(async (symbol) => {
          try {
            const ticker = await (client as Exchange).fetchTicker(symbol);
            if (ticker.last) tickerMap.set(symbol, ticker.last);
          } catch { /* skip */ }
        }),
      );
    }
  }

  const positions = rows.map((pos) => {
    const entryPrice = pos.entryPrice ? parseFloat(pos.entryPrice) : null;
    const positionSize = pos.positionSize ? parseFloat(pos.positionSize) : null;
    const currentPrice = pos.symbol ? (tickerMap.get(pos.symbol) ?? null) : null;
    const direction = (pos.direction ?? 'LONG') as 'LONG' | 'SHORT';

    let unrealizedPnlUsd: number | null = null;
    let unrealizedPnlPct: number | null = null;

    if (entryPrice && positionSize && currentPrice) {
      const raw = (currentPrice - entryPrice) * positionSize;
      unrealizedPnlUsd = direction === 'LONG' ? raw : -raw;
      unrealizedPnlPct = entryPrice > 0 ? (unrealizedPnlUsd / (entryPrice * positionSize)) * 100 : null;
    }

    return {
      id: pos.id,
      symbol: pos.symbol,
      direction,
      exchangeName: pos.exchangeName,
      mode: pos.mode ?? 'paper',
      entryPrice,
      currentPrice,
      positionSize,
      unrealizedPnlUsd,
      unrealizedPnlPct,
      stopLoss: pos.stopLoss ? parseFloat(pos.stopLoss) : null,
      takeProfit: pos.takeProfit ? parseFloat(pos.takeProfit) : null,
      entryAt: pos.entryAt?.toISOString() ?? null,
    };
  });

  return NextResponse.json({ positions });
}
