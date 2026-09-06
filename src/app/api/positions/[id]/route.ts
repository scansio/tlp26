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
import { computePnlUsd } from '@/lib/pnl';
import { toExchangeSymbol, resolveHedgeMode, type MarketType } from '@/mastra/tools/market-symbol';
import { resolveSignalExitMode } from '@/lib/exit-config';
import { placeProtectiveOrders, cancelProtectiveOrders } from '@/lib/protective-orders';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getCurrentPrice(
  exchangeName: string,
  symbol: string,
  marketType: MarketType = 'spot',
): Promise<number | null> {
  try {
    const ExClass = (ccxt as unknown as Record<string, new (c: object) => Exchange>)[exchangeName];
    if (!ExClass) return null;
    const client = new ExClass({});
    const ticker = await client.fetchTicker(toExchangeSymbol(symbol, marketType));
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

/**
 * Cancel the old resting order (if any) and place a new one at `newPrice`,
 * sized for the position's current remaining amount. Used whenever a live,
 * fixed-mode position's SL or TP level changes so the exchange-side backstop
 * stays in sync with what the DB says the level is — otherwise it goes stale
 * and could fire at the wrong price or not at all.
 */
async function replaceRestingOrder(
  client: Exchange,
  symbol: string,
  marketType: MarketType,
  direction: 'LONG' | 'SHORT',
  amount: number,
  kind: 'sl' | 'tp',
  oldOrderId: string | null,
  newPrice: number,
): Promise<string | null> {
  if (oldOrderId) {
    await cancelProtectiveOrders(client, symbol, marketType, [oldOrderId]);
  }
  const hedged = marketType === 'swap' ? await resolveHedgeMode(client, toExchangeSymbol(symbol, marketType)) : false;
  const result = await placeProtectiveOrders({
    client,
    symbol,
    marketType,
    direction,
    amount,
    stopLossPrice: kind === 'sl' ? newPrice : null,
    takeProfitPrice: kind === 'tp' ? newPrice : null,
    hedged,
  });
  if (result.errors.length > 0) {
    console.error(`[positions/[id]] Failed to replace resting ${kind} order:`, result.errors.join('; '));
  }
  return kind === 'sl' ? result.slOrderId : result.tpOrderId;
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
      stopLoss: tradeSignals.stopLoss,
      takeProfit: tradeSignals.takeProfit,
      marketType: tradeExecutions.marketType,
      contractSize: tradeExecutions.contractSize,
      slOrderId: tradeExecutions.slOrderId,
      tpOrderId: tradeExecutions.tpOrderId,
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
  const marketType = (exec.marketType as MarketType) ?? 'spot';
  const exchangeSymbol = toExchangeSymbol(exec.symbol, marketType);
  const contractSize = exec.contractSize ? parseFloat(exec.contractSize) : 1;

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
      const closeAmount = marketType === 'swap' ? closeSize / contractSize : closeSize;
      const hedged = marketType === 'swap' ? await resolveHedgeMode(client, exchangeSymbol) : false;
      try {
        const order = await client.createOrder(
          exchangeSymbol,
          'market',
          closeSide,
          closeAmount,
          undefined,
          marketType === 'swap' ? { reduceOnly: true, ...(hedged ? { hedged: true } : {}) } : undefined,
        );
        exitPrice = order.average ?? order.price ?? null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: `Exchange order failed: ${msg}` }, { status: 502 });
      }
    } else {
      exitPrice = await getCurrentPrice(exec.exchangeName, exec.symbol, marketType);
    }

    if (!exitPrice) {
      return NextResponse.json({ error: 'Could not determine exit price' }, { status: 502 });
    }

    let realizedPnl: number | null = null;
    if (entryPrice && positionSize) {
      const closedSize = positionSize * (clampedPct / 100);
      realizedPnl = computePnlUsd(entryPrice, exitPrice, closedSize, direction);
    }

    let restingOrderWarning = '';

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

      // Position is flat — any resting protective orders are now stale.
      if (isLive && (exec.slOrderId || exec.tpOrderId)) {
        const client = await getExchangeClient(userId, exec.exchangeName);
        if (client) {
          await cancelProtectiveOrders(client, exec.symbol, marketType, [exec.slOrderId, exec.tpOrderId]);
        }
      }
    } else {
      // Partial: reduce position size, keep status open
      const newSize = positionSize ? positionSize * (1 - clampedPct / 100) : null;
      await db
        .update(tradeExecutions)
        .set({ positionSize: newSize !== null ? String(newSize) : undefined })
        .where(eq(tradeExecutions.id, id));

      // Resting protective orders were sized for the original (larger) position —
      // resize them to match what remains, otherwise they overhang the new size.
      if (isLive && newSize !== null && (exec.slOrderId || exec.tpOrderId)) {
        const exitMode = await resolveSignalExitMode(userId, exec.signalId);
        if (exitMode !== 'trailing') {
          const client = await getExchangeClient(userId, exec.exchangeName);
          if (client) {
            const newAmount = marketType === 'swap' ? newSize / contractSize : newSize;
            const [signal] = exec.signalId
              ? await db
                  .select({ stopLoss: tradeSignals.stopLoss, takeProfit: tradeSignals.takeProfit })
                  .from(tradeSignals)
                  .where(eq(tradeSignals.id, exec.signalId))
                  .limit(1)
              : [undefined];

            const updates: { slOrderId?: string | null; tpOrderId?: string | null } = {};
            const failures: string[] = [];
            if (exec.slOrderId && signal?.stopLoss) {
              updates.slOrderId = await replaceRestingOrder(
                client, exec.symbol, marketType, direction, newAmount, 'sl', exec.slOrderId, parseFloat(signal.stopLoss),
              );
              if (!updates.slOrderId) failures.push('SL');
            }
            if (exec.tpOrderId && signal?.takeProfit) {
              updates.tpOrderId = await replaceRestingOrder(
                client, exec.symbol, marketType, direction, newAmount, 'tp', exec.tpOrderId, parseFloat(signal.takeProfit),
              );
              if (!updates.tpOrderId) failures.push('TP');
            }
            if (Object.keys(updates).length > 0) {
              await db.update(tradeExecutions).set(updates).where(eq(tradeExecutions.id, id));
            }
            if (failures.length > 0) {
              // The old resting order(s) were already cancelled before this replace
              // attempt — a failure here leaves the position with NO exchange-side
              // backstop for those levels, not just a stale one. Must not be silent.
              restingOrderWarning = ` WARNING: failed to resize the resting exchange-side ${failures.join('/')} order — the position has no exchange-side backstop for ${failures.length > 1 ? 'these levels' : 'this level'} until corrected.`;
            }
          } else {
            restingOrderWarning = ' WARNING: no exchange credentials available to resize the resting order(s).';
          }
        } else if (exec.slOrderId) {
          // Trailing position with a profit-lock resting order (see position-monitor.ts):
          // it was sized for the pre-partial-close position. Rather than resize it here,
          // cancel it and clear the sync marker — the next profit-lock cycle re-establishes
          // it at the correct (new) size once trailSlPrice next improves.
          const client = await getExchangeClient(userId, exec.exchangeName);
          if (client) {
            await cancelProtectiveOrders(client, exec.symbol, marketType, [exec.slOrderId]);
          }
          await db
            .update(tradeExecutions)
            .set({ slOrderId: null, profitLockSyncedPrice: null })
            .where(eq(tradeExecutions.id, id));
        }
      }
    }

    return NextResponse.json({
      success: true,
      action: body.action,
      exitPrice,
      realizedPnl,
      closed: isFull,
      message: (isFull
        ? `Position closed at $${exitPrice.toFixed(4)}`
        : `Closed ${clampedPct}% at $${exitPrice.toFixed(4)}`) + restingOrderWarning,
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

    // Fixed-mode live positions have a resting SL order — it must move too,
    // otherwise the exchange keeps enforcing the old (pre-breakeven) level.
    let restingOrderWarning = '';
    if (isLive && positionSize) {
      const exitMode = await resolveSignalExitMode(userId, exec.signalId);
      if (exitMode !== 'trailing') {
        const client = await getExchangeClient(userId, exec.exchangeName);
        if (client) {
          const amount = marketType === 'swap' ? positionSize / contractSize : positionSize;
          const newSlOrderId = await replaceRestingOrder(
            client, exec.symbol, marketType, direction, amount, 'sl', exec.slOrderId, entryPrice,
          );
          await db.update(tradeExecutions).set({ slOrderId: newSlOrderId }).where(eq(tradeExecutions.id, id));
          if (!newSlOrderId) {
            restingOrderWarning = ' WARNING: failed to move the resting exchange-side SL order — only the software monitor enforces breakeven until this is corrected.';
          }
        } else {
          restingOrderWarning = ' WARNING: no exchange credentials available to move the resting SL order.';
        }
      } else if (exec.slOrderId) {
        // Trailing position with a profit-lock resting order: breakeven just reset
        // trailSlPrice back to entry in the DB, which no longer matches the level
        // that resting order sits at. Cancel it — the profit-lock cycle re-places
        // one once trailSlPrice next ratchets past entry again.
        const client = await getExchangeClient(userId, exec.exchangeName);
        if (client) {
          await cancelProtectiveOrders(client, exec.symbol, marketType, [exec.slOrderId]);
        }
        await db
          .update(tradeExecutions)
          .set({ slOrderId: null, profitLockSyncedPrice: null })
          .where(eq(tradeExecutions.id, id));
      }
    }

    return NextResponse.json({
      success: true,
      action: 'breakeven',
      newSl: entryPrice,
      message: `Stop-loss moved to breakeven ($${entryPrice.toFixed(4)})${restingOrderWarning}`,
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

    // Fixed-mode live positions have resting SL/TP orders on the exchange —
    // whichever level changed must move there too, or the exchange keeps
    // enforcing the old price while the DB reports the new one.
    let restingOrderWarning = '';
    if (isLive && positionSize) {
      const exitMode = await resolveSignalExitMode(userId, exec.signalId);
      if (exitMode !== 'trailing') {
        const client = await getExchangeClient(userId, exec.exchangeName);
        if (client) {
          const amount = marketType === 'swap' ? positionSize / contractSize : positionSize;
          const updates: { slOrderId?: string | null; tpOrderId?: string | null } = {};
          const failures: string[] = [];

          if (body.sl !== undefined) {
            const newSlOrderId = await replaceRestingOrder(
              client, exec.symbol, marketType, direction, amount, 'sl', exec.slOrderId, body.sl,
            );
            updates.slOrderId = newSlOrderId;
            if (!newSlOrderId) failures.push('SL');
          }
          if (body.tp !== undefined) {
            const newTpOrderId = await replaceRestingOrder(
              client, exec.symbol, marketType, direction, amount, 'tp', exec.tpOrderId, body.tp,
            );
            updates.tpOrderId = newTpOrderId;
            if (!newTpOrderId) failures.push('TP');
          }

          await db.update(tradeExecutions).set(updates).where(eq(tradeExecutions.id, id));
          if (failures.length > 0) {
            restingOrderWarning = ` WARNING: failed to move the resting exchange-side ${failures.join('/')} order — only the software monitor enforces the new level(s) until this is corrected.`;
          }
        } else {
          restingOrderWarning = ' WARNING: no exchange credentials available to move the resting order(s).';
        }
      } else if (exec.slOrderId) {
        // Trailing position with a profit-lock resting order: the manual SL/TP
        // override on trade_signals no longer corresponds to what that resting
        // order reflects. Cancel it — the profit-lock cycle re-places one from
        // trailSlPrice on its own next cycle if/when appropriate.
        const client = await getExchangeClient(userId, exec.exchangeName);
        if (client) {
          await cancelProtectiveOrders(client, exec.symbol, marketType, [exec.slOrderId]);
        }
        await db
          .update(tradeExecutions)
          .set({ slOrderId: null, profitLockSyncedPrice: null })
          .where(eq(tradeExecutions.id, id));
      }
    }

    return NextResponse.json({
      success: true,
      action: 'adjust',
      newSl: body.sl ?? null,
      newTp: body.tp ?? null,
      message: `Levels updated${restingOrderWarning}`,
    });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
