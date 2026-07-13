/**
 * Copy Trading Mirror Engine (TLP-34)
 *
 * Propagates a publisher's trade signal to all active subscribers,
 * scaling position size to each subscriber's copy ratio and risk profile.
 *
 * Key behaviours:
 * - Runs asynchronously (fire-and-forget) so it never blocks the publisher's
 *   own signal creation.
 * - Checks each subscriber's circuit breaker before creating their signal.
 * - Supports cascade cancellation: when the publisher signal is rejected or
 *   cancelled, all mirrored subscriber signals are also cancelled.
 * - Logs a structured propagation record to the publisher's signal rawPayload.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import {
  signalPublishers,
  signalSubscriptions,
  tradeSignals,
  userRiskProfiles,
} from '@/db/schema';
import { checkCircuitBreaker } from '@/lib/circuit-breaker';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PropagationLog {
  publisherSignalId: string;
  subscriberSignalIds: string[];
  propagatedAt: string;
  skippedSubscribers: Array<{ subscriberId: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Scale publisher's USDT position size to subscriber using:
 *   subscriberSize = publisherSize × (copyRatioPct / 100)
 *                    × (subscriberRiskPct / publisherRiskPct)
 *
 * Falls back to the base copy-ratio-only scale when risk profiles are missing.
 */
function scalePositionSize(
  publisherPositionSize: number,
  copyRatioPct: number,
  subscriberRiskPct: number | null,
  publisherRiskPct: number | null,
): number {
  const copyRatio = copyRatioPct / 100;
  const riskAdjustment =
    subscriberRiskPct != null && publisherRiskPct != null && publisherRiskPct > 0
      ? subscriberRiskPct / publisherRiskPct
      : 1;

  return publisherPositionSize * copyRatio * riskAdjustment;
}

// ---------------------------------------------------------------------------
// Core: propagate a publisher signal to all subscribers
// ---------------------------------------------------------------------------

/**
 * Propagate a newly-created publisher signal to active subscribers.
 *
 * @param publisherSignalId  - ID of the publisher's own trade_signals row
 * @param publisherUserId    - Clerk user ID of the publisher
 *
 * This function is always called with `void` — it must never throw to the caller.
 */
