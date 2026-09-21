/**
 * Usage metering — two independent daily counters (auto-trade runs, chat
 * messages), reset on a calendar-day (UTC) boundary. One usage_counters row
 * per (user, UTC day); `periodStart` is that day's date string.
 *
 * Increment only when a run/message actually happens, never on a
 * rejected/skipped attempt — callers must call the check function first and
 * only increment after the corresponding action actually goes through (see
 * src/worker/job-queue.ts's processJob and src/app/api/chat/route.ts).
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db';
import { usageCounters } from '@/db/schema';
import type { ResolvedPlan } from './plan';

export interface DailyUsage {
  autoTradeRunsUsed: number;
  chatMessagesUsed: number;
}

const EMPTY_USAGE: DailyUsage = { autoTradeRunsUsed: 0, chatMessagesUsed: 0 };

/** UTC calendar day boundary, as 'YYYY-MM-DD'. */
export function utcPeriodStart(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

export async function getUsageToday(userId: string): Promise<DailyUsage> {
  const periodStart = utcPeriodStart();
  const [row] = await db
    .select({
      autoTradeRunsUsed: usageCounters.autoTradeRunsUsed,
      chatMessagesUsed: usageCounters.chatMessagesUsed,
    })
    .from(usageCounters)
    .where(and(eq(usageCounters.userId, userId), eq(usageCounters.periodStart, periodStart)))
    .limit(1);
  return row ?? EMPTY_USAGE;
}

/** Batched read — one query for any number of users, instead of N. */
export async function getUsageForUsersToday(userIds: string[]): Promise<Map<string, DailyUsage>> {
  const result = new Map<string, DailyUsage>();
  if (userIds.length === 0) return result;

  const periodStart = utcPeriodStart();
  const rows = await db
    .select({
      userId: usageCounters.userId,
      autoTradeRunsUsed: usageCounters.autoTradeRunsUsed,
      chatMessagesUsed: usageCounters.chatMessagesUsed,
    })
    .from(usageCounters)
    .where(and(inArray(usageCounters.userId, userIds), eq(usageCounters.periodStart, periodStart)));

  for (const row of rows) {
    result.set(row.userId, { autoTradeRunsUsed: row.autoTradeRunsUsed, chatMessagesUsed: row.chatMessagesUsed });
  }
  return result;
}

export async function incrementAutoTradeRunUsage(userId: string): Promise<void> {
  const periodStart = utcPeriodStart();
  await db
    .insert(usageCounters)
    .values({ userId, periodStart, autoTradeRunsUsed: 1, chatMessagesUsed: 0 })
    .onConflictDoUpdate({
      target: [usageCounters.userId, usageCounters.periodStart],
      set: { autoTradeRunsUsed: sql`${usageCounters.autoTradeRunsUsed} + 1`, updatedAt: new Date() },
    });
}

export async function incrementChatMessageUsage(userId: string): Promise<void> {
  const periodStart = utcPeriodStart();
  await db
    .insert(usageCounters)
    .values({ userId, periodStart, autoTradeRunsUsed: 0, chatMessagesUsed: 1 })
    .onConflictDoUpdate({
      target: [usageCounters.userId, usageCounters.periodStart],
      set: { chatMessagesUsed: sql`${usageCounters.chatMessagesUsed} + 1`, updatedAt: new Date() },
    });
}

export function hasAutoTradeQuota(usage: DailyUsage, plan: ResolvedPlan): boolean {
  return usage.autoTradeRunsUsed < plan.autoTradeRunsPerDay;
}

export function hasChatQuota(usage: DailyUsage, plan: ResolvedPlan): boolean {
  return usage.chatMessagesUsed < plan.chatMessagesPerDay;
}
