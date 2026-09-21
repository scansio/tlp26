-- Seed additional plan tiers beyond 'free' (seeded by migration 0034) so the
-- pricing page and /admin/subscription-plans have real rows to show/edit
-- instead of just Free. Caps and prices below are placeholders — an admin
-- edits them via /admin/subscription-plans and /admin/subscription-plan-prices.
-- OxaPay needs no provider_price_id (priced inline per invoice from `price`,
-- see subscription_plan_prices' column comment in src/db/schema.ts), so these
-- are checkout-ready for OxaPay immediately; Stripe/Paystack recurring
-- checkout needs their provider Price object id added once those exist.
INSERT INTO "subscription_plans"
	("name", "auto_trade_runs_per_day", "chat_messages_per_day", "allows_byok", "allows_personalized_memory", "job_priority", "active")
VALUES
	('pro', 20, 150, false, true, 1, true),
	('byok', 100, 500, true, true, 2, true)
ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint
INSERT INTO "subscription_plan_prices" ("plan_id", "billing_interval", "price", "currency")
SELECT "id", 'monthly', 19.00, 'USD' FROM "subscription_plans" WHERE "name" = 'pro'
ON CONFLICT ("plan_id", "billing_interval", "currency") DO NOTHING;
--> statement-breakpoint
INSERT INTO "subscription_plan_prices" ("plan_id", "billing_interval", "price", "currency")
SELECT "id", 'yearly', 190.00, 'USD' FROM "subscription_plans" WHERE "name" = 'pro'
ON CONFLICT ("plan_id", "billing_interval", "currency") DO NOTHING;
--> statement-breakpoint
INSERT INTO "subscription_plan_prices" ("plan_id", "billing_interval", "price", "currency")
SELECT "id", 'monthly', 49.00, 'USD' FROM "subscription_plans" WHERE "name" = 'byok'
ON CONFLICT ("plan_id", "billing_interval", "currency") DO NOTHING;
--> statement-breakpoint
INSERT INTO "subscription_plan_prices" ("plan_id", "billing_interval", "price", "currency")
SELECT "id", 'yearly', 490.00, 'USD' FROM "subscription_plans" WHERE "name" = 'byok'
ON CONFLICT ("plan_id", "billing_interval", "currency") DO NOTHING;
