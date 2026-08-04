CREATE TYPE "training_project_access_mode" AS ENUM ('all_participants', 'assigned_users');

ALTER TABLE "training_projects"
  ADD COLUMN "access_mode" "training_project_access_mode";

UPDATE "training_projects"
SET "access_mode" = 'all_participants';

ALTER TABLE "training_projects"
  ALTER COLUMN "access_mode" SET DEFAULT 'assigned_users',
  ALTER COLUMN "access_mode" SET NOT NULL;

CREATE TABLE "training_project_assignments" (
  "id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "assigned_by_id" UUID,
  "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "training_project_assignments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "training_project_assignments_project_id_user_id_key"
  ON "training_project_assignments"("project_id", "user_id");
CREATE INDEX "training_project_assignments_project_id_revoked_at_idx"
  ON "training_project_assignments"("project_id", "revoked_at");
CREATE INDEX "training_project_assignments_user_id_revoked_at_idx"
  ON "training_project_assignments"("user_id", "revoked_at");

ALTER TABLE "training_project_assignments"
  ADD CONSTRAINT "training_project_assignments_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "training_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "training_project_assignments_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "training_project_assignments_assigned_by_id_fkey"
    FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
