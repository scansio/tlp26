import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { userRiskProfiles } from '@/db/schema';
import { RISK_PROFILE_EXPORT_SCHEMA_VERSION, toRiskProfileInput } from '../shared';

// ---------------------------------------------------------------------------
// GET /api/risk-profile/export
// Serializes the authenticated user's active risk profile to a versioned
// JSON document the user can download and later re-import via
// POST /api/risk-profile/import.
//
// Only fields validated by `riskProfileSchema` are included — there is no
// secret/key material on `userRiskProfiles` (API keys live encrypted on the
// separate `userExchanges` table), but `webhookToken` (a bearer credential
// for the TradingView webhook) also lives on this table and is deliberately
// excluded here since it isn't part of `riskProfileSchema`.
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

  return NextResponse.json({
    schemaVersion: RISK_PROFILE_EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    profile: toRiskProfileInput(profile),
  });
}
