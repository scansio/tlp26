/**
 * POST /api/webhooks/paystack — Paystack charge/subscription events.
 *
 * Verifies `x-paystack-signature` (HMAC-SHA512 of the RAW body, keyed by
 * PAYSTACK_SECRET_KEY) before ever touching the DB. See
 * src/lib/billing/providers/paystack.ts for the documented shape this was
 * built against; NOT live-tested (no Paystack test credentials here).
 *
 * Handled event:
 *  - charge.success — covers both the initial checkout charge (reference ==
 *    our subscription_payments.id, set at checkout time — activated via the
 *    normal pending->paid path) and a plan-driven renewal charge Paystack
 *    initiates on its own (no matching pending row — a fresh 'paid' row is
 *    inserted directly, keyed idempotently on (provider, provider_reference)
 *    == the charge's own reference). Renewal charges are matched to a user
 *    via `data.customer.customer_code` against user_subscriptions
 *    .providerCustomerId — NOT `data.subscription_code`, which
 *    charge.success does not reliably carry (that field lives on
 *    subscription and invoice events instead); customer_code is stored on
 *    providerCustomerId from the very first successful charge.
 *
 * Deferred (not implemented — see PR description): Paystack's dedicated
 * subscription lifecycle events (subscription.create/disable/not_renew) for
 * clean plan-code-driven cancellation; charge.success alone drives renewal
 * activation here, which is sufficient for the payment/entitlement side but
 * doesn't capture every subscription-status nuance those events would.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { subscriptionPayments, userSubscriptions } from '@/db/schema';
import { verifyPaystackSignature, type PaystackChargeSuccessEvent } from '@/lib/billing/providers/paystack';
import { activateSubscriptionFromPayment } from '@/lib/billing/activate-subscription';
import { addBillingInterval } from '@/lib/billing/period';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const rawBody = await req.text();
  const sigHeader = req.headers.get('x-paystack-signature');

  if (!verifyPaystackSignature(rawBody, sigHeader)) {
    console.warn('[webhooks/paystack] signature verification failed');
    return Response.json({ error: 'Invalid signature' }, { status: 400 });
  }

  let event: PaystackChargeSuccessEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (event.event !== 'charge.success') {
    // Verified but not an event we act on — 200 so Paystack stops retrying.
    return Response.json({ ok: true });
  }

  const { reference, amount, currency } = event.data;

  try {
    const [pendingPayment] = await db
      .select()
      .from(subscriptionPayments)
      .where(eq(subscriptionPayments.id, reference))
      .limit(1);

    if (pendingPayment) {
      // Initial checkout charge — reference is our own payment row id.
      await activateSubscriptionFromPayment(pendingPayment.id, {
        providerCustomerId: event.data.customer?.customer_code ?? undefined,
        providerSubscriptionId: event.data.subscription_code ?? undefined,
        rawWebhookPayload: event,
      });
      return Response.json({ ok: true });
    }

    // No pending row for this reference — a plan-driven renewal charge
    // Paystack initiated on its own. charge.success does not reliably carry
    // subscription_code (that's a subscription.*/invoice.* event field), so
    // match on the customer_code stored on user_subscriptions
    // .providerCustomerId from the very first successful charge instead.
    const customerCode = event.data.customer?.customer_code;
    if (!customerCode) {
      console.warn(`[webhooks/paystack] charge.success with unknown reference=${reference} and no customer_code`);
      return Response.json({ ok: true });
    }

    const [existingSub] = await db
      .select()
      .from(userSubscriptions)
      .where(and(eq(userSubscriptions.providerCustomerId, customerCode), eq(userSubscriptions.paymentProvider, 'paystack')))
      .limit(1);
    if (!existingSub) {
      console.warn(`[webhooks/paystack] charge.success for unknown customer_code=${customerCode}`);
      return Response.json({ ok: true });
    }

    const periodStart = existingSub.currentPeriodEnd ?? new Date();
    const periodEnd = addBillingInterval(periodStart, existingSub.billingInterval as 'monthly' | 'biannual' | 'yearly');

    const [row] = await db
      .insert(subscriptionPayments)
      .values({
        userId: existingSub.userId,
        planId: existingSub.planId,
        billingInterval: existingSub.billingInterval,
        provider: 'paystack',
        providerReference: reference,
        amount: (amount / 100).toFixed(2),
        currency: currency?.toUpperCase() ?? 'NGN',
        status: 'paid',
        periodCoveredStart: periodStart,
        periodCoveredEnd: periodEnd,
        rawWebhookPayload: event,
      })
      .onConflictDoNothing({ target: [subscriptionPayments.provider, subscriptionPayments.providerReference] })
      .returning();

    if (row) {
      await db
        .update(userSubscriptions)
        .set({
          status: 'active',
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          nextBillingAt: periodEnd,
          updatedAt: new Date(),
        })
        .where(eq(userSubscriptions.userId, existingSub.userId));
    }

    return Response.json({ ok: true });
  } catch (err) {
    console.error('[webhooks/paystack] processing failed', err);
    return Response.json({ error: 'Processing failed' }, { status: 500 });
  }
}
