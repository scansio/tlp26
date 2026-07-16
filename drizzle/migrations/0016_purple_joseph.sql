-- Cancel any existing signals that are missing SL or TP so the NOT NULL constraint can be applied cleanly.
-- Signals in terminal states (executed, cancelled, rejected, expired) are left as-is with a sentinel
-- value of 0 to satisfy the constraint without altering historical meaning.
UPDATE "trade_signals"
SET status = 'cancelled', updated_at = NOW()
WHERE (stop_loss IS NULL OR take_profit IS NULL)
  AND status IN ('pending', 'approved');--> statement-breakpoint

-- Backfill remaining null SL/TP with 0 on historical terminal rows so the constraint applies.
UPDATE "trade_signals"
SET stop_loss = COALESCE(stop_loss, '0'), take_profit = COALESCE(take_profit, '0')
WHERE stop_loss IS NULL OR take_profit IS NULL;--> statement-breakpoint

ALTER TABLE "trade_signals" ALTER COLUMN "stop_loss" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "trade_signals" ALTER COLUMN "take_profit" SET NOT NULL;
