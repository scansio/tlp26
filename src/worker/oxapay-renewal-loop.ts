/**
 * OxaPay renewal-emulation job.
 *
 * OxaPay has no native recurring-subscription object (unlike Stripe/
 * Paystack, whose webhooks drive renewal directly) — invoices are one-off.
 * So for every active `user_subscriptions` row with payment_provider =
 * 'oxapay' approaching its `current_period_end`, this job:
 *  1. Creates a fresh OxaPay invoice for the next period and a matching
 *     'pending' subscription_payments row (the OxaPay webhook then
 *     activates it exactly like a first-time checkout would, via
 *     activateSubscriptionFromPayment).
 *  2. If the *prior* period already lapsed unpaid (current_period_end is in
 *     the past and no payment arrived in time), marks the subscription
 *     'past_due' — src/lib/billing/plan.ts's resolvePlansForUsers falls
 *     back to the free plan for any user without a currently-valid active
 *     subscription, which is the actual "downgrade to free" effect; this
 *     job never mutates plan_id directly.
 *
 * Runs hourly (not on the 15m trading-tick cadence — this is a billing
 * concern, not a trading one) — see src/worker/schedule.ts for the
 * comparable pattern this borrows from.
 */

import { and, eq, lt, lte } from 'drizzle-orm';
import { db } from '@/db';
import { subscriptionPayments, subscriptionPlanPrices, userSubscriptions } from '@/db/schema';
import { createOxapayInvoice } from '@/lib/billing/providers/oxapay';
import { addBillingInterval, type BillingInterval } from '@/lib/billing/period';

const DEFAULT_INTERVAL_MS = 60 * 60_000; // hourly
/** Create the next invoice this far ahead of current_period_end. */
const RENEWAL_LEAD_DAYS = 3;
const RENEWAL_LEAD_MS = RENEWAL_LEAD_DAYS * 24 * 60 * 60_000;

function appBaseUrl(): string {
  return process.env.APP_BASE_URL ?? 'http://localhost:3000';
}

/**
 * Pass 1: any active oxapay subscription whose period ends within
 * RENEWAL_LEAD_DAYS, that doesn't already have a pending renewal invoice
 * outstanding, gets a fresh invoice + pending subscription_payments row.
 */
async function createUpcomingRenewalInvoices(): Promise<void> {
  const now = new Date();
  const leadCutoff = new Date(now.getTime() + RENEWAL_LEAD_MS);

  const dueSubs = await db
    .select()
    .from(userSubscriptions)
    .where(
      and(
        eq(userSubscriptions.paymentProvider, 'oxapay'),
        eq(userSubscriptions.status, 'active'),
        lte(userSubscriptions.currentPeriodEnd, leadCutoff),
      ),
    );

  for (const sub of dueSubs) {
    if (!sub.currentPeriodEnd) continue;

    // Skip if a renewal invoice for this subscription's next period is
    // already pending — avoids creating a second invoice every hourly pass
    // until the first one is paid or genuinely expires.
    const [existingPending] = await db
      .select({ id: subscriptionPayments.id })
      .from(subscriptionPayments)
      .where(
        and(
          eq(subscriptionPayments.userId, sub.userId),
          eq(subscriptionPayments.provider, 'oxapay'),
          eq(subscriptionPayments.status, 'pending'),
          eq(subscriptionPayments.planId, sub.planId),
        ),
      )
      .limit(1);
    if (existingPending) continue;

    const [price] = await db
      .select()
      .from(subscriptionPlanPrices)
      .where(and(eq(subscriptionPlanPrices.planId, sub.planId), eq(subscriptionPlanPrices.billingInterval, sub.billingInterval)))
      .limit(1);
    if (!price) {
      console.warn(
        `[worker] oxapay-renewal: no price row for planId=${sub.planId} interval=${sub.billingInterval} (userId=${sub.userId}) — skipping`,
      );
      continue;
    }

    const periodStart = sub.currentPeriodEnd;
    const periodEnd = addBillingInterval(periodStart, sub.billingInterval as BillingInterval);

    const [paymentRow] = await db
      .insert(subscriptionPayments)
      .values({
        userId: sub.userId,
        planId: sub.planId,
        billingInterval: sub.billingInterval,
        promoCodeId: sub.promoCodeId,
        provider: 'oxapay',
        providerReference: null,
        amount: price.price,
        discountApplied: '0',
        currency: price.currency,
        status: 'pending',
        periodCoveredStart: periodStart,
        periodCoveredEnd: periodEnd,
      })
      .returning();

    try {
      const invoice = await createOxapayInvoice({
        amount: Number(price.price),
        currency: price.currency,
        orderId: paymentRow.id,
        callbackUrl: `${appBaseUrl()}/api/webhooks/oxapay`,
        description: `Renewal — plan ${sub.planId} (${sub.billingInterval})`,
        // OxaPay invoices default to a 60-minute lifetime — give renewal
        // invoices the full lead window so a slow-to-pay user isn't
        // penalized for the job running earlier in the window.
        lifetimeMinutes: Math.min(RENEWAL_LEAD_DAYS * 24 * 60, 2880),
      });

      await db
        .update(subscriptionPayments)
        .set({ providerReference: invoice.trackId, checkoutUrl: invoice.paymentUrl })
        .where(eq(subscriptionPayments.id, paymentRow.id));

      console.log(`[worker] oxapay-renewal: created renewal invoice for userId=${sub.userId} track_id=${invoice.trackId}`);
    } catch (err) {
      console.error(`[worker] oxapay-renewal: invoice creation failed for userId=${sub.userId}`, err);
      await db.update(subscriptionPayments).set({ status: 'failed' }).where(eq(subscriptionPayments.id, paymentRow.id));
    }
  }
}

/**
 * Pass 2: any oxapay subscription whose period has already lapsed (past
 * current_period_end, still 'active') without a renewal ever landing is
 * marked 'past_due' — plan.ts's free-plan fallback then applies for that
 * user everywhere entitlements are checked.
 */
async function lapseOverdueSubscriptions(): Promise<void> {
  const now = new Date();

  const lapsed = await db
    .update(userSubscriptions)
    .set({ status: 'past_due', updatedAt: now })
    .where(
      and(
        eq(userSubscriptions.paymentProvider, 'oxapay'),
        eq(userSubscriptions.status, 'active'),
        // A null current_period_end makes this comparison SQL NULL (falsy in
        // WHERE), so such a row is naturally excluded rather than treated as
        // "always overdue" — no separate null guard needed.
        lt(userSubscriptions.currentPeriodEnd, now),
      ),
    )
    .returning({ userId: userSubscriptions.userId });

  for (const row of lapsed) {
    console.log(`[worker] oxapay-renewal: userId=${row.userId} subscription lapsed unpaid — marked past_due`);
  }
}

async function runOxapayRenewalPass(): Promise<void> {
  await createUpcomingRenewalInvoices();
  await lapseOverdueSubscriptions();
}

export function startOxapayRenewalLoop(): void {
  const intervalMs = process.env.OXAPAY_RENEWAL_INTERVAL_MS
    ? Number(process.env.OXAPAY_RENEWAL_INTERVAL_MS)
    : DEFAULT_INTERVAL_MS;

  const tick = () => {
    runOxapayRenewalPass().catch((err) => console.error('[worker] oxapay-renewal loop error', err));
  };

  tick();
  setInterval(tick, intervalMs);
  console.log(`[worker] oxapay-renewal loop started (every ${intervalMs}ms)`);
}
