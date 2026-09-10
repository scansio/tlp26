/**
 * Minimal Stripe REST client — no `stripe` SDK dependency (none is
 * currently installed in this repo; adding one wasn't judged worth a new
 * dependency for the handful of calls this phase needs). Talks to the
 * documented Stripe API surface directly via fetch + form-encoding.
 *
 * NOT live-tested — no Stripe test/sandbox credentials in this environment.
 * Built strictly against Stripe's publicly documented API/webhook shapes:
 *  - Checkout Session: POST /v1/checkout/sessions (form-encoded, Bearer
 *    secret key), mode=subscription, line_items[0][price]=<price id>,
 *    line_items[0][quantity]=1, client_reference_id=<our payment row id>.
 *  - Coupons: POST /v1/coupons — used to apply a promo code's discount to a
 *    recurring Price (a fixed Price object can't have an ad-hoc amount).
 *  - Signature: header `Stripe-Signature` = `t=<unix>,v1=<hex>`; verify by
 *    HMAC-SHA256 of `${t}.${rawBody}` keyed by STRIPE_WEBHOOK_SECRET,
 *    reject if the timestamp is more than 5 minutes old.
 */

import crypto from 'node:crypto';

const STRIPE_API_BASE = 'https://api.stripe.com/v1';

// Pinned explicitly rather than left to the account's dashboard default —
// Stripe API versions from 2025-03-31 ("basil") onward moved
// current_period_start/end off the Subscription object onto
// items.data[].current_period_* and restructured Invoice's subscription
// reference, which would silently break getStripeSubscription's shape below.
// This code is written against the pre-basil shape.
const STRIPE_API_VERSION = '2024-06-20';

function requireSecretKey(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not configured');
  return key;
}

function toFormBody(params: Record<string, string | number | boolean | undefined>): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) usp.append(key, String(value));
  }
  return usp.toString();
}

async function stripeRequest<T>(path: string, params: Record<string, string | number | boolean | undefined>): Promise<T> {
  const res = await fetch(`${STRIPE_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${requireSecretKey()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': STRIPE_API_VERSION,
    },
    body: toFormBody(params),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Stripe API error (${path}): ${json?.error?.message ?? res.statusText}`);
  }
  return json as T;
}

async function stripeGet<T>(path: string): Promise<T> {
  const res = await fetch(`${STRIPE_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${requireSecretKey()}`, 'Stripe-Version': STRIPE_API_VERSION },
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Stripe API error (${path}): ${json?.error?.message ?? res.statusText}`);
  }
  return json as T;
}

export interface CreateStripeCouponInput {
  percentOff?: number;
  amountOffCents?: number;
  currency?: string;
  /** 'once' = first-period-only discount; 'forever' = recurring discount every renewal. */
  duration: 'once' | 'forever';
}

/** Creates an ad-hoc coupon so a promo code's discount can apply on top of a fixed recurring Price. */
export async function createStripeCoupon(input: CreateStripeCouponInput): Promise<string> {
  const json = await stripeRequest<{ id: string }>('/coupons', {
    percent_off: input.percentOff,
    amount_off: input.amountOffCents,
    currency: input.amountOffCents != null ? input.currency ?? 'usd' : undefined,
    duration: input.duration,
  });
  return json.id;
}

export interface CreateStripeCheckoutSessionInput {
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  /** Our subscription_payments.id — round-tripped via client_reference_id + metadata for webhook lookup. */
  paymentRowId: string;
  customerEmail?: string;
  couponId?: string;
}

export interface StripeCheckoutSession {
  id: string;
  url: string | null;
}

export async function createStripeCheckoutSession(input: CreateStripeCheckoutSessionInput): Promise<StripeCheckoutSession> {
  const json = await stripeRequest<{ id: string; url: string | null }>('/checkout/sessions', {
    mode: 'subscription',
    'line_items[0][price]': input.priceId,
    'line_items[0][quantity]': 1,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    client_reference_id: input.paymentRowId,
    customer_email: input.customerEmail,
    'metadata[subscription_payment_id]': input.paymentRowId,
    'subscription_data[metadata][subscription_payment_id]': input.paymentRowId,
    ...(input.couponId ? { 'discounts[0][coupon]': input.couponId } : {}),
  });
  return { id: json.id, url: json.url };
}

export interface StripeSubscription {
  id: string;
  status: string;
  customer: string;
  current_period_start: number;
  current_period_end: number;
}

export async function getStripeSubscription(subscriptionId: string): Promise<StripeSubscription> {
  return stripeGet<StripeSubscription>(`/subscriptions/${subscriptionId}`);
}

export interface StripeCheckoutSessionObject {
  id: string;
  client_reference_id: string | null;
  customer: string | null;
  subscription: string | null;
  metadata?: Record<string, string>;
}

export async function getStripeCheckoutSession(sessionId: string): Promise<StripeCheckoutSessionObject> {
  return stripeGet<StripeCheckoutSessionObject>(`/checkout/sessions/${sessionId}`);
}

const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Verifies `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>...]` against the
 * RAW request body (never a re-serialized JSON.parse'd body — Stripe signs
 * the exact bytes it sent).
 */
export function verifyStripeSignature(rawBody: string, sigHeader: string | null, secret: string | undefined): boolean {
  if (!sigHeader || !secret) return false;

  const parts = sigHeader.split(',').reduce<Record<string, string[]>>((acc, part) => {
    const [k, v] = part.split('=');
    if (!k || !v) return acc;
    (acc[k] ??= []).push(v);
    return acc;
  }, {});

  const timestamp = parts.t?.[0];
  const signatures = parts.v1 ?? [];
  if (!timestamp || signatures.length === 0) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_SECONDS) return false;

  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');

  return signatures.some((sig) => {
    const gotBuf = Buffer.from(sig, 'hex');
    return expectedBuf.length === gotBuf.length && crypto.timingSafeEqual(expectedBuf, gotBuf);
  });
}
