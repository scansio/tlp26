/**
 * BYOK (bring your own model key) model resolution for market-chat-agent.
 *
 * Looks up a user's connected key (user_llm_keys) and, if it's still valid —
 * the joined ai_models row is 'active' and both ai_models.byokEligible and
 * ai_providers.byokEligible are true — returns a per-request model config
 * carrying the user's own decrypted API key. Returns null when no key is
 * connected or it's no longer eligible, so the caller can fall back to the
 * platform's defaultModel.
 *
 * The key is decrypted here, at the point of use, and must not be logged or
 * cached beyond this call.
 */

import { eq, and } from 'drizzle-orm';
import { db } from '@/db';
import { userLlmKeys, aiModels, aiProviders } from '@/db/schema';
import { decrypt } from '@/lib/crypto';

// Key used on the Mastra RequestContext to carry the requesting user's id
// through to market-chat-agent's dynamic model resolver. Set server-side in
// src/app/api/chat/route.ts from Clerk's auth() — never trust a client-
// supplied value for this.
export const BYOK_USER_ID_CONTEXT_KEY = 'byokUserId';

export interface ByokModelConfig {
  id: `${string}/${string}`;
  apiKey: string;
}

export async function resolveByokModel(userId: string | undefined | null): Promise<ByokModelConfig | null> {
  if (!userId) return null;

  const [row] = await db
    .select({
      encryptedKey: userLlmKeys.encryptedKey,
      modelIdentifier: aiModels.modelId,
      modelStatus: aiModels.status,
      modelByokEligible: aiModels.byokEligible,
      providerByokEligible: aiProviders.byokEligible,
    })
    .from(userLlmKeys)
    .innerJoin(aiModels, eq(userLlmKeys.modelId, aiModels.id))
    .innerJoin(aiProviders, eq(userLlmKeys.providerId, aiProviders.id))
    .where(eq(userLlmKeys.userId, userId))
    .limit(1);

  if (!row) return null;

  if (row.modelStatus !== 'active' || !row.modelByokEligible || !row.providerByokEligible) {
    // Key was connected while the model/provider was eligible but the admin
    // allowlist has since changed (deprecated, disabled, etc.) — do not use it.
    return null;
  }

  if (!row.modelIdentifier.includes('/')) {
    // ai_models.modelId is expected to be a full router id ("provider/model");
    // guard against a malformed row rather than passing garbage to the router.
    return null;
  }

  let apiKey: string;
  try {
    apiKey = decrypt(row.encryptedKey);
  } catch (err) {
    console.error('[byok/resolve-model] failed to decrypt user LLM key:', err);
    return null;
  }

  return {
    id: row.modelIdentifier as `${string}/${string}`,
    apiKey,
  };
}

// ---------------------------------------------------------------------------
// Read-only status for UI/API responses — never exposes the key itself.
// ---------------------------------------------------------------------------
export async function getUserLlmKeyStatus(userId: string) {
  const [row] = await db
    .select({
      id: userLlmKeys.id,
      providerId: userLlmKeys.providerId,
      providerName: aiProviders.name,
      modelId: userLlmKeys.modelId,
      modelIdentifier: aiModels.modelId,
      modelStatus: aiModels.status,
      createdAt: userLlmKeys.createdAt,
      updatedAt: userLlmKeys.updatedAt,
    })
    .from(userLlmKeys)
    .innerJoin(aiModels, eq(userLlmKeys.modelId, aiModels.id))
    .innerJoin(aiProviders, eq(userLlmKeys.providerId, aiProviders.id))
    .where(eq(userLlmKeys.userId, userId))
    .limit(1);

  return row ?? null;
}

// ---------------------------------------------------------------------------
// Validates that a (providerId, modelId) pair is BYOK-eligible before
// accepting a connect request — active model, byokEligible on both the
// model and its provider.
// ---------------------------------------------------------------------------
export async function isByokEligiblePair(providerId: string, modelId: string): Promise<boolean> {
  const [row] = await db
    .select({
      status: aiModels.status,
      modelByokEligible: aiModels.byokEligible,
      providerByokEligible: aiProviders.byokEligible,
    })
    .from(aiModels)
    .innerJoin(aiProviders, eq(aiModels.providerId, aiProviders.id))
    .where(and(eq(aiModels.id, modelId), eq(aiModels.providerId, providerId)))
    .limit(1);

  if (!row) return false;
  return row.status === 'active' && !!row.modelByokEligible && !!row.providerByokEligible;
}
