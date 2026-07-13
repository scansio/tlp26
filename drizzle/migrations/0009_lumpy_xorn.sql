ALTER TABLE "trade_executions" ADD COLUMN "symbol" varchar(30) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "trade_executions" ADD COLUMN "exit_order_id" varchar(128);--> statement-breakpoint
ALTER TABLE "trade_executions" ADD COLUMN "fill_type" varchar(20);--> statement-breakpoint
CREATE INDEX "te_status_idx" ON "trade_executions" USING btree ("status");