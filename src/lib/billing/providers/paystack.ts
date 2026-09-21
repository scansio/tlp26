/**
 * Minimal Paystack REST client — no SDK dependency, same reasoning as
 * providers/stripe.ts.
 *
 * NOT live-tested — no Paystack test/sandbox credentials in this
 * environment. Built strictly against Paystack's publicly documented API/
 * webhook shapes:
 *  - Initialize transaction: POST /transaction/initialize, Bearer
 *    PAYSTACK_SECRET_KEY, JSON body { email, amount (kobo/subunit integer),
 *    reference, callback_url, metadata, plan? }. Response:
 *    { status, message, data: { authorization_url, access_code, reference } }.
 *  - Signature: header `x-paystack-signature` = HMAC-SHA512 hex digest of
 *    the RAW request body, keyed by PAYSTACK_SECRET_KEY.
 *  - Recurring: a `plan` code created in the Paystack dashboard/API drives
 *    subsequent renewal charges automatically once a customer is
 *    subscribed to it; renewal amounts follow the plan, not an ad-hoc
 *    discounted amount — see the recurring-discount limitation noted in
 *    the checkout route.
 */

import crypto from 'node:crypto';

const PAYSTACK_API_BASE = 'https://api.paystack.co';

function requireSecretKey(): string {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new Error('PAYSTACK_SECRET_KEY is not configured');
  return key;
}

export interface InitializePaystackTransactionInput {
  email: string;
  amountSubunits: number;
  /**
   * Required — Paystack otherwise defaults to whatever currency the account
   * itself is configured for and interprets `amount` as subunits of THAT
   * currency, silently charging the wrong amount if it doesn't match what
   * `amount` was actually computed in (e.g. a USD amount charged as if it
   * were already NGN kobo).
   */
  currency: string;
  reference: string;
  callbackUrl: string;
  metadata?: Record<string, unknown>;
  /** Paystack recurring plan code (subscriptionPlanPrices.providerPriceId.paystack) — omit for a one-off charge. */
  planCode?: string;
}

export interface PaystackTransaction {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

export async function initializePaystackTransaction(input: InitializePaystackTransactionInput): Promise<PaystackTransaction> {
  const res = await fetch(`${PAYSTACK_API_BASE}/transaction/initialize`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${requireSecretKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: input.email,
      amount: input.amountSubunits,
      currency: input.currency,
      reference: input.reference,
      callback_url: input.callbackUrl,
      metadata: input.metadata,
      plan: input.planCode,
    }),
  });

  const json = await res.json();
  if (!res.ok || !json.status) {
    throw new Error(`Paystack initialize failed: ${json?.message ?? res.statusText}`);
  }

  return {
    authorizationUrl: json.data.authorization_url,
    accessCode: json.data.access_code,
    reference: json.data.reference,
  };
}

/** Verifies `x-paystack-signature` against the RAW request body. */
export function verifyPaystackSignature(rawBody: string, sigHeader: string | null): boolean {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret || !sigHeader) return false;

  const expected = crypto.createHmac('sha512', secret).update(rawBody, 'utf8').digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const gotBuf = Buffer.from(sigHeader, 'hex');
  if (expectedBuf.length !== gotBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, gotBuf);
}

export interface PaystackChargeSuccessEvent {
  event: string;
  data: {
    reference: string;
    amount: number; // subunits
    currency: string;
    customer?: { email?: string; customer_code?: string };
    plan?: { plan_code?: string } | null;
    subscription_code?: string;
    metadata?: Record<string, unknown>;
  };
}
