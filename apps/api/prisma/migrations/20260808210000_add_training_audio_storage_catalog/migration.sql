CREATE TYPE "training_audio_storage_object_kind" AS ENUM ('segment', 'merged');
CREATE TYPE "training_audio_deletion_manifest_status" AS ENUM ('pending', 'completed');
CREATE TYPE "training_audio_deletion_item_status" AS ENUM ('pending', 'processing', 'deleted');

CREATE TABLE "training_audio_storage_entries" (
  "id" UUID NOT NULL,
  "file_id" UUID,
  "kind" "training_audio_storage_object_kind" NOT NULL,
  "bucket" VARCHAR(255) NOT NULL,
  "key" TEXT NOT NULL,
  "checksum" CHAR(64),
  "etag" VARCHAR(128),
  "size_bytes" BIGINT,
  "mime_type" VARCHAR(120),
  "project_id_snapshot" UUID,
  "project_title_snapshot" VARCHAR(300),
  "user_id_snapshot" UUID,
  "user_name_snapshot" VARCHAR(200),
  "user_email_snapshot" VARCHAR(320),
  "attempt_id_snapshot" UUID,
  "answer_id_snapshot" UUID,
  "object_created_at" TIMESTAMPTZ(3) NOT NULL,
  "deleted_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "training_audio_storage_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "training_audio_storage_entries_size_check"
    CHECK ("size_bytes" IS NULL OR "size_bytes" >= 0)
);

CREATE TABLE "training_audio_deletion_manifests" (
  "id" UUID NOT NULL,
  "created_by_id" UUID,
  "reason" VARCHAR(500) NOT NULL,
  "status" "training_audio_deletion_manifest_status" NOT NULL DEFAULT 'pending',
  "completed_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "training_audio_deletion_manifests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "training_audio_deletion_manifest_items" (
  "id" UUID NOT NULL,
  "manifest_id" UUID NOT NULL,
  "storage_entry_id" UUID,
  "file_id_snapshot" UUID,
  "bucket" VARCHAR(255) NOT NULL,
  "key" TEXT NOT NULL,
  "checksum" CHAR(64),
  "etag" VARCHAR(128),
  "size_bytes" BIGINT,
  "project_title_snapshot" VARCHAR(300),
  "user_name_snapshot" VARCHAR(200),
  "user_email_snapshot" VARCHAR(320),
  "object_created_at" TIMESTAMPTZ(3) NOT NULL,
  "status" "training_audio_deletion_item_status" NOT NULL DEFAULT 'pending',
  "last_error_code" VARCHAR(64),
  "execution_token" UUID,
  "execution_started_at" TIMESTAMPTZ(3),
  "deleted_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "training_audio_deletion_manifest_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "training_audio_deletion_manifest_items_size_check"
    CHECK ("size_bytes" IS NULL OR "size_bytes" >= 0),
  CONSTRAINT "training_audio_deletion_manifest_items_execution_check" CHECK (
    ("status" = 'processing' AND "execution_token" IS NOT NULL AND "execution_started_at" IS NOT NULL) OR
    ("status" <> 'processing' AND "execution_token" IS NULL AND "execution_started_at" IS NULL)
  )
);

CREATE UNIQUE INDEX "training_audio_storage_entries_file_id_key"
  ON "training_audio_storage_entries"("file_id");
CREATE UNIQUE INDEX "training_audio_storage_entries_bucket_key_key"
  ON "training_audio_storage_entries"("bucket", "key");
CREATE INDEX "training_audio_storage_entries_project_id_snapshot_object_created_at_idx"
  ON "training_audio_storage_entries"("project_id_snapshot", "object_created_at");
CREATE INDEX "training_audio_storage_entries_user_id_snapshot_object_created_at_idx"
  ON "training_audio_storage_entries"("user_id_snapshot", "object_created_at");
CREATE INDEX "training_audio_storage_entries_object_created_at_idx"
  ON "training_audio_storage_entries"("object_created_at");
CREATE INDEX "training_audio_storage_entries_deleted_at_idx"
  ON "training_audio_storage_entries"("deleted_at");
CREATE INDEX "training_audio_storage_entries_active_project_title_idx"
  ON "training_audio_storage_entries"(LOWER("project_title_snapshot"), "object_created_at")
  WHERE "deleted_at" IS NULL;
CREATE INDEX "training_audio_storage_entries_active_user_name_idx"
  ON "training_audio_storage_entries"(LOWER("user_name_snapshot"), "object_created_at")
  WHERE "deleted_at" IS NULL;
CREATE INDEX "training_audio_deletion_manifests_status_created_at_idx"
  ON "training_audio_deletion_manifests"("status", "created_at");
CREATE INDEX "training_audio_deletion_manifests_created_by_id_idx"
  ON "training_audio_deletion_manifests"("created_by_id");
CREATE UNIQUE INDEX "training_audio_deletion_manifest_items_manifest_id_bucket_key_key"
  ON "training_audio_deletion_manifest_items"("manifest_id", "bucket", "key");
CREATE INDEX "training_audio_deletion_manifest_items_manifest_id_status_idx"
  ON "training_audio_deletion_manifest_items"("manifest_id", "status");
CREATE INDEX "training_audio_deletion_manifest_items_storage_entry_id_idx"
  ON "training_audio_deletion_manifest_items"("storage_entry_id");

ALTER TABLE "training_audio_storage_entries"
  ADD CONSTRAINT "training_audio_storage_entries_file_id_fkey"
  FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "training_audio_deletion_manifests"
  ADD CONSTRAINT "training_audio_deletion_manifests_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "training_audio_deletion_manifest_items"
  ADD CONSTRAINT "training_audio_deletion_manifest_items_manifest_id_fkey"
  FOREIGN KEY ("manifest_id") REFERENCES "training_audio_deletion_manifests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "training_audio_deletion_manifest_items"
  ADD CONSTRAINT "training_audio_deletion_manifest_items_storage_entry_id_fkey"
  FOREIGN KEY ("storage_entry_id") REFERENCES "training_audio_storage_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "training_audio_storage_entries" (
  "id", "file_id", "kind", "bucket", "key", "checksum", "size_bytes", "mime_type",
  "project_id_snapshot", "project_title_snapshot", "user_id_snapshot", "user_name_snapshot",
  "user_email_snapshot", "attempt_id_snapshot", "answer_id_snapshot", "object_created_at", "updated_at"
)
SELECT
  MD5('training-audio-merged:' || file."id"::text)::uuid,
  file."id",
  'merged'::"training_audio_storage_object_kind",
  file."bucket",
  file."key",
  file."checksum",
  file."size_bytes",
  file."mime_type",
  project."id",
  project."title",
  owner."id",
  owner."name",
  owner."email",
  attempt."id",
  answer."id",
  file."created_at" AT TIME ZONE 'UTC',
  CURRENT_TIMESTAMP
