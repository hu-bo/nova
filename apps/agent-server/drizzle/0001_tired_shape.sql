CREATE TABLE "runner_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(128) NOT NULL,
	"slot" integer NOT NULL,
	"token" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runner_tokens_token_unique" UNIQUE("token"),
	CONSTRAINT "runner_tokens_user_slot_unique" UNIQUE("user_id","slot")
);
--> statement-breakpoint
DELETE FROM "runners";--> statement-breakpoint
ALTER TABLE "runners" DROP CONSTRAINT "runners_pkey";--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "token_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_owner_id_id_pk" PRIMARY KEY("owner_id","id");--> statement-breakpoint
ALTER TABLE "runner_tokens" ADD CONSTRAINT "runner_tokens_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("casdoor_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_token_fk" FOREIGN KEY ("token_id") REFERENCES "public"."runner_tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runners_owner_seen_idx" ON "runners" USING btree ("owner_id","last_seen_at","id");
