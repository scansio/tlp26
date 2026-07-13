/**
 * Throttle alert notification helper — imported lazily by rate-limiter.ts
 * to avoid circular dependency issues.
 */

import { sendNotification } from '@/lib/notifications';

/**
 * Send a notification to the user when sustained exchange throttling is detected.
 */
export async function sendUserThrottleAlert(
  userId: string,
  exchange: string,
  consecutiveThrottles: number,
): Promise<void> {
  await sendNotification(userId, {
    event: 'signal_rejected',
    reason: `Exchange API throttling detected on ${exchange.toUpperCase()} (${consecutiveThrottles} consecutive 429 responses). Requests are being queued with exponential backoff.`,
  });
}
