-- Migration 0001: nova-server v1 surface
--
-- 引入 owner_user_id / soft delete / v1 tables (users / project_bindings / conversations /
-- messages / pending_inputs / runs / ui_events / runner_tokens / runners / runner_operations).
-- 与 docs/nova-server.md §6.1 + §6.1.1 对齐; 不在 DB 层声明外键约束, 一致性由
-- (owner_user_id, resource_id) 复合索引 + 应用层 owner predicate 共同维护.

ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "owner_user_id" uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
--> statement-breakpoint
DROP INDEX IF EXISTS "projects_created_at_id_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "projects_owner_created_idx"
  ON "projects" USING btree ("owner_user_id","created_at","id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "projects_deleted_at_idx"
  ON "projects" USING btree ("deleted_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "identity_id" text NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "display_name" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_identity_id_idx" ON "users" USING btree ("identity_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "project_bindings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "revision" integer NOT NULL,
  "runner_id" text,
  "workspace_id" text NOT NULL,
  "canonical_cwd" text NOT NULL,
  "instructions" jsonb NOT NULL,
  "is_current" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "invalidated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_bindings_project_revision_idx"
  ON "project_bindings" USING btree ("project_id","revision");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_bindings_project_current_idx"
  ON "project_bindings" USING btree ("project_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_user_id" uuid NOT NULL,
  "mode" text NOT NULL,
  "project_id" uuid,
  "title" text,
  "context_epoch" bigint DEFAULT 1 NOT NULL,
  "active_run_id" uuid,
  "last_event_sequence" bigint DEFAULT 0 NOT NULL,
  "metadata" jsonb DEFAULT '{}' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_owner_updated_idx"
  ON "conversations" USING btree ("owner_user_id","updated_at","id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL,
  "role" text NOT NULL,
  "blocks" jsonb DEFAULT '[]' NOT NULL,
  "attachments" jsonb DEFAULT '[]' NOT NULL,
  "revision" bigint DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_conversation_created_idx"
  ON "messages" USING btree ("conversation_id","created_at","id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "pending_inputs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL,
  "sequence" bigint NOT NULL,
  "mode" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "payload" jsonb DEFAULT '{}' NOT NULL,
  "revision" bigint DEFAULT 1 NOT NULL,
  "consumed_at" timestamp with time zone,
  "removed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pending_inputs_conversation_sequence_unique"
    UNIQUE ("conversation_id","sequence")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL,
  "state" text NOT NULL,
  "phase" text DEFAULT 'prepare' NOT NULL,
  "deadline_at" timestamp with time zone,
  "pause_reason" text,
  "failure_reason" text,
  "budget" jsonb DEFAULT '{}' NOT NULL,
  "fence" bigint DEFAULT 1 NOT NULL,
  "worker_id" text,
  "lease_until" timestamp with time zone,
  "revision" bigint DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_conversation_state_idx"
  ON "runs" USING btree ("conversation_id","state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_worker_lease_idx"
  ON "runs" USING btree ("worker_id","lease_until");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ui_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL,
  "sequence" bigint NOT NULL,
  "run_id" uuid,
  "protocol_version" text DEFAULT '2' NOT NULL,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  "context_epoch" bigint DEFAULT 1 NOT NULL,
  "type" text NOT NULL,
  "payload" jsonb DEFAULT '{}' NOT NULL,
  CONSTRAINT "ui_events_conversation_sequence_unique"
    UNIQUE ("conversation_id","sequence")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ui_events_occurred_at_idx"
  ON "ui_events" USING btree ("occurred_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "runner_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_user_id" uuid NOT NULL,
  "token_hash" text NOT NULL,
  "prev_token_hash" text,
  "label" text,
  "capabilities" jsonb DEFAULT '[]' NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "rotated_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "last_used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "runner_tokens_owner_hash_unique"
    UNIQUE ("owner_user_id","token_hash")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runner_tokens_status_idx"
  ON "runner_tokens" USING btree ("status","status_changed_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "runners" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_user_id" uuid NOT NULL,
  "runner_id" text NOT NULL,
  "boot_id" text,
  "workspace_id" text,
  "capabilities" jsonb DEFAULT '[]' NOT NULL,
  "last_seen_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "runners_owner_runner_unique"
    UNIQUE ("owner_user_id","runner_id")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "runner_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "operation_id" text NOT NULL,
  "run_id" uuid NOT NULL,
  "tool_call_id" text NOT NULL,
  "boot" text,
  "status" text DEFAULT 'queued' NOT NULL,
  "payload_hash" text,
  "deadline_at" timestamp with time zone,
  "result_payload" jsonb,
  "known_outcome" boolean DEFAULT false NOT NULL,
  "revision" bigint DEFAULT 1 NOT NULL,
  "dispatched_at" timestamp with time zone,
  "acknowledged_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runner_operations_run_tool_idx"
  ON "runner_operations" USING btree ("run_id","tool_call_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runner_operations_status_idx"
  ON "runner_operations" USING btree ("status","deadline_at");