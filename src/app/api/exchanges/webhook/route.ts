import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { nanoid } from 'nanoid';
import { db } from '@/db';
import { userRiskProfiles } from '@/db/schema';

// ---------------------------------------------------------------------------
// POST /api/exchanges/webhook — regenerate the user's TradingView webhook token
// ---------------------------------------------------------------------------
export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const newToken = nanoid(32);

  await db
    .insert(userRiskProfiles)
    .values({ userId, webhookToken: newToken })
    .onConflictDoUpdate({
      target: userRiskProfiles.userId,
      set: { webhookToken: newToken, updatedAt: new Date() },
    });

  const origin = new URL(req.url).origin;
  const webhookUrl = `${origin}/api/webhooks/tradingview`;

  return NextResponse.json({ webhookToken: newToken, webhookUrl });
}
