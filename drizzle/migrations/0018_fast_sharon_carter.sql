ALTER TABLE "trade_signals" ADD COLUMN "analysis_run_id" uuid;--> statement-breakpoint
CREATE INDEX "ts_analysis_run_id_idx" ON "trade_signals" USING btree ("analysis_run_id");