CREATE TABLE "runs" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"payload" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_status_updated_idx" ON "runs" USING btree ("status","updated_at");