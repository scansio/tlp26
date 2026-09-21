ALTER TABLE "trade_signals" ADD COLUMN "risk_override_pct" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "trade_signals" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "trade_signals" ADD COLUMN "last_error_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trade_signals" ADD COLUMN "execution_attempts" integer DEFAULT 0;