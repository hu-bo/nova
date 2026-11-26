CREATE TABLE "model_usages" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	"model_name" text NOT NULL,
	"model_config_version" integer NOT NULL,
	"status" text NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cache_read_tokens" bigint NOT NULL,
	"reasoning_tokens" bigint NOT NULL,
	"cost" numeric(38, 8) NOT NULL,
	"estimated" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_configs" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "model_usages" ADD CONSTRAINT "model_usages_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_usages" ADD CONSTRAINT "model_usages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_usages_created_at_idx" ON "model_usages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "model_usages_model_created_at_idx" ON "model_usages" USING btree ("model_id","created_at");--> statement-breakpoint
CREATE INDEX "model_usages_status_created_at_idx" ON "model_usages" USING btree ("status","created_at");