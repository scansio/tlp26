import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { db } from '@/db';
import { userNotifications } from '@/db/schema';
import { eq } from 'drizzle-orm';

// GET /api/notifications — return current config (tokens omitted for security)
export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const rows = await db
    .select()
    .from(userNotifications)
    .where(eq(userNotifications.userId, userId))
    .limit(1);

  const config = rows[0] ?? null;

  if (!config) {
    return NextResponse.json(null);
  }

  // Mask sensitive tokens — only expose whether they are set
  return NextResponse.json({
    hasTelegramToken: !!config.telegramBotToken,
    hasTelegramChatId: !!config.telegramChatId,
    telegramChatId: config.telegramChatId,
    hasDiscordWebhook: !!config.discordWebhookUrl,
    quietHoursStart: config.quietHoursStart,
    quietHoursEnd: config.quietHoursEnd,
    timezone: config.timezone,
    updatedAt: config.updatedAt,
  });
}

// PUT /api/notifications — upsert config
export async function PUT(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  let body: {
    telegramBotToken?: string | null;
    telegramChatId?: string | null;
    discordWebhookUrl?: string | null;
    quietHoursStart?: number | null;
    quietHoursEnd?: number | null;
    timezone?: string | null;
  };

  try {
    body = await req.json();
  } catch {
    return new NextResponse('Invalid JSON', { status: 400 });
  }

  const values = {
    userId,
    ...(body.telegramBotToken !== undefined && { telegramBotToken: body.telegramBotToken }),
    ...(body.telegramChatId !== undefined && { telegramChatId: body.telegramChatId }),
    ...(body.discordWebhookUrl !== undefined && { discordWebhookUrl: body.discordWebhookUrl }),
    ...(body.quietHoursStart !== undefined && { quietHoursStart: body.quietHoursStart }),
    ...(body.quietHoursEnd !== undefined && { quietHoursEnd: body.quietHoursEnd }),
    ...(body.timezone !== undefined && { timezone: body.timezone }),
    updatedAt: new Date(),
  };

  await db
    .insert(userNotifications)
    .values({ ...values, userId })
    .onConflictDoUpdate({
      target: userNotifications.userId,
      set: values,
    });

  return NextResponse.json({ ok: true });
}
