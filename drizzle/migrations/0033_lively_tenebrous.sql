CREATE TABLE "promo_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(50) NOT NULL,
	"discount_type" varchar(10) NOT NULL,
	"discount_value" numeric(10, 2) NOT NULL,
	"discount_scope" varchar(20) DEFAULT 'first_period' NOT NULL,
	"applicable_plan_ids" jsonb DEFAULT 'null'::jsonb,
	"max_redemptions" integer,
	"redemptions_used" integer DEFAULT 0 NOT NULL,
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "subscription_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"plan_id" uuid,
	"billing_interval" varchar(20),
	"promo_code_id" uuid,
	"provider" varchar(20) NOT NULL,
	"provider_reference" text NOT NULL,
	"amount" numeric(20, 2) NOT NULL,
	"discount_applied" numeric(20, 2) DEFAULT '0' NOT NULL,
	"currency" varchar(10) DEFAULT 'USD' NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"period_covered_start" timestamp with time zone,
	"period_covered_end" timestamp with time zone,
	"raw_webhook_payload" jsonb,
	"checkout_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_plan_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"billing_interval" varchar(20) NOT NULL,
	"price" numeric(20, 2) NOT NULL,
	"currency" varchar(10) DEFAULT 'USD' NOT NULL,
	"provider_price_id" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(50) NOT NULL,
	"auto_trade_runs_per_day" integer DEFAULT 3 NOT NULL,
	"chat_messages_per_day" integer DEFAULT 15 NOT NULL,
	"allows_byok" boolean DEFAULT false NOT NULL,
	"allows_personalized_memory" boolean DEFAULT false NOT NULL,
	"job_priority" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_plans_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "usage_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"period_start" date NOT NULL,
	"auto_trade_runs_used" integer DEFAULT 0 NOT NULL,
	"chat_messages_used" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"plan_id" uuid NOT NULL,
	"billing_interval" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"next_billing_at" timestamp with time zone,
	"payment_provider" varchar(20) NOT NULL,
	"provider_customer_id" text,
	"provider_subscription_id" text,
	"promo_code_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_subscriptions_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_plan_id_subscription_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_promo_code_id_promo_codes_id_fk" FOREIGN KEY ("promo_code_id") REFERENCES "public"."promo_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_plan_prices" ADD CONSTRAINT "subscription_plan_prices_plan_id_subscription_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_plan_id_subscription_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_promo_code_id_promo_codes_id_fk" FOREIGN KEY ("promo_code_id") REFERENCES "public"."promo_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sp_user_id_idx" ON "subscription_payments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sp_status_idx" ON "subscription_payments" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "sp_provider_reference_idx" ON "subscription_payments" USING btree ("provider","provider_reference");--> statement-breakpoint
CREATE INDEX "spp_plan_id_idx" ON "subscription_plan_prices" USING btree ("plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "spp_plan_interval_currency_idx" ON "subscription_plan_prices" USING btree ("plan_id","billing_interval","currency");--> statement-breakpoint
CREATE UNIQUE INDEX "uc_user_period_idx" ON "usage_counters" USING btree ("user_id","period_start");--> statement-breakpoint
CREATE INDEX "us_status_idx" ON "user_subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "us_current_period_end_idx" ON "user_subscriptions" USING btree ("current_period_end");--> statement-breakpoint
-- Seed the free plan's caps as the actual row every user without an active
-- subscription resolves to (src/lib/billing/plan.ts) — 1 symbol in the risk
-- profile is a UI-level cap noted where the risk-profile form/API allows
-- multiple symbols (not enforced here), 3 executed auto-trade signals/day,
-- 15 chat messages/day. Never hardcoded as magic numbers in application code.
INSERT INTO "subscription_plans"
	("name", "auto_trade_runs_per_day", "chat_messages_per_day", "allows_byok", "allows_personalized_memory", "job_priority", "active")
VALUES
	('free', 3, 15, false, false, 0, true)
ON CONFLICT ("name") DO NOTHING;