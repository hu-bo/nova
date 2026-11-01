-- Unified chat protocol: preserve display history; interrupt legacy runs lacking native checkpoints.
DROP INDEX "messages_conversation_created_idx";--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "last_event_sequence" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "pending_inputs" ALTER COLUMN "payload" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "ui_events" ALTER COLUMN "payload" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "last_message_sequence" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sequence" bigint;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "state" text DEFAULT 'completed' NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_inputs" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "pending_inputs" ADD COLUMN "fingerprint" text;--> statement-breakpoint
ALTER TABLE "pending_inputs" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "pending_inputs" ADD COLUMN "message_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "checkpoint" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "projection" jsonb;--> statement-breakpoint

-- Preserve display history. Native tool ordering/metadata previously lost cannot be recovered.
CREATE FUNCTION pg_temp.chat_blocks(blocks jsonb, attachments jsonb, metadata jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE result jsonb := '[]'; block jsonb; attachment jsonb; reference jsonb; identifier text; i integer := 0;
BEGIN
 FOR block IN SELECT value FROM jsonb_array_elements(COALESCE(blocks,'[]')) LOOP
  identifier := 'block:' || i; i := i+1;
  CASE block->>'type'
   WHEN 'text' THEN block := jsonb_build_object('id',identifier,'type','text','text',COALESCE(block->>'text',''));
   WHEN 'thinking' THEN block := jsonb_build_object('id',identifier,'type','thinking','text',COALESCE(block->>'text',''));
   WHEN 'code' THEN block := jsonb_build_object('id',identifier,'type','code','language',COALESCE(block->>'language',''),'code',COALESCE(block->>'code','')) || CASE WHEN block ? 'path' THEN jsonb_build_object('path',block->>'path') ELSE '{}'::jsonb END;
   WHEN 'diff' THEN block := jsonb_build_object('id',identifier,'type','diff','path',COALESCE(block->>'path',''),'diff',COALESCE(block->>'diff',''));
   WHEN 'error' THEN block := jsonb_build_object('id',identifier,'type','error','error',jsonb_build_object('code',COALESCE(NULLIF(block->>'code',''),'LEGACY_ERROR'),'message',COALESCE(NULLIF(block->>'message',''),'Legacy error')));
   WHEN 'tool_call' THEN block := jsonb_build_object('id',identifier,'type','tool_call','callId',COALESCE(NULLIF(block->>'callId',''),identifier),'name',COALESCE(block->>'name','tool'),'args',COALESCE(block->'args','null'));
   WHEN 'tool_result' THEN block := jsonb_build_object('id',identifier,'type','tool_result','callId',COALESCE(NULLIF(block->>'callId',''),identifier),'operationId',COALESCE(NULLIF(block->>'callId',''),identifier),'outcome',CASE WHEN block->>'status'='ok' THEN 'succeeded' ELSE 'failed' END,'content',jsonb_build_array(jsonb_build_object('id','content','type','text','text',COALESCE(block->'blocks','[]')::text)));
   ELSE block := jsonb_build_object('id',identifier,'type','custom','name','legacy','data',block,'fallback','历史内容：' || block::text);
  END CASE;
  result := result || jsonb_build_array(block);
 END LOOP;
 FOR attachment IN SELECT value FROM jsonb_array_elements(COALESCE(attachments,'[]')) LOOP
  reference := NULL;
  IF attachment->>'kind'='minio' THEN reference := jsonb_build_object('kind','object','key',attachment->>'key');
  ELSIF attachment->>'kind'='ssh_ref' THEN reference := jsonb_build_object('kind','ssh','remoteConnectionId',attachment->>'remoteConnectionId','path',attachment->>'relativePath');
  ELSIF attachment->>'kind'='runner_ref' AND metadata->'binding'->>'runnerId' IS NOT NULL AND metadata->'binding'->>'workspaceId' IS NOT NULL THEN reference := jsonb_build_object('kind','runner','runnerId',metadata->'binding'->>'runnerId','workspaceId',metadata->'binding'->>'workspaceId','path',attachment->>'relativePath');
  END IF;
  identifier := 'attachment:' || i; i := i+1;
  IF reference IS NULL THEN block := jsonb_build_object('id',identifier,'type','custom','name','legacy_attachment','data',attachment,'fallback','历史附件引用不可恢复');
  ELSE block := jsonb_build_object('id',identifier,'type',CASE WHEN COALESCE(attachment->'summary'->>'mime','text/plain') LIKE 'image/%' THEN 'image' ELSE 'file' END,'attachment',jsonb_strip_nulls(jsonb_build_object('ref',reference,'name',COALESCE(attachment->>'relativePath',attachment->>'key','file'),'mimeType',COALESCE(attachment->'summary'->>'mime','text/plain'),'size',attachment->'summary'->'size','sha256',attachment->'summary'->'sha256')));
  END IF;
  result := result || jsonb_build_array(block);
 END LOOP;
 RETURN result;
END $$;
--> statement-breakpoint
UPDATE messages m SET blocks=pg_temp.chat_blocks(m.blocks,m.attachments,c.metadata) FROM conversations c WHERE c.id=m.conversation_id;
--> statement-breakpoint
WITH ordered AS (SELECT id,row_number() OVER(PARTITION BY conversation_id ORDER BY created_at,id) AS sequence FROM messages) UPDATE messages m SET sequence=o.sequence FROM ordered o WHERE o.id=m.id;
--> statement-breakpoint
UPDATE conversations c SET last_message_sequence=COALESCE((SELECT max(sequence) FROM messages m WHERE m.conversation_id=c.id),0);
--> statement-breakpoint
UPDATE conversations SET metadata=jsonb_strip_nulls((metadata-'runtime'-'executionStarted'-'contextClearedAt'-'plan'-'latestCheckpointRunId') || jsonb_build_object('configuration',jsonb_strip_nulls(jsonb_build_object('backendId','nova','modelId',COALESCE(metadata->'runtime'->'modelId','null'),'mode',COALESCE(metadata->'runtime'->>'executionMode','build'),'reasoningEffort',metadata->'runtime'->'reasoningEffort','remoteConnectionId',metadata->'runtime'->'remoteConnectionId')),'plan',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',item->>'id','text',COALESCE(item->>'content',''),'status',item->>'status')) FROM jsonb_array_elements(COALESCE(metadata->'plan'->'items','[]')) item),'[]'::jsonb)));
--> statement-breakpoint
UPDATE pending_inputs p SET idempotency_key=p.payload->>'idempotencyKey', payload=jsonb_build_object('blocks',pg_temp.chat_blocks(jsonb_build_array(jsonb_build_object('type','text','text',COALESCE(p.payload->>'text',''))),COALESCE(p.payload->'attachments','[]'),c.metadata),'mode',p.mode,'configuration',c.metadata->'configuration') FROM conversations c WHERE c.id=p.conversation_id;
--> statement-breakpoint
-- Legacy queued keys cannot be safely retried across schemas; preserve them and reject changed payloads.
UPDATE pending_inputs SET fingerprint='legacy:' || id;
--> statement-breakpoint
UPDATE pending_inputs SET status='rejected' WHERE status='queued' AND (EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'blocks') block WHERE block->>'type' NOT IN ('text','image','file')) OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'blocks') block WHERE block->>'type' IN ('image','file') OR length(trim(block->>'text'))>0));
--> statement-breakpoint
ALTER TABLE messages ALTER COLUMN sequence SET NOT NULL;
--> statement-breakpoint
ALTER TABLE pending_inputs ALTER COLUMN fingerprint SET NOT NULL;
--> statement-breakpoint
UPDATE runs SET state=CASE WHEN state='cancelling' OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(budget->'draftMessages','[]')) message CROSS JOIN LATERAL jsonb_array_elements(COALESCE(message->'blocks','[]')) block WHERE block->>'type'='tool_call' AND block->>'status' IN ('running','outcome_unknown')) THEN 'cancelled_unconfirmed' ELSE 'failed' END,failure_reason='LEGACY_CHECKPOINT_UNAVAILABLE',worker_id=NULL,lease_until=NULL WHERE state IN ('queued','running','waiting_decision','waiting','paused','cancelling');
--> statement-breakpoint
UPDATE conversations SET active_run_id=NULL,metadata=CASE WHEN metadata->'goal'->>'status'='active' THEN jsonb_set(metadata,'{goal,status}','"paused"') ELSE metadata END;
--> statement-breakpoint
CREATE UNIQUE INDEX runs_conversation_active_unique ON runs(conversation_id) WHERE state IN ('queued','running','waiting','paused','cancelling');
--> statement-breakpoint
CREATE UNIQUE INDEX pending_inputs_idempotency_unique ON pending_inputs(conversation_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX conversations_creation_key_unique ON conversations(owner_user_id,(metadata->>'creationKey')) WHERE metadata->>'creationKey' IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "messages_conversation_sequence_idx" ON "messages" USING btree ("conversation_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_conversation_sequence_unique" ON "messages" USING btree ("conversation_id","sequence");--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "attachments";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "revision";--> statement-breakpoint
ALTER TABLE "pending_inputs" DROP COLUMN "revision";--> statement-breakpoint
ALTER TABLE "ui_events" DROP COLUMN "protocol_version";--> statement-breakpoint
ALTER TABLE "ui_events" DROP COLUMN "context_epoch";
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "event_floor_sequence" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE conversations SET event_floor_sequence=last_event_sequence;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "source" jsonb;
