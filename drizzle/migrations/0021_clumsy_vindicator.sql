ALTER TABLE "price_watches" ADD COLUMN "market_type" varchar(10) DEFAULT 'spot' NOT NULL;--> statement-breakpoint
ALTER TABLE "price_watches" ADD COLUMN "leverage" integer DEFAULT 1;--> statement-breakpoint
ALTER TABLE "price_watches" ADD COLUMN "margin_mode" varchar(20) DEFAULT 'cross';