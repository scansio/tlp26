/**
 * Shared "entry should be entry" logic — signals carry an entryPrice that is
 * often a target zone away from the current market price (SMC retest/order
 * block entries — see trading-agent.ts), not a live snapshot. Live orders are
 * therefore placed as resting LIMIT orders at entryPrice rather than market
 * orders, and paper mode simulates the same semantics.
 *
 * A signal moves pending -> approved (order resting, awaiting fill) instead
 * of straight to executed when the entry doesn't fill immediately. Used by:
 *  - execute-trade-tool.ts (auto-mode + immediate manual-approval fills)
 *  - /api/trade-signals/[id] (manual approve/cancel)
 *  - /api/cron/reconcile-entries (polls resting orders/prices to completion)
 *  - /api/cron/expire-signals (cancels resting orders on expiry)
 */

import ccxt, { type Exchange, type Order } from 'ccxt';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { tradeExecutions, tradeSignals, userExchanges } from '@/db/schema';
import { decrypt } from '@/lib/crypto';
import { and } from 'drizzle-orm';
import { toExchangeSymbol, type MarketType } from '@/mastra/tools/market-symbol';
import { placeProtectiveOrders } from '@/lib/protective-orders';
import { resolveSignalExitMode } from '@/lib/exit-config';

export type ExchangeName = 'binance' | 'bybit' | 'bingx';

// ---------------------------------------------------------------------------
// Marketability — mirrors real limit-order semantics: a LONG (buy) limit
// fills once price drops to/through entryPrice; a SHORT (sell) limit fills
// once price rises to/through entryPrice. True regardless of which side of
// the current price the entry zone sits on (pullback or breakout entries).
// ---------------------------------------------------------------------------
export function isLimitMarketable(direction: string, entryPrice: number, currentPrice: number): boolean {
  return direction === 'LONG' ? currentPrice <= entryPrice : currentPrice >= entryPrice;
}

/**
 * Apply slippage to a simulated market-style fill — only used for the no-entry-target
 * fallback (a signal with no entryPrice at all), where there's no limit price to fill
 * exactly at. A genuine entryPrice fill never slips (see finalizePaperFill callers).
 */
export function applySlippage(price: number, direction: string, slippagePct: number): number {
  const factor = slippagePct / 100;
  return direction === 'LONG' ? price * (1 + factor) : price * (1 - factor);
}

