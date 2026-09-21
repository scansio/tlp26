import { z } from 'zod';

// ---------------------------------------------------------------------------
// Validation schemas for the subscription_plans / subscription_plan_prices /
// promo_codes admin CRUD routes (Phase 5). Mirrors the pattern in
// ai-catalog-schemas.ts — numeric Postgres columns are read/written as
// strings by drizzle-orm, so numeric inputs are transformed to fixed-point
// strings before hitting the DB.
// ---------------------------------------------------------------------------

export const subscriptionPlanInsertSchema = z.object({
  name: z.string().min(1).max(50),
  autoTradeRunsPerDay: z.number().int().min(0).optional(),
  chatMessagesPerDay: z.number().int().min(0).optional(),
  allowsByok: z.boolean().optional(),
  allowsPersonalizedMemory: z.boolean().optional(),
  jobPriority: z.number().int().optional(),
  active: z.boolean().optional(),
});

export const subscriptionPlanUpdateSchema = subscriptionPlanInsertSchema.partial();

export const providerPriceIdSchema = z.object({
  stripe: z.string().optional(),
  paystack: z.string().optional(),
});

export const subscriptionPlanPriceInsertSchema = z.object({
  planId: z.uuid(),
  billingInterval: z.enum(['monthly', 'biannual', 'yearly']),
  price: z
    .number()
    .min(0)
    .transform((v) => v.toFixed(2)),
  currency: z.string().min(1).max(10).optional(),
  providerPriceId: providerPriceIdSchema.optional(),
});

export const subscriptionPlanPriceUpdateSchema = z.object({
  planId: z.uuid().optional(),
  billingInterval: z.enum(['monthly', 'biannual', 'yearly']).optional(),
  price: z
    .number()
    .min(0)
    .transform((v) => v.toFixed(2))
    .optional(),
  currency: z.string().min(1).max(10).optional(),
  providerPriceId: providerPriceIdSchema.optional(),
});

export const promoCodeInsertSchema = z.object({
  code: z.string().min(1).max(50),
  discountType: z.enum(['percent', 'fixed']),
  discountValue: z
    .number()
    .min(0)
    .transform((v) => v.toFixed(2)),
  discountScope: z.enum(['first_period', 'recurring']).optional(),
  applicablePlanIds: z.array(z.uuid()).nullable().optional(),
  maxRedemptions: z.number().int().positive().nullable().optional(),
  startsAt: z.coerce.date().nullable().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  active: z.boolean().optional(),
});

export const promoCodeUpdateSchema = promoCodeInsertSchema.partial();
