CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(128) NOT NULL,
	"project_id" uuid,
	"runner_id" text NOT NULL,
	"title" text NOT NULL,
	"model_config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entries" (
	"conversation_id" uuid NOT NULL,
	"id" text NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "entries_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"parent_id" text,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "entries_conversation_id_id_pk" PRIMARY KEY("conversation_id","id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"conversation_id" uuid NOT NULL,
	"id" text NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "messages_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"role" text NOT NULL,
	"blocks" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "messages_conversation_id_id_pk" PRIMARY KEY("conversation_id","id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(128) NOT NULL,
	"name" text NOT NULL,
	"workspace" text,
	"runner_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_owner_workspace_unique" UNIQUE("user_id","runner_id","workspace"),
	CONSTRAINT "projects_id_user_unique" UNIQUE("id","user_id")
);
--> statement-breakpoint
CREATE TABLE "records" (
	"conversation_id" uuid NOT NULL,
	"id" text NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "records_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "records_conversation_id_id_pk" PRIMARY KEY("conversation_id","id")
);
--> statement-breakpoint
CREATE TABLE "runners" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" varchar(128) NOT NULL,
	"generation" text NOT NULL,
	"root_workspace" text NOT NULL,
	"version" text NOT NULL,
	"platform" text NOT NULL,
	"capabilities" text[] NOT NULL,
	"labels" jsonb NOT NULL,
	"max_concurrency" integer NOT NULL,
	"running" integer NOT NULL,
	"reported_state" text,
	"registered_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"casdoor_id" varchar(128) NOT NULL,
	"username" varchar(64) DEFAULT '' NOT NULL,
	"display_name" varchar(64) DEFAULT '' NOT NULL,
	"role" varchar(64) DEFAULT '' NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_casdoor_id_unique" UNIQUE("casdoor_id")
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("casdoor_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_owner_fk" FOREIGN KEY ("project_id","user_id") REFERENCES "public"."projects"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_parent_fk" FOREIGN KEY ("conversation_id","parent_id") REFERENCES "public"."entries"("conversation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("casdoor_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_owner_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("casdoor_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_owner_project_updated_idx" ON "conversations" USING btree ("user_id","project_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "entries_conversation_seq_idx" ON "entries" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE INDEX "messages_conversation_created_seq_idx" ON "messages" USING btree ("conversation_id","created_at","seq");--> statement-breakpoint
CREATE INDEX "records_conversation_run_seq_idx" ON "records" USING btree ("conversation_id","run_id","seq");--> statement-breakpoint
CREATE INDEX "records_conversation_kind_seq_idx" ON "records" USING btree ("conversation_id","kind","seq");