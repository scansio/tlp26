/**
 * Position Monitor — WebSocket-based SL/TP fill detection.
 *
 * Architecture notes:
 * - Singleton pattern attached to `globalThis` (HMR-safe, same as db pool).
 * - One WebSocket connection per {userId, exchangeName} pair using ccxt.pro.
 * - Paper mode: REST price polling every 10 s instead of WebSocket.
 * - Exponential backoff on reconnect: 1s, 2s, 4s, 8s, 16s, 32s, 60s (×4), then alert.
 * - Connection closes gracefully when all open positions for that user+exchange are gone.
 *
 * IMPORTANT — runtime requirement:
 * WebSocket connections require a long-running Node.js process. This monitor
 * will NOT persist across cold-starts on serverless runtimes (e.g. Vercel).
 * A persistent dyno/container or a cron-tick approach via /api/cron/position-monitor
 * is required for production. The cron endpoint is provided to re-bootstrap
 * connections on each tick, but true real-time behaviour needs a worker process.
 */

import ccxt, { type Exchange, type Ticker } from 'ccxt';
import { eq, and } from 'drizzle-orm';
import { db } from '@/db';
import {
  tradeExecutions,
  tradeSignals,
  userExchanges,
} from '@/db/schema';
import { decrypt } from '@/lib/crypto';
import { sendNotification } from '@/lib/notifications';

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
}

interface MonitorState {
  userId: string;
  exchangeName: string;
  mode: 'live' | 'paper';
  active: boolean;
  retryCount: number;
  retryTimeoutId: ReturnType<typeof setTimeout> | null;
  paperIntervalId: ReturnType<typeof setInterval> | null;
  // abort flag — set to true to stop the watch loop
  stopped: boolean;
}

// ---------------------------------------------------------------------------
// Exponential backoff schedule (ms): 1s, 2s, 4s, 8s, 16s, 32s, 60s×4
// Max 10 retries, then alert.
// ---------------------------------------------------------------------------

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000];
const MAX_RETRIES = 10;
const PAPER_POLL_INTERVAL_MS = 10_000; // 10 seconds
const PRICE_TOLERANCE_PCT = 0.005;     // 0.5% — fills within this band count as SL/TP

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

  // Liquidation signals from exchange metadata
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
): number {
  return (exitPrice - entryPrice) * positionSize;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function fetchOpenPositions(
  userId: string,
  exchangeName: string,
): Promise<OpenPosition[]> {
  // Join trade_executions with trade_signals to get SL/TP levels
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
      mode: tradeExecutions.mode,
      positionSize: tradeExecutions.positionSize,
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

  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    exchangeName: r.exchangeName,
    symbol: r.symbol,
    exchangeOrderId: r.exchangeOrderId,
    exitOrderId: r.exitOrderId,
    entryPrice: r.entryPrice,
    stopLoss: r.stopLoss ?? null,
    takeProfit: r.takeProfit ?? null,
    mode: r.mode,
    positionSize: r.positionSize,
  }));
}

