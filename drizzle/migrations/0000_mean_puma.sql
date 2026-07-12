CREATE TABLE "backtest_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"config" jsonb NOT NULL,
	"metrics" jsonb,
	"equity_curve" jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "ohlcv_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol" varchar(30) NOT NULL,
	"timeframe" varchar(10) NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"open" numeric(20, 8) NOT NULL,
	"high" numeric(20, 8) NOT NULL,
	"low" numeric(20, 8) NOT NULL,
	"close" numeric(20, 8) NOT NULL,
	"volume" numeric(30, 8) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publisher_earnings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publisher_id" uuid NOT NULL,
	"subscriber_id" varchar(255) NOT NULL,
	"trade_id" uuid,
	"profit_amount" numeric(20, 8) NOT NULL,
	"fee_amount" numeric(20, 8) NOT NULL,
	"period" varchar(20),
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "signal_publishers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"display_name" varchar(100),
	"description" text,
	"fee_percent" numeric(5, 2) DEFAULT '0.00',
	"is_public" boolean DEFAULT false,
	"subscriber_count" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "signal_publishers_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "signal_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscriber_id" varchar(255) NOT NULL,
	"publisher_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "trade_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signal_id" uuid,
	"user_id" varchar(255) NOT NULL,
	"exchange_name" varchar(50) NOT NULL,
	"exchange_order_id" varchar(128),
	"entry_price" numeric(20, 8),
	"exit_price" numeric(20, 8),
	"position_size" numeric(20, 8),
	"realized_pnl" numeric(20, 8),
	"status" varchar(20) DEFAULT 'open',
	"mode" varchar(10) DEFAULT 'paper',
	"entry_at" timestamp with time zone DEFAULT now(),
	"exit_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "trade_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"symbol" varchar(30) NOT NULL,
	"timeframe" varchar(10) NOT NULL,
	"direction" varchar(10) NOT NULL,
	"entry_price" numeric(20, 8),
	"stop_loss" numeric(20, 8),
	"take_profit" numeric(20, 8),
	"confidence" numeric(5, 2),
	"reasoning" text,
	"source" varchar(20) DEFAULT 'ai',
	"status" varchar(20) DEFAULT 'pending',
	"publisher_id" uuid,
	"raw_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_exchanges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"exchange_name" varchar(50) NOT NULL,
	"encrypted_api_key" text NOT NULL,
	"encrypted_api_secret" text NOT NULL,
	"encrypted_passphrase" text,
	"status" varchar(20) DEFAULT 'active',
	"connected_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "user_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"telegram_bot_token" text,
	"telegram_chat_id" varchar(100),
	"discord_webhook_url" text,
	"quiet_hours_start" integer,
	"quiet_hours_end" integer,
	CONSTRAINT "user_notifications_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "user_risk_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"strategies" jsonb DEFAULT '[]'::jsonb,
	"max_trades_per_day" integer DEFAULT 5,
	"risk_per_trade_pct" numeric(5, 2) DEFAULT '1.00',
	"max_daily_loss_pct" numeric(5, 2) DEFAULT '3.00',
	"execution_mode" varchar(20) DEFAULT 'paper',
	"preferred_timeframes" jsonb DEFAULT '[]'::jsonb,
	"allowed_symbols" jsonb DEFAULT '[]'::jsonb,
	"kill_switch_active" boolean DEFAULT false,
	"trading_mode" varchar(20) DEFAULT 'manual',
	"webhook_token" varchar(128),
	"is_active" boolean DEFAULT true,
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "user_risk_profiles_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "publisher_earnings" ADD CONSTRAINT "publisher_earnings_publisher_id_signal_publishers_id_fk" FOREIGN KEY ("publisher_id") REFERENCES "public"."signal_publishers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publisher_earnings" ADD CONSTRAINT "publisher_earnings_trade_id_trade_executions_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trade_executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_subscriptions" ADD CONSTRAINT "signal_subscriptions_publisher_id_signal_publishers_id_fk" FOREIGN KEY ("publisher_id") REFERENCES "public"."signal_publishers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_executions" ADD CONSTRAINT "trade_executions_signal_id_trade_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."trade_signals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "br_user_id_idx" ON "backtest_runs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oc_symbol_tf_ts_idx" ON "ohlcv_cache" USING btree ("symbol","timeframe","timestamp");--> statement-breakpoint
CREATE INDEX "pe_publisher_id_idx" ON "publisher_earnings" USING btree ("publisher_id");--> statement-breakpoint
CREATE INDEX "ss_subscriber_id_idx" ON "signal_subscriptions" USING btree ("subscriber_id");--> statement-breakpoint
CREATE INDEX "ss_publisher_id_idx" ON "signal_subscriptions" USING btree ("publisher_id");--> statement-breakpoint
CREATE INDEX "te_user_id_idx" ON "trade_executions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "te_signal_id_idx" ON "trade_executions" USING btree ("signal_id");--> statement-breakpoint
CREATE INDEX "ts_user_id_idx" ON "trade_signals" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ts_status_idx" ON "trade_signals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ue_user_id_idx" ON "user_exchanges" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "urp_user_id_idx" ON "user_risk_profiles" USING btree ("user_id");