FROM "training_answers" AS answer
JOIN "files" AS file ON file."id" = answer."merged_audio_file_id"
JOIN "training_attempt_questions" AS question ON question."id" = answer."attempt_question_id"
JOIN "training_attempts" AS attempt ON attempt."id" = question."attempt_id"
JOIN "training_projects" AS project ON project."id" = attempt."project_id"
JOIN "users" AS owner ON owner."id" = attempt."user_id"
WHERE file."bucket" IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO "training_audio_storage_entries" (
  "id", "file_id", "kind", "bucket", "key", "checksum", "size_bytes", "mime_type",
  "project_id_snapshot", "project_title_snapshot", "user_id_snapshot", "user_name_snapshot",
  "user_email_snapshot", "attempt_id_snapshot", "answer_id_snapshot", "object_created_at", "updated_at"
)
SELECT
  MD5('training-audio-segment:' || file."id"::text)::uuid,
  file."id",
  'segment'::"training_audio_storage_object_kind",
  file."bucket",
  file."key",
  file."checksum",
  file."size_bytes",
  file."mime_type",
  project."id",
  project."title",
  owner."id",
  owner."name",
  owner."email",
  attempt."id",
  answer."id",
  file."created_at" AT TIME ZONE 'UTC',
  CURRENT_TIMESTAMP
FROM "training_answer_segments" AS segment
JOIN "files" AS file ON file."id" = segment."stored_file_id"
JOIN "training_answers" AS answer ON answer."id" = segment."answer_id"
JOIN "training_attempt_questions" AS question ON question."id" = answer."attempt_question_id"
JOIN "training_attempts" AS attempt ON attempt."id" = question."attempt_id"
JOIN "training_projects" AS project ON project."id" = attempt."project_id"
JOIN "users" AS owner ON owner."id" = attempt."user_id"
WHERE file."bucket" IS NOT NULL
ON CONFLICT DO NOTHING;
