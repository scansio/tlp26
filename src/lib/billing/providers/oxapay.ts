/**
 * OxaPay merchant API client — invoice-based, no native recurring-
 * subscription object (unlike Stripe/Paystack), so renewal is emulated by
 * src/worker/oxapay-renewal-loop.ts creating a fresh invoice ahead of
 * current_period_end.
 *
 * Verified against OxaPay's public docs (docs.oxapay.com) at the time this
 * was written:
 *  - Invoice creation: POST https://api.oxapay.com/v1/payment/invoice,
 *    header `merchant_api_key`, JSON body { amount, currency?, lifetime,
 *    order_id, callback_url, description, sandbox, return_url, email }.
 *    Response: { data: { track_id, payment_url, expired_at, date }, ... }.
 *  - Callback signature: HTTP header `HMAC`, HMAC-SHA512 of the raw request
 *    body, keyed by the merchant API key.
 *  - Payment status values include (at least) "Paying" (awaiting
 *    confirmation) and "Paid" (confirmed/credited) — this codebase also
 *    treats "Expired"/"Failed" as terminal-non-paid since OxaPay invoices
 *    expire after `lifetime` minutes; that specific enum member could not
 *    be independently re-verified against a live sandbox in this
 *    environment — treat any status other than "Paid" as not-yet-paid
 *    rather than silently activating a subscription on an unrecognized value.
 *
 * NOT live-tested — no sandbox credentials in this environment. Built
 * strictly against the documented request/response shape above.
 */

import crypto from 'node:crypto';

const OXAPAY_API_BASE = 'https://api.oxapay.com/v1';

export function isOxapaySandbox(): boolean {
  const raw = process.env.OXAPAY_SANDBOX;
  // Fail-safe default, matching CLAUDE.md's WORKER_ENABLED pattern: sandbox
  // unless explicitly told otherwise, so a missing/misconfigured env var
  // never accidentally takes a live payment in a non-prod environment.
  return raw ? raw === 'true' : process.env.NODE_ENV !== 'production';
}

export interface CreateOxapayInvoiceInput {
  amount: number;
  currency?: string;
  orderId: string;
  callbackUrl: string;
  returnUrl?: string;
  description?: string;
  email?: string;
  lifetimeMinutes?: number;
}

export interface OxapayInvoice {
  trackId: string;
  paymentUrl: string;
  expiredAt: number | null;
}

export async function createOxapayInvoice(input: CreateOxapayInvoiceInput): Promise<OxapayInvoice> {
  const apiKey = process.env.OXAPAY_MERCHANT_API_KEY;
  if (!apiKey) throw new Error('OXAPAY_MERCHANT_API_KEY is not configured');

  const res = await fetch(`${OXAPAY_API_BASE}/payment/invoice`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      merchant_api_key: apiKey,
    },
    body: JSON.stringify({
      amount: input.amount,
      currency: input.currency,
      lifetime: input.lifetimeMinutes ?? 60,
      order_id: input.orderId,
      callback_url: input.callbackUrl,
      return_url: input.returnUrl,
      description: input.description,
      email: input.email,
      sandbox: isOxapaySandbox(),
    }),
  });

  const json = await res.json();
  if (!res.ok || json?.error) {
    throw new Error(`OxaPay invoice creation failed: ${json?.message ?? res.statusText}`);
  }

  return {
    trackId: String(json.data.track_id),
    paymentUrl: String(json.data.payment_url),
    expiredAt: json.data.expired_at ?? null,
  };
}

/**
 * Verifies the `HMAC` header against the raw request body (must be the
 * unparsed body string — verifying after JSON.parse/re-stringify can produce
 * a different byte sequence and silently break verification).
 */
export function verifyOxapayCallbackSignature(rawBody: string, hmacHeader: string | null): boolean {
  const apiKey = process.env.OXAPAY_MERCHANT_API_KEY;
  if (!apiKey || !hmacHeader) return false;

  const expected = crypto.createHmac('sha512', apiKey).update(rawBody, 'utf8').digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const gotBuf = Buffer.from(hmacHeader, 'hex');
  if (expectedBuf.length !== gotBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, gotBuf);
}

export interface OxapayCallbackPayload {
  track_id: string;
  status: string;
  type?: string;
  order_id?: string;
  amount?: string | number;
  currency?: string;
  date?: number;
}

/** Only "Paid" is treated as a confirmed payment — see the header comment. */
export function isOxapayPaid(payload: OxapayCallbackPayload): boolean {
  return payload.status === 'Paid';
}
