/**
 * Resting SL/TP order helpers — the exchange-side backstop for fixed-mode
 * live positions. These orders sit on the exchange and fire even if this
 * application's monitor process is down; position-monitor.ts is still
 * responsible for detecting fills (or reconciling ones that happened while
 * offline) and cancelling whichever sibling order didn't fire.
 *
 * Trailing-mode positions also get a resting SL placed here at entry, as
 * pre-activation protection — position-monitor.ts cancels it the moment the
 * trail activates and the software ratchet takes over. They never get a
 * resting TP: reaching the initial TP must convert to trailing-TP-active,
 * not fire a market close, and a resting order can't be intercepted before
 * it fills (see position-monitor.ts header).
 */

import type { Exchange } from 'ccxt';
import { toExchangeSymbol, type MarketType } from '@/mastra/tools/market-symbol';

export interface ProtectiveOrderParams {
  client: Exchange;
  symbol: string; // human "BASE/QUOTE"
  marketType: MarketType;
  direction: string; // 'LONG' | 'SHORT' — the position's direction
  amount: number; // base units (spot) or contracts (swap) — already resolved by caller
  stopLossPrice: number | null;
  takeProfitPrice: number | null;
  hedged?: boolean; // account is in dual-side/hedge position mode — see resolveHedgeMode()
}

export interface ProtectiveOrderResult {
  slOrderId: string | null;
  tpOrderId: string | null;
  errors: string[];
}

/**
 * Place resting reduceOnly stop-loss / take-profit orders via CCXT's unified
 * createStopLossOrder/createTakeProfitOrder (confirmed supported on binance,
 * bybit, bingx). Placed independently — most exchanges' unified API has no
 * true OCO, so the caller must cancel the sibling once one fills.
 */
export async function placeProtectiveOrders(
  params: ProtectiveOrderParams,
): Promise<ProtectiveOrderResult> {
  const { client, symbol, marketType, direction, amount, stopLossPrice, takeProfitPrice, hedged } = params;
  const exchangeSymbol = toExchangeSymbol(symbol, marketType);
  const closeSide = direction === 'LONG' ? 'sell' : 'buy';
  const reduceOnlyParams =
    marketType === 'swap' ? { reduceOnly: true, ...(hedged ? { hedged: true } : {}) } : {};

  const errors: string[] = [];
  let slOrderId: string | null = null;
  let tpOrderId: string | null = null;

  if (stopLossPrice) {
    try {
      const order = await client.createStopLossOrder(
        exchangeSymbol, 'market', closeSide, amount, undefined, stopLossPrice, reduceOnlyParams,
      );
      slOrderId = order.id ?? null;
    } catch (err) {
      errors.push(`stop-loss order failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (takeProfitPrice) {
    try {
      const order = await client.createTakeProfitOrder(
        exchangeSymbol, 'market', closeSide, amount, undefined, takeProfitPrice, reduceOnlyParams,
      );
      tpOrderId = order.id ?? null;
    } catch (err) {
      errors.push(`take-profit order failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { slOrderId, tpOrderId, errors };
}

/**
 * Best-effort cancel of resting protective orders. Swallows "already
 * filled"/"not found"/"already cancelled" errors — that's the expected
 * outcome once a position has closed by any means, not a failure to log.
 */
export async function cancelProtectiveOrders(
  client: Exchange,
  symbol: string,
  marketType: MarketType,
  orderIds: Array<string | null | undefined>,
): Promise<void> {
  const exchangeSymbol = toExchangeSymbol(symbol, marketType);
  for (const orderId of orderIds) {
    if (!orderId) continue;
    try {
      await client.cancelOrder(orderId, exchangeSymbol);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/not found|already|does not exist|unknown order/i.test(msg)) {
        console.error(`[protective-orders] Failed to cancel order ${orderId} on ${exchangeSymbol}: ${msg}`);
      }
    }
  }
}
