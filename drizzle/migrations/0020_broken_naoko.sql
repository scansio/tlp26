ALTER TABLE "trade_executions" ADD COLUMN "market_type" varchar(10) DEFAULT 'spot';--> statement-breakpoint
ALTER TABLE "trade_executions" ADD COLUMN "leverage" integer DEFAULT 1;--> statement-breakpoint
ALTER TABLE "trade_executions" ADD COLUMN "margin_mode" varchar(20) DEFAULT 'cross';--> statement-breakpoint
ALTER TABLE "trade_executions" ADD COLUMN "contract_size" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "trade_executions" ADD COLUMN "order_contracts" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "trade_signals" ADD COLUMN "market_type" varchar(10) DEFAULT 'spot';--> statement-breakpoint
ALTER TABLE "trade_signals" ADD COLUMN "leverage" integer DEFAULT 1;--> statement-breakpoint
ALTER TABLE "trade_signals" ADD COLUMN "margin_mode" varchar(20) DEFAULT 'cross';--> statement-breakpoint
ALTER TABLE "user_risk_profiles" ADD COLUMN "market_type" varchar(10) DEFAULT 'spot';--> statement-breakpoint
ALTER TABLE "user_risk_profiles" ADD COLUMN "default_leverage" integer DEFAULT 1;--> statement-breakpoint
ALTER TABLE "user_risk_profiles" ADD COLUMN "margin_mode" varchar(20) DEFAULT 'cross';