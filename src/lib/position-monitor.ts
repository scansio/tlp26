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
 * Live mode trailing (ccxt.pro):
 * - watchTicker drives continuous ratchet updates on each price tick.
 * - watchOrders handles fill detection and position close on fixed-mode exits.
 * - For trailing positions in live mode, exchange SL/TP orders remain at their original
 *   levels as a safety net. Server-side trailing fires a market close when the ratcheted
 *   SL/TP is breached (via watchTicker), ahead of the exchange's fixed order.
 *   Full cancel/replace of exchange orders is outside this implementation scope.
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
  userRiskProfiles,
  trailAuditLog,
} from '@/db/schema';
import { decrypt } from '@/lib/crypto';
import { sendNotification } from '@/lib/notifications';
import { accruePublisherFee } from '@/lib/publisher-fee';

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
  entryPrice: string | null;
  stopLoss: string | null;
  takeProfit: string | null;
  mode: string | null;
  positionSize: string | null;
  direction: string | null;
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

interface TrailingConfig {
  exitMode: string;
  trailSlPct: number;
  trailTpPct: number;
  trailActivationPct: number;
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

// Default trailing % values (mirrors schema defaults)
const DEFAULT_TRAIL_SL_PCT = 1.0;
const DEFAULT_TRAIL_TP_PCT = 2.0;
const DEFAULT_TRAIL_ACTIVATION_PCT = 0.0;

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
  return direction === 'LONG'
    ? (exitPrice - entryPrice) * positionSize
    : (entryPrice - exitPrice) * positionSize;
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

async function fetchUserTrailingConfig(userId: string): Promise<TrailingConfig> {
  const [profile] = await db
    .select({
      exitMode: userRiskProfiles.exitMode,
      trailSlPct: userRiskProfiles.trailSlPct,
      trailTpPct: userRiskProfiles.trailTpPct,
      trailActivationPct: userRiskProfiles.trailActivationPct,
    })
    .from(userRiskProfiles)
    .where(eq(userRiskProfiles.userId, userId))
    .limit(1);

  return {
    exitMode: profile?.exitMode ?? 'fixed',
    trailSlPct: profile?.trailSlPct ? Number(profile.trailSlPct) : DEFAULT_TRAIL_SL_PCT,
    trailTpPct: profile?.trailTpPct ? Number(profile.trailTpPct) : DEFAULT_TRAIL_TP_PCT,
    trailActivationPct: profile?.trailActivationPct
      ? Number(profile.trailActivationPct)
      : DEFAULT_TRAIL_ACTIVATION_PCT,
  };
}

async function fetchOpenPositions(
  userId: string,
  exchangeName: string,
): Promise<OpenPosition[]> {
  const userConfig = await fetchUserTrailingConfig(userId);

  const rows = await db
    .select({
      id: tradeExecutions.id,
      userId: tradeExecutions.userId,
      exchangeName: tradeExecutions.exchangeName,
      symbol: tradeExecutions.symbol,
      exchangeOrderId: tradeExecutions.exchangeOrderId,
      exitOrderId: tradeExecutions.exitOrderId,
      entryPrice: tradeExecutions.entryPrice,
      stopLoss: tradeSignals.stopLoss,
      takeProfit: tradeSignals.takeProfit,
      direction: tradeSignals.direction,
      mode: tradeExecutions.mode,
      positionSize: tradeExecutions.positionSize,
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
      entryPrice: r.entryPrice,
      stopLoss: r.stopLoss ?? null,
      takeProfit: r.takeProfit ?? null,
      direction: r.direction ?? null,
      mode: r.mode,
      positionSize: r.positionSize,
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
): Promise<void> {
  await db
    .update(tradeExecutions)
    .set({
      exitPrice: String(exitPrice),
      exitAt: new Date(),
      status: 'closed',
      fillType,
      realizedPnl: String(realizedPnl),
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
      const positionSize = position.positionSize ? parseFloat(position.positionSize) : 0;
      const pnl = computePnl(entry, currentPrice, positionSize, direction);
      await closePosition(position.id, currentPrice, 'sl_hit', pnl);
      void sendNotification(position.userId, {
        event: 'sl_hit',
        symbol: position.symbol,
        exitPrice: String(currentPrice),
        pnl: pnl.toFixed(4),
      });
      return true;
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
          const positionSize = position.positionSize ? parseFloat(position.positionSize) : 0;
          const pnl = computePnl(entry, currentPrice, positionSize, direction);
          await closePosition(position.id, currentPrice, 'tp_hit', pnl);
          void sendNotification(position.userId, {
            event: 'tp_hit',
            symbol: position.symbol,
            exitPrice: String(currentPrice),
            pnl: pnl.toFixed(4),
          });
          return true;
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

          for (const order of orders) {
            if (order.status !== 'closed') continue;

            const fillPrice = order.average ?? order.price ?? 0;
            if (!fillPrice) continue;

            const orderId = order.id ?? '';
            const position =
              byExchangeOrderId.get(orderId) ??
              byExitOrderId.get(orderId);

            if (!position) continue;

            // For trailing positions, the ticker loop handles exit logic.
            // We still record the fill here in case the exchange SL/TP fired
            // before our server-side trail (safety net).
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
   * Ticker loop: drives trailing ratchet updates for all trailing-mode positions.
   * Watches the ticker for each unique symbol that has a trailing-mode open position.
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
          // Identify unique symbols for trailing positions
          const positions = await fetchOpenPositions(userId, exchangeName);
          const trailingPositions = positions.filter((p) => p.exitMode === 'trailing');

          if (trailingPositions.length === 0) {
            // No trailing positions — wait before rechecking
            await new Promise<void>((resolve) => setTimeout(resolve, PAPER_POLL_INTERVAL_MS));
            continue;
          }

          const symbols = [...new Set(trailingPositions.map((p) => p.symbol))];

          // Watch tickers for all trailing symbols simultaneously
          const tickers = await (exchange as unknown as {
            watchTickers: (symbols: string[]) => Promise<Record<string, { last?: number | null }>>;
          }).watchTickers(symbols);

          if (state.stopped) break;

          for (const [symbol, ticker] of Object.entries(tickers)) {
            const currentPrice = ticker.last ?? 0;
            if (!currentPrice) continue;

            const symbolPositions = trailingPositions.filter(
              (p) => p.symbol === symbol,
            );

            for (const position of symbolPositions) {
              await applyTrailingLogic(position, currentPrice);
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
        const symbols = [...new Set(positions.map((p) => p.symbol))];

        for (const symbol of symbols) {
          let ticker: Ticker;
          try {
            ticker = await publicExchange.fetchTicker(symbol);
          } catch {
            continue;
          }

          const currentPrice = ticker.last ?? 0;
          if (!currentPrice) continue;

          const symbolPositions = positions.filter((p) => p.symbol === symbol);

          for (const position of symbolPositions) {
            // Trailing mode: delegate entirely to applyTrailingLogic
            if (position.exitMode === 'trailing') {
              await applyTrailingLogic(position, currentPrice);
              continue;
            }

            // Fixed mode: compare current price against absolute SL/TP levels
            const stopLoss = position.stopLoss ? parseFloat(position.stopLoss) : null;
            const takeProfit = position.takeProfit ? parseFloat(position.takeProfit) : null;
            const direction = position.direction ?? 'LONG';

            let fillType: FillType | null = null;

            if (stopLoss !== null) {
              const slHit = direction === 'LONG'
                ? currentPrice <= stopLoss
                : currentPrice >= stopLoss;
              if (slHit) fillType = 'sl_hit';
            }

            if (!fillType && takeProfit !== null) {
              const tpHit = direction === 'LONG'
                ? currentPrice >= takeProfit
                : currentPrice <= takeProfit;
              if (tpHit) fillType = 'tp_hit';
            }

            if (!fillType) continue;

            const entryPrice = position.entryPrice ? parseFloat(position.entryPrice) : 0;
            const positionSize = position.positionSize ? parseFloat(position.positionSize) : 0;
            const pnl = computePnl(entryPrice, currentPrice, positionSize, direction);

            await closePosition(position.id, currentPrice, fillType, pnl);

            const notifEvent = fillType === 'sl_hit' ? 'sl_hit' as const : 'tp_hit' as const;
            void sendNotification(userId, {
              event: notifEvent,
              symbol: position.symbol,
              exitPrice: String(currentPrice),
              pnl: pnl.toFixed(4),
            });
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