/** Unauthenticated public ticker fetch — used only to check marketability, no API keys needed. */
export async function fetchTickerPrice(
  symbol: string,
  exchangeName: string,
  marketType: MarketType = 'spot',
): Promise<number | null> {
  const name = (exchangeName ?? 'binance').toLowerCase();
  const ExchangeClass = (ccxt as unknown as Record<string, new (c: object) => Exchange>)[name];
  if (!ExchangeClass) return null;
  try {
    const ex = new ExchangeClass({});
    const ticker = await ex.fetchTicker(toExchangeSymbol(symbol, marketType));
    return ticker.last ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Exchange client construction (live mode only)
// ---------------------------------------------------------------------------
async function getExchangeCredentials(
  userId: string,
  exchangeName: string,
): Promise<{ apiKey: string; secret: string; password?: string } | null> {
  const [row] = await db
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

  if (!row) return null;
  return {
    apiKey: decrypt(row.encryptedApiKey),
    secret: decrypt(row.encryptedApiSecret),
    password: row.encryptedPassphrase ? decrypt(row.encryptedPassphrase) : undefined,
  };
}

export async function buildExchangeClient(userId: string, exchangeName: string): Promise<Exchange | null> {
  const creds = await getExchangeCredentials(userId, exchangeName);
  if (!creds) return null;
  const ExchangeClass = (ccxt as unknown as Record<string, new (c: object) => Exchange>)[exchangeName];
  if (!ExchangeClass) return null;
  return new ExchangeClass({
    apiKey: creds.apiKey,
    secret: creds.secret,
    ...(creds.password ? { password: creds.password } : {}),
  });
}

// ---------------------------------------------------------------------------
// Finalize a filled live entry order into a trade_execution + protective
// orders + signal status. Shared by execute-trade-tool.ts's immediate-fill
// path and the reconcile-entries cron's resting-order-filled path.
// ---------------------------------------------------------------------------
export interface FinalizeLiveFillParams {
  client: Exchange;
  order: Order;
  signalId: string;
  userId: string;
  exchange: ExchangeName;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  marketType: MarketType;
  leverage: number;
  marginMode: 'cross' | 'isolated';
  sl: number;
  tp: number;
  contractSize: number | null;
  hedged: boolean;
}

export interface FinalizeFillResult {
  executionId: string;
  fillPrice: number;
  slOrderId: string | null;
  tpOrderId: string | null;
  // 'trailing' positions never get a resting TP order by design — see
  // placeProtectiveOrders' takeProfitPrice above — so a null tpOrderId here
  // isn't a placement failure the way it is for 'fixed'.
  exitMode: string;
}

export async function finalizeLiveFill(params: FinalizeLiveFillParams): Promise<FinalizeFillResult> {
  const {
    client, order, signalId, userId, exchange, symbol, direction, marketType,
    leverage, marginMode, sl, tp, contractSize, hedged,
  } = params;

  const resolvedFillPrice = order.average ?? order.price;
  const filledAmount = order.filled ?? order.amount ?? 0;
  if (resolvedFillPrice == null || filledAmount <= 0) {
    throw new Error(`finalizeLiveFill called on an order with no confirmed fill (order ${order.id})`);
  }

  const exitMode = await resolveSignalExitMode(userId, signalId);

  let slOrderId: string | null = null;
  let tpOrderId: string | null = null;
  {
    const protective = await placeProtectiveOrders({
      client,
      symbol,
      marketType,
      direction,
      amount: filledAmount,
      stopLossPrice: sl ?? null,
      takeProfitPrice: exitMode !== 'trailing' ? (tp ?? null) : null,
      hedged,
    });
    slOrderId = protective.slOrderId;
    tpOrderId = protective.tpOrderId;
    if (protective.errors.length > 0) {
      console.error(
        `[entry-fill] Protective order placement issues for ${exchange}/${symbol}:`,
        protective.errors.join('; '),
      );
    }
  }

  const positionSizeUnits = marketType === 'swap' ? filledAmount * (contractSize ?? 1) : filledAmount;

  const [execution] = await db
    .insert(tradeExecutions)
    .values({
      signalId,
      userId,
      exchangeName: exchange,
      symbol,
      exchangeOrderId: order.id ?? undefined,
      entryPrice: String(resolvedFillPrice),
      positionSize: String(positionSizeUnits),
      mode: 'live',
      status: 'open',
      marketType,
      leverage,
      marginMode,
      contractSize: contractSize != null ? String(contractSize) : null,
      orderContracts: marketType === 'swap' ? String(filledAmount) : null,
      slOrderId: slOrderId ?? undefined,
      tpOrderId: tpOrderId ?? undefined,
      entryAt: new Date(),
    })
    .returning({ id: tradeExecutions.id });

  await db
    .update(tradeSignals)
    .set({ status: 'executed', updatedAt: new Date(), entryOrderId: null })
    .where(eq(tradeSignals.id, signalId));

  return { executionId: execution.id, fillPrice: resolvedFillPrice, slOrderId, tpOrderId, exitMode };
}

// ---------------------------------------------------------------------------
// Paper-mode equivalent — no exchange order, just a simulated fill exactly
// at entryPrice once/if price is marketable (limit orders don't slip).
// ---------------------------------------------------------------------------
export interface FinalizePaperFillParams {
  signalId: string;
  userId: string;
  exchange: string;
  symbol: string;
  marketType: MarketType;
  fillPrice: number;
  // Already resolved by the caller (either directly, or via risk-tool against
  // an account balance) — this helper only records the fill, it doesn't size it.
  positionSizeUnits: number | null;
  leverage: number;
  marginMode: 'cross' | 'isolated';
}

export async function finalizePaperFill(params: FinalizePaperFillParams): Promise<{ executionId: string }> {
  const { signalId, userId, exchange, symbol, marketType, fillPrice, positionSizeUnits, leverage, marginMode } = params;

  const [execution] = await db
    .insert(tradeExecutions)
    .values({
      signalId,
      userId,
      exchangeName: exchange,
      symbol,
      entryPrice: String(fillPrice),
      positionSize: positionSizeUnits !== null ? String(positionSizeUnits) : null,
      mode: 'paper',
      status: 'open',
      marketType,
      leverage,
      marginMode,
      entryAt: new Date(),
    })
    .returning({ id: tradeExecutions.id });

  await db
    .update(tradeSignals)
    .set({ status: 'executed', updatedAt: new Date() })
    .where(eq(tradeSignals.id, signalId));

  return { executionId: execution.id };
}

// ---------------------------------------------------------------------------
// Cancel a resting entry order (live) — best-effort, swallows "already
// filled/cancelled" errors the same way cancelProtectiveOrders does.
// ---------------------------------------------------------------------------
export async function cancelEntryOrder(
  client: Exchange,
  symbol: string,
  marketType: MarketType,
  entryOrderId: string,
): Promise<void> {
  const exchangeSymbol = toExchangeSymbol(symbol, marketType);
  try {
    await client.cancelOrder(entryOrderId, exchangeSymbol);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/not found|already|does not exist|unknown order/i.test(msg)) {
      console.error(`[entry-fill] Failed to cancel entry order ${entryOrderId} on ${exchangeSymbol}: ${msg}`);
    }
  }
}
