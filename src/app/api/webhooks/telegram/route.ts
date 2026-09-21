import { consumeTelegramConnectToken } from '@/lib/telegram-connect';
import { sendTelegram } from '@/lib/notifications';

export const runtime = 'nodejs';

// Telegram update shape — only the fields we read.
interface TelegramUpdate {
  message?: {
    text?: string;
    chat?: { id?: number | string };
  };
}

// POST /api/webhooks/telegram — receives updates from the shared platform bot.
//
// Always resolves 200 (even on bad/expired tokens or malformed payloads):
// Telegram aggressively retries non-2xx responses, and a 400 here would just
// get the same update redelivered for hours. Errors are surfaced to the user
// via the bot's reply text instead of the HTTP status.
export async function POST(req: Request) {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expectedSecret) {
    const gotSecret = req.headers.get('x-telegram-bot-api-secret-token');
    if (gotSecret !== expectedSecret) {
      return Response.json({ ok: true });
    }
  }

  let update: TelegramUpdate;
  try {
    update = await req.json();
  } catch {
    return Response.json({ ok: true });
  }

  const text = update.message?.text;
  const chatIdRaw = update.message?.chat?.id;
  if (!text || chatIdRaw == null || !text.startsWith('/start')) {
    return Response.json({ ok: true });
  }

  const chatId = String(chatIdRaw);
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const [, payload] = text.split(/\s+/, 2);

  if (!payload) {
    if (botToken) {
      await sendTelegram(
        botToken,
        chatId,
        'To link this chat, go to Settings → Notifications in the app and click "Connect Telegram".'
      ).catch((err) => console.error('[telegram webhook] reply failed:', err));
    }
    return Response.json({ ok: true });
  }

  const linkedUserId = await consumeTelegramConnectToken(payload, chatId).catch((err) => {
    console.error('[telegram webhook] consumeTelegramConnectToken failed:', err);
    return null;
  });

  if (botToken) {
    const reply = linkedUserId
      ? "✅ Telegram connected! You'll receive trade alerts here."
      : 'That connect link expired or was already used. Go back to Settings → Notifications and click "Connect Telegram" again.';
    await sendTelegram(botToken, chatId, reply).catch((err) =>
      console.error('[telegram webhook] reply failed:', err)
    );
  }

  return Response.json({ ok: true });
}
