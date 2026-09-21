CREATE TABLE "user_llm_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"provider_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	"encrypted_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "user_llm_keys_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "user_llm_keys" ADD CONSTRAINT "user_llm_keys_provider_id_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_llm_keys" ADD CONSTRAINT "user_llm_keys_model_id_ai_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."ai_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ulk_user_id_idx" ON "user_llm_keys" USING btree ("user_id");