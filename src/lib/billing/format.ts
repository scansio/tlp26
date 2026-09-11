import type { BillingInterval } from './period';

export const INTERVAL_LABEL: Record<BillingInterval, string> = {
  monthly: 'mo',
  biannual: '6 mo',
  yearly: 'yr',
};

export function formatPlanPrice(price: string, currency: string): string {
  const amount = Number(price);
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}
