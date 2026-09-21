CREATE TABLE "exchange_balance_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"exchange_name" varchar(50) NOT NULL,
	"market_type" varchar(10) NOT NULL,
	"balance_usdt" numeric(20, 2),
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ebc_user_exchange_market_idx" ON "exchange_balance_cache" USING btree ("user_id","exchange_name","market_type");