-- Copy trading data model: add missing columns, fix types, add FK constraints (TLP-13)

-- signal_publishers: rename description -> strategy_description, add stats columns, widen user_id to text
ALTER TABLE "signal_publishers" RENAME COLUMN "description" TO "strategy_description";--> statement-breakpoint
ALTER TABLE "signal_publishers" ALTER COLUMN "user_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "signal_publishers" ADD COLUMN "total_signals" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "signal_publishers" ADD COLUMN "win_rate" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "signal_publishers" ADD COLUMN "sharpe_ratio" numeric(8, 4);--> statement-breakpoint
ALTER TABLE "signal_publishers" ADD COLUMN "avg_rr" numeric(8, 4);--> statement-breakpoint

-- signal_subscriptions: add copy_ratio_pct, widen subscriber_id to text
ALTER TABLE "signal_subscriptions" ALTER COLUMN "subscriber_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "signal_subscriptions" ADD COLUMN "copy_ratio_pct" integer DEFAULT 100 NOT NULL;--> statement-breakpoint

-- trade_signals: widen varchar columns to text, change confidence type, add new columns, add FK
ALTER TABLE "trade_signals" ALTER COLUMN "user_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "trade_signals" ALTER COLUMN "symbol" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "trade_signals" ALTER COLUMN "direction" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "trade_signals" ALTER COLUMN "confidence" SET DATA TYPE text USING confidence::text;--> statement-breakpoint
ALTER TABLE "trade_signals" ALTER COLUMN "source" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "trade_signals" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "trade_signals" ADD COLUMN "strategy_source" text;--> statement-breakpoint
ALTER TABLE "trade_signals" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "trade_signals" ADD CONSTRAINT "trade_signals_publisher_id_signal_publishers_id_fk" FOREIGN KEY ("publisher_id") REFERENCES "public"."signal_publishers"("id") ON DELETE no action ON UPDATE no action;
