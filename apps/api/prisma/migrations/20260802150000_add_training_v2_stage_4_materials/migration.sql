CREATE TYPE "training_material_type" AS ENUM ('pdf', 'official_url', 'manual_text', 'object_snapshot');
CREATE TYPE "training_material_status" AS ENUM ('active', 'archived');
CREATE TYPE "training_material_revision_status" AS ENUM ('ready', 'failed');
CREATE TYPE "training_material_suggestion_status" AS ENUM ('not_generated', 'ready', 'failed');
CREATE TYPE "training_fact_source_type" AS ENUM ('manual', 'material');

ALTER TABLE "training_projects"
  DROP CONSTRAINT "training_projects_content_schema_version_check",
  ADD CONSTRAINT "training_projects_content_schema_version_check"
    CHECK ("content_schema_version" IN (1, 2, 3));

UPDATE "training_projects"
SET "content_schema_version" = 3
WHERE "content_schema_version" = 2;

CREATE TABLE "training_materials" (
  "id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "type" "training_material_type" NOT NULL,
  "title" VARCHAR(240) NOT NULL,
  "status" "training_material_status" NOT NULL DEFAULT 'active',
  "source_url" VARCHAR(2048),
  "official_confirmed_at" TIMESTAMP(3),
  "official_confirmed_by_id" UUID,
  "created_by_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "training_materials_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "training_materials_title_check" CHECK (btrim("title") <> ''),
  CONSTRAINT "training_materials_source_check" CHECK (
    (
      "type" = 'official_url' AND
      btrim(COALESCE("source_url", '')) <> '' AND
      "official_confirmed_at" IS NOT NULL AND
      "official_confirmed_by_id" IS NOT NULL
    ) OR
    (
      "type" <> 'official_url' AND
      "source_url" IS NULL AND
      "official_confirmed_at" IS NULL AND
      "official_confirmed_by_id" IS NULL
    )
  )
);

CREATE TABLE "training_material_revisions" (
  "id" UUID NOT NULL,
  "material_id" UUID NOT NULL,
  "revision_number" INTEGER NOT NULL,
  "previous_revision_id" UUID,
  "status" "training_material_revision_status" NOT NULL,
  "file_id" UUID,
  "requested_url" VARCHAR(2048),
  "final_url" VARCHAR(2048),
  "fetched_at" TIMESTAMP(3),
  "extracted_text" TEXT NOT NULL,
  "segments_json" JSONB NOT NULL,
  "content_hash" VARCHAR(64) NOT NULL,
  "extraction_metadata_json" JSONB NOT NULL,
  "diff_json" JSONB NOT NULL,
  "is_changed" BOOLEAN NOT NULL,
  "suggestion_status" "training_material_suggestion_status" NOT NULL DEFAULT 'not_generated',
  "suggestions_json" JSONB,
  "suggestion_model" VARCHAR(120),
  "suggestion_request_ids_json" JSONB,
  "suggestion_error_code" VARCHAR(120),
  "created_by_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "training_material_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "training_material_revisions_number_check" CHECK ("revision_number" > 0),
  CONSTRAINT "training_material_revisions_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "training_material_revisions_segments_check" CHECK (jsonb_typeof("segments_json") = 'array'),
  CONSTRAINT "training_material_revisions_metadata_check" CHECK (jsonb_typeof("extraction_metadata_json") = 'object'),
  CONSTRAINT "training_material_revisions_diff_check" CHECK (jsonb_typeof("diff_json") = 'object'),
  CONSTRAINT "training_material_revisions_suggestion_state_check" CHECK (
    ("suggestion_status" = 'not_generated' AND "suggestions_json" IS NULL AND "suggestion_error_code" IS NULL) OR
    ("suggestion_status" = 'ready' AND jsonb_typeof("suggestions_json") = 'array' AND "suggestion_error_code" IS NULL) OR
    ("suggestion_status" = 'failed' AND "suggestions_json" IS NULL AND btrim(COALESCE("suggestion_error_code", '')) <> '')
  )
);

CREATE UNIQUE INDEX "training_material_revisions_material_id_revision_number_key"
  ON "training_material_revisions"("material_id", "revision_number");
CREATE UNIQUE INDEX "training_material_revisions_material_id_id_key"
  ON "training_material_revisions"("material_id", "id");
CREATE INDEX "training_materials_project_id_status_created_at_idx"
  ON "training_materials"("project_id", "status", "created_at");
CREATE INDEX "training_materials_created_by_id_idx" ON "training_materials"("created_by_id");
CREATE INDEX "training_materials_official_confirmed_by_id_idx" ON "training_materials"("official_confirmed_by_id");
CREATE INDEX "training_material_revisions_file_id_idx" ON "training_material_revisions"("file_id");
CREATE INDEX "training_material_revisions_created_by_id_idx" ON "training_material_revisions"("created_by_id");
CREATE INDEX "training_material_revisions_created_at_idx" ON "training_material_revisions"("created_at");

