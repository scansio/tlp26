CREATE TABLE "price_watches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"symbol" varchar(30) NOT NULL,
	"exchange" varchar(50) DEFAULT 'binance' NOT NULL,
	"target_price" numeric(20, 8) NOT NULL,
	"direction" varchar(10) NOT NULL,
	"note" text,
	"action_type" varchar(20) DEFAULT 'notify' NOT NULL,
	"trade_direction" varchar(10),
	"stop_loss" numeric(20, 8),
	"take_profit" numeric(20, 8),
	"confidence" text,
	"reasoning" text,
	"strategy_source" text,
	"timeframe" varchar(10),
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"triggered_price" numeric(20, 8),
	"triggered_at" timestamp with time zone,
	"result_signal_id" uuid,
	"result_message" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "price_watches" ADD CONSTRAINT "price_watches_result_signal_id_trade_signals_id_fk" FOREIGN KEY ("result_signal_id") REFERENCES "public"."trade_signals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pw_user_id_idx" ON "price_watches" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "pw_status_idx" ON "price_watches" USING btree ("status");