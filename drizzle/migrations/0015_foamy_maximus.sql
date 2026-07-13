ALTER TABLE "trade_signals" ADD COLUMN "news_sentiment" text;--> statement-breakpoint
ALTER TABLE "trade_signals" ADD COLUMN "news_sentiment_score" numeric(8, 4);--> statement-breakpoint
ALTER TABLE "trade_signals" ADD COLUMN "on_chain_funding_rate" numeric(12, 8);--> statement-breakpoint
ALTER TABLE "trade_signals" ADD COLUMN "on_chain_funding_bias" text;--> statement-breakpoint
ALTER TABLE "trade_signals" ADD COLUMN "on_chain_netflow" numeric(20, 4);