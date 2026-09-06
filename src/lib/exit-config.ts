/**
 * Shared SL/TP exit-mode resolution: signal-level override → user risk
 * profile default → 'fixed'. Single source of truth so execute-trade-tool
 * (deciding whether to place resting protective orders at entry) and
 * position-monitor (deciding trailing vs fixed handling per open position)
 * never disagree on which mode a position is in.
 */

import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { tradeSignals, userRiskProfiles } from '@/db/schema';

export interface ExitConfig {
  exitMode: string; // 'fixed' | 'trailing'
  trailSlPct: number;
  trailTpPct: number;
  trailActivationPct: number;
  // Profit lock — user-level only, no per-signal override (see position-monitor.ts).
  profitLockEnabled: boolean;
}

const DEFAULT_TRAIL_SL_PCT = 1.0;
const DEFAULT_TRAIL_TP_PCT = 2.0;
const DEFAULT_TRAIL_ACTIVATION_PCT = 0.0;

export async function fetchUserExitConfig(userId: string): Promise<ExitConfig> {
  const [profile] = await db
    .select({
      exitMode: userRiskProfiles.exitMode,
      trailSlPct: userRiskProfiles.trailSlPct,
      trailTpPct: userRiskProfiles.trailTpPct,
      trailActivationPct: userRiskProfiles.trailActivationPct,
      profitLockEnabled: userRiskProfiles.profitLockEnabled,
    })
    .from(userRiskProfiles)
    .where(eq(userRiskProfiles.userId, userId))
    .limit(1);

  return {
    exitMode: profile?.exitMode ?? 'fixed',
    trailSlPct: profile?.trailSlPct ? Number(profile.trailSlPct) : DEFAULT_TRAIL_SL_PCT,
    trailTpPct: profile?.trailTpPct ? Number(profile.trailTpPct) : DEFAULT_TRAIL_TP_PCT,
    trailActivationPct: profile?.trailActivationPct
      ? Number(profile.trailActivationPct)
      : DEFAULT_TRAIL_ACTIVATION_PCT,
    profitLockEnabled: profile?.profitLockEnabled ?? false,
  };
}

/** Resolve the effective exit mode for a single signal: signal override → user default. */
export async function resolveSignalExitMode(
  userId: string,
  signalId: string | null,
): Promise<string> {
  const userConfig = await fetchUserExitConfig(userId);
  if (!signalId) return userConfig.exitMode;

  const [signal] = await db
    .select({ exitMode: tradeSignals.exitMode })
    .from(tradeSignals)
    .where(eq(tradeSignals.id, signalId))
    .limit(1);

  return signal?.exitMode ?? userConfig.exitMode;
}
