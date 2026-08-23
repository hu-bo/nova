ALTER TABLE "model_providers" ADD COLUMN "is_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "model_providers" ADD COLUMN "owner_id" varchar(128);--> statement-breakpoint
UPDATE "model_providers" SET "is_public" = true WHERE "owner_id" IS NULL;--> statement-breakpoint
ALTER TABLE "model_providers" ADD CONSTRAINT "model_providers_owner_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("casdoor_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_providers_visibility_idx" ON "model_providers" USING btree ("is_public","owner_id");
