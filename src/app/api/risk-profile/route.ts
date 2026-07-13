import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { userRiskProfiles } from '@/db/schema';

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------
const riskProfileSchema = z.object({
  strategies: z
    .array(z.string())
    .min(1, 'At least one strategy is required'),
  maxTradesPerDay: z
    .number()
    .int()
    .min(1)
    .max(20, 'maxTradesPerDay cannot exceed 20'),
  riskPerTradePct: z
    .number()
    .positive()
    .max(10, 'riskPerTradePct cannot exceed 10%'),
  maxDailyLossPct: z
    .number()
    .positive()
    .max(20, 'maxDailyLossPct cannot exceed 20%'),
  executionMode: z.enum(['auto', 'manual']),
  preferredTimeframes: z.array(z.string()).optional().default([]),
  allowedSymbols: z.array(z.string()).optional().default([]),
  // Slippage estimate as a percentage of notional (default 0.05%)
  slippagePct: z
    .number()
    .min(0)
    .max(1, 'slippagePct cannot exceed 1%')
    .optional()
    .default(0.05),
  // Virtual paper balance (user-configurable starting equity, default $10,000)
  paperBalanceUsd: z
    .number()
    .positive()
    .max(10_000_000, 'paperBalanceUsd cannot exceed $10M')
    .optional()
    .default(10_000),
});

type RiskProfileInput = z.infer<typeof riskProfileSchema>;

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
      allowedSymbols: data.allowedSymbols,
      slippagePct: String(data.slippagePct),
      paperBalanceUsd: String(data.paperBalanceUsd),
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
        allowedSymbols: data.allowedSymbols,
        slippagePct: String(data.slippagePct),
        paperBalanceUsd: String(data.paperBalanceUsd),
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
type ProfileRow = typeof userRiskProfiles.$inferSelect;

function toResponse(profile: ProfileRow) {
  return {
    id: profile.id,
    userId: profile.userId,
    strategies: profile.strategies,
    maxTradesPerDay: profile.maxTradesPerDay,
    riskPerTradePct: Number(profile.riskPerTradePct),
    maxDailyLossPct: Number(profile.maxDailyLossPct),
    executionMode: profile.tradingMode, // auto | manual
    preferredTimeframes: profile.preferredTimeframes,
    allowedSymbols: profile.allowedSymbols,
    slippagePct: Number(profile.slippagePct ?? '0.05'),
    // Paper trading mode fields
    paperMode: (profile.executionMode ?? 'paper') === 'paper', // true = paper, false = live
    paperBalanceUsd: Number(profile.paperBalanceUsd ?? '10000.00'),
    isActive: profile.isActive,
    updatedAt: profile.updatedAt,
  };
}
