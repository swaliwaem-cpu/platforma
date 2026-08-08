CREATE TYPE "training_material_operation_type" AS ENUM (
  'create_pdf',
  'create_official_url',
  'import_object'
);

CREATE TYPE "training_material_operation_status" AS ENUM (
  'queued',
  'storing',
  'extracting',
  'generating',
  'persisting',
  'ready',
  'failed',
  'cancelled'
);

CREATE TABLE "training_material_operations" (
  "id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "created_by_id" UUID NOT NULL,
  "type" "training_material_operation_type" NOT NULL,
  "status" "training_material_operation_status" NOT NULL DEFAULT 'queued',
  "idempotency_key" UUID NOT NULL,
  "input_fingerprint" CHAR(64) NOT NULL,
  "input_json" JSONB NOT NULL,
  "source_file_id" UUID,
  "result_material_id" UUID,
  "result_revision_id" UUID,
  "base_knowledge_version" INTEGER NOT NULL,
  "completed_knowledge_version" INTEGER,
  "source_hash" CHAR(64),
  "progress_total" INTEGER NOT NULL DEFAULT 0,
  "progress_completed" INTEGER NOT NULL DEFAULT 0,
  "progress_failed" INTEGER NOT NULL DEFAULT 0,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locked_at" TIMESTAMP(3),
  "locked_by" VARCHAR(160),
  "error_code" VARCHAR(120),
  "result_json" JSONB,
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "training_material_operations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "training_material_operations_versions_check" CHECK (
    "base_knowledge_version" >= 0 AND
    ("completed_knowledge_version" IS NULL OR "completed_knowledge_version" >= 0)
  ),
  CONSTRAINT "training_material_operations_progress_check" CHECK (
    "progress_total" >= 0 AND
    "progress_completed" >= 0 AND
    "progress_failed" >= 0 AND
    "progress_completed" + "progress_failed" <= "progress_total"
  ),
  CONSTRAINT "training_material_operations_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "training_material_operations_lock_pair_check" CHECK (
    ("locked_at" IS NULL AND "locked_by" IS NULL) OR
    ("locked_at" IS NOT NULL AND "locked_by" IS NOT NULL)
  ),
  CONSTRAINT "training_material_operations_terminal_check" CHECK (
    ("status" = 'ready' AND "error_code" IS NULL AND "finished_at" IS NOT NULL AND "locked_at" IS NULL) OR
    ("status" = 'failed' AND "error_code" IS NOT NULL AND "finished_at" IS NOT NULL AND "locked_at" IS NULL) OR
    ("status" = 'cancelled' AND "finished_at" IS NOT NULL AND "locked_at" IS NULL) OR
    ("status" NOT IN ('ready', 'failed', 'cancelled') AND "finished_at" IS NULL)
  )
);

CREATE TABLE "training_material_operation_items" (
  "id" UUID NOT NULL,
  "operation_id" UUID NOT NULL,
  "item_key" VARCHAR(120) NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "title" VARCHAR(240) NOT NULL,
  "status" "training_material_operation_status" NOT NULL DEFAULT 'queued',
  "source_file_id" UUID,
  "result_material_id" UUID,
  "result_revision_id" UUID,
  "source_hash" CHAR(64),
  "error_code" VARCHAR(120),
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "training_material_operation_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "training_material_operation_items_ordinal_check" CHECK ("ordinal" >= 0),
  CONSTRAINT "training_material_operation_items_title_check" CHECK (btrim("title") <> ''),
  CONSTRAINT "training_material_operation_items_terminal_check" CHECK (
    ("status" = 'ready' AND "error_code" IS NULL AND "finished_at" IS NOT NULL) OR
    ("status" = 'failed' AND "error_code" IS NOT NULL AND "finished_at" IS NOT NULL) OR
    ("status" = 'cancelled' AND "finished_at" IS NOT NULL) OR
    ("status" NOT IN ('ready', 'failed', 'cancelled') AND "finished_at" IS NULL)
  )
);

CREATE UNIQUE INDEX "training_material_operations_project_actor_idempotency_key"
  ON "training_material_operations"("project_id", "created_by_id", "idempotency_key");

CREATE INDEX "training_material_operations_pending_claim_idx"
  ON "training_material_operations"("available_at", "created_at", "id")
  WHERE "status" = 'queued';

CREATE INDEX "training_material_operations_stale_recovery_idx"
  ON "training_material_operations"("locked_at", "created_at", "id")
  WHERE "status" IN ('extracting', 'generating', 'persisting');

CREATE INDEX "training_material_operations_project_active_idx"
  ON "training_material_operations"("project_id", "locked_at")
  WHERE "status" IN ('extracting', 'generating', 'persisting');

CREATE INDEX "training_material_operations_project_created_at_idx"
  ON "training_material_operations"("project_id", "created_at");

CREATE INDEX "training_material_operations_created_by_id_idx"
  ON "training_material_operations"("created_by_id");

CREATE INDEX "training_material_operations_source_file_id_idx"
  ON "training_material_operations"("source_file_id");

CREATE UNIQUE INDEX "training_material_operation_items_operation_id_item_key"
  ON "training_material_operation_items"("operation_id", "item_key");

CREATE INDEX "training_material_operation_items_operation_id_ordinal_idx"
  ON "training_material_operation_items"("operation_id", "ordinal");

ALTER TABLE "training_material_operations"
  ADD CONSTRAINT "training_material_operations_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "training_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "training_material_operations_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "training_material_operations_source_file_id_fkey"
    FOREIGN KEY ("source_file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "training_material_operation_items"
  ADD CONSTRAINT "training_material_operation_items_operation_id_fkey"
    FOREIGN KEY ("operation_id") REFERENCES "training_material_operations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
