/**
 * Notification service — Telegram and Discord alerts.
 *
 * Design notes:
 * - Failures are logged but never thrown; callers on the trade-execution
 *   hot path must use fire-and-forget (`void sendNotification(...)`).
 * - Quiet hours use the user's stored IANA timezone; UTC is the default.
 * - Critical events (kill-switch, daily-loss, SL hit) bypass quiet hours.
 * - All summary strings are capped at 280 characters.
 */

import { db } from '@/db';
import { userNotifications } from '@/db/schema';
import { eq } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NotificationEvent =
  | 'signal_new'         // New AI signal (pending approval)
  | 'signal_executed'    // Signal auto-executed
  | 'signal_rejected'    // Rejected by circuit breaker
  | 'sl_hit'            // Stop-loss hit
  | 'tp_hit'            // Take-profit hit
  | 'daily_limit'       // Daily trade limit reached
  | 'daily_loss_limit'; // Daily loss limit — kill switch activated

export interface NotificationPayload {
  event: NotificationEvent;
  symbol?: string;
  direction?: string;
  entryZone?: string;
  entryPrice?: string;
  stopLoss?: string;
  takeProfit?: string;
  positionSize?: string;
  exitPrice?: string;
  pnl?: string;
  confidence?: string;
  reason?: string;
  tradesUsed?: number;
  tradesLimit?: number;
}

// ---------------------------------------------------------------------------
// Critical-event classification
// ---------------------------------------------------------------------------

const CRITICAL_EVENTS: Set<NotificationEvent> = new Set([
  'sl_hit',
  'daily_loss_limit',
  'signal_rejected',
]);

function isCritical(event: NotificationEvent): boolean {
  return CRITICAL_EVENTS.has(event);
}

// ---------------------------------------------------------------------------
// Message formatters (max 280 chars for summary)
// ---------------------------------------------------------------------------

function truncate(str: string, max = 280): string {
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

function formatMessage(payload: NotificationPayload): string {
  const { event } = payload;

  switch (event) {
    case 'signal_new':
      return truncate(
        `📡 New Signal: ${payload.symbol ?? '?'} ${payload.direction ?? '?'} | Entry: ${payload.entryZone ?? '?'} | Confidence: ${payload.confidence ?? '?'}%`
      );
    case 'signal_executed':
      return truncate(
        `✅ Executed: ${payload.symbol ?? '?'} ${payload.direction ?? '?'} | Entry: ${payload.entryPrice ?? '?'} | SL: ${payload.stopLoss ?? '?'} | TP: ${payload.takeProfit ?? '?'} | Size: ${payload.positionSize ?? '?'}`
      );
    case 'signal_rejected':
      return truncate(
        `🚫 Signal Rejected: ${payload.symbol ?? '?'} | Reason: ${payload.reason ?? 'circuit breaker triggered'}`
      );
    case 'sl_hit':
      return truncate(
        `🔴 Stop-Loss Hit: ${payload.symbol ?? '?'} | Exit: ${payload.exitPrice ?? '?'} | P&L: ${payload.pnl ?? '?'}`
      );
    case 'tp_hit':
      return truncate(
        `🟢 Take-Profit Hit: ${payload.symbol ?? '?'} | Exit: ${payload.exitPrice ?? '?'} | P&L: ${payload.pnl ?? '?'}`
      );
    case 'daily_limit':
      return truncate(
        `⏸️ ${payload.tradesUsed ?? '?'}/${payload.tradesLimit ?? '?'} trades used today. Trading paused until midnight UTC.`
      );
    case 'daily_loss_limit':
      return truncate(
        `🛑 Max daily loss reached. Kill switch activated.`
      );
    default:
      return truncate(`📢 Trade notification event: ${event}`);
  }
}

// ---------------------------------------------------------------------------
// Sample message for test button
// ---------------------------------------------------------------------------

export function formatSampleMessage(channel: 'telegram' | 'discord'): string {
  return `✅ Test notification from Trading Hub. Your ${channel === 'telegram' ? 'Telegram' : 'Discord'} alerts are working correctly.`;
}

// ---------------------------------------------------------------------------
// Quiet-hours check
// ---------------------------------------------------------------------------

function isInQuietHours(
  quietStart: number | null | undefined,
  quietEnd: number | null | undefined,
  timezone: string | null | undefined
): boolean {
  if (quietStart == null || quietEnd == null) return false;

  const tz = timezone ?? 'UTC';

  let hourStr: string;
  try {
    hourStr = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: tz,
    }).format(new Date());
  } catch {
    // Unknown timezone — fall back to UTC
    hourStr = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: 'UTC',
    }).format(new Date());
  }

  const hour = parseInt(hourStr, 10);

  if (quietStart <= quietEnd) {
    // e.g. 23–07 wraps; simple case 09–17
    return hour >= quietStart && hour < quietEnd;
  } else {
    // Wraps midnight, e.g. quietStart=23, quietEnd=7
    return hour >= quietStart || hour < quietEnd;
  }
}

