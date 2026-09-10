import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { userRiskProfiles } from '@/db/schema';
import { normalizeSymbolList } from '@/lib/symbols';
import { riskProfileSchema, toResponse, type RiskProfileInput } from './shared';

// ---------------------------------------------------------------------------
// GET /api/risk-profile
// Returns the authenticated user's risk profile; 404 if none exists.
// ---------------------------------------------------------------------------
export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [profile] = await db
    .select()
    .from(userRiskProfiles)
    .where(eq(userRiskProfiles.userId, userId))
    .limit(1);

  if (!profile || !profile.isActive) {
    return NextResponse.json(
      { error: 'Risk profile not found. Please complete the setup flow.' },
      { status: 404 },
    );
  }

  return NextResponse.json(toResponse(profile));
}

// ---------------------------------------------------------------------------
// POST /api/risk-profile
// Creates or updates (upserts) the risk profile for the authenticated user.
// ---------------------------------------------------------------------------
export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = riskProfileSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const data: RiskProfileInput = parsed.data;

  // Several fields below default when omitted (see schema) — fine for a fresh
  // insert, but this route is a full upsert and at least one caller (the
  // onboarding SetupChat fallback, which POSTs a parsed profile JSON straight
  // from a chat message) only ever sends the 8 fields that flow collect —
  // never these settings-page-only ones. On conflict, only overwrite a field
  // when the caller actually sent it — otherwise a value set from the
  // risk-profile page gets silently reset to its default the next time
  // onboarding chat re-saves the profile.
  const bodyKeys = new Set(
    typeof body === 'object' && body !== null ? Object.keys(body) : [],
  );
  const provided = (key: string) => bodyKeys.has(key);
  const allowedSymbols = normalizeSymbolList(data.allowedSymbols);

  const [upserted] = await db
    .insert(userRiskProfiles)
    .values({
      userId,
      strategies: data.strategies,
      maxTradesPerDay: data.maxTradesPerDay,
      riskPerTradePct: String(data.riskPerTradePct),
      maxDailyLossPct: String(data.maxDailyLossPct),
      // executionMode in schema stores paper/live; tradingMode stores auto/manual
      tradingMode: data.executionMode,
      preferredTimeframes: data.preferredTimeframes,
      allowedSymbols,
      slippagePct: String(data.slippagePct),
      paperBalanceUsd: String(data.paperBalanceUsd),
      minRiskRewardRatio: String(data.minRiskRewardRatio),
      marketType: data.marketType,
      defaultLeverage: data.defaultLeverage,
      marginMode: data.marginMode,
      profitLockEnabled: data.profitLockEnabled,
      exitMode: data.exitMode,
      trailSlPct: String(data.trailSlPct),
      trailTpPct: String(data.trailTpPct),
      trailActivationPct: String(data.trailActivationPct),
      isActive: true,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: userRiskProfiles.userId,
      set: {
        strategies: data.strategies,
        maxTradesPerDay: data.maxTradesPerDay,
        riskPerTradePct: String(data.riskPerTradePct),
        maxDailyLossPct: String(data.maxDailyLossPct),
        tradingMode: data.executionMode,
        preferredTimeframes: data.preferredTimeframes,
        allowedSymbols,
        slippagePct: String(data.slippagePct),
        paperBalanceUsd: String(data.paperBalanceUsd),
        minRiskRewardRatio: String(data.minRiskRewardRatio),
        ...(provided('marketType') ? { marketType: data.marketType } : {}),
        ...(provided('defaultLeverage') ? { defaultLeverage: data.defaultLeverage } : {}),
        ...(provided('marginMode') ? { marginMode: data.marginMode } : {}),
        ...(provided('profitLockEnabled') ? { profitLockEnabled: data.profitLockEnabled } : {}),
        ...(provided('exitMode') ? { exitMode: data.exitMode } : {}),
        ...(provided('trailSlPct') ? { trailSlPct: String(data.trailSlPct) } : {}),
        ...(provided('trailTpPct') ? { trailTpPct: String(data.trailTpPct) } : {}),
        ...(provided('trailActivationPct') ? { trailActivationPct: String(data.trailActivationPct) } : {}),
        isActive: true,
        updatedAt: new Date(),
      },
    })
    .returning();

  return NextResponse.json(toResponse(upserted), { status: 200 });
}

// ---------------------------------------------------------------------------
// DELETE /api/risk-profile
// Soft-deletes the profile (sets isActive=false). Blocks trading until re-setup.
// ---------------------------------------------------------------------------
export async function DELETE() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [existing] = await db
    .select()
    .from(userRiskProfiles)
    .where(eq(userRiskProfiles.userId, userId))
    .limit(1);

  if (!existing) {
    return NextResponse.json(
      { error: 'Risk profile not found' },
      { status: 404 },
    );
  }

  const [deleted] = await db
    .update(userRiskProfiles)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(userRiskProfiles.userId, userId))
    .returning();

  return NextResponse.json({
    message: 'Risk profile deactivated. Trading is suspended until re-setup.',
    profile: toResponse(deleted),
  });
}

