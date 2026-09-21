/**
 * POST /api/webhooks/oxapay — OxaPay payment callback.
 *
 * Verifies the `HMAC` header (HMAC-SHA512 of the RAW body, keyed by
 * OXAPAY_MERCHANT_API_KEY) before ever touching the DB — never trust a
 * client-side "payment succeeded" redirect. See src/lib/billing/providers/
 * oxapay.ts for the documented callback shape this was built against; NOT
 * live-tested (no sandbox credentials in this environment).
 *
 * Looks the payment row up by our own order_id (== subscription_payments.id,
 * set at checkout time), not by trusting any other field in the payload.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { subscriptionPayments } from '@/db/schema';
import { verifyOxapayCallbackSignature, isOxapayPaid, type OxapayCallbackPayload } from '@/lib/billing/providers/oxapay';
import { activateSubscriptionFromPayment } from '@/lib/billing/activate-subscription';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const rawBody = await req.text();
  const hmacHeader = req.headers.get('hmac');

  if (!verifyOxapayCallbackSignature(rawBody, hmacHeader)) {
    console.warn('[webhooks/oxapay] signature verification failed');
    return Response.json({ error: 'Invalid signature' }, { status: 400 });
  }

  let payload: OxapayCallbackPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const orderId = payload.order_id;
  if (!orderId) {
    // Verified signature but nothing we can act on — 200 so OxaPay doesn't
    // keep retrying a payload we'll never be able to match to a payment row.
    console.warn('[webhooks/oxapay] callback missing order_id', payload);
    return Response.json({ ok: true });
  }

  if (!isOxapayPaid(payload)) {
    // Terminal non-paid statuses ("Expired", "Failed") flip a still-pending
    // row so it stops looking "pending" forever — this matters for
    // src/worker/oxapay-renewal-loop.ts's existingPending guard, which
    // otherwise treats a dead invoice as still outstanding and never issues
    // a replacement. Anything else (e.g. "Paying") is a genuine in-progress
    // state — acknowledge with no state change; a later "Paid"/terminal
    // callback will resolve it.
    const terminalNonPaid = payload.status === 'Expired' || payload.status === 'Failed';
    if (terminalNonPaid) {
      await db
        .update(subscriptionPayments)
        .set({ status: payload.status === 'Expired' ? 'expired' : 'failed' })
        .where(and(eq(subscriptionPayments.id, orderId), eq(subscriptionPayments.status, 'pending')));
    }
    return Response.json({ ok: true });
  }

  try {
    const [payment] = await db
      .select({ id: subscriptionPayments.id })
      .from(subscriptionPayments)
      .where(eq(subscriptionPayments.id, orderId))
      .limit(1);

    if (!payment) {
      console.error(`[webhooks/oxapay] no subscription_payments row for order_id=${orderId}`);
      return Response.json({ ok: true }); // verified but unmatched — stop retries, nothing to act on
    }

    await activateSubscriptionFromPayment(payment.id, { rawWebhookPayload: payload });
    return Response.json({ ok: true });
  } catch (err) {
    console.error('[webhooks/oxapay] processing failed', err);
    // 500 so OxaPay retries — this is a transient/processing failure, not a
    // "we understood and there's nothing to do" case.
    return Response.json({ error: 'Processing failed' }, { status: 500 });
  }
}
