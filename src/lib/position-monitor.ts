/**
 * Position Monitor — WebSocket-based SL/TP fill detection with trailing stop support.
 *
 * Architecture notes:
 * - Singleton pattern attached to `globalThis` (HMR-safe, same as db pool).
 * - One WebSocket connection per {userId, exchangeName} pair using ccxt.pro.
 * - Paper mode: REST price polling every 10 s instead of WebSocket.
 * - Exponential backoff on reconnect: 1s, 2s, 4s, 8s, 16s, 32s, 60s (×4), then alert.
 * - Connection closes gracefully when all open positions for that user+exchange are gone.
 *
 * Trailing stop logic (server-side, cross-exchange):
 * - Exit mode is resolved per-position: signal override → user risk profile default → 'fixed'.
 * - TRAILING SL ratchet:
 *     LONG:  trailSlPrice only moves UP   (price × (1 − trailSlPct/100))
 *     SHORT: trailSlPrice only moves DOWN (price × (1 + trailSlPct/100))
 * - TRAILING TP: activates once price reaches the initial TP level; TP then trails
 *   by trailTpPct% — exit fires when price retreats below (LONG) or above (SHORT)
 *   the trailing floor, allowing winners to run further.
 * - Activation guard: trailing starts only after price has moved trailActivationPct%
 *   in the profit direction from entry.
 * - Every SL/TP movement is appended to trail_audit_log with timestamp and trigger price.
 *
 * Live mode SL/TP/trailing exits (ccxt.pro):
 * - Fixed-mode positions get a real exchange-side backstop: execute-trade-tool
 *   places resting reduceOnly STOP_MARKET/TAKE_PROFIT_MARKET orders right after
 *   entry (see `@/lib/protective-orders`), tracked as slOrderId/tpOrderId. These
 *   fire even if this process is down. runOrdersLoop's watchOrders detects the
 *   fill, closes the position with the real fill price, and cancels the sibling
 *   order (an exchange-native OCO isn't exposed uniformly through CCXT's unified
 *   API, so the two orders are independent and this app plays OCO manually).
 * - Trailing-mode positions have NO resting order — the ratchet needs constant
 *   cancel/replace that isn't attempted here. They rely entirely on software:
 *   watchTicker drives continuous price checks, and when the ratcheted level is
 *   breached this module places a REAL reduceOnly market order via plain ccxt
 *   (see `placeMarketClose`) to flatten the position. Fixed-mode positions are
 *   ALSO checked this way on every tick (`checkFixedExit`) as a low-latency
 *   second line of defense alongside the resting order.
 * - Startup reconciliation (`reconcileLivePositions`, called from `startMonitor`):
 *   watchOrders only reports fills from connection time onward, so a resting
 *   order that filled while this process was down would otherwise go unnoticed
 *   forever. Before starting a monitor's WS loops, REST-fetch both resting
 *   orders' status and close the DB record if either already filled offline.
 * - If a software-driven live close order fails (network error, rejected order,
 *   etc.), the position is left open in the DB and an `exit_order_failed`
 *   notification is sent — the next tick retries. The DB is never marked
 *   "closed" without a confirmed exchange fill for live-mode positions.
 *
 * IMPORTANT — runtime requirement:
 * WebSocket connections require a long-running Node.js process. This monitor
 * will NOT persist across cold-starts on serverless runtimes (e.g. Vercel).
 * A persistent dyno/container or a cron-tick approach via /api/cron/position-monitor
 * is required for production.
 */

import ccxt, { type Exchange, type Ticker } from 'ccxt';
import { eq, and } from 'drizzle-orm';
import { db } from '@/db';
import {
  tradeExecutions,
  tradeSignals,
  userExchanges,
  trailAuditLog,
} from '@/db/schema';
import { decrypt } from '@/lib/crypto';
import { sendNotification } from '@/lib/notifications';
import { accruePublisherFee } from '@/lib/publisher-fee';
import { fetchUserExitConfig } from '@/lib/exit-config';
import { cancelProtectiveOrders } from '@/lib/protective-orders';
import { computePnlUsd, type PositionDirection } from '@/lib/pnl';
import { toExchangeSymbol, type MarketType } from '@/mastra/tools/market-symbol';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FillType = 'sl_hit' | 'tp_hit' | 'manual' | 'liquidation';

interface OpenPosition {
  id: string;
  userId: string;
  exchangeName: string;
  symbol: string;
  exchangeOrderId: string | null;
  exitOrderId: string | null;
  slOrderId: string | null;
  tpOrderId: string | null;
  entryPrice: string | null;
  stopLoss: string | null;
  takeProfit: string | null;
  mode: string | null;
  positionSize: string | null;
  direction: string | null;
  marketType: string | null;
  contractSize: string | null;
  orderContracts: string | null;
  // Trailing config (resolved: signal override → user profile → defaults)
  exitMode: string;            // 'fixed' | 'trailing'
  trailSlPct: number;          // e.g. 1.0 = 1%
  trailTpPct: number;          // e.g. 2.0 = 2%
  trailActivationPct: number;  // e.g. 0 = immediately
  // Trailing state persisted in trade_executions
  trailSlPrice: string | null;
  trailTpActive: boolean;
  trailTpPrice: string | null;
}

interface MonitorState {
  userId: string;
  exchangeName: string;
  mode: 'live' | 'paper';
  active: boolean;
  retryCount: number;
  retryTimeoutId: ReturnType<typeof setTimeout> | null;
  paperIntervalId: ReturnType<typeof setInterval> | null;
  stopped: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000];
const MAX_RETRIES = 10;
const PAPER_POLL_INTERVAL_MS = 10_000;
const PRICE_TOLERANCE_PCT = 0.005;

// ---------------------------------------------------------------------------
// Global singleton
// ---------------------------------------------------------------------------

declare global {
  var __positionMonitor: PositionMonitorManager | undefined;
}

// ---------------------------------------------------------------------------
// Fill classification helpers
// ---------------------------------------------------------------------------

