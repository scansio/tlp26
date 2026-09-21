/**
 * Promo code validation + discount computation — server-side only. The
 * discounted amount is always computed here from discount_type/
 * discount_value, never trusted from the client. redemptions_used is
 * intentionally NOT incremented here — only the webhook handlers increment
 * it, once payment is actually confirmed (see incrementPromoRedemption
 * below), so an abandoned checkout never burns a redemption.
 */

import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '@/db';
import { promoCodes } from '@/db/schema';

type PromoCodeRow = typeof promoCodes.$inferSelect;

export interface PromoValidationResult {
  valid: boolean;
  reason?: string;
  promo?: PromoCodeRow;
}

export async function validatePromoCode(code: string, planId: string, now: Date = new Date()): Promise<PromoValidationResult> {
  const [promo] = await db.select().from(promoCodes).where(eq(promoCodes.code, code)).limit(1);

  if (!promo) return { valid: false, reason: 'Promo code not found' };
  if (!promo.active) return { valid: false, reason: 'Promo code is not active' };
  if (promo.startsAt && promo.startsAt.getTime() > now.getTime()) {
    return { valid: false, reason: 'Promo code is not active yet' };
  }
  if (promo.expiresAt && promo.expiresAt.getTime() < now.getTime()) {
    return { valid: false, reason: 'Promo code has expired' };
  }
  if (promo.maxRedemptions != null && promo.redemptionsUsed >= promo.maxRedemptions) {
    return { valid: false, reason: 'Promo code redemption limit reached' };
  }
  const applicable = promo.applicablePlanIds;
  if (applicable && applicable.length > 0 && !applicable.includes(planId)) {
    return { valid: false, reason: 'Promo code is not applicable to this plan' };
  }

  return { valid: true, promo };
}

/** Discount amount for one billing period, clamped to [0, baseAmount]. */
export function computeDiscountAmount(baseAmount: number, promo: PromoCodeRow): number {
  const value = Number(promo.discountValue);
  const raw = promo.discountType === 'percent' ? baseAmount * (value / 100) : value;
  const clamped = Math.max(0, Math.min(baseAmount, raw));
  return Math.round(clamped * 100) / 100;
}

/**
 * Atomically increments redemptions_used, guarded by max_redemptions so a
 * race between two webhook deliveries can't over-redeem a capped code.
 * Called only from a webhook handler on the pending->paid transition.
 */
export async function incrementPromoRedemption(promoCodeId: string): Promise<void> {
  await db
    .update(promoCodes)
    .set({ redemptionsUsed: sql`${promoCodes.redemptionsUsed} + 1`, updatedAt: new Date() })
    .where(
      and(
        eq(promoCodes.id, promoCodeId),
        or(isNull(promoCodes.maxRedemptions), lt(promoCodes.redemptionsUsed, promoCodes.maxRedemptions)),
      ),
    );
}
