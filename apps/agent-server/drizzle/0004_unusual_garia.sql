CREATE TABLE "model_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"api_key_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	"status" text NOT NULL,
	"input" bigint NOT NULL,
	"output" bigint NOT NULL,
	"cache_read" bigint DEFAULT 0 NOT NULL,
	"cost" numeric(20, 8) NOT NULL,
	"estimated" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_usage" ADD CONSTRAINT "model_usage_api_key_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."model_api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_usage" ADD CONSTRAINT "model_usage_model_fk" FOREIGN KEY ("model_id") REFERENCES "public"."model_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_usage_api_key_created_idx" ON "model_usage" USING btree ("api_key_id","created_at");--> statement-breakpoint
CREATE INDEX "model_usage_model_created_idx" ON "model_usage" USING btree ("model_id","created_at");