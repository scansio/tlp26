ALTER TABLE "signal_publishers" ADD COLUMN "is_active" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "signal_publishers" ADD COLUMN "share_individual_trades" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "signal_publishers" ADD COLUMN "max_drawdown" numeric(8, 4);--> statement-breakpoint
ALTER TABLE "signal_publishers" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now();