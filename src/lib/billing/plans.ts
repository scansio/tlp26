/**
 * Read-side helpers for the customer-facing pricing/billing page.
 *
 * The displayed price for a given (plan, interval) must match what
 * POST /api/billing/checkout actually charges. The checkout route selects a
 * price row with `where(planId, billingInterval)` and no currency filter —
 * if more than one currency is ever configured for the same interval, this
 * mirrors that exact query shape so the two can never disagree.
 */

import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { subscriptionPlans, subscriptionPlanPrices } from '@/db/schema';
import type { BillingInterval } from './period';

export interface PlanPrice {
  billingInterval: BillingInterval;
  price: string;
  currency: string;
}

export interface PlanWithPrices {
  id: string;
  name: string;
  autoTradeRunsPerDay: number;
  chatMessagesPerDay: number;
  allowsByok: boolean;
  allowsPersonalizedMemory: boolean;
  jobPriority: number;
  prices: PlanPrice[];
}

const INTERVAL_ORDER: BillingInterval[] = ['monthly', 'biannual', 'yearly'];

export async function listActivePlansWithPrices(): Promise<PlanWithPrices[]> {
  const [plans, prices] = await Promise.all([
    db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.active, true))
      .orderBy(subscriptionPlans.jobPriority),
    db.select().from(subscriptionPlanPrices),
  ]);

  const firstPriceByPlanInterval = new Map<string, (typeof prices)[number]>();
  for (const price of prices) {
    const key = `${price.planId}:${price.billingInterval}`;
    if (!firstPriceByPlanInterval.has(key)) {
      firstPriceByPlanInterval.set(key, price);
    }
  }

  return plans.map((plan) => ({
    id: plan.id,
    name: plan.name,
    autoTradeRunsPerDay: plan.autoTradeRunsPerDay,
    chatMessagesPerDay: plan.chatMessagesPerDay,
    allowsByok: plan.allowsByok,
    allowsPersonalizedMemory: plan.allowsPersonalizedMemory,
    jobPriority: plan.jobPriority,
    prices: INTERVAL_ORDER.flatMap((interval) => {
      const row = firstPriceByPlanInterval.get(`${plan.id}:${interval}`);
      return row ? [{ billingInterval: interval, price: row.price, currency: row.currency }] : [];
    }),
  }));
}
