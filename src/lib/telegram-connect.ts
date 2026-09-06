/**
 * One-click Telegram connect flow.
 *
 * The user clicks "Connect Telegram", we hand them a `t.me/<bot>?start=<token>`
 * deep link, and Telegram's `/start` webhook update carries the token back to
 * us along with the chat_id — no manual bot creation or chat ID lookup.
 */

import crypto from 'crypto';
import { db } from '@/db';
import { userNotifications } from '@/db/schema';
import { eq, and, gt } from 'drizzle-orm';

const CONNECT_TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function getTelegramBotUsername(): string | undefined {
  return process.env.TELEGRAM_BOT_USERNAME;
}

/**
 * Generates a fresh connect token for userId and stores it (upserting a row
 * if the user has no notification config yet). Returns the deep-link URL.
 */
export async function createTelegramConnectLink(userId: string): Promise<string> {
  const botUsername = getTelegramBotUsername();
  if (!botUsername) {
    throw new Error('TELEGRAM_BOT_USERNAME is not configured');
  }

  // base64url — the `start` deep-link payload only allows [A-Za-z0-9_-], max 64 chars.
  const token = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + CONNECT_TOKEN_TTL_MS);

  await db
    .insert(userNotifications)
    .values({ userId, telegramConnectToken: token, telegramConnectTokenExpiresAt: expiresAt })
    .onConflictDoUpdate({
      target: userNotifications.userId,
      set: { telegramConnectToken: token, telegramConnectTokenExpiresAt: expiresAt },
    });

  return `https://t.me/${botUsername}?start=${token}`;
}

/**
 * Consumes a connect token from an inbound `/start <token>` update: if valid
 * and unexpired, links chatId to that user's notification config and clears
 * the token. Returns the linked userId, or null if the token was invalid,
 * expired, or already used.
 */
export async function consumeTelegramConnectToken(
  token: string,
  chatId: string
): Promise<string | null> {
  const rows = await db
    .select()
    .from(userNotifications)
    .where(
      and(
        eq(userNotifications.telegramConnectToken, token),
        gt(userNotifications.telegramConnectTokenExpiresAt, new Date())
      )
    )
    .limit(1);

  const pending = rows[0];
  if (!pending) return null;

  await db
    .update(userNotifications)
    .set({
      telegramChatId: chatId,
      telegramConnectToken: null,
      telegramConnectTokenExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(eq(userNotifications.userId, pending.userId));

  return pending.userId;
}
