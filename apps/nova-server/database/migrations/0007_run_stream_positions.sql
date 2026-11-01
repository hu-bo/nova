ALTER TABLE runs ADD COLUMN stream_state jsonb;
--> statement-breakpoint
CREATE INDEX pending_inputs_conversation_status_sequence_idx ON pending_inputs(conversation_id, status, sequence);
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN checkpoint_revision bigint NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN checkpoint_metadata jsonb;
--> statement-breakpoint
UPDATE runs SET checkpoint_metadata = checkpoint - 'nativeState' - 'executions' WHERE checkpoint IS NOT NULL;
--> statement-breakpoint
UPDATE runs SET checkpoint_revision = revision;
--> statement-breakpoint
CREATE TABLE session_commits (
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  revision bigint NOT NULL,
  batch jsonb NOT NULL,
  PRIMARY KEY(run_id, revision)
);
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN effect_state text NOT NULL DEFAULT 'known';
--> statement-breakpoint
UPDATE runs SET effect_state = CASE
  WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(checkpoint->'executions','[]')) e WHERE e->>'effects' IS DISTINCT FROM 'read' AND e->'result'->>'outcome'='unknown') THEN 'unknown'
  WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(checkpoint->'executions','[]')) e WHERE e->>'effects' IS DISTINCT FROM 'read' AND e->>'dispatch'='dispatched' AND NOT (e ? 'result')) THEN 'pending'
  ELSE 'known' END;
