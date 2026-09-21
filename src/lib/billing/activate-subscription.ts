/**
 * Shared "payment confirmed -> activate/renew subscription" write path used
 * by all three webhook handlers (OxaPay/Stripe/Paystack). Idempotent against
 * webhook redelivery: the initial UPDATE is a compare-and-swap (`WHERE
 * status <> 'paid'`) — a redelivered webhook for an already-processed
 * payment updates zero rows and the function is a no-op, so a promo code's
 * redemptions_used can never be double-counted and a renewal can't be
 * applied twice for the same payment event.
 */

import { and, eq, ne } from 'drizzle-orm';
import { db } from '@/db';
import { subscriptionPayments, userSubscriptions } from '@/db/schema';
import { incrementPromoRedemption } from './promo';
import { addBillingInterval, type BillingInterval } from './period';

export interface ActivateSubscriptionOptions {
  providerCustomerId?: string | null;
  providerSubscriptionId?: string | null;
  /** Raw webhook payload, stored on the payment row for audit/debugging. */
  rawWebhookPayload?: unknown;
}

/**
 * Marks a `subscription_payments` row 'paid' and upserts the matching
 * `user_subscriptions` row (one row per user — active plan/interval/period
 * fields updated in place). Returns false (no-op) if the payment row is
 * missing, was already processed, or is missing plan/interval data.
 */
export async function activateSubscriptionFromPayment(
  paymentId: string,
  opts: ActivateSubscriptionOptions = {},
): Promise<boolean> {
  // Compare-and-swap: only the delivery that actually flips pending/failed
  // -> paid gets a row back and proceeds to upsert user_subscriptions /
  // increment the promo redemption. Any concurrent or later redelivery of
  // the same webhook event updates zero rows here.
  const setValues: Partial<typeof subscriptionPayments.$inferInsert> = { status: 'paid' };
  if (opts.rawWebhookPayload !== undefined) setValues.rawWebhookPayload = opts.rawWebhookPayload;

  const [claimed] = await db
    .update(subscriptionPayments)
    .set(setValues)
    .where(and(eq(subscriptionPayments.id, paymentId), ne(subscriptionPayments.status, 'paid')))
    .returning();

  if (!claimed) {
    return false; // missing row, or already processed by an earlier delivery
  }
  if (!claimed.planId || !claimed.billingInterval) {
    console.error(`[billing] activateSubscriptionFromPayment: payment ${paymentId} missing planId/billingInterval`);
    return false;
  }

  const periodStart = claimed.periodCoveredStart ?? new Date();
  const periodEnd =
    claimed.periodCoveredEnd ?? addBillingInterval(periodStart, claimed.billingInterval as BillingInterval);

  await db
    .insert(userSubscriptions)
    .values({
      userId: claimed.userId,
      planId: claimed.planId,
      billingInterval: claimed.billingInterval,
      status: 'active',
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      nextBillingAt: periodEnd,
      paymentProvider: claimed.provider,
      providerCustomerId: opts.providerCustomerId ?? undefined,
      providerSubscriptionId: opts.providerSubscriptionId ?? undefined,
      promoCodeId: claimed.promoCodeId,
    })
    .onConflictDoUpdate({
      target: userSubscriptions.userId,
      set: {
        planId: claimed.planId,
        billingInterval: claimed.billingInterval,
        status: 'active',
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        nextBillingAt: periodEnd,
        paymentProvider: claimed.provider,
        ...(opts.providerCustomerId ? { providerCustomerId: opts.providerCustomerId } : {}),
        ...(opts.providerSubscriptionId ? { providerSubscriptionId: opts.providerSubscriptionId } : {}),
        promoCodeId: claimed.promoCodeId,
        updatedAt: new Date(),
      },
    });

  if (claimed.promoCodeId) {
    await incrementPromoRedemption(claimed.promoCodeId);
  }

  return true;
}

/** Marks a user's subscription canceled/past_due (Stripe subscription.deleted, OxaPay lapse, etc). */
export async function setSubscriptionStatus(userId: string, status: 'past_due' | 'canceled'): Promise<void> {
  await db
    .update(userSubscriptions)
    .set({ status, updatedAt: new Date() })
    .where(eq(userSubscriptions.userId, userId));
}
