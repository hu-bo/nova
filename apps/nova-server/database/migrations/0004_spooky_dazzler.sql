CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"aggregate_id" uuid,
	"dedupe_key" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"lease_until" timestamp with time zone,
	"status" text DEFAULT 'queued' NOT NULL,
	"safe_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "jobs_status_available_idx" ON "jobs" USING btree ("status","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_kind_aggregate_dedupe_idx" ON "jobs" USING btree ("kind","aggregate_id","dedupe_key");