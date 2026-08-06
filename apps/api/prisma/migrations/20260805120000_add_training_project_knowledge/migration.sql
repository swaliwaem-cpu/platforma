ALTER TABLE "training_projects"
  ADD COLUMN "knowledge_version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "knowledge_source_hash" CHAR(64);

CREATE TABLE "training_project_knowledge_versions" (
  "id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "source_hash" CHAR(64) NOT NULL,
  "compiler_version" VARCHAR(64) NOT NULL,
  "prompt_version" VARCHAR(64) NOT NULL,
  "status" VARCHAR(16) NOT NULL,
  "source_manifest_json" JSONB NOT NULL,
  "compiled_knowledge_json" JSONB,
  "source_chars" INTEGER,
  "generation_model" VARCHAR(120),
  "generation_request_ids_json" JSONB,
  "generation_attempts" INTEGER NOT NULL DEFAULT 0,
  "generation_token" VARCHAR(128),
  "locked_at" TIMESTAMP(3),
  "error_code" VARCHAR(120),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "training_project_knowledge_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "training_project_knowledge_versions_status_check"
    CHECK ("status" IN ('GENERATING', 'READY', 'FAILED')),
  CONSTRAINT "training_project_knowledge_versions_payload_check"
    CHECK (
      ("status" = 'GENERATING' AND "generation_token" IS NOT NULL AND "locked_at" IS NOT NULL)
      OR ("status" = 'READY' AND "compiled_knowledge_json" IS NOT NULL)
      OR ("status" = 'FAILED' AND "error_code" IS NOT NULL)
    ),
  CONSTRAINT "training_project_knowledge_versions_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "training_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "training_project_knowledge_versions_project_id_version_key"
  ON "training_project_knowledge_versions"("project_id", "version");

CREATE UNIQUE INDEX "training_project_knowledge_versions_project_id_source_hash_key"
  ON "training_project_knowledge_versions"("project_id", "source_hash");

CREATE INDEX "training_project_knowledge_versions_status_locked_at_idx"
  ON "training_project_knowledge_versions"("status", "locked_at");