async function closePosition(
  executionId: string,
  exitPrice: number,
  fillType: FillType,
): Promise<void> {
  await db
    .update(tradeExecutions)
    .set({
      exitPrice: String(exitPrice),
      exitAt: new Date(),
      status: 'closed',
      fillType,
    })
    .where(eq(tradeExecutions.id, executionId));
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
// Manager class
// ---------------------------------------------------------------------------

class PositionMonitorManager {
  // key: `${userId}::${exchangeName}`
  private monitors = new Map<string, MonitorState>();

  private monitorKey(userId: string, exchangeName: string): string {
    return `${userId}::${exchangeName}`;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Ensure a monitor is running for each (userId, exchangeName) pair that has
   * open positions. Call from the cron tick or after a trade is placed.
   */
  async syncMonitors(): Promise<void> {
    // Fetch all currently open positions grouped by user+exchange
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

    // Stop monitors whose user+exchange no longer has open positions
    for (const [key, state] of this.monitors.entries()) {
      if (!seen.has(key) && state.active) {
        this.stopMonitor(state.userId, state.exchangeName);
      }
    }
  }

  /**
   * Start a monitor for a specific user+exchange. No-op if already running.
   */
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

  /**
   * Stop a specific monitor gracefully.
   */
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

  /**
   * Return status of all active monitors (for the /api/monitor endpoint).
   */
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
  // -------------------------------------------------------------------------

  private startWebSocketLoop(state: MonitorState): void {
    void this.runWebSocketLoop(state);
  }

  private async runWebSocketLoop(state: MonitorState): Promise<void> {
    const { userId, exchangeName } = state;

    while (!state.stopped) {
      let exchange: Exchange | null = null;
      try {
        const creds = await getExchangeCredentials(userId, exchangeName);
        if (!creds) {
          console.warn(
            `[position-monitor] No active exchange credentials for ${userId}/${exchangeName} — stopping monitor`,
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

        // Reset retry count on successful connection
        state.retryCount = 0;

        // Watch orders indefinitely — ccxt.pro watchOrders reconnects internally
        // but throws on fatal errors; we catch and reconnect at this level too.
        while (!state.stopped) {
          const orders = await exchange.watchOrders();

          // Check if still active after awaiting
          if (state.stopped) break;

          const positions = await fetchOpenPositions(userId, exchangeName);
          if (positions.length === 0) {
            // No more open positions — close WebSocket and remove monitor
            await exchange.close();
            this.stopMonitor(userId, exchangeName);
            return;
          }

          // Build lookup maps for fast matching
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

            // Match by either the entry order ID or the exit order ID
            const orderId = order.id ?? '';
            const position =
              byExchangeOrderId.get(orderId) ??
              byExitOrderId.get(orderId);

            if (!position) continue;

            const fillType = classifyFill(
              fillPrice,
              position.stopLoss ? parseFloat(position.stopLoss) : null,
              position.takeProfit ? parseFloat(position.takeProfit) : null,
              order.type ?? '',
              (order.info as Record<string, string>)?.reason ?? '',
            );

            const entryPrice = position.entryPrice ? parseFloat(position.entryPrice) : 0;
            const positionSize = position.positionSize ? parseFloat(position.positionSize) : 0;
            const pnl = computePnl(entryPrice, fillPrice, positionSize);

            await closePosition(position.id, fillPrice, fillType);

            // Fire notification — determine the event type
            const notifEvent =
              fillType === 'sl_hit'    ? 'sl_hit' as const :
              fillType === 'tp_hit'    ? 'tp_hit' as const :
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
          `[position-monitor] WebSocket error for ${userId}/${exchangeName} (retry ${state.retryCount}/${MAX_RETRIES}):`,
          err,
        );

        try {
          await exchange?.close();
        } catch {
          // ignore close errors
        }

        if (state.retryCount >= MAX_RETRIES) {
          state.active = false;
          state.stopped = true;
          this.monitors.delete(this.monitorKey(userId, exchangeName));

          void sendNotification(userId, {
            event: 'monitor_disconnected',
            symbol: exchangeName,
          });
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

  // -------------------------------------------------------------------------
  // Paper mode poller (REST price every 10 s)
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

        // Use a single unauthenticated ccxt instance for price fetching
        const ExchangeClass = (ccxt as unknown as Record<string, new (config: object) => Exchange>)[exchangeName];
        if (!ExchangeClass) return;

        const publicExchange = new ExchangeClass({});

        // Deduplicate symbols
        const symbols = [...new Set(positions.map((p) => p.symbol))];

        for (const symbol of symbols) {
          let ticker: Ticker;
          try {
            ticker = await publicExchange.fetchTicker(symbol);
          } catch {
            continue; // skip on fetch error
          }

          const currentPrice = ticker.last ?? 0;
          if (!currentPrice) continue;

          const symbolPositions = positions.filter((p) => p.symbol === symbol);

          for (const position of symbolPositions) {
            const stopLoss = position.stopLoss ? parseFloat(position.stopLoss) : null;
            const takeProfit = position.takeProfit ? parseFloat(position.takeProfit) : null;

            let fillType: FillType | null = null;

            if (stopLoss !== null && currentPrice <= stopLoss) {
              fillType = 'sl_hit';
            } else if (takeProfit !== null && currentPrice >= takeProfit) {
              fillType = 'tp_hit';
            }

            if (!fillType) continue;

            const entryPrice = position.entryPrice ? parseFloat(position.entryPrice) : 0;
            const positionSize = position.positionSize ? parseFloat(position.positionSize) : 0;
            const pnl = computePnl(entryPrice, currentPrice, positionSize);

            await closePosition(position.id, currentPrice, fillType);

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

    // Run immediately, then on interval
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
