import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db } from '@/db';
import { aiModels, aiProviders } from '@/db/schema';

// ---------------------------------------------------------------------------
// GET /api/user-llm-keys/eligible-models — the BYOK-eligible provider/model
// options a signed-in (non-admin) user can pick from when connecting their
// own key. Read-only, no keys involved.
// ---------------------------------------------------------------------------
export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const rows = await db
    .select({
      providerId: aiProviders.id,
      providerName: aiProviders.name,
      modelId: aiModels.id,
      modelIdentifier: aiModels.modelId,
      contextMax: aiModels.contextMax,
      capabilities: aiModels.capabilities,
    })
    .from(aiModels)
    .innerJoin(aiProviders, eq(aiModels.providerId, aiProviders.id))
    .where(
      and(
        eq(aiModels.status, 'active'),
        eq(aiModels.byokEligible, true),
        eq(aiProviders.byokEligible, true),
      ),
    )
    .orderBy(aiProviders.name, aiModels.modelId);

  return NextResponse.json({ models: rows });
}
