import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { sendTestNotification } from '@/lib/notifications';

// POST /api/notifications/test — send a sample message to a given channel
export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  let body: { channel?: string };
  try {
    body = await req.json();
  } catch {
    return new NextResponse('Invalid JSON', { status: 400 });
  }

  const channel = body.channel;
  if (channel !== 'telegram' && channel !== 'discord') {
    return new NextResponse('channel must be "telegram" or "discord"', { status: 400 });
  }

  const result = await sendTestNotification(userId, channel);

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