// ---------------------------------------------------------------------------
// Low-level channel senders
// ---------------------------------------------------------------------------

async function sendTelegram(
  botToken: string,
  chatId: string,
  text: string
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Telegram API error ${res.status}: ${body}`);
  }
}

async function sendDiscord(webhookUrl: string, content: string): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Discord webhook error ${res.status}: ${body}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a notification to all configured channels for a given userId.
 * Safe to fire-and-forget — failures are logged, never thrown.
 */
export async function sendNotification(
  userId: string,
  payload: NotificationPayload
): Promise<void> {
  let config: typeof userNotifications.$inferSelect | undefined;

  try {
    const rows = await db
      .select()
      .from(userNotifications)
      .where(eq(userNotifications.userId, userId))
      .limit(1);
    config = rows[0];
  } catch (err) {
    console.error('[notifications] Failed to fetch config for user', userId, err);
    return;
  }

  if (!config) return;

  const critical = isCritical(payload.event);
  const quieted =
    !critical &&
    isInQuietHours(config.quietHoursStart, config.quietHoursEnd, config.timezone);

  if (quieted) return;

  const message = formatMessage(payload);

  const sends: Promise<void>[] = [];

  if (config.telegramBotToken && config.telegramChatId) {
    sends.push(
      sendTelegram(config.telegramBotToken, config.telegramChatId, message).catch(
        (err) => console.error('[notifications] Telegram send failed:', err)
      )
    );
  }

  if (config.discordWebhookUrl) {
    sends.push(
      sendDiscord(config.discordWebhookUrl, message).catch(
        (err) => console.error('[notifications] Discord send failed:', err)
      )
    );
  }

  await Promise.allSettled(sends);
}

/**
 * Send a test notification to a specific channel for a given userId.
 * Returns { ok: true } or { ok: false, error: string }.
 */
export async function sendTestNotification(
  userId: string,
  channel: 'telegram' | 'discord'
): Promise<{ ok: boolean; error?: string }> {
  let config: typeof userNotifications.$inferSelect | undefined;

  try {
    const rows = await db
      .select()
      .from(userNotifications)
      .where(eq(userNotifications.userId, userId))
      .limit(1);
    config = rows[0];
  } catch {
    return { ok: false, error: 'Failed to load notification config' };
  }

  if (!config) {
    return { ok: false, error: 'No notification config found. Please save your settings first.' };
  }

  const message = formatSampleMessage(channel);

  try {
    if (channel === 'telegram') {
      if (!config.telegramBotToken || !config.telegramChatId) {
        return { ok: false, error: 'Telegram Bot Token and Chat ID are required' };
      }
      await sendTelegram(config.telegramBotToken, config.telegramChatId, message);
    } else {
      if (!config.discordWebhookUrl) {
        return { ok: false, error: 'Discord Webhook URL is required' };
      }
      await sendDiscord(config.discordWebhookUrl, message);
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
