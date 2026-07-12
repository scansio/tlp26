import { auth } from '@clerk/nextjs/server';
import { nanoid } from 'nanoid';
import { db } from '@/db';
import { userRiskProfiles } from '@/db/schema';

export const runtime = 'nodejs';

export async function POST() {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const newToken = nanoid(32);

  // Upsert the risk profile row with the new token
  await db
    .insert(userRiskProfiles)
    .values({ userId, webhookToken: newToken })
    .onConflictDoUpdate({
      target: userRiskProfiles.userId,
      set: { webhookToken: newToken, updatedAt: new Date() },
    });

  return Response.json({ ok: true, webhookToken: newToken });
}
