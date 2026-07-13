ALTER TABLE "publisher_earnings" ADD COLUMN "platform_cut_amount" numeric(20, 8) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "publisher_earnings" ADD COLUMN "publisher_net_amount" numeric(20, 8) DEFAULT '0' NOT NULL;--> statement-breakpoint
CREATE INDEX "pe_subscriber_id_idx" ON "publisher_earnings" USING btree ("subscriber_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pe_trade_id_unique_idx" ON "publisher_earnings" USING btree ("trade_id");