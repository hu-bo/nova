CREATE TABLE "remote_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"hostname" text NOT NULL,
	"port" integer DEFAULT 22 NOT NULL,
	"username" text NOT NULL,
	"root_path" text NOT NULL,
	"auth_method" text NOT NULL,
	"credential_ciphertext" text NOT NULL,
	"passphrase_ciphertext" text,
	"host_fingerprint" text,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "project_bindings" ADD COLUMN "remote_connection_id" uuid;--> statement-breakpoint
CREATE INDEX "remote_connections_owner_idx" ON "remote_connections" USING btree ("owner_user_id");