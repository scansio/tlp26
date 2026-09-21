/**
 * Resolves the effective subscription_plans row for a user: their active
 * user_subscriptions row (if any, and not past its current_period_end) or
 * the 'free' plan as fallback — this fallback *is* the OxaPay
 * renewal-emulation job's "downgrade to free" (see
 * src/worker/oxapay-renewal-loop.ts): it never mutates user_subscriptions
 * .planId, it just lets the subscription lapse (status/period fields) so
 * every caller here naturally falls back.
 *
 * Used by: src/worker/eligibility.ts + src/worker/job-queue.ts (auto-trade
 * run quota + job priority), src/app/api/chat/route.ts (chat message
 * quota), src/worker/tick.ts (auto_trade_jobs.priority).
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { subscriptionPlans, userSubscriptions } from '@/db/schema';

export interface ResolvedPlan {
  id: string;
  name: string;
  autoTradeRunsPerDay: number;
  chatMessagesPerDay: number;
  allowsByok: boolean;
  allowsPersonalizedMemory: boolean;
  jobPriority: number;
}

type SubscriptionPlanRow = typeof subscriptionPlans.$inferSelect;

function toResolvedPlan(row: SubscriptionPlanRow): ResolvedPlan {
  return {
    id: row.id,
    name: row.name,
    autoTradeRunsPerDay: row.autoTradeRunsPerDay,
    chatMessagesPerDay: row.chatMessagesPerDay,
    allowsByok: row.allowsByok,
    allowsPersonalizedMemory: row.allowsPersonalizedMemory,
    jobPriority: row.jobPriority,
  };
}

// Hard-coded only as a last-resort degrade path if the free plan row hasn't
// been seeded yet (migration not applied) — matches the caps documented for
// the free tier so metering still fails safe rather than throwing.
const UNSEEDED_FREE_FALLBACK: ResolvedPlan = {
  id: 'unseeded-free-fallback',
  name: 'free',
  autoTradeRunsPerDay: 3,
  chatMessagesPerDay: 15,
  allowsByok: false,
  allowsPersonalizedMemory: false,
  jobPriority: 0,
};

async function fetchFreePlan(): Promise<ResolvedPlan> {
  const [row] = await db
    .select()
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.name, 'free'))
    .limit(1);
  return row ? toResolvedPlan(row) : UNSEEDED_FREE_FALLBACK;
}

/** Batched resolution — one query for any number of users, instead of N. */
export async function resolvePlansForUsers(userIds: string[]): Promise<Map<string, ResolvedPlan>> {
  const result = new Map<string, ResolvedPlan>();
  if (userIds.length === 0) return result;

  const freePlan = await fetchFreePlan();
  const now = new Date();

  const rows = await db
    .select({
      userId: userSubscriptions.userId,
      currentPeriodEnd: userSubscriptions.currentPeriodEnd,
      plan: subscriptionPlans,
    })
    .from(userSubscriptions)
    .innerJoin(subscriptionPlans, eq(userSubscriptions.planId, subscriptionPlans.id))
    .where(and(inArray(userSubscriptions.userId, userIds), eq(userSubscriptions.status, 'active')));

  const activeByUser = new Map(rows.map((r) => [r.userId, r]));

  for (const userId of userIds) {
    const row = activeByUser.get(userId);
    // A null currentPeriodEnd (subscription still being provisioned) is
    // treated as valid rather than silently downgrading the user.
    const stillValid = row && (row.currentPeriodEnd == null || row.currentPeriodEnd.getTime() > now.getTime());
    result.set(userId, stillValid ? toResolvedPlan(row.plan) : freePlan);
  }

  return result;
}

export async function resolvePlanForUser(userId: string): Promise<ResolvedPlan> {
  const map = await resolvePlansForUsers([userId]);
  return map.get(userId) ?? (await fetchFreePlan());
}
