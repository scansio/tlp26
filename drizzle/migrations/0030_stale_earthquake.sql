ALTER TABLE "trade_signals" ADD COLUMN "risk_calculation" jsonb;--> statement-breakpoint
ALTER TABLE "trade_signals" ADD COLUMN "risk_capital_usdt" numeric(20, 4);--> statement-breakpoint
ALTER TABLE "trade_signals" ADD COLUMN "risk_calculated_at" timestamp with time zone;