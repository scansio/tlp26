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
import { auth, clerkClient } from '@clerk/nextjs/server';
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

// `req.url`'s origin is the address Next.js's own HTTP server sees — behind
// a reverse proxy (Dokploy/Traefik, any CDN) that's the internal
// container/upstream address, not the public domain, which is exactly what
// broke Paystack's callback_url. APP_BASE_URL (set explicitly, see
// .env.example) is authoritative when present; behind a proxy that forgot
// to set it, prefer the standard X-Forwarded-* headers the proxy itself
// sets over the internal origin — only fall all the way back to `req.url`
// when there's truly no proxy in front of this at all (e.g. local dev).
function appBaseUrl(req: Request): string {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL;

  const forwardedHost = req.headers.get('x-forwarded-host');
  if (forwardedHost) {
    const forwardedProto = req.headers.get('x-forwarded-proto') ?? 'https';
    return `${forwardedProto}://${forwardedHost}`;
  }

  return new URL(req.url).origin;
}

// The users table (src/db/schema.ts) is only populated by the Clerk
// `user.created` webhook — if that webhook never reached this deployment
// (misconfigured CLERK_WEBHOOK_SECRET, endpoint added after the account was
// created, etc.) the mirror row never exists at all, regardless of whether
// the account actually has a real email. Clerk itself is always the source
// of truth, so ask it first; the local mirror is only a fallback in case the
// Clerk API call itself fails transiently.
async function resolveUserEmail(userId: string): Promise<string | undefined> {
  try {
    const client = await clerkClient();
    const clerkUser = await client.users.getUser(userId);
    const clerkEmail =
      clerkUser.primaryEmailAddress?.emailAddress || clerkUser.emailAddresses[0]?.emailAddress;
    if (clerkEmail) return clerkEmail;
  } catch (err) {
    console.error('[billing/checkout] clerkClient.users.getUser failed', err);
  }

  const [userRow] = await db.select({ email: users.email }).from(users).where(eq(users.clerkUserId, userId)).limit(1);
  return userRow?.email || undefined;
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

  // Which currency to charge is a property of the *provider*, not a free
  // choice — Paystack's Nigerian card rails need NGN (that's the whole
  // reason "Card (NGN)" is its own option in the UI; many Nigerian issuers
  // decline non-NGN Paystack charges), Stripe/OxaPay bill in USD. Filtering
  // here (rather than grabbing whatever row exists for the plan/interval)
  // is what actually enforces that — previously this ignored currency
  // entirely, so a Paystack checkout silently got the USD row's raw number
  // charged as NGN (e.g. an intended $19 charge became ₦19).
  const targetCurrency = provider === 'paystack' ? 'NGN' : 'USD';

  const [price] = await db
    .select()
    .from(subscriptionPlanPrices)
    .where(
      and(
        eq(subscriptionPlanPrices.planId, planId),
        eq(subscriptionPlanPrices.billingInterval, billingInterval),
        eq(subscriptionPlanPrices.currency, targetCurrency),
      ),
    )
    .limit(1);
  if (!price) {
    return NextResponse.json(
      { error: `No ${targetCurrency} price configured for this plan/interval` },
      { status: 404 },
    );
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

  // Paystack recurring subscriptions are driven entirely by the plan code's
  // own configured amount — /transaction/initialize ignores a custom
  // `amount` whenever `plan` is also set, so an ad-hoc discount can never
  // actually apply to a Paystack recurring plan. Reject rather than silently
  // recording a discounted amount while the customer is charged full price.
  if (provider === 'paystack' && price.providerPriceId?.paystack && discountApplied > 0) {
    return NextResponse.json(
      { error: 'Promo codes are not supported for this plan on Paystack — its recurring billing uses a fixed plan-code amount.' },
      { status: 400 },
    );
  }

  const finalAmount = Math.max(0, Math.round((baseAmount - discountApplied) * 100) / 100);

  const now = new Date();
  const periodEnd = addBillingInterval(now, billingInterval as BillingInterval);

  const email = await resolveUserEmail(userId);

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
      // example.com is IANA/RFC 2606 reserved specifically for placeholder
      // use — always passes format+domain validation. `.local` (the previous
      // fallback) is a reserved special-use TLD (RFC 6762, mDNS) that
      // Paystack's own email validation rejects outright.
      email: email ?? `${userId}@example.com`,
      amountSubunits: Math.round(finalAmount * 100),
      currency: price.currency,
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