function classifyFill(
  exitPrice: number,
  stopLoss: number | null,
  takeProfit: number | null,
  orderType: string,
  orderReason: string,
): FillType {
  const lowerType = orderType?.toLowerCase() ?? '';
  const lowerReason = orderReason?.toLowerCase() ?? '';

  if (
    lowerType.includes('liquidat') ||
    lowerReason.includes('liquidat') ||
    lowerType === 'stop_loss_limit' && lowerReason.includes('liqu')
  ) {
    return 'liquidation';
  }

  if (stopLoss !== null) {
    const diff = Math.abs(exitPrice - stopLoss) / stopLoss;
    if (diff <= PRICE_TOLERANCE_PCT) return 'sl_hit';
  }

  if (takeProfit !== null) {
    const diff = Math.abs(exitPrice - takeProfit) / takeProfit;
    if (diff <= PRICE_TOLERANCE_PCT) return 'tp_hit';
  }

  return 'manual';
}

function computePnl(
  entryPrice: number,
  exitPrice: number,
  positionSize: number,
  direction: string = 'LONG',
): number {
  return computePnlUsd(entryPrice, exitPrice, positionSize, direction as PositionDirection);
}

// ---------------------------------------------------------------------------
// Trailing stop helpers
// ---------------------------------------------------------------------------

/**
 * Compute the new trailing SL level given the current price.
 * LONG:  newSl = price × (1 − trailSlPct/100)
 * SHORT: newSl = price × (1 + trailSlPct/100)
 */
function computeTrailSl(
  currentPrice: number,
  direction: string,
  trailSlPct: number,
): number {
  const pct = trailSlPct / 100;
  return direction === 'LONG'
    ? currentPrice * (1 - pct)
    : currentPrice * (1 + pct);
}

/**
 * Compute the trailing TP floor level given the current price.
 *
 * This is the level price must RETREAT through to trigger the exit.
 * LONG:  floor = price × (1 − trailTpPct/100)  — below current price
 * SHORT: floor = price × (1 + trailTpPct/100)  — above current price
 *
 * The floor ratchets upward (LONG) / downward (SHORT) as price makes new
 * extremes, locking in more profit.
 */
function computeTrailTpFloor(
  currentPrice: number,
  direction: string,
  trailTpPct: number,
): number {
  const pct = trailTpPct / 100;
  return direction === 'LONG'
    ? currentPrice * (1 - pct)   // exit if price drops below this floor
    : currentPrice * (1 + pct);  // exit if price rises above this ceiling
}

/**
 * Returns true when the activation guard has been cleared:
 * price has moved trailActivationPct% from entry in the profit direction.
 */
