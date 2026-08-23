UPDATE "conversations" SET "model_config" = "model_config" - 'wireApi' WHERE "model_config" ? 'wireApi';--> statement-breakpoint
ALTER TABLE "model_providers" DROP COLUMN "wire_api";
