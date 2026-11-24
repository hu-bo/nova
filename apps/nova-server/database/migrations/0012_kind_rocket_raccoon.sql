CREATE TABLE "skill_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid NOT NULL,
	"version" text NOT NULL,
	"body" text NOT NULL,
	"slug" text NOT NULL,
	"description" text NOT NULL,
	"display_name" text,
	"requirements" jsonb NOT NULL,
	"sha256" text NOT NULL,
	"source_sha256" text,
	"resources" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"owner_user_id" uuid,
	"project_id" uuid,
	"runner_id" text,
	"workspace_id" text,
	"relative_cwd" text,
	"slug" text NOT NULL,
	"display_name" text,
	"description" text DEFAULT '' NOT NULL,
	"draft_body" text,
	"draft_requirements" jsonb,
	"draft_revision" integer DEFAULT 1 NOT NULL,
	"current_published_version_id" uuid,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_versions_skill_version_uidx" ON "skill_versions" USING btree ("skill_id","version");--> statement-breakpoint
CREATE INDEX "skill_versions_skill_sha_idx" ON "skill_versions" USING btree ("skill_id","sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_local_identity_uidx" ON "skills" USING btree ("owner_user_id","runner_id","source","workspace_id","relative_cwd","slug") WHERE source in ('runner-global', 'runner-project') and owner_user_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "skills_builtin_slug_uidx" ON "skills" USING btree ("slug") WHERE source = 'builtin';