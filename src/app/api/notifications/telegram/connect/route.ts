import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { createTelegramConnectLink } from '@/lib/telegram-connect';

// POST /api/notifications/telegram/connect — mint a one-click Telegram deep link
export async function POST() {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  try {
    const url = await createTelegramConnectLink(userId);
    return NextResponse.json({ url });
  } catch (err) {
    console.error('[telegram/connect] Failed to create connect link:', err);
    return NextResponse.json(
      { error: 'Telegram connect is not configured on this server.' },
      { status: 503 }
    );
  }
}
