import { z } from 'zod';
import { db } from '@/db';
import { userRiskProfiles } from '@/db/schema';

// ---------------------------------------------------------------------------
// Validation schema — shared by POST /api/risk-profile and
// POST /api/risk-profile/import. Do not redefine an equivalent schema
// elsewhere.
// ---------------------------------------------------------------------------
export const riskProfileSchema = z.object({
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
  // Minimum R:R ratio required to take a trade (default 1.5)
  minRiskRewardRatio: z
    .number()
    .min(1, 'minRiskRewardRatio must be at least 1')
    .max(10, 'minRiskRewardRatio cannot exceed 10')
    .optional()
    .default(1.5),
  marketType: z.enum(['spot', 'swap']).optional().default('spot'),
  defaultLeverage: z.number().int().min(1).max(125).optional().default(1),
  marginMode: z.enum(['cross', 'isolated']).optional().default('cross'),
  // Trailing-position profit lock: periodically materialize the software-ratcheted
  // trailing SL as a real resting exchange order once a trailing live position is
  // in profit — see src/lib/position-monitor.ts. No effect on fixed-mode positions.
  profitLockEnabled: z.boolean().optional().default(false),
  // Exit mode default for new signals: 'fixed' = SL/TP stay at their opening
  // levels; 'trailing' = SL (and, after the initial TP is hit, TP too) trails
  // price by the percentages below. A signal can still override this per-trade
  // (see src/lib/exit-config.ts) — this is only the account-level default.
  exitMode: z.enum(['fixed', 'trailing']).optional().default('fixed'),
  trailSlPct: z
    .number()
    .positive()
    .max(20, 'trailSlPct cannot exceed 20%')
    .optional()
    .default(1.0),
  trailTpPct: z
    .number()
    .positive()
    .max(50, 'trailTpPct cannot exceed 50%')
    .optional()
    .default(2.0),
  trailActivationPct: z
    .number()
    .min(0)
    .max(50, 'trailActivationPct cannot exceed 50%')
    .optional()
    .default(0.0),
});

export type RiskProfileInput = z.infer<typeof riskProfileSchema>;

export type ProfileRow = typeof userRiskProfiles.$inferSelect;

// Bump this whenever the exported `profile` shape changes in a way old
// clients can't safely interpret. POST /api/risk-profile/import rejects any
// version it doesn't explicitly know how to handle.
export const RISK_PROFILE_EXPORT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Response/serialization helpers
// ---------------------------------------------------------------------------

export function toResponse(profile: ProfileRow) {
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
    minRiskRewardRatio: Number(profile.minRiskRewardRatio ?? '1.50'),
    marketType: profile.marketType ?? 'spot',
    defaultLeverage: profile.defaultLeverage ?? 1,
    marginMode: profile.marginMode ?? 'cross',
    profitLockEnabled: profile.profitLockEnabled ?? false,
    exitMode: profile.exitMode ?? 'fixed',
    trailSlPct: Number(profile.trailSlPct ?? '1.000'),
    trailTpPct: Number(profile.trailTpPct ?? '2.000'),
    trailActivationPct: Number(profile.trailActivationPct ?? '0.000'),
    // Paper trading mode fields
    paperMode: (profile.executionMode ?? 'paper') === 'paper', // true = paper, false = live
    paperBalanceUsd: Number(profile.paperBalanceUsd ?? '10000.00'),
    isActive: profile.isActive,
    updatedAt: profile.updatedAt,
  };
}

// Maps a DB row to the exact shape of `riskProfileSchema` (used by the
// import/export routes) — deliberately narrower than toResponse(), which
// also includes id/userId/isActive/updatedAt/paperMode metadata that aren't
// part of the importable risk-profile payload. Note `webhookToken` and
// `killSwitchActive`/`maxOpenPositions` (also on this same table) are
// intentionally excluded since none of them are part of `riskProfileSchema`.
export function toRiskProfileInput(profile: ProfileRow): RiskProfileInput {
  return {
    strategies: profile.strategies ?? [],
    maxTradesPerDay: profile.maxTradesPerDay ?? 5,
    riskPerTradePct: Number(profile.riskPerTradePct ?? '1.00'),
    maxDailyLossPct: Number(profile.maxDailyLossPct ?? '3.00'),
    executionMode: (profile.tradingMode as 'auto' | 'manual') ?? 'manual',
    preferredTimeframes: profile.preferredTimeframes ?? [],
    allowedSymbols: profile.allowedSymbols ?? [],
    slippagePct: Number(profile.slippagePct ?? '0.05'),
    paperBalanceUsd: Number(profile.paperBalanceUsd ?? '10000.00'),
    minRiskRewardRatio: Number(profile.minRiskRewardRatio ?? '1.50'),
    marketType: (profile.marketType as 'spot' | 'swap') ?? 'spot',
    defaultLeverage: profile.defaultLeverage ?? 1,
    marginMode: (profile.marginMode as 'cross' | 'isolated') ?? 'cross',
    profitLockEnabled: profile.profitLockEnabled ?? false,
    exitMode: (profile.exitMode as 'fixed' | 'trailing') ?? 'fixed',
    trailSlPct: Number(profile.trailSlPct ?? '1.000'),
    trailTpPct: Number(profile.trailTpPct ?? '2.000'),
    trailActivationPct: Number(profile.trailActivationPct ?? '0.000'),
  };
}

// ---------------------------------------------------------------------------
// Full-overwrite upsert — used by POST /api/risk-profile/import only. Unlike
// the settings-page POST /api/risk-profile route (which only overwrites a
// field when the caller actually sent it, to protect onboarding chat's
// partial-payload upserts), an import document is always a complete,
// previously-exported profile, so every field is safe to overwrite.
// ---------------------------------------------------------------------------
export async function upsertFullRiskProfile(userId: string, data: RiskProfileInput) {
  const [upserted] = await db
    .insert(userRiskProfiles)
    .values({
      userId,
      strategies: data.strategies,
      maxTradesPerDay: data.maxTradesPerDay,
      riskPerTradePct: String(data.riskPerTradePct),
      maxDailyLossPct: String(data.maxDailyLossPct),
      tradingMode: data.executionMode,
      preferredTimeframes: data.preferredTimeframes,
      allowedSymbols: data.allowedSymbols,
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
        allowedSymbols: data.allowedSymbols,
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
      },
    })
    .returning();

  return upserted;
}
