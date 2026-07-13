ALTER TABLE "signal_subscriptions" ADD COLUMN "execution_mode" varchar(20) DEFAULT 'review-copy' NOT NULL;--> statement-breakpoint
ALTER TABLE "signal_subscriptions" ADD COLUMN "max_position_size_cap" numeric(20, 2);--> statement-breakpoint
ALTER TABLE "signal_subscriptions" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
CREATE INDEX "ss_sub_pub_idx" ON "signal_subscriptions" USING btree ("subscriber_id","publisher_id");