import { auth } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '@/db';
import { userRiskProfiles } from '@/db/schema';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Look up existing profile
  const profiles = await db
    .select({ webhookToken: userRiskProfiles.webhookToken })
    .from(userRiskProfiles)
    .where(eq(userRiskProfiles.userId, userId))
    .limit(1);

  let webhookToken: string;

  if (profiles.length === 0 || profiles[0].webhookToken == null) {
    // Generate and persist a token on first access (upsert-on-read)
    webhookToken = nanoid(32);
    await db
      .insert(userRiskProfiles)
      .values({ userId, webhookToken })
      .onConflictDoUpdate({
        target: userRiskProfiles.userId,
        set: { webhookToken, updatedAt: new Date() },
      });
  } else {
    webhookToken = profiles[0].webhookToken;
  }

  // Build the webhook URL from the request origin
  const origin = new URL(req.url).origin;
  const webhookUrl = `${origin}/api/webhooks/tradingview`;

  return Response.json({ webhookUrl, webhookToken });
}