ALTER TABLE "training_materials"
  ADD CONSTRAINT "training_materials_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "training_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "training_materials_official_confirmed_by_id_fkey"
    FOREIGN KEY ("official_confirmed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "training_materials_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "training_material_revisions"
  ADD CONSTRAINT "training_material_revisions_material_id_fkey"
    FOREIGN KEY ("material_id") REFERENCES "training_materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "training_material_revisions_material_id_previous_revision_id_fkey"
    FOREIGN KEY ("material_id", "previous_revision_id") REFERENCES "training_material_revisions"("material_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "training_material_revisions_file_id_fkey"
    FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "training_material_revisions_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "training_facts"
  ADD COLUMN "source_type" "training_fact_source_type" NOT NULL DEFAULT 'manual',
  ADD COLUMN "source_revision_id" UUID,
  ADD COLUMN "source_label" VARCHAR(240) NOT NULL DEFAULT 'Добавлено вручную',
  ADD COLUMN "source_locator" VARCHAR(240),
  ADD COLUMN "source_excerpt" TEXT,
  ADD CONSTRAINT "training_facts_source_state_check" CHECK (
    (
      "source_type" = 'manual' AND
      "source_revision_id" IS NULL AND
      "source_locator" IS NULL AND
      "source_excerpt" IS NULL
    ) OR
    (
      "source_type" = 'material' AND
      "source_revision_id" IS NOT NULL AND
      btrim(COALESCE("source_locator", '')) <> '' AND
      btrim(COALESCE("source_excerpt", '')) <> ''
    )
  ),
  ADD CONSTRAINT "training_facts_source_label_check" CHECK (btrim("source_label") <> '');

CREATE INDEX "training_facts_source_revision_id_idx" ON "training_facts"("source_revision_id");

ALTER TABLE "training_facts"
  ADD CONSTRAINT "training_facts_source_revision_id_fkey"
    FOREIGN KEY ("source_revision_id") REFERENCES "training_material_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION training_material_revision_ready_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'ready' AND (
    NEW.material_id IS DISTINCT FROM OLD.material_id OR
    NEW.revision_number IS DISTINCT FROM OLD.revision_number OR
    NEW.previous_revision_id IS DISTINCT FROM OLD.previous_revision_id OR
    NEW.status IS DISTINCT FROM OLD.status OR
    NEW.file_id IS DISTINCT FROM OLD.file_id OR
    NEW.requested_url IS DISTINCT FROM OLD.requested_url OR
    NEW.final_url IS DISTINCT FROM OLD.final_url OR
    NEW.fetched_at IS DISTINCT FROM OLD.fetched_at OR
    NEW.extracted_text IS DISTINCT FROM OLD.extracted_text OR
    NEW.segments_json IS DISTINCT FROM OLD.segments_json OR
    NEW.content_hash IS DISTINCT FROM OLD.content_hash OR
    NEW.extraction_metadata_json IS DISTINCT FROM OLD.extraction_metadata_json OR
    NEW.diff_json IS DISTINCT FROM OLD.diff_json OR
    NEW.is_changed IS DISTINCT FROM OLD.is_changed OR
    NEW.created_by_id IS DISTINCT FROM OLD.created_by_id OR
    NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'READY training material revision payload is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER training_material_revision_ready_immutable_trigger
BEFORE UPDATE ON "training_material_revisions"
FOR EACH ROW EXECUTE FUNCTION training_material_revision_ready_immutable();

CREATE FUNCTION training_fact_material_same_project() RETURNS trigger AS $$
DECLARE
  question_project_id UUID;
  material_project_id UUID;
BEGIN
  IF NEW.source_type = 'manual' THEN
    RETURN NEW;
  END IF;

  SELECT question.project_id INTO question_project_id
  FROM training_questions AS question
  WHERE question.id = NEW.question_id;

  SELECT material.project_id INTO material_project_id
  FROM training_material_revisions AS revision
  JOIN training_materials AS material ON material.id = revision.material_id
  WHERE revision.id = NEW.source_revision_id AND revision.status = 'ready';

  IF question_project_id IS NULL OR material_project_id IS NULL OR question_project_id <> material_project_id THEN
    RAISE EXCEPTION 'Training fact source revision must be READY and belong to the same project';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER training_fact_material_same_project_trigger
BEFORE INSERT OR UPDATE OF "question_id", "source_type", "source_revision_id" ON "training_facts"
FOR EACH ROW EXECUTE FUNCTION training_fact_material_same_project();
