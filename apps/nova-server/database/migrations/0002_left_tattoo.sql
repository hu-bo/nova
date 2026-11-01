CREATE TABLE "model_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"protocol" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"credential_ciphertext" text,
	"credential_masked" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"owner_id" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "model_providers_deleted_at_idx" ON "model_providers" USING btree ("deleted_at");
--> statement-breakpoint
CREATE TABLE "model_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_name" text NOT NULL,
	"provider_id" uuid NOT NULL,
	"upstream_name" text NOT NULL,
	"context_window" numeric(10, 0) NOT NULL,
	"max_output" numeric(10, 0) NOT NULL,
	"thinking_levels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"parallel_tool_calls" boolean DEFAULT true NOT NULL,
	"reasoning_format" text DEFAULT 'none' NOT NULL,
	"input_modalities" jsonb DEFAULT '["text"]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"price_in" numeric(20, 8) DEFAULT '0' NOT NULL,
	"price_out" numeric(20, 8) DEFAULT '0' NOT NULL,
	"price_cache_read" numeric(20, 8) DEFAULT '0' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "model_configs_public_name_unique" ON "model_configs" USING btree ("public_name");
--> statement-breakpoint
CREATE INDEX "model_configs_provider_id_idx" ON "model_configs" USING btree ("provider_id");
--> statement-breakpoint
CREATE INDEX "model_configs_deleted_at_idx" ON "model_configs" USING btree ("deleted_at");
