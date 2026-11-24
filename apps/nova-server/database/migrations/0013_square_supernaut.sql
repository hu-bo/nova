CREATE TABLE "run_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"tool_execution_id" text NOT NULL,
	"skill_version_id" uuid,
	"name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" bigint DEFAULT 0 NOT NULL,
	"sha256" text,
	"object_key" text,
	"state" text DEFAULT 'publishing' NOT NULL,
	"preview" text DEFAULT 'download' NOT NULL,
	"recovery" jsonb,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_artifacts" ADD CONSTRAINT "run_artifacts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_artifacts" ADD CONSTRAINT "run_artifacts_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "skill_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_artifacts_run_execution_uidx" ON "run_artifacts" USING btree ("run_id","tool_execution_id");--> statement-breakpoint
CREATE INDEX "run_artifacts_state_idx" ON "run_artifacts" USING btree ("state","updated_at");