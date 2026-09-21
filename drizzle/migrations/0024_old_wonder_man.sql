ALTER TABLE "user_notifications" ADD COLUMN "telegram_connect_token" varchar(64);--> statement-breakpoint
ALTER TABLE "user_notifications" ADD COLUMN "telegram_connect_token_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "un_telegram_connect_token_idx" ON "user_notifications" USING btree ("telegram_connect_token");