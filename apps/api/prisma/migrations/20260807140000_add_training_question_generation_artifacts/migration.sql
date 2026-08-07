CREATE TABLE "training_question_generation_artifacts" (
  "id" UUID NOT NULL,
  "real_estate_object_id" UUID NOT NULL,
  "generation_key_hash" CHAR(64) NOT NULL,
  "generation_key_json" JSONB NOT NULL,
  "source_fingerprint" CHAR(64) NOT NULL,
  "artifact_schema_version" INTEGER NOT NULL,
  "compiler_version" VARCHAR(64) NOT NULL,
  "prompt_version" VARCHAR(64) NOT NULL,
  "generation_model" VARCHAR(120) NOT NULL,
  "generation_reasoning" VARCHAR(16) NOT NULL,
  "routing_strategy" VARCHAR(64) NOT NULL,
  "chosen_budget" INTEGER NOT NULL,
  "budget_policy_version" VARCHAR(64) NOT NULL,
  "max_output_tokens" INTEGER NOT NULL,
  "status" VARCHAR(16) NOT NULL,
  "artifact_json" JSONB,
  "source_chars" INTEGER,
  "generation_request_ids_json" JSONB,
  "generation_attempts" INTEGER NOT NULL DEFAULT 0,
  "generation_token" VARCHAR(128),
  "locked_at" TIMESTAMP(3),
  "error_code" VARCHAR(120),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "training_question_generation_artifacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "training_question_generation_artifacts_status_check"
    CHECK ("status" IN ('GENERATING', 'READY', 'FAILED')),
  CONSTRAINT "training_question_generation_artifacts_payload_check"
    CHECK (
      ("status" = 'GENERATING' AND "generation_token" IS NOT NULL AND "locked_at" IS NOT NULL AND "artifact_json" IS NULL)
      OR ("status" = 'READY' AND "generation_token" IS NULL AND "locked_at" IS NULL AND "artifact_json" IS NOT NULL)
      OR ("status" = 'FAILED' AND "generation_token" IS NULL AND "locked_at" IS NULL AND "error_code" IS NOT NULL)
    ),
  CONSTRAINT "training_question_generation_artifacts_real_estate_object_id_fkey"
    FOREIGN KEY ("real_estate_object_id") REFERENCES "real_estate_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "training_question_generation_artifacts_object_key_key"
  ON "training_question_generation_artifacts"("real_estate_object_id", "generation_key_hash");

CREATE INDEX "training_question_generation_artifacts_status_locked_at_idx"
  ON "training_question_generation_artifacts"("status", "locked_at");

ALTER TABLE "training_project_knowledge_versions"
  ADD COLUMN "generation_artifact_id" UUID;

CREATE INDEX "training_project_knowledge_versions_generation_artifact_id_idx"
  ON "training_project_knowledge_versions"("generation_artifact_id");

ALTER TABLE "training_project_knowledge_versions"
  ADD CONSTRAINT "training_project_knowledge_versions_generation_artifact_id_fkey"
  FOREIGN KEY ("generation_artifact_id") REFERENCES "training_question_generation_artifacts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
