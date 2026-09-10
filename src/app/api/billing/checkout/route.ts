/**
 * POST /api/billing/checkout — creates a provider checkout (OxaPay invoice /
 * Stripe Checkout Session / Paystack transaction) for a chosen plan +
 * billing interval, applying a promo code server-side.
 *
 * The discount is always computed here from promo_codes.discount_type/
 * discount_value — never trusted from the client. A `subscription_payments`
 * row is inserted 'pending' *before* calling the provider (so its own id can
 * be handed to the provider as order_id/client_reference_id/reference for
 * idempotent webhook lookup), then updated with the provider's own
 * reference once the provider call returns. redemptions_used on the promo
 * code is NOT incremented here — only the webhook handlers increment it,
 * once payment is actually confirmed, so an abandoned checkout doesn't burn
 * a redemption.
 */

import { and, eq } from 'drizzle-orm';
import { auth } from '@clerk/nextjs/server';
import { z } from 'zod';
import { NextResponse } from 'next/server';
import { db } from '@/db';
import { subscriptionPlans, subscriptionPlanPrices, subscriptionPayments, users } from '@/db/schema';
import { validatePromoCode, computeDiscountAmount } from '@/lib/billing/promo';
import { addBillingInterval, type BillingInterval } from '@/lib/billing/period';
import { createOxapayInvoice } from '@/lib/billing/providers/oxapay';
import { createStripeCheckoutSession, createStripeCoupon } from '@/lib/billing/providers/stripe';
import { initializePaystackTransaction } from '@/lib/billing/providers/paystack';

export const runtime = 'nodejs';

const checkoutSchema = z.object({
  planId: z.uuid(),
  billingInterval: z.enum(['monthly', 'biannual', 'yearly']),
  provider: z.enum(['oxapay', 'stripe', 'paystack']),
  promoCode: z.string().optional(),
  successUrl: z.string().optional(),
  cancelUrl: z.string().optional(),
});

function appBaseUrl(req: Request): string {
  return process.env.APP_BASE_URL ?? new URL(req.url).origin;
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: z.infer<typeof checkoutSchema>;
  try {
    body = checkoutSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid input', issues: err.issues }, { status: 400 });
    }
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { planId, billingInterval, provider, promoCode } = body;

  const [plan] = await db
    .select()
    .from(subscriptionPlans)
    .where(and(eq(subscriptionPlans.id, planId), eq(subscriptionPlans.active, true)))
    .limit(1);
  if (!plan) {
    return NextResponse.json({ error: 'Plan not found or inactive' }, { status: 404 });
  }

  const [price] = await db
    .select()
    .from(subscriptionPlanPrices)
    .where(and(eq(subscriptionPlanPrices.planId, planId), eq(subscriptionPlanPrices.billingInterval, billingInterval)))
    .limit(1);
  if (!price) {
    return NextResponse.json({ error: 'No price configured for this plan/interval' }, { status: 404 });
  }

  const baseAmount = Number(price.price);
  let discountApplied = 0;
  let promoCodeId: string | null = null;
  let promoDiscountScope: 'first_period' | 'recurring' | null = null;

  if (promoCode) {
    const validation = await validatePromoCode(promoCode, planId);
    if (!validation.valid || !validation.promo) {
      return NextResponse.json({ error: validation.reason ?? 'Invalid promo code' }, { status: 400 });
    }
    discountApplied = computeDiscountAmount(baseAmount, validation.promo);
    promoCodeId = validation.promo.id;
    promoDiscountScope = validation.promo.discountScope as 'first_period' | 'recurring';
  }

  const finalAmount = Math.max(0, Math.round((baseAmount - discountApplied) * 100) / 100);

  const now = new Date();
  const periodEnd = addBillingInterval(now, billingInterval as BillingInterval);

  const [userRow] = await db.select({ email: users.email }).from(users).where(eq(users.clerkUserId, userId)).limit(1);
  const email = userRow?.email ?? undefined;

  const [paymentRow] = await db
    .insert(subscriptionPayments)
    .values({
      userId,
      planId,
      billingInterval,
      promoCodeId,
      provider,
      providerReference: null,
      amount: finalAmount.toFixed(2),
      discountApplied: discountApplied.toFixed(2),
      currency: price.currency,
      status: 'pending',
      periodCoveredStart: now,
      periodCoveredEnd: periodEnd,
    })
    .returning();

  const base = appBaseUrl(req);
  const callbackUrl = `${base}/api/webhooks/${provider}`;
  const successUrl = body.successUrl ?? `${base}/billing?checkout=success`;
  const cancelUrl = body.cancelUrl ?? `${base}/billing?checkout=cancelled`;

  try {
    if (provider === 'oxapay') {
      const invoice = await createOxapayInvoice({
        amount: finalAmount,
        currency: price.currency,
        orderId: paymentRow.id,
        callbackUrl,
        returnUrl: successUrl,
        description: `${plan.name} plan (${billingInterval})`,
        email,
      });
      await db
        .update(subscriptionPayments)
        .set({ providerReference: invoice.trackId, checkoutUrl: invoice.paymentUrl })
        .where(eq(subscriptionPayments.id, paymentRow.id));
      return NextResponse.json({ checkoutUrl: invoice.paymentUrl, paymentId: paymentRow.id });
    }

    if (provider === 'stripe') {
      const stripePriceId = price.providerPriceId?.stripe;
      if (!stripePriceId) {
        return NextResponse.json({ error: 'No Stripe price configured for this plan/interval' }, { status: 400 });
      }

      // Discounting on a fixed recurring Price needs an ad-hoc coupon —
      // 'once' for first_period scope, 'forever' for recurring scope.
      let couponId: string | undefined;
      if (discountApplied > 0) {
        couponId = await createStripeCoupon({
          amountOffCents: Math.round(discountApplied * 100),
          currency: price.currency.toLowerCase(),
          duration: promoDiscountScope === 'recurring' ? 'forever' : 'once',
        });
      }

      const session = await createStripeCheckoutSession({
        priceId: stripePriceId,
        successUrl,
        cancelUrl,
        paymentRowId: paymentRow.id,
        customerEmail: email,
        couponId,
      });
      await db
        .update(subscriptionPayments)
        .set({ providerReference: session.id, checkoutUrl: session.url })
        .where(eq(subscriptionPayments.id, paymentRow.id));
      return NextResponse.json({ checkoutUrl: session.url, paymentId: paymentRow.id });
    }

    // paystack
    const paystackPlanCode = price.providerPriceId?.paystack;
    const reference = paymentRow.id;
    const transaction = await initializePaystackTransaction({
      email: email ?? `${userId}@unknown.local`,
      amountSubunits: Math.round(finalAmount * 100),
      reference,
      callbackUrl,
      metadata: { subscription_payment_id: paymentRow.id, user_id: userId, plan_id: planId },
      planCode: paystackPlanCode,
    });
    await db
      .update(subscriptionPayments)
      .set({ providerReference: transaction.reference, checkoutUrl: transaction.authorizationUrl })
      .where(eq(subscriptionPayments.id, paymentRow.id));
    return NextResponse.json({ checkoutUrl: transaction.authorizationUrl, paymentId: paymentRow.id });
  } catch (err) {
    console.error('[billing/checkout] provider call failed', err);
    await db
      .update(subscriptionPayments)
      .set({ status: 'failed' })
      .where(eq(subscriptionPayments.id, paymentRow.id));
    return NextResponse.json({ error: 'Failed to create checkout session' }, { status: 502 });
  }
}
