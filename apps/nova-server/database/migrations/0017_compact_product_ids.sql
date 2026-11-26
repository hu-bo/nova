-- Old IDs also live in JSON payloads and queued jobs. Apply after clearing these tables.
LOCK TABLE "conversations", "jobs", "messages", "model_usages", "pending_inputs",
  "run_artifacts", "runner_operations", "runs", "session_commits", "spec_task_attempts", "specs", "ui_events"
  IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "conversations") OR EXISTS (SELECT 1 FROM "jobs")
    OR EXISTS (SELECT 1 FROM "messages") OR EXISTS (SELECT 1 FROM "model_usages")
    OR EXISTS (SELECT 1 FROM "pending_inputs") OR EXISTS (SELECT 1 FROM "run_artifacts")
    OR EXISTS (SELECT 1 FROM "runner_operations") OR EXISTS (SELECT 1 FROM "runs")
    OR EXISTS (SELECT 1 FROM "session_commits") OR EXISTS (SELECT 1 FROM "spec_task_attempts")
    OR EXISTS (SELECT 1 FROM "specs") OR EXISTS (SELECT 1 FROM "ui_events")
  THEN
    RAISE EXCEPTION 'Compact product IDs require empty conversation, run, specification and job tables'
      USING ERRCODE = '55000';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "model_usages" DROP CONSTRAINT "model_usages_run_id_runs_id_fk",
  DROP CONSTRAINT "model_usages_conversation_id_conversations_id_fk";
--> statement-breakpoint
ALTER TABLE "run_artifacts" DROP CONSTRAINT "run_artifacts_run_id_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "session_commits" DROP CONSTRAINT "session_commits_run_id_fkey";
--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "pending_inputs" ALTER COLUMN "id" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "id" DROP DEFAULT;
--> statement-breakpoint
DROP INDEX IF EXISTS "ui_events_conversation_sequence_idx";
--> statement-breakpoint
ALTER TABLE "ui_events" DROP CONSTRAINT IF EXISTS "ui_events_conversation_sequence_unique", DROP COLUMN "id";
--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "id" SET DATA TYPE bytea USING NULL::bytea;--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "id" SET DEFAULT substring(uuid_send(gen_random_uuid()) from 1 for 6)
  || substring(uuid_send(gen_random_uuid()) from 10 for 6);--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "active_run_id" SET DATA TYPE bytea USING NULL::bytea;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "aggregate_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "conversation_id" SET DATA TYPE bytea USING NULL::bytea;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "run_id" SET DATA TYPE bytea USING NULL::bytea;--> statement-breakpoint
ALTER TABLE "model_providers" ALTER COLUMN "owner_id" SET DATA TYPE uuid USING "owner_id"::uuid;--> statement-breakpoint
ALTER TABLE "model_usages" ALTER COLUMN "run_id" SET DATA TYPE bytea USING NULL::bytea;--> statement-breakpoint
ALTER TABLE "model_usages" ALTER COLUMN "conversation_id" SET DATA TYPE bytea USING NULL::bytea;--> statement-breakpoint
ALTER TABLE "pending_inputs" ALTER COLUMN "id" SET DATA TYPE bytea USING NULL::bytea;--> statement-breakpoint
ALTER TABLE "pending_inputs" ALTER COLUMN "id" SET DEFAULT substring(uuid_send(gen_random_uuid()) from 1 for 6)
  || substring(uuid_send(gen_random_uuid()) from 10 for 6);--> statement-breakpoint
ALTER TABLE "pending_inputs" ALTER COLUMN "conversation_id" SET DATA TYPE bytea USING NULL::bytea;--> statement-breakpoint
ALTER TABLE "pending_inputs" ALTER COLUMN "run_id" SET DATA TYPE bytea USING NULL::bytea;--> statement-breakpoint
ALTER TABLE "project_bindings" ALTER COLUMN "runner_id" SET DATA TYPE uuid USING "runner_id"::uuid;--> statement-breakpoint
ALTER TABLE "run_artifacts" ALTER COLUMN "run_id" SET DATA TYPE bytea USING NULL::bytea;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "id" SET DATA TYPE bytea USING NULL::bytea;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "id" SET DEFAULT substring(uuid_send(gen_random_uuid()) from 1 for 6)
  || substring(uuid_send(gen_random_uuid()) from 10 for 6);--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "conversation_id" SET DATA TYPE bytea USING NULL::bytea;--> statement-breakpoint
ALTER TABLE "runner_operations" ALTER COLUMN "run_id" SET DATA TYPE bytea USING NULL::bytea;--> statement-breakpoint
ALTER TABLE "session_commits" ALTER COLUMN "run_id" SET DATA TYPE bytea USING NULL::bytea;--> statement-breakpoint
ALTER TABLE "spec_task_attempts" ALTER COLUMN "pending_input_id" SET DATA TYPE bytea USING NULL::bytea;--> statement-breakpoint
ALTER TABLE "specs" ALTER COLUMN "conversation_id" SET DATA TYPE bytea USING NULL::bytea;--> statement-breakpoint
ALTER TABLE "ui_events" ALTER COLUMN "conversation_id" SET DATA TYPE bytea USING NULL::bytea;--> statement-breakpoint
ALTER TABLE "ui_events" ALTER COLUMN "run_id" SET DATA TYPE bytea USING NULL::bytea;--> statement-breakpoint
ALTER TABLE "ui_events" ADD CONSTRAINT "ui_events_pkey" PRIMARY KEY("conversation_id","sequence");--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "latest_run_id" "bytea";--> statement-breakpoint
ALTER TABLE "model_usages" ADD CONSTRAINT "model_usages_run_id_runs_id_fk"
  FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "model_usages_conversation_id_conversations_id_fk"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "run_artifacts" ADD CONSTRAINT "run_artifacts_run_id_runs_id_fk"
  FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "session_commits" ADD CONSTRAINT "session_commits_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE;