export async function propagatePublisherSignal(
  publisherSignalId: string,
  publisherUserId: string,
): Promise<void> {
  const startedAt = Date.now();

  try {
    // --- 1. Load the publisher's signal ---
    const [pubSignal] = await db
      .select()
      .from(tradeSignals)
      .where(eq(tradeSignals.id, publisherSignalId))
      .limit(1);

    if (!pubSignal) {
      console.warn(
        `[mirror-engine] publisher signal not found: signalId=${publisherSignalId}`,
      );
      return;
    }

    // --- 2. Resolve the publisher record (user must be an active, public publisher) ---
    const [publisher] = await db
      .select()
      .from(signalPublishers)
      .where(
        and(
          eq(signalPublishers.userId, publisherUserId),
          eq(signalPublishers.isActive, true),
        ),
      )
      .limit(1);

    if (!publisher) {
      // User is not a publisher (or is deactivated) — nothing to propagate.
      return;
    }

    // --- 3. Load publisher's risk profile for position-size scaling ---
    const [pubProfile] = await db
      .select({ riskPerTradePct: userRiskProfiles.riskPerTradePct })
      .from(userRiskProfiles)
      .where(eq(userRiskProfiles.userId, publisherUserId))
      .limit(1);

    const publisherRiskPct = pubProfile?.riskPerTradePct
      ? Number(pubProfile.riskPerTradePct)
      : null;

    // Publisher position size stored in rawPayload by the workflow/webhook.
    // Falls back to 0 so scaling degrades gracefully (subscriber gets 0 → skipped).
    const publisherPositionSize: number =
      (pubSignal.rawPayload as Record<string, unknown> | null)
        ?.riskCalculation != null
        ? Number(
            (
              (pubSignal.rawPayload as Record<string, unknown>)
                .riskCalculation as Record<string, unknown>
            ).positionSizeUsdt ?? 0,
          )
        : 0;

    // --- 4. Fetch all active subscriptions for this publisher ---
    const subscriptions = await db
      .select()
      .from(signalSubscriptions)
      .where(
        and(
          eq(signalSubscriptions.publisherId, publisher.id),
          eq(signalSubscriptions.isActive, true),
        ),
      );

    if (subscriptions.length === 0) {
      return; // No active subscribers — nothing to do
    }

    // --- 5. Per-subscriber processing (parallel, independent) ---
    const skippedSubscribers: Array<{ subscriberId: string; reason: string }> = [];
    const subscriberSignalIds: string[] = [];

    const subscriberTasks = subscriptions.map(async (sub) => {
      // 5a. Circuit breaker check
      const cbResult = await checkCircuitBreaker(sub.subscriberId, {
        signalSymbol: pubSignal.symbol,
        signalDirection: pubSignal.direction,
      });

      if (!cbResult.allowed) {
        skippedSubscribers.push({
          subscriberId: sub.subscriberId,
          reason: cbResult.reason ?? 'circuit breaker blocked',
        });
        return;
      }

      // 5b. Load subscriber risk profile
      const [subProfile] = await db
        .select({ riskPerTradePct: userRiskProfiles.riskPerTradePct })
        .from(userRiskProfiles)
        .where(eq(userRiskProfiles.userId, sub.subscriberId))
        .limit(1);

      const subscriberRiskPct = subProfile?.riskPerTradePct
        ? Number(subProfile.riskPerTradePct)
        : null;

      // 5c. Scale position size
      let scaledSize =
        publisherPositionSize > 0
          ? scalePositionSize(
              publisherPositionSize,
              sub.copyRatioPct,
              subscriberRiskPct,
              publisherRiskPct,
            )
          : 0;

      // Apply subscriber's max position cap if configured
      if (sub.maxPositionSizeCap != null) {
        const cap = Number(sub.maxPositionSizeCap);
        if (cap > 0 && scaledSize > cap) {
          scaledSize = cap;
        }
      }

      // 5d. Determine initial status based on subscriber's execution mode
      // auto-copy → execute immediately (status: 'approved' — triggers execution layer)
      // review-copy → pending approval queue
      const initialStatus =
        sub.executionMode === 'auto-copy' ? 'approved' : 'pending';

      // 5e. Create subscriber signal
      try {
        const [subSignal] = await db
          .insert(tradeSignals)
          .values({
            userId: sub.subscriberId,
            symbol: pubSignal.symbol,
            timeframe: pubSignal.timeframe,
            direction: pubSignal.direction,
            entryPrice: pubSignal.entryPrice,
            stopLoss: pubSignal.stopLoss,
            takeProfit: pubSignal.takeProfit,
            confidence: pubSignal.confidence,
            reasoning: pubSignal.reasoning
              ? `[COPY] ${pubSignal.reasoning}`
              : `[COPY] Signal mirrored from publisher ${publisher.displayName ?? publisher.id}`,
            strategySource: pubSignal.strategySource,
            source: 'copy',
            status: initialStatus,
            publisherId: publisher.id,
            parentSignalId: publisherSignalId,
            exitMode: pubSignal.exitMode,
            trailSlPct: pubSignal.trailSlPct,
            trailTpPct: pubSignal.trailTpPct,
            trailActivationPct: pubSignal.trailActivationPct,
            rawPayload: {
              copyMeta: {
                publisherSignalId,
                publisherUserId,
                publisherId: publisher.id,
                copyRatioPct: sub.copyRatioPct,
                publisherPositionSize,
                scaledPositionSizeUsdt: scaledSize,
                publisherRiskPct,
                subscriberRiskPct,
              },
            },
          })
          .returning({ id: tradeSignals.id });

        if (subSignal) {
          subscriberSignalIds.push(subSignal.id);
        }
      } catch (err) {
        console.error(
          `[mirror-engine] failed to create subscriber signal: subscriberId=${sub.subscriberId}`,
          err,
        );
        skippedSubscribers.push({
          subscriberId: sub.subscriberId,
          reason: 'internal error creating signal',
        });
      }
    });

    // Wait for all subscriber tasks (independent — one failure should not block others)
    await Promise.allSettled(subscriberTasks);

    const elapsed = Date.now() - startedAt;

    // --- 6. Build propagation log ---
    const propagationLog: PropagationLog = {
      publisherSignalId,
      subscriberSignalIds,
      propagatedAt: new Date().toISOString(),
      skippedSubscribers,
    };

    console.info('[mirror-engine] propagation complete', {
      ...propagationLog,
      elapsedMs: elapsed,
    });

    // Persist propagation log into the publisher signal's rawPayload
    await db
      .update(tradeSignals)
      .set({
        rawPayload: {
          ...(pubSignal.rawPayload as Record<string, unknown> | null ?? {}),
          propagationResult: propagationLog,
        },
        updatedAt: new Date(),
      })
      .where(eq(tradeSignals.id, publisherSignalId));
  } catch (err) {
    console.error('[mirror-engine] unexpected error during propagation', {
      publisherSignalId,
      publisherUserId,
      err,
    });
  }
}

// ---------------------------------------------------------------------------
// Cascade cancellation
// ---------------------------------------------------------------------------

/**
 * Cancel all mirrored subscriber signals that were created from the given
 * publisher signal (status must be pending or approved — not yet executed).
 *
 * Called when the publisher's own signal is rejected or cancelled.
 */
export async function cancelMirroredSignals(publisherSignalId: string): Promise<void> {
  try {
    const updated = await db
      .update(tradeSignals)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(tradeSignals.parentSignalId, publisherSignalId),
          inArray(tradeSignals.status, ['pending', 'approved']),
        ),
      )
      .returning({ id: tradeSignals.id });

    if (updated.length > 0) {
      console.info(
        `[mirror-engine] cancelled ${updated.length} mirrored signal(s) for publisherSignalId=${publisherSignalId}`,
      );
    }
  } catch (err) {
    console.error('[mirror-engine] failed to cancel mirrored signals', {
      publisherSignalId,
      err,
    });
  }
}
