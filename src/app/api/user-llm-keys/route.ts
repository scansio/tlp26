import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { userLlmKeys } from '@/db/schema';
import { encrypt } from '@/lib/crypto';
import { getUserLlmKeyStatus, isByokEligiblePair } from '@/lib/byok/resolve-model';

// ---------------------------------------------------------------------------
// POST /api/user-llm-keys — connect (or replace) a BYOK provider/model + key
// ---------------------------------------------------------------------------
export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { providerId, modelId, apiKey } = body as {
    providerId?: string;
    modelId?: string;
    apiKey?: string;
  };

  if (!providerId || typeof providerId !== 'string') {
    return NextResponse.json({ error: 'providerId is required' }, { status: 400 });
  }
  if (!modelId || typeof modelId !== 'string') {
    return NextResponse.json({ error: 'modelId is required' }, { status: 400 });
  }
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
    return NextResponse.json({ error: 'apiKey is required' }, { status: 400 });
  }

  // Only allow connecting a provider/model pair the admin allowlist marks as
  // active AND explicitly BYOK-eligible on both the model and its provider.
  const eligible = await isByokEligiblePair(providerId, modelId);
  if (!eligible) {
    return NextResponse.json(
      {
        error:
          'This provider/model is not available for bring-your-own-key. It must be active and BYOK-eligible on the admin allowlist.',
      },
      { status: 400 },
    );
  }

  const encryptedKey = encrypt(apiKey.trim());

  await db
    .insert(userLlmKeys)
    .values({
      userId,
      providerId,
      modelId,
      encryptedKey,
    })
    .onConflictDoUpdate({
      target: userLlmKeys.userId,
      set: { providerId, modelId, encryptedKey, updatedAt: new Date() },
    });

  const status = await getUserLlmKeyStatus(userId);
  return NextResponse.json(
    {
      connected: true,
      providerId: status?.providerId ?? providerId,
      providerName: status?.providerName ?? null,
      modelId: status?.modelId ?? modelId,
      modelIdentifier: status?.modelIdentifier ?? null,
    },
    { status: 201 },
  );
}

// ---------------------------------------------------------------------------
// GET /api/user-llm-keys — connection status only (never returns the key)
// ---------------------------------------------------------------------------
export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const status = await getUserLlmKeyStatus(userId);
  if (!status) {
    return NextResponse.json({ connected: false });
  }

  return NextResponse.json({
    connected: true,
    providerId: status.providerId,
    providerName: status.providerName,
    modelId: status.modelId,
    modelIdentifier: status.modelIdentifier,
    modelStatus: status.modelStatus,
    connectedAt: status.createdAt,
    updatedAt: status.updatedAt,
  });
}

// ---------------------------------------------------------------------------
// DELETE /api/user-llm-keys — disconnect (revert to platform default model)
// ---------------------------------------------------------------------------
export async function DELETE() {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  await db.delete(userLlmKeys).where(eq(userLlmKeys.userId, userId));

  return NextResponse.json({ deleted: true });
}
