-- 0007 already applied the run/session changes absent from its historical snapshot.
-- Only identity uniqueness is new here. Existing duplicates fail rather than reassign owners.
DROP INDEX "users_identity_id_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "users_identity_id_idx" ON "users" USING btree ("identity_id");
