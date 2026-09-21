-- Seed NGN price rows for 'pro' and 'byok' (only USD rows existed — see
-- migration 0035), fixing the Paystack ("Card (NGN)") checkout path: without
-- an NGN row, /api/billing/checkout had no NGN price to look up and (before
-- that route's currency-filter fix) fell back to the USD row's raw number,
-- which Paystack then charged as if it were already NGN.
--
-- Amounts here are a placeholder conversion (~1600 NGN/USD) — NOT a live FX
-- rate. An admin should correct these to the actual desired NGN price via
-- /admin/subscription-plan-prices; nothing here auto-updates with FX moves.
INSERT INTO "subscription_plan_prices" ("plan_id", "billing_interval", "price", "currency")
SELECT "id", 'monthly', 30400.00, 'NGN' FROM "subscription_plans" WHERE "name" = 'pro'
ON CONFLICT ("plan_id", "billing_interval", "currency") DO NOTHING;
--> statement-breakpoint
INSERT INTO "subscription_plan_prices" ("plan_id", "billing_interval", "price", "currency")
SELECT "id", 'yearly', 304000.00, 'NGN' FROM "subscription_plans" WHERE "name" = 'pro'
ON CONFLICT ("plan_id", "billing_interval", "currency") DO NOTHING;
--> statement-breakpoint
INSERT INTO "subscription_plan_prices" ("plan_id", "billing_interval", "price", "currency")
SELECT "id", 'monthly', 78400.00, 'NGN' FROM "subscription_plans" WHERE "name" = 'byok'
ON CONFLICT ("plan_id", "billing_interval", "currency") DO NOTHING;
--> statement-breakpoint
INSERT INTO "subscription_plan_prices" ("plan_id", "billing_interval", "price", "currency")
SELECT "id", 'yearly', 784000.00, 'NGN' FROM "subscription_plans" WHERE "name" = 'byok'
ON CONFLICT ("plan_id", "billing_interval", "currency") DO NOTHING;
