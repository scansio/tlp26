ALTER TABLE "trade_executions" ADD COLUMN "profit_lock_synced_price" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "user_risk_profiles" ADD COLUMN "profit_lock_enabled" boolean DEFAULT false;