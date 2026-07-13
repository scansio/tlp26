CREATE TABLE "trail_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"execution_id" uuid NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"event_type" varchar(20) NOT NULL,
	"trigger_price" numeric(20, 8) NOT NULL,
	"new_level" numeric(20, 8) NOT NULL,
	"prev_level" numeric(20, 8),
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "trade_executions" ADD COLUMN "trail_sl_price" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "trade_executions" ADD COLUMN "trail_tp_active" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "trade_executions" ADD COLUMN "trail_tp_price" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "trade_signals" ADD COLUMN "exit_mode" varchar(20);--> statement-breakpoint
ALTER TABLE "trade_signals" ADD COLUMN "trail_sl_pct" numeric(5, 3);--> statement-breakpoint
ALTER TABLE "trade_signals" ADD COLUMN "trail_tp_pct" numeric(5, 3);--> statement-breakpoint
ALTER TABLE "trade_signals" ADD COLUMN "trail_activation_pct" numeric(5, 3);--> statement-breakpoint
ALTER TABLE "user_risk_profiles" ADD COLUMN "exit_mode" varchar(20) DEFAULT 'fixed';--> statement-breakpoint
ALTER TABLE "user_risk_profiles" ADD COLUMN "trail_sl_pct" numeric(5, 3) DEFAULT '1.000';--> statement-breakpoint
ALTER TABLE "user_risk_profiles" ADD COLUMN "trail_tp_pct" numeric(5, 3) DEFAULT '2.000';--> statement-breakpoint
ALTER TABLE "user_risk_profiles" ADD COLUMN "trail_activation_pct" numeric(5, 3) DEFAULT '0.000';--> statement-breakpoint
ALTER TABLE "trail_audit_log" ADD CONSTRAINT "trail_audit_log_execution_id_trade_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."trade_executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tal_execution_id_idx" ON "trail_audit_log" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "tal_user_id_idx" ON "trail_audit_log" USING btree ("user_id");