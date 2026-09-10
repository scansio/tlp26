/**
 * POST /api/webhooks/stripe — Stripe subscription billing events.
 *
 * Verifies `Stripe-Signature` (HMAC-SHA256 of `${t}.${rawBody}` keyed by
 * STRIPE_WEBHOOK_SECRET, ±5min tolerance) before ever touching the DB.
 * See src/lib/billing/providers/stripe.ts for the documented shapes this
 * was built against; NOT live-tested (no Stripe test credentials here).
 *
 * Handled events:
 *  - checkout.session.completed — initial subscription purchase. Looks up
 *    our subscription_payments row via client_reference_id (== our payment
 *    row id, set at checkout time), then fetches the Stripe subscription
 *    object for its real current_period_start/end rather than trusting the
 *    session payload for that.
 *  - invoice.paid — renewal. subscription_data.metadata carries our
 *    subscription_payment_id only for the *first* invoice (attached at
 *    checkout); renewals have no corresponding pending payment row, so a
 *    fresh 'paid' subscription_payments row is inserted directly instead of
 *    going through activateSubscriptionFromPayment's pending->paid CAS.
 *  - customer.subscription.deleted — cancellation.
 */

import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { subscriptionPayments, userSubscriptions } from '@/db/schema';
import { verifyStripeSignature, getStripeSubscription } from '@/lib/billing/providers/stripe';
import { activateSubscriptionFromPayment, setSubscriptionStatus } from '@/lib/billing/activate-subscription';

export const runtime = 'nodejs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StripeEvent = { id: string; type: string; data: { object: any } };

export async function POST(req: Request) {
  const rawBody = await req.text();
  const sigHeader = req.headers.get('stripe-signature');
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!verifyStripeSignature(rawBody, sigHeader, secret)) {
    console.warn('[webhooks/stripe] signature verification failed');
    return Response.json({ error: 'Invalid signature' }, { status: 400 });
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as {
          id: string;
          client_reference_id: string | null;
          customer: string | null;
          subscription: string | null;
        };
        const paymentId = session.client_reference_id;
        if (!paymentId || !session.subscription) {
          console.warn('[webhooks/stripe] checkout.session.completed missing client_reference_id/subscription');
          return Response.json({ ok: true });
        }

        const subscription = await getStripeSubscription(session.subscription);

        await db
          .update(subscriptionPayments)
          .set({
            periodCoveredStart: new Date(subscription.current_period_start * 1000),
            periodCoveredEnd: new Date(subscription.current_period_end * 1000),
          })
          .where(eq(subscriptionPayments.id, paymentId));

        await activateSubscriptionFromPayment(paymentId, {
          providerCustomerId: session.customer,
          providerSubscriptionId: session.subscription,
          rawWebhookPayload: event,
        });
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object as {
          id: string;
          customer: string;
          subscription: string | null;
          amount_paid: number;
          currency: string;
          lines?: { data?: { period?: { start: number; end: number } }[] };
        };
        if (!invoice.subscription) break; // one-off invoice, not a subscription renewal

        const [existingSub] = await db
          .select()
          .from(userSubscriptions)
          .where(eq(userSubscriptions.providerSubscriptionId, invoice.subscription))
          .limit(1);
        if (!existingSub) {
          // The *first* invoice for a subscription is covered by
          // checkout.session.completed above (arrives first in normal
          // ordering) — an invoice.paid with no matching subscription yet is
          // logged and skipped rather than guessed at.
          console.warn(`[webhooks/stripe] invoice.paid for unknown subscription=${invoice.subscription}`);
          break;
        }

        const line = invoice.lines?.data?.[0];
        const periodStart = line?.period ? new Date(line.period.start * 1000) : new Date();
        const periodEnd = line?.period ? new Date(line.period.end * 1000) : existingSub.currentPeriodEnd ?? new Date();

        // Renewal — no pre-existing pending payment row (Stripe drives this
        // automatically), so insert a paid row directly and idempotently on
        // (provider, provider_reference).
        const [row] = await db
          .insert(subscriptionPayments)
          .values({
            userId: existingSub.userId,
            planId: existingSub.planId,
            billingInterval: existingSub.billingInterval,
            provider: 'stripe',
            providerReference: invoice.id,
            amount: (invoice.amount_paid / 100).toFixed(2),
            currency: invoice.currency.toUpperCase(),
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
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as { id: string; customer: string };
        const [existingSub] = await db
          .select({ userId: userSubscriptions.userId })
          .from(userSubscriptions)
          .where(eq(userSubscriptions.providerSubscriptionId, subscription.id))
          .limit(1);
        if (existingSub) {
          await setSubscriptionStatus(existingSub.userId, 'canceled');
        }
        break;
      }

      default:
        // Verified but not an event we act on — 200 so Stripe stops retrying.
        break;
    }

    return Response.json({ ok: true });
  } catch (err) {
    console.error('[webhooks/stripe] processing failed', err);
    return Response.json({ error: 'Processing failed' }, { status: 500 });
  }
}