function isTrailActivated(
  currentPrice: number,
  entryPrice: number,
  direction: string,
  trailActivationPct: number,
): boolean {
  if (trailActivationPct <= 0) return true;
  const movePct = direction === 'LONG'
    ? ((currentPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - currentPrice) / entryPrice) * 100;
  return movePct >= trailActivationPct;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function fetchOpenPositions(
  userId: string,
  exchangeName: string,
): Promise<OpenPosition[]> {
  const userConfig = await fetchUserExitConfig(userId);

  const rows = await db
    .select({
      id: tradeExecutions.id,
      userId: tradeExecutions.userId,
      exchangeName: tradeExecutions.exchangeName,
      symbol: tradeExecutions.symbol,
      exchangeOrderId: tradeExecutions.exchangeOrderId,
      exitOrderId: tradeExecutions.exitOrderId,
      slOrderId: tradeExecutions.slOrderId,
      tpOrderId: tradeExecutions.tpOrderId,
      entryPrice: tradeExecutions.entryPrice,
      stopLoss: tradeSignals.stopLoss,
      takeProfit: tradeSignals.takeProfit,
      direction: tradeSignals.direction,
      mode: tradeExecutions.mode,
      positionSize: tradeExecutions.positionSize,
      marketType: tradeExecutions.marketType,
      contractSize: tradeExecutions.contractSize,
      orderContracts: tradeExecutions.orderContracts,
      // Per-signal trailing overrides
      signalExitMode: tradeSignals.exitMode,
      signalTrailSlPct: tradeSignals.trailSlPct,
      signalTrailTpPct: tradeSignals.trailTpPct,
      signalTrailActivationPct: tradeSignals.trailActivationPct,
      // Current trailing state
      trailSlPrice: tradeExecutions.trailSlPrice,
      trailTpActive: tradeExecutions.trailTpActive,
      trailTpPrice: tradeExecutions.trailTpPrice,
    })
    .from(tradeExecutions)
    .leftJoin(tradeSignals, eq(tradeExecutions.signalId, tradeSignals.id))
    .where(
      and(
        eq(tradeExecutions.userId, userId),
        eq(tradeExecutions.exchangeName, exchangeName),
        eq(tradeExecutions.status, 'open'),
      ),
    );

  return rows.map((r) => {
    // Resolve trailing config: signal override → user profile default
    const exitMode = r.signalExitMode ?? userConfig.exitMode;
    const trailSlPct = r.signalTrailSlPct
      ? Number(r.signalTrailSlPct)
      : userConfig.trailSlPct;
    const trailTpPct = r.signalTrailTpPct
      ? Number(r.signalTrailTpPct)
      : userConfig.trailTpPct;
    const trailActivationPct = r.signalTrailActivationPct
      ? Number(r.signalTrailActivationPct)
      : userConfig.trailActivationPct;

    return {
      id: r.id,
      userId: r.userId,
      exchangeName: r.exchangeName,
      symbol: r.symbol,
      exchangeOrderId: r.exchangeOrderId,
      exitOrderId: r.exitOrderId,
      slOrderId: r.slOrderId,
      tpOrderId: r.tpOrderId,
      entryPrice: r.entryPrice,
      stopLoss: r.stopLoss ?? null,
      takeProfit: r.takeProfit ?? null,
      direction: r.direction ?? null,
      mode: r.mode,
      positionSize: r.positionSize,
      marketType: r.marketType,
      contractSize: r.contractSize,
      orderContracts: r.orderContracts,
      exitMode,
      trailSlPct,
      trailTpPct,
      trailActivationPct,
      trailSlPrice: r.trailSlPrice ?? null,
      trailTpActive: r.trailTpActive ?? false,
      trailTpPrice: r.trailTpPrice ?? null,
    };
  });
}

async function closePosition(
  executionId: string,
  exitPrice: number,
  fillType: FillType,
  realizedPnl: number = 0,
  exitOrderId: string | null = null,
): Promise<void> {
  // Any close path retires a pending retry-cooldown/notify-once streak for this position.
  exitFailureState.delete(executionId);

  await db
    .update(tradeExecutions)
    .set({
      exitPrice: String(exitPrice),
      exitAt: new Date(),
      status: 'closed',
      fillType,
      realizedPnl: String(realizedPnl),
      ...(exitOrderId ? { exitOrderId } : {}),
    })
    .where(eq(tradeExecutions.id, executionId));

  // Accrue performance fee for copy trades with positive P&L (fire-and-forget)
  void accruePublisherFee(executionId, realizedPnl);
}

async function updateTrailState(
  executionId: string,
  update: {
    trailSlPrice?: string;
    trailTpActive?: boolean;
    trailTpPrice?: string | null;
  },
): Promise<void> {
  await db
    .update(tradeExecutions)
    .set(update)
    .where(eq(tradeExecutions.id, executionId));
}

async function appendTrailAudit(
  executionId: string,
  userId: string,
  eventType: 'sl_move' | 'tp_activate' | 'tp_move',
  triggerPrice: number,
  newLevel: number,
  prevLevel: number | null,
): Promise<void> {
  await db.insert(trailAuditLog).values({
    executionId,
    userId,
    eventType,
    triggerPrice: String(triggerPrice),
    newLevel: String(newLevel),
    prevLevel: prevLevel !== null ? String(prevLevel) : null,
  });
}

async function getExchangeCredentials(
  userId: string,
  exchangeName: string,
): Promise<{ apiKey: string; secret: string; password?: string } | null> {
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

  const { encryptedApiKey, encryptedApiSecret, encryptedPassphrase } = rows[0];
  return {
    apiKey: decrypt(encryptedApiKey),
    secret: decrypt(encryptedApiSecret),
    password: encryptedPassphrase ? decrypt(encryptedPassphrase) : undefined,
  };
}

async function buildExchangeClient(userId: string, exchangeName: string): Promise<Exchange | null> {
  const creds = await getExchangeCredentials(userId, exchangeName);
  if (!creds) return null;

  const ExchangeClass = (ccxt as unknown as Record<string, new (config: object) => Exchange>)[exchangeName];
  if (!ExchangeClass) return null;

  return new ExchangeClass({
    apiKey: creds.apiKey,
    secret: creds.secret,
    ...(creds.password ? { password: creds.password } : {}),
  });
}

/**
 * Check whether a resting SL/TP order has already filled — meaning the
 * position closed by that route rather than by whatever the caller is about
 * to do. Used both for startup reconciliation (a fill that happened while
 * this process was down) and, critically, inside executeExit's failure path:
 * a resting STOP_MARKET is trigger-side on the exchange and usually wins the
 * race against a software-driven reduceOnly close, so "the close order
 * failed" and "a resting order already flattened this" look identical from
 * here without this check — and the two cases must not be confused, or the
 * user gets a false "EXIT FAILED" alert right next to the real fill notice.
 */
async function reconcileRestingOrderFill(client: Exchange, position: OpenPosition): Promise<boolean> {
  const marketType = (position.marketType as MarketType) ?? 'spot';
  const exchangeSymbol = toExchangeSymbol(position.symbol, marketType);

  const checks: Array<{ orderId: string; fillType: 'sl_hit' | 'tp_hit'; sibling: string | null }> = [];
  if (position.slOrderId) {
    checks.push({ orderId: position.slOrderId, fillType: 'sl_hit', sibling: position.tpOrderId });
  }
  if (position.tpOrderId) {
    checks.push({ orderId: position.tpOrderId, fillType: 'tp_hit', sibling: position.slOrderId });
  }

  for (const check of checks) {
    let order;
    try {
      order = await client.fetchOrder(check.orderId, exchangeSymbol);
    } catch (err) {
      console.error(
        `[position-monitor] fetchOrder failed for ${check.orderId} (execution ${position.id}):`,
        err,
      );
      continue;
    }

    if (order.status !== 'closed') continue; // still resting, or was cancelled

    const fillPrice = order.average ?? order.price ?? null;
    if (!fillPrice) continue;

    const entryPrice = position.entryPrice ? parseFloat(position.entryPrice) : 0;
    const positionSize = position.positionSize ? parseFloat(position.positionSize) : 0;
    const direction = position.direction ?? 'LONG';
    const pnl = computePnl(entryPrice, fillPrice, positionSize, direction);

    await closePosition(position.id, fillPrice, check.fillType, pnl, check.orderId);
    await cancelProtectiveOrders(client, position.symbol, marketType, [check.sibling]);
    void sendNotification(position.userId, {
      event: check.fillType,
      symbol: position.symbol,
      exitPrice: String(fillPrice),
      pnl: pnl.toFixed(4),
    });

    return true;
  }

  return false;
}

// Skip re-attempting a live close order for this many ms after a failed
// attempt (avoids hammering the exchange / rate-limit bans on every tick of
// a fast-moving ticker) and suppresses repeat `exit_order_failed` alerts for
// the same failure streak — the user is told once, not once per tick.
const EXIT_RETRY_COOLDOWN_MS = 45_000;
const exitFailureState = new Map<string, number>(); // executionId -> last-attempt timestamp

type CloseOrderResult =
  | { ok: true; exitPrice: number | null; orderId: string | null; client: Exchange }
  | { ok: false; error: string };

/**
 * Place a real reduceOnly market order that flattens a live position.
 * Mirrors the manual-close logic in /api/positions/[id] — same contract-size
 * handling for swap markets, same reduceOnly flag.
 *
 * Full closes always use `orderContracts` (the exact contract count booked
 * at entry) rather than re-deriving amount from positionSize/contractSize,
 * which drifts from the true filled size by the entry-price/fill-price
 * slippage delta. If a manual partial close has since shrunk positionSize,
 * the close amount is scaled down proportionally.
 */
async function placeMarketClose(
  userId: string,
  exchangeName: string,
  symbol: string,
  marketType: MarketType,
  direction: string,
  positionSize: number,
  contractSize: number,
  orderContracts: number | null,
): Promise<CloseOrderResult> {
  const client = await buildExchangeClient(userId, exchangeName);
  if (!client) return { ok: false, error: `No active ${exchangeName} credentials found` };

  const exchangeSymbol = toExchangeSymbol(symbol, marketType);
  const closeSide = direction === 'LONG' ? 'sell' : 'buy';

  let closeAmount: number;
  if (marketType === 'swap') {
    const effContractSize = contractSize || 1;
    if (orderContracts && orderContracts > 0) {
      const originalBaseSize = orderContracts * effContractSize;
      const ratio = originalBaseSize > 0 ? positionSize / originalBaseSize : 1;
      // Entry-price → fill-price slippage (~0.05%) also shrinks this ratio below 1,
      // but a genuine partial close changes size by at least 1% (the manual-close
      // route clamps pct to [1,100]). Only scale down for the latter — scaling for
      // slippage dust would leave exchange-side dust open while the DB reports closed.
      closeAmount = ratio >= 0.995 ? orderContracts : orderContracts * Math.min(ratio, 1);
    } else {
      closeAmount = positionSize / effContractSize;
    }
  } else {
    closeAmount = positionSize;
  }

  if (!closeAmount || closeAmount <= 0) {
    return { ok: false, error: 'Invalid position size for close order' };
  }

  // Spot sells: some exchanges (e.g. BingX) deduct trading fees from the base
  // asset on the entry buy, so the wallet can hold slightly less than the
  // recorded positionSize. Clamp to free balance so the close order doesn't
  // fail on insufficient funds — best-effort only, never blocks the attempt.
  if (marketType === 'spot' && closeSide === 'sell') {
    try {
      await client.loadMarkets();
      const baseCurrency = client.markets[exchangeSymbol]?.base;
      if (baseCurrency) {
        const balance = await client.fetchBalance();
        const free = (balance.free as unknown as Record<string, number> | undefined)?.[baseCurrency];
        if (typeof free === 'number' && free > 0 && free < closeAmount) {
          closeAmount = free;
        }
      }
    } catch {
      // Balance lookup failed — proceed with the computed amount as-is.
    }
  }

  try {
    const order = await client.createOrder(
      exchangeSymbol,
      'market',
      closeSide,
      closeAmount,
      undefined,
      marketType === 'swap' ? { reduceOnly: true } : undefined,
    );

    let exitPrice = order.average ?? order.price ?? null;
    if (!exitPrice && order.id) {
      // Market orders on some exchanges don't return fill details inline —
      // the order was still placed, so this is bookkeeping, not a retry case.
      try {
        const fetched = await client.fetchOrder(order.id, exchangeSymbol);
        exitPrice = fetched.average ?? fetched.price ?? null;
      } catch {
        // Fall through with exitPrice null — caller falls back to ticker price.
      }
    }

    return { ok: true, exitPrice, orderId: order.id ?? null, client };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

/**
 * Resolve a triggered SL/TP/trailing exit into an actual position close.
 *
 * Live mode: places a real reduceOnly market order first — the DB is only
 * marked "closed" once the exchange confirms the order was placed. On
 * failure the position stays open; further attempts are rate-limited by
 * EXIT_RETRY_COOLDOWN_MS and only the first failure in a streak notifies
 * the user (repeat attempts still log server-side).
 *
 * Paper mode: no exchange call — the ticker price is the simulated fill.
 */
async function executeExit(
  position: OpenPosition,
  tickerPrice: number,
  fillType: FillType,
): Promise<boolean> {
  const direction = position.direction ?? 'LONG';
  const entry = position.entryPrice ? parseFloat(position.entryPrice) : 0;
  const positionSize = position.positionSize ? parseFloat(position.positionSize) : 0;

  let exitPrice = tickerPrice;
  let exitOrderId: string | null = null;

  if (position.mode === 'live') {
    const lastAttempt = exitFailureState.get(position.id);
    if (lastAttempt && Date.now() - lastAttempt < EXIT_RETRY_COOLDOWN_MS) {
      return false; // cooling down after a recent failure — retry next tick
    }

    const marketType = (position.marketType as MarketType) ?? 'spot';
    const contractSize = position.contractSize ? parseFloat(position.contractSize) : 1;
    const orderContracts = position.orderContracts ? parseFloat(position.orderContracts) : null;

    const result = await placeMarketClose(
      position.userId,
      position.exchangeName,
      position.symbol,
      marketType,
      direction,
      positionSize,
      contractSize,
      orderContracts,
    );

    if (!result.ok) {
      // A resting STOP_MARKET/TAKE_PROFIT_MARKET is trigger-side on the
      // exchange and usually wins the race against this software-driven
      // close — a reduceOnly order against an already-flat position fails
      // with the same shape as a genuine order-placement failure. Check
      // before alerting: without this, the user would see a false "EXIT
      // FAILED, check manually" right next to the real sl_hit/tp_hit
      // notification a moment later, on exactly the path they'll test first.
      if (position.slOrderId || position.tpOrderId) {
        const client = await buildExchangeClient(position.userId, position.exchangeName);
        if (client) {
          const wasClosedByRestingOrder = await reconcileRestingOrderFill(client, position);
          if (wasClosedByRestingOrder) {
            exitFailureState.delete(position.id);
            return true;
          }
        }
      }

      const isFirstFailureInStreak = !exitFailureState.has(position.id);
      exitFailureState.set(position.id, Date.now());

      console.error(
        `[position-monitor] Live close order failed for execution ${position.id} (${fillType}): ${result.error}`,
      );
      if (isFirstFailureInStreak) {
        void sendNotification(position.userId, {
          event: 'exit_order_failed',
          symbol: position.symbol,
          exitPrice: String(tickerPrice),
          reason: result.error,
        });
      }
      return false;
    }

    exitFailureState.delete(position.id);
    exitPrice = result.exitPrice ?? tickerPrice;
    exitOrderId = result.orderId;

    // The position is now flat via a software-driven close, not a resting
    // order fill — clean up whichever protective orders are still resting so
    // they don't linger (reduceOnly makes them harmless if they later fire,
    // but leaving stale orders on the account is confusing clutter).
    if (position.slOrderId || position.tpOrderId) {
      void cancelProtectiveOrders(
        result.client,
        position.symbol,
        marketType,
        [position.slOrderId, position.tpOrderId],
      );
    }
  }

  const pnl = computePnl(entry, exitPrice, positionSize, direction);
  await closePosition(position.id, exitPrice, fillType, pnl, exitOrderId);
  void sendNotification(position.userId, {
    event: fillType === 'sl_hit' ? 'sl_hit' as const : 'tp_hit' as const,
    symbol: position.symbol,
    exitPrice: String(exitPrice),
    pnl: pnl.toFixed(4),
  });
  return true;
}

/**
 * Fixed-mode exit check: direct SL/TP price comparison against the absolute
 * levels (as opposed to the ratcheted levels used by trailing positions).
 */
async function checkFixedExit(position: OpenPosition, currentPrice: number): Promise<boolean> {
  const stopLoss = position.stopLoss ? parseFloat(position.stopLoss) : null;
  const takeProfit = position.takeProfit ? parseFloat(position.takeProfit) : null;
  const direction = position.direction ?? 'LONG';

  let fillType: FillType | null = null;

  if (stopLoss !== null) {
    const slHit = direction === 'LONG' ? currentPrice <= stopLoss : currentPrice >= stopLoss;
    if (slHit) fillType = 'sl_hit';
  }

  if (!fillType && takeProfit !== null) {
    const tpHit = direction === 'LONG' ? currentPrice >= takeProfit : currentPrice <= takeProfit;
    if (tpHit) fillType = 'tp_hit';
  }

  if (!fillType) return false;

  return executeExit(position, currentPrice, fillType);
}

// ---------------------------------------------------------------------------
// Core trailing logic — called on each price tick for a trailing-mode position.
//
// Handles ratchet updates and exit detection for both SL and TP.
// Returns true if the position was closed (caller should skip further processing).
// ---------------------------------------------------------------------------

async function applyTrailingLogic(
  position: OpenPosition,
  currentPrice: number,
): Promise<boolean> {
  const direction = position.direction ?? 'LONG';
  const entry = position.entryPrice ? parseFloat(position.entryPrice) : null;
  if (!entry) return false;

  const { trailSlPct, trailTpPct, trailActivationPct } = position;
  const activated = isTrailActivated(currentPrice, entry, direction, trailActivationPct);
  if (!activated) return false;

  // ------------------------------------------------------------------
  // Trailing SL ratchet
  // ------------------------------------------------------------------
  const newSlCandidate = computeTrailSl(currentPrice, direction, trailSlPct);
  const currentTrailSl = position.trailSlPrice ? parseFloat(position.trailSlPrice) : null;

  let updatedTrailSl: number | null = null;

  if (currentTrailSl === null) {
    // First tick: establish the initial trailing SL
    updatedTrailSl = newSlCandidate;
    await updateTrailState(position.id, { trailSlPrice: String(newSlCandidate) });
    await appendTrailAudit(position.id, position.userId, 'sl_move', currentPrice, newSlCandidate, null);
  } else {
    // Ratchet: LONG only moves up, SHORT only moves down
    const shouldMove = direction === 'LONG'
      ? newSlCandidate > currentTrailSl
      : newSlCandidate < currentTrailSl;

    if (shouldMove) {
      updatedTrailSl = newSlCandidate;
      await updateTrailState(position.id, { trailSlPrice: String(newSlCandidate) });
      await appendTrailAudit(position.id, position.userId, 'sl_move', currentPrice, newSlCandidate, currentTrailSl);
    } else {
      updatedTrailSl = currentTrailSl;
    }
  }

  // Check if trailing SL has been breached
  if (updatedTrailSl !== null) {
    const slHit = direction === 'LONG'
      ? currentPrice <= updatedTrailSl
      : currentPrice >= updatedTrailSl;

    if (slHit) {
      return executeExit(position, currentPrice, 'sl_hit');
    }
  }

  // ------------------------------------------------------------------
  // Trailing TP
  // ------------------------------------------------------------------
  const initialTp = position.takeProfit ? parseFloat(position.takeProfit) : null;

  if (initialTp !== null) {
    if (!position.trailTpActive) {
      // Activate once price reaches the initial TP level
      const tpReached = direction === 'LONG'
        ? currentPrice >= initialTp
        : currentPrice <= initialTp;

      if (tpReached) {
        // Set the initial trailing floor at the current price
        const newFloor = computeTrailTpFloor(currentPrice, direction, trailTpPct);
        await updateTrailState(position.id, {
          trailTpActive: true,
          trailTpPrice: String(newFloor),
        });
        await appendTrailAudit(position.id, position.userId, 'tp_activate', currentPrice, newFloor, null);
        // Update in-memory state so exit check below uses fresh values
        position.trailTpActive = true;
        position.trailTpPrice = String(newFloor);
        // Do NOT close here — the position stays open to run further
      }
    }

    // When trailing TP is active: ratchet the floor and check for retreat exit
    if (position.trailTpActive) {
      const currentFloor = position.trailTpPrice ? parseFloat(position.trailTpPrice) : null;
      const newFloorCandidate = computeTrailTpFloor(currentPrice, direction, trailTpPct);

      let activeFloor = currentFloor;

      if (currentFloor !== null) {
        // Ratchet: for LONG the floor only moves UP (higher prices → higher floor)
        //          for SHORT the floor only moves DOWN (lower prices → lower ceiling)
        const shouldMoveFloor = direction === 'LONG'
          ? newFloorCandidate > currentFloor
          : newFloorCandidate < currentFloor;

        if (shouldMoveFloor) {
          activeFloor = newFloorCandidate;
          await updateTrailState(position.id, { trailTpPrice: String(newFloorCandidate) });
          await appendTrailAudit(position.id, position.userId, 'tp_move', currentPrice, newFloorCandidate, currentFloor);
        }
      }

      // Exit when price retreats back through the trailing floor
      if (activeFloor !== null) {
        const tpFloorBreached = direction === 'LONG'
          ? currentPrice <= activeFloor
          : currentPrice >= activeFloor;

        if (tpFloorBreached) {
          return executeExit(position, currentPrice, 'tp_hit');
        }
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Manager class
// ---------------------------------------------------------------------------

class PositionMonitorManager {
  private monitors = new Map<string, MonitorState>();

  private monitorKey(userId: string, exchangeName: string): string {
    return `${userId}::${exchangeName}`;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async syncMonitors(): Promise<void> {
    const openRows = await db
      .select({
        userId: tradeExecutions.userId,
        exchangeName: tradeExecutions.exchangeName,
        mode: tradeExecutions.mode,
      })
      .from(tradeExecutions)
      .where(eq(tradeExecutions.status, 'open'));

    const seen = new Set<string>();
    for (const row of openRows) {
      const key = this.monitorKey(row.userId, row.exchangeName);
      seen.add(key);

      if (!this.monitors.has(key)) {
        const mode = (row.mode as 'live' | 'paper') ?? 'paper';
        await this.startMonitor(row.userId, row.exchangeName, mode);
      }
    }

    for (const [key, state] of this.monitors.entries()) {
      if (!seen.has(key) && state.active) {
        this.stopMonitor(state.userId, state.exchangeName);
      }
    }
  }

  async startMonitor(
    userId: string,
    exchangeName: string,
    mode: 'live' | 'paper',
  ): Promise<void> {
    const key = this.monitorKey(userId, exchangeName);
    if (this.monitors.get(key)?.active) return;

    // One-time catch-up: a resting protective order can fill while this
    // process is down (crash, redeploy, serverless cold start). Nothing
    // observes that fill until we ask the exchange directly — watchOrders()
    // below only reports events from the moment it (re)connects onward.
    if (mode === 'live') {
      await this.reconcileLivePositions(userId, exchangeName);
    }

    const state: MonitorState = {
      userId,
      exchangeName,
      mode,
      active: true,
      retryCount: 0,
      retryTimeoutId: null,
      paperIntervalId: null,
      stopped: false,
    };
    this.monitors.set(key, state);

    if (mode === 'paper') {
      this.startPaperPoller(state);
    } else {
      this.startWebSocketLoop(state);
    }
  }

  /**
   * Catch up on resting SL/TP orders that may have filled while this process
   * was not running. REST-only (fetchOrder), runs once per (userId,
   * exchangeName) right before its WS loops start — those loops only report
   * events from connection time onward and would otherwise never notice a
   * fill that already happened.
   */
  private async reconcileLivePositions(userId: string, exchangeName: string): Promise<void> {
    const positions = await fetchOpenPositions(userId, exchangeName);
    const candidates = positions.filter(
      (p) => p.mode === 'live' && (p.slOrderId || p.tpOrderId),
    );
    if (candidates.length === 0) return;

    const client = await buildExchangeClient(userId, exchangeName);
    if (!client) return; // runOrdersLoop will surface the missing-credentials case

    for (const position of candidates) {
      try {
        const wasClosed = await reconcileRestingOrderFill(client, position);
        if (wasClosed) {
          console.warn(
            `[position-monitor] Reconcile: execution ${position.id} was already closed by a resting order while this process was offline.`,
          );
        }
      } catch (err) {
        console.error(
          `[position-monitor] Reconcile failed for execution ${position.id}:`,
          err,
        );
      }
    }
  }

  stopMonitor(userId: string, exchangeName: string): void {
    const key = this.monitorKey(userId, exchangeName);
    const state = this.monitors.get(key);
    if (!state) return;

    state.stopped = true;
    state.active = false;

    if (state.retryTimeoutId) {
      clearTimeout(state.retryTimeoutId);
      state.retryTimeoutId = null;
    }
    if (state.paperIntervalId) {
      clearInterval(state.paperIntervalId);
      state.paperIntervalId = null;
    }

    this.monitors.delete(key);
  }

  getStatus(): Array<{
    userId: string;
    exchangeName: string;
    mode: string;
    active: boolean;
    retryCount: number;
  }> {
    return Array.from(this.monitors.values()).map((s) => ({
      userId: s.userId,
      exchangeName: s.exchangeName,
      mode: s.mode,
      active: s.active,
      retryCount: s.retryCount,
    }));
  }

  // -------------------------------------------------------------------------
  // Live WebSocket loop (ccxt.pro)
  //
  // Two concurrent loops run per {userId, exchangeName}:
  //   1. runTickerLoop  — drives trailing ratchet updates for trailing-mode positions
  //   2. runOrdersLoop  — detects exchange-side fills for fixed-mode exits
  //
  // Both share the same MonitorState; either loop can stop the monitor.
  // -------------------------------------------------------------------------

  private startWebSocketLoop(state: MonitorState): void {
    void this.runOrdersLoop(state);
    void this.runTickerLoop(state);
  }

  /**
   * Orders loop: watches exchange order fills and closes positions on fixed-mode SL/TP.
   */
  private async runOrdersLoop(state: MonitorState): Promise<void> {
    const { userId, exchangeName } = state;

    while (!state.stopped) {
      let exchange: Exchange | null = null;
      try {
        const creds = await getExchangeCredentials(userId, exchangeName);
        if (!creds) {
          console.warn(
            `[position-monitor] No credentials for ${userId}/${exchangeName} — stopping orders loop`,
          );
          this.stopMonitor(userId, exchangeName);
          return;
        }

        const ExchangeClass = (ccxt.pro as unknown as Record<string, new (config: object) => Exchange>)[exchangeName];
        if (!ExchangeClass) {
          console.error(`[position-monitor] ccxt.pro has no class for "${exchangeName}"`);
          this.stopMonitor(userId, exchangeName);
          return;
        }

        exchange = new ExchangeClass({
          apiKey: creds.apiKey,
          secret: creds.secret,
          ...(creds.password ? { password: creds.password } : {}),
        });

        state.retryCount = 0;

        while (!state.stopped) {
          const orders = await exchange.watchOrders();

          if (state.stopped) break;

          const positions = await fetchOpenPositions(userId, exchangeName);
          if (positions.length === 0) {
            await exchange.close();
            this.stopMonitor(userId, exchangeName);
            return;
          }

          const byExchangeOrderId = new Map(
            positions.filter((p) => p.exchangeOrderId).map((p) => [p.exchangeOrderId!, p]),
          );
          const byExitOrderId = new Map(
            positions.filter((p) => p.exitOrderId).map((p) => [p.exitOrderId!, p]),
          );
          // Resting protective orders — a fill here is a DEFINITIVE sl_hit/tp_hit,
          // not a guess (unlike classifyFill's price-proximity heuristic below).
          const bySlOrderId = new Map(
            positions.filter((p) => p.slOrderId).map((p) => [p.slOrderId!, p]),
          );
          const byTpOrderId = new Map(
            positions.filter((p) => p.tpOrderId).map((p) => [p.tpOrderId!, p]),
          );

          // Guards against processing the same execution twice within one
          // batch — e.g. the exchange reports both the real fill and a
          // spurious "closed" status on the sibling it auto-cancelled, which
          // would otherwise double-call closePosition (and double-accrue the
          // publisher fee) for the same position.
          const processedExecutionIds = new Set<string>();

          for (const order of orders) {
            if (order.status !== 'closed') continue;

            const fillPrice = order.average ?? order.price ?? 0;
            if (!fillPrice) continue;

            const orderId = order.id ?? '';

            const slPosition = bySlOrderId.get(orderId);
            const tpPosition = byTpOrderId.get(orderId);

            if (slPosition || tpPosition) {
              const position = (slPosition ?? tpPosition)!;
              if (processedExecutionIds.has(position.id)) continue;
              processedExecutionIds.add(position.id);
              const fillType: 'sl_hit' | 'tp_hit' = slPosition ? 'sl_hit' : 'tp_hit';
              const siblingOrderId = slPosition ? position.tpOrderId : position.slOrderId;

              const entryPrice = position.entryPrice ? parseFloat(position.entryPrice) : 0;
              const positionSize = position.positionSize ? parseFloat(position.positionSize) : 0;
              const fillDirection = position.direction ?? 'LONG';
              const pnl = computePnl(entryPrice, fillPrice, positionSize, fillDirection);

              await closePosition(position.id, fillPrice, fillType, pnl, orderId);
              await cancelProtectiveOrders(
                exchange,
                position.symbol,
                (position.marketType as MarketType) ?? 'spot',
                [siblingOrderId],
              );

              void sendNotification(userId, {
                event: fillType,
                symbol: position.symbol,
                exitPrice: String(fillPrice),
                pnl: pnl.toFixed(4),
              });
              continue;
            }

            const position =
              byExchangeOrderId.get(orderId) ??
              byExitOrderId.get(orderId);

            if (!position) continue;
            if (processedExecutionIds.has(position.id)) continue;
            processedExecutionIds.add(position.id);

            // Fallback path: a fill under the entry/exit order id, not a resting
            // protective order — e.g. a manual close done directly on the exchange.
            // For trailing positions, the ticker loop handles exit logic; we still
            // record the fill here in case something closed the position outside
            // this app's control.
            const fillType = classifyFill(
              fillPrice,
              position.stopLoss ? parseFloat(position.stopLoss) : null,
              position.takeProfit ? parseFloat(position.takeProfit) : null,
              order.type ?? '',
              (order.info as Record<string, string>)?.reason ?? '',
            );

            const entryPrice = position.entryPrice ? parseFloat(position.entryPrice) : 0;
            const positionSize = position.positionSize ? parseFloat(position.positionSize) : 0;
            const fillDirection = position.direction ?? 'LONG';
            const pnl = computePnl(entryPrice, fillPrice, positionSize, fillDirection);

            await closePosition(position.id, fillPrice, fillType, pnl);
            await cancelProtectiveOrders(
              exchange,
              position.symbol,
              (position.marketType as MarketType) ?? 'spot',
              [position.slOrderId, position.tpOrderId],
            );

            const notifEvent =
              fillType === 'sl_hit'      ? 'sl_hit' as const :
              fillType === 'tp_hit'      ? 'tp_hit' as const :
              fillType === 'liquidation' ? 'liquidation' as const :
              'manual_close' as const;

            void sendNotification(userId, {
              event: notifEvent,
              symbol: position.symbol,
              exitPrice: String(fillPrice),
              pnl: pnl.toFixed(4),
            });
          }
        }
      } catch (err) {
        if (state.stopped) return;

        console.error(
          `[position-monitor] Orders WS error for ${userId}/${exchangeName} (retry ${state.retryCount}/${MAX_RETRIES}):`,
          err,
        );

        try { await exchange?.close(); } catch { /* ignore */ }

        if (state.retryCount >= MAX_RETRIES) {
          state.active = false;
          state.stopped = true;
          this.monitors.delete(this.monitorKey(userId, exchangeName));
          void sendNotification(userId, { event: 'monitor_disconnected', symbol: exchangeName });
          return;
        }

        const backoffMs = BACKOFF_MS[state.retryCount] ?? 60000;
        state.retryCount += 1;
        await new Promise<void>((resolve) => {
          state.retryTimeoutId = setTimeout(resolve, backoffMs);
        });
        state.retryTimeoutId = null;
      }
    }
  }

  /**
   * Ticker loop: drives trailing ratchet updates AND fixed-mode SL/TP checks for
   * every open position. Watches the ticker for each unique symbol with an open
   * position and fires a real market close on breach (see `executeExit`).
   * Runs concurrently alongside the orders loop.
   */
  private async runTickerLoop(state: MonitorState): Promise<void> {
    const { userId, exchangeName } = state;

    while (!state.stopped) {
      let exchange: Exchange | null = null;
      try {
        const creds = await getExchangeCredentials(userId, exchangeName);
        if (!creds) return; // orders loop will handle stop

        const ExchangeClass = (ccxt.pro as unknown as Record<string, new (config: object) => Exchange>)[exchangeName];
        if (!ExchangeClass) return;

        exchange = new ExchangeClass({
          apiKey: creds.apiKey,
          secret: creds.secret,
          ...(creds.password ? { password: creds.password } : {}),
        });

        while (!state.stopped) {
          // Identify unique symbols across all open positions — trailing
          // positions need continuous ratchet ticks, fixed-mode positions
          // need their absolute SL/TP levels checked on every tick too
          // (no resting exchange order exists to catch these otherwise).
          const positions = await fetchOpenPositions(userId, exchangeName);

          if (positions.length === 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, PAPER_POLL_INTERVAL_MS));
            continue;
          }

          // Group by (marketType, symbol) — the same human symbol can have
          // both a spot and a swap position open if the user changed their
          // market-type setting between trades.
          const pairs = [
            ...new Map(
              positions.map((p) => {
                const marketType = (p.marketType as MarketType) ?? 'spot';
                return [`${marketType}::${p.symbol}`, { marketType, symbol: p.symbol }] as const;
              }),
            ).values(),
          ];
          const exchangeSymbolToPair = new Map(
            pairs.map((p) => [toExchangeSymbol(p.symbol, p.marketType), p]),
          );

          // Watch tickers for all open-position symbols simultaneously
          const tickers = await (exchange as unknown as {
            watchTickers: (symbols: string[]) => Promise<Record<string, { last?: number | null }>>;
          }).watchTickers([...exchangeSymbolToPair.keys()]);

          if (state.stopped) break;

          for (const [exchangeSymbol, ticker] of Object.entries(tickers)) {
            const pair = exchangeSymbolToPair.get(exchangeSymbol);
            if (!pair) continue;
            const currentPrice = ticker.last ?? 0;
            if (!currentPrice) continue;

            const symbolPositions = positions.filter(
              (p) => p.symbol === pair.symbol && ((p.marketType as MarketType) ?? 'spot') === pair.marketType,
            );

            for (const position of symbolPositions) {
              if (position.exitMode === 'trailing') {
                await applyTrailingLogic(position, currentPrice);
              } else {
                await checkFixedExit(position, currentPrice);
              }
            }
          }
        }
      } catch (err) {
        if (state.stopped) return;
        console.error(
          `[position-monitor] Ticker WS error for ${userId}/${exchangeName}:`,
          err,
        );
        try { await exchange?.close(); } catch { /* ignore */ }
        // Wait briefly before retrying — the orders loop manages the main retry counter
        await new Promise<void>((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  // -------------------------------------------------------------------------
  // Paper mode poller (REST price every 10 s)
  //
  // For trailing-mode positions: applyTrailingLogic handles all exit decisions.
  // For fixed-mode positions: direct SL/TP price comparison.
  // -------------------------------------------------------------------------

  private startPaperPoller(state: MonitorState): void {
    const { userId, exchangeName } = state;

    const poll = async () => {
      if (state.stopped) return;

      try {
        const positions = await fetchOpenPositions(userId, exchangeName);

        if (positions.length === 0) {
          this.stopMonitor(userId, exchangeName);
          return;
        }

        const ExchangeClass = (ccxt as unknown as Record<string, new (config: object) => Exchange>)[exchangeName];
        if (!ExchangeClass) return;

        const publicExchange = new ExchangeClass({});
        const pairs = [
          ...new Map(
            positions.map((p) => {
              const marketType = (p.marketType as MarketType) ?? 'spot';
              return [`${marketType}::${p.symbol}`, { marketType, symbol: p.symbol }] as const;
            }),
          ).values(),
        ];

        for (const pair of pairs) {
          let ticker: Ticker;
          try {
            ticker = await publicExchange.fetchTicker(toExchangeSymbol(pair.symbol, pair.marketType));
          } catch {
            continue;
          }

          const currentPrice = ticker.last ?? 0;
          if (!currentPrice) continue;

          const symbolPositions = positions.filter(
            (p) => p.symbol === pair.symbol && ((p.marketType as MarketType) ?? 'spot') === pair.marketType,
          );

          for (const position of symbolPositions) {
            if (position.exitMode === 'trailing') {
              await applyTrailingLogic(position, currentPrice);
            } else {
              await checkFixedExit(position, currentPrice);
            }
          }
        }
      } catch (err) {
        console.error(`[position-monitor] Paper poller error for ${userId}/${exchangeName}:`, err);
      }
    };

    void poll();
    state.paperIntervalId = setInterval(() => void poll(), PAPER_POLL_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const positionMonitor: PositionMonitorManager =
  globalThis.__positionMonitor ??
  (globalThis.__positionMonitor = new PositionMonitorManager());

if (process.env.NODE_ENV !== 'production') {
  globalThis.__positionMonitor = positionMonitor;
}
