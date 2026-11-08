CREATE TABLE "spec_revisions" (
	"spec_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"requirements_md" text DEFAULT '' NOT NULL,
	"design_md" text,
	"task_plan" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reviews" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"acceptance" jsonb,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spec_revisions_spec_id_revision_pk" PRIMARY KEY("spec_id","revision")
);
--> statement-breakpoint
CREATE TABLE "spec_task_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"spec_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"task_key" text NOT NULL,
	"pending_input_id" uuid NOT NULL,
	"request_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"resolution" jsonb,
	CONSTRAINT "spec_task_attempts_pending_input_id_unique" UNIQUE("pending_input_id")
);
--> statement-breakpoint
CREATE TABLE "specs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"title" text NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "specs_conversation_id_unique" UNIQUE("conversation_id")
);
--> statement-breakpoint
ALTER TABLE "spec_revisions" ADD CONSTRAINT "spec_revisions_spec_id_specs_id_fk" FOREIGN KEY ("spec_id") REFERENCES "specs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_task_attempts" ADD CONSTRAINT "spec_task_attempts_revision_fk" FOREIGN KEY ("spec_id","revision") REFERENCES "spec_revisions"("spec_id","revision") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "spec_task_attempts_request_unique" ON "spec_task_attempts" USING btree ("spec_id","request_key");--> statement-breakpoint
CREATE UNIQUE INDEX "spec_task_attempts_active_unique" ON "spec_task_attempts" USING btree ("spec_id") WHERE "spec_task_attempts"."released_at" is null;--> statement-breakpoint
CREATE INDEX "spec_task_attempts_history_idx" ON "spec_task_attempts" USING btree ("spec_id","revision","task_key","created_at","id");--> statement-breakpoint
CREATE INDEX "spec_task_attempts_spec_idx" ON "spec_task_attempts" USING btree ("spec_id");--> statement-breakpoint
CREATE INDEX "specs_project_updated_idx" ON "specs" USING btree ("project_id","updated_at","id");
