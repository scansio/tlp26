/** Billing period arithmetic shared by checkout, webhooks, and the OxaPay renewal job. */

export type BillingInterval = 'monthly' | 'biannual' | 'yearly';

/** Advances `start` by one billing interval, in UTC. */
export function addBillingInterval(start: Date, interval: BillingInterval): Date {
  const d = new Date(start.getTime());
  switch (interval) {
    case 'monthly':
      d.setUTCMonth(d.getUTCMonth() + 1);
      break;
    case 'biannual':
      d.setUTCMonth(d.getUTCMonth() + 6);
      break;
    case 'yearly':
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      break;
  }
  return d;
}
