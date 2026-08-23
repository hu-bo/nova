CREATE TABLE "model_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_prefix" varchar(32) NOT NULL,
	"name" varchar(80) NOT NULL,
	"owner_id" varchar(120) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "model_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_name" varchar(100) NOT NULL,
	"provider_id" uuid NOT NULL,
	"upstream_name" varchar(150) NOT NULL,
	"context_window" integer NOT NULL,
	"max_output" integer NOT NULL,
	"thinking_levels" text[] NOT NULL,
	"parallel_tool_calls" boolean NOT NULL,
	"reasoning_format" text NOT NULL,
	"input_modalities" text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"price_in" numeric(18, 8) NOT NULL,
	"price_out" numeric(18, 8) NOT NULL,
	"price_cache_read" numeric(18, 8) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "model_catalog_public_name_unique" UNIQUE("public_name")
);
--> statement-breakpoint
CREATE TABLE "model_quotas" (
	"api_key_id" uuid PRIMARY KEY NOT NULL,
	"rpm" integer,
	"tpm" integer,
	"monthly_cost" numeric(18, 8),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_catalog" ADD CONSTRAINT "model_catalog_provider_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_quotas" ADD CONSTRAINT "model_quotas_api_key_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."model_api_keys"("id") ON DELETE cascade ON UPDATE no action;