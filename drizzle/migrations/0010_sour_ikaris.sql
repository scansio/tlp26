DROP INDEX "oc_symbol_tf_ts_idx";--> statement-breakpoint
ALTER TABLE "ohlcv_cache" ALTER COLUMN "symbol" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "ohlcv_cache" ALTER COLUMN "timeframe" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "ohlcv_cache" ALTER COLUMN "timestamp" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "trade_executions" ADD COLUMN "symbol" varchar(30) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "trade_executions" ADD COLUMN "exit_order_id" varchar(128);--> statement-breakpoint
ALTER TABLE "trade_executions" ADD COLUMN "fill_type" varchar(20);--> statement-breakpoint
ALTER TABLE "user_risk_profiles" ADD COLUMN "max_open_positions" integer DEFAULT 5;--> statement-breakpoint
CREATE INDEX "te_status_idx" ON "trade_executions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "oc_symbol_tf_ts_idx" ON "ohlcv_cache" USING btree ("symbol","timeframe","timestamp");