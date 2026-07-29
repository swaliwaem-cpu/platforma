-- Add explicit project audiences while preserving access to all existing projects.
CREATE TYPE "training_project_audience_mode" AS ENUM (
  'all_eligible',
  'assigned_only'
);

CREATE TYPE "training_source_origin_kind" AS ENUM (
  'upload',
  'linked_object_pdf'
);

ALTER TABLE "training_projects"
  ADD COLUMN "audience_mode" "training_project_audience_mode" NOT NULL DEFAULT 'all_eligible',
  ADD COLUMN "audience_revision" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "training_projects_audience_revision_check" CHECK ("audience_revision" >= 0);

-- Existing rows are backfilled by the non-null defaults above. Application code
-- explicitly opts new projects into assigned_only after this compatibility migration.
ALTER TABLE "training_source_documents"
  ADD COLUMN "origin_kind" "training_source_origin_kind" NOT NULL DEFAULT 'upload',
  ADD COLUMN "origin_metadata_json" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT "training_source_documents_origin_metadata_check" CHECK (
    jsonb_typeof("origin_metadata_json") = 'object'
  );

ALTER TABLE "training_attempts"
  ADD COLUMN "assignment_id" UUID;

CREATE TABLE "training_project_assignments" (
  "id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "assigned_by_id" UUID NOT NULL,
  "revoked_by_id" UUID,
  "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "training_project_assignments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "training_project_assignments_time_check" CHECK (
    "assigned_at" >= "created_at"
    AND ("revoked_at" IS NULL OR "revoked_at" >= "assigned_at")
  ),
  CONSTRAINT "training_project_assignments_revoke_actor_check" CHECK (
    "revoked_at" IS NOT NULL OR "revoked_by_id" IS NULL
  )
);

CREATE UNIQUE INDEX "training_project_assignments_project_id_user_id_key"
  ON "training_project_assignments"("project_id", "user_id");

CREATE INDEX "training_project_assignments_user_id_revoked_at_project_id_idx"
  ON "training_project_assignments"("user_id", "revoked_at", "project_id");

CREATE INDEX "training_project_assignments_project_id_revoked_at_assigned_at_idx"
  ON "training_project_assignments"("project_id", "revoked_at", "assigned_at");

CREATE INDEX "training_project_assignments_assigned_by_id_idx"
  ON "training_project_assignments"("assigned_by_id");

CREATE INDEX "training_project_assignments_revoked_by_id_idx"
  ON "training_project_assignments"("revoked_by_id");

CREATE INDEX "training_attempts_assignment_id_idx"
  ON "training_attempts"("assignment_id");

ALTER TABLE "training_project_assignments"
  ADD CONSTRAINT "training_project_assignments_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "training_projects"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "training_project_assignments_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "training_project_assignments_assigned_by_id_fkey"
    FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "training_project_assignments_revoked_by_id_fkey"
    FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "training_attempts"
  ADD CONSTRAINT "training_attempts_assignment_id_fkey"
    FOREIGN KEY ("assignment_id") REFERENCES "training_project_assignments"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Assignment identity never changes; reactivation updates the same row's
-- assignment/revocation audit fields instead.
CREATE FUNCTION "training_prevent_assignment_identity_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
  THEN
    RAISE EXCEPTION 'Training assignment project and user are immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "training_project_assignments_prevent_identity_mutation"
BEFORE UPDATE OF "project_id", "user_id"
ON "training_project_assignments"
FOR EACH ROW
EXECUTE FUNCTION "training_prevent_assignment_identity_mutation"();

-- Fail closed for assigned-only projects and guarantee that a pinned
-- assignment belongs to the same project and user as the attempt.
CREATE FUNCTION "training_validate_attempt_assignment"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  project_audience_mode "training_project_audience_mode";
  assignment_matches BOOLEAN;
BEGIN
  SELECT "audience_mode"
  INTO project_audience_mode
  FROM "training_projects"
  WHERE "id" = NEW."project_id";

  IF project_audience_mode = 'assigned_only' AND NEW."assignment_id" IS NULL THEN
    RAISE EXCEPTION 'Assigned-only training attempts require an assignment';
  END IF;

  IF NEW."assignment_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM "training_project_assignments"
    WHERE "id" = NEW."assignment_id"
      AND "project_id" = NEW."project_id"
      AND "user_id" = NEW."user_id"
      AND "revoked_at" IS NULL
  )
  INTO assignment_matches;

  IF NOT assignment_matches THEN
    RAISE EXCEPTION 'Training attempt assignment must match its project and user';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "training_attempts_validate_assignment"
BEFORE INSERT OR UPDATE OF "assignment_id", "project_id", "user_id"
ON "training_attempts"
FOR EACH ROW
EXECUTE FUNCTION "training_validate_attempt_assignment"();

-- The existing training_documents_prevent_published_mutation trigger also
-- protects origin_kind and origin_metadata_json on published source rows.
