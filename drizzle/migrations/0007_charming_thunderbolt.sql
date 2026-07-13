DROP INDEX "oc_symbol_tf_ts_idx";--> statement-breakpoint
ALTER TABLE "ohlcv_cache" ALTER COLUMN "symbol" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "ohlcv_cache" ALTER COLUMN "timeframe" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "ohlcv_cache" ALTER COLUMN "timestamp" SET DATA TYPE bigint;--> statement-breakpoint
CREATE UNIQUE INDEX "oc_symbol_tf_ts_idx" ON "ohlcv_cache" USING btree ("symbol","timeframe","timestamp");