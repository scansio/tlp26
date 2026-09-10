CREATE TABLE "ai_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"model_id" text NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"gateway" text NOT NULL,
	"context_max" integer,
	"capabilities" jsonb DEFAULT '{"toolCalling":false,"structuredOutput":false,"streaming":false}'::jsonb,
	"eval_score" numeric(6, 2),
	"eval_run_id" text,
	"byok_eligible" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "ai_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"byok_eligible" boolean DEFAULT false,
	"platform_pooled_key_available" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "ai_providers_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "ai_models" ADD CONSTRAINT "ai_models_provider_id_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "am_provider_id_idx" ON "ai_models" USING btree ("provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "am_provider_model_idx" ON "ai_models" USING btree ("provider_id","model_id");