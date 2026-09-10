CREATE TABLE "auto_trade_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"analysis_run_id" uuid NOT NULL,
	"symbol" varchar(30) NOT NULL,
	"exchange" varchar(50) NOT NULL,
	"market_type" varchar(10) DEFAULT 'spot' NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auto_trade_supported_symbols" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol" varchar(30) NOT NULL,
	"exchange" varchar(50) NOT NULL,
	"market_type" varchar(10) DEFAULT 'spot' NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deterministic_data_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cache_key" text NOT NULL,
	"source" text NOT NULL,
	"payload" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "atj_claim_idx" ON "auto_trade_jobs" USING btree ("status","priority" DESC NULLS LAST,"created_at");--> statement-breakpoint
CREATE INDEX "atj_user_id_idx" ON "auto_trade_jobs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "atj_analysis_run_id_idx" ON "auto_trade_jobs" USING btree ("analysis_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "atss_symbol_exchange_market_idx" ON "auto_trade_supported_symbols" USING btree ("symbol","exchange","market_type");--> statement-breakpoint
CREATE UNIQUE INDEX "ddc_cache_key_idx" ON "deterministic_data_cache" USING btree ("cache_key");--> statement-breakpoint
-- Seed the allowlist with common majors across all three exchanges, spot and
-- swap, so this migration doesn't silently cut off every currently-running
-- user's watchlist the moment it applies (the worker's eligibility pass now
-- requires an active row here — see src/worker/eligibility.ts /
-- src/worker/supported-symbols.ts). Operators add/disable further symbols by
-- inserting/updating rows in this table directly (no admin UI yet — out of
-- scope for this phase).
INSERT INTO "auto_trade_supported_symbols" ("symbol", "exchange", "market_type", "status")
SELECT symbol, exchange, market_type, 'active'
FROM (
	VALUES
		('BTC/USDT'), ('ETH/USDT'), ('SOL/USDT'), ('BNB/USDT'), ('XRP/USDT')
) AS s(symbol)
CROSS JOIN (VALUES ('binance'), ('bybit'), ('bingx')) AS e(exchange)
CROSS JOIN (VALUES ('spot'), ('swap')) AS m(market_type)
ON CONFLICT ("symbol", "exchange", "market_type") DO NOTHING;