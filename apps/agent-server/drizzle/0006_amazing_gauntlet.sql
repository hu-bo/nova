ALTER TABLE "model_providers" ADD COLUMN "wire_api" text DEFAULT 'chat_completions' NOT NULL;--> statement-breakpoint
UPDATE "model_providers" SET "wire_api" = 'anthropic' WHERE "protocol" = 'anthropic';
