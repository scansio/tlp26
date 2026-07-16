/**
 * PATCH /api/positions/[id]
 *
 * Manage an open trade execution. Supported actions:
 *  - close          : Market-close the full position
 *  - partial_close  : Close pct% of position at market (body: { action, pct: number })
 *  - breakeven      : Move stop-loss to entry price
 *  - adjust         : Update stop-loss and/or take-profit (body: { action, sl?, tp? })
 *
 * Paper mode: DB-only updates with current ticker price for P&L.
 * Live mode : Executes CCXT market order for close/partial_close; DB-only for SL/TP changes
 *             (the position monitor enforces the updated levels).
 */

import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import ccxt, { type Exchange } from 'ccxt';
import { db } from '@/db';
import { tradeExecutions, tradeSignals, userExchanges } from '@/db/schema';
import { decrypt } from '@/lib/crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getCurrentPrice(exchangeName: string, symbol: string): Promise<number | null> {
  try {
    const ExClass = (ccxt as unknown as Record<string, new (c: object) => Exchange>)[exchangeName];
    if (!ExClass) return null;
    const client = new ExClass({});
    const ticker = await client.fetchTicker(symbol);
    return ticker.last ?? null;
  } catch {
    return null;
  }
}

async function getExchangeClient(
  userId: string,
  exchangeName: string,
): Promise<Exchange | null> {
  const rows = await db
    .select({
      encryptedApiKey: userExchanges.encryptedApiKey,
      encryptedApiSecret: userExchanges.encryptedApiSecret,
      encryptedPassphrase: userExchanges.encryptedPassphrase,
    })
    .from(userExchanges)
    .where(
      and(
        eq(userExchanges.userId, userId),
        eq(userExchanges.exchangeName, exchangeName),
        eq(userExchanges.status, 'active'),
      ),
    )
    .limit(1);

  if (!rows[0]) return null;
  try {
    const { encryptedApiKey, encryptedApiSecret, encryptedPassphrase } = rows[0];
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

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const body = (await req.json()) as {
    action: 'close' | 'partial_close' | 'breakeven' | 'adjust';
    pct?: number;
    sl?: number;
    tp?: number;
  };

  // Fetch the execution with its linked signal
  const rows = await db
    .select({
      id: tradeExecutions.id,
      userId: tradeExecutions.userId,
      symbol: tradeExecutions.symbol,
      exchangeName: tradeExecutions.exchangeName,
      entryPrice: tradeExecutions.entryPrice,
      positionSize: tradeExecutions.positionSize,
      mode: tradeExecutions.mode,
      status: tradeExecutions.status,
      signalId: tradeExecutions.signalId,
      direction: tradeSignals.direction,
    })
    .from(tradeExecutions)
    .leftJoin(tradeSignals, eq(tradeExecutions.signalId, tradeSignals.id))
    .where(and(eq(tradeExecutions.id, id), eq(tradeExecutions.userId, userId)))
    .limit(1);

  const exec = rows[0];
  if (!exec) return NextResponse.json({ error: 'Position not found' }, { status: 404 });
  if (exec.status !== 'open') return NextResponse.json({ error: 'Position is not open' }, { status: 409 });

  const entryPrice = exec.entryPrice ? parseFloat(exec.entryPrice) : null;
  const positionSize = exec.positionSize ? parseFloat(exec.positionSize) : null;
  const direction = (exec.direction ?? 'LONG') as 'LONG' | 'SHORT';
  const isLive = exec.mode === 'live';

  // ---------------------------------------------------------------------------
  // CLOSE / PARTIAL_CLOSE
  // ---------------------------------------------------------------------------
  if (body.action === 'close' || body.action === 'partial_close') {
    const pct = body.action === 'partial_close' ? (body.pct ?? 100) : 100;
    const clampedPct = Math.max(1, Math.min(100, pct));
    const isFull = clampedPct >= 100;

    let exitPrice: number | null = null;

    if (isLive) {
      const client = await getExchangeClient(userId, exec.exchangeName);
      if (!client) {
        return NextResponse.json({ error: `No active credentials for ${exec.exchangeName}` }, { status: 422 });
      }

      const closeSize = positionSize ? positionSize * (clampedPct / 100) : 0;
      if (closeSize <= 0) {
        return NextResponse.json({ error: 'Cannot determine position size' }, { status: 422 });
      }

      const closeSide = direction === 'LONG' ? 'sell' : 'buy';
      try {
        const order = await client.createOrder(exec.symbol, 'market', closeSide, closeSize);
        exitPrice = order.average ?? order.price ?? null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: `Exchange order failed: ${msg}` }, { status: 502 });
      }
    } else {
      exitPrice = await getCurrentPrice(exec.exchangeName, exec.symbol);
    }

    if (!exitPrice) {
      return NextResponse.json({ error: 'Could not determine exit price' }, { status: 502 });
    }

    let realizedPnl: number | null = null;
    if (entryPrice && positionSize) {
      const closedSize = positionSize * (clampedPct / 100);
      const raw = (exitPrice - entryPrice) * closedSize;
      realizedPnl = direction === 'LONG' ? raw : -raw;
    }

    if (isFull) {
      await db
        .update(tradeExecutions)
        .set({
          exitPrice: String(exitPrice),
          exitAt: new Date(),
          status: 'closed',
          fillType: 'manual',
          realizedPnl: realizedPnl !== null ? String(realizedPnl) : undefined,
        })
        .where(eq(tradeExecutions.id, id));
    } else {
      // Partial: reduce position size, keep status open
      const newSize = positionSize ? positionSize * (1 - clampedPct / 100) : null;
      await db
        .update(tradeExecutions)
        .set({ positionSize: newSize !== null ? String(newSize) : undefined })
        .where(eq(tradeExecutions.id, id));
    }

    return NextResponse.json({
      success: true,
      action: body.action,
      exitPrice,
      realizedPnl,
      closed: isFull,
      message: isFull
        ? `Position closed at $${exitPrice.toFixed(4)}`
        : `Closed ${clampedPct}% at $${exitPrice.toFixed(4)}`,
    });
  }

  // ---------------------------------------------------------------------------
  // BREAKEVEN — move SL to entry price
  // ---------------------------------------------------------------------------
  if (body.action === 'breakeven') {
    if (!entryPrice) {
      return NextResponse.json({ error: 'Entry price not recorded' }, { status: 422 });
    }
    if (!exec.signalId) {
      return NextResponse.json({ error: 'No linked signal to update SL on' }, { status: 422 });
    }

    await db
      .update(tradeSignals)
      .set({ stopLoss: String(entryPrice), updatedAt: new Date() })
      .where(eq(tradeSignals.id, exec.signalId));

    // Also reset trailing SL to entry so the ratchet starts fresh from breakeven
    await db
      .update(tradeExecutions)
      .set({ trailSlPrice: String(entryPrice) })
      .where(eq(tradeExecutions.id, id));

    return NextResponse.json({
      success: true,
      action: 'breakeven',
      newSl: entryPrice,
      message: `Stop-loss moved to breakeven ($${entryPrice.toFixed(4)})`,
    });
  }

  // ---------------------------------------------------------------------------
  // ADJUST SL / TP
  // ---------------------------------------------------------------------------
  if (body.action === 'adjust') {
    if (body.sl === undefined && body.tp === undefined) {
      return NextResponse.json({ error: 'Provide sl and/or tp to adjust' }, { status: 400 });
    }
    if (!exec.signalId) {
      return NextResponse.json({ error: 'No linked signal to update' }, { status: 422 });
    }

    await db
      .update(tradeSignals)
      .set({
        ...(body.sl !== undefined ? { stopLoss: String(body.sl) } : {}),
        ...(body.tp !== undefined ? { takeProfit: String(body.tp) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(tradeSignals.id, exec.signalId));

    return NextResponse.json({
      success: true,
      action: 'adjust',
      newSl: body.sl ?? null,
      newTp: body.tp ?? null,
      message: 'Levels updated',
    });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
