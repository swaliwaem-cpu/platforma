CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE "assistant_knowledge_source_type" AS ENUM (
  'development_page',
  'developer_promotion',
  'bank_promotion',
  'aggregator_cian',
  'aggregator_domclick',
  'aggregator_yandex',
  'aggregator_novostroy'
);
CREATE TYPE "assistant_knowledge_source_state" AS ENUM ('active', 'paused', 'disabled');
CREATE TYPE "assistant_source_revision_status" AS ENUM ('indexed', 'failed');
CREATE TYPE "assistant_source_fact_kind" AS ENUM (
  'static_description',
  'architecture',
  'infrastructure',
  'promotion',
  'external_lot'
);
CREATE TYPE "assistant_source_job_status" AS ENUM ('pending', 'running', 'completed', 'failed');
CREATE TYPE "assistant_source_job_trigger" AS ENUM ('manual', 'scheduled');

CREATE TABLE "assistant_knowledge_sources" (
  "id" UUID NOT NULL,
  "canonical_url" VARCHAR(2048) NOT NULL,
  "type" "assistant_knowledge_source_type" NOT NULL,
  "state" "assistant_knowledge_source_state" NOT NULL DEFAULT 'active',
  "priority" SMALLINT NOT NULL DEFAULT 100,
  "schedule_minutes" INTEGER NOT NULL DEFAULT 1440,
  "connector_key" VARCHAR(80) NOT NULL,
  "connector_config_json" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "project_key" VARCHAR(120),
  "developer_key" VARCHAR(120),
  "created_by_user_id" UUID NOT NULL,
  "next_refresh_at" TIMESTAMP(3),
  "last_attempt_at" TIMESTAMP(3),
  "last_success_at" TIMESTAMP(3),
  "last_indexed_at" TIMESTAMP(3),
  "last_error_code" VARCHAR(120),
  "last_error_message" VARCHAR(240),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "assistant_knowledge_sources_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "assistant_knowledge_sources_schedule_check" CHECK ("schedule_minutes" BETWEEN 60 AND 1440),
  CONSTRAINT "assistant_knowledge_sources_priority_check" CHECK ("priority" BETWEEN 1 AND 1000),
  CONSTRAINT "assistant_knowledge_sources_connector_config_check" CHECK (jsonb_typeof("connector_config_json") = 'object')
);

CREATE TABLE "assistant_source_revisions" (
  "id" UUID NOT NULL,
  "source_id" UUID NOT NULL,
  "previous_revision_id" UUID,
  "checksum" CHAR(64) NOT NULL,
  "raw_payload" BYTEA NOT NULL,
  "raw_encoding" VARCHAR(20) NOT NULL DEFAULT 'gzip',
  "raw_size_bytes" INTEGER NOT NULL,
  "content_type" VARCHAR(120) NOT NULL,
  "final_url" VARCHAR(2048) NOT NULL,
  "http_status" SMALLINT NOT NULL,
  "etag" VARCHAR(512),
  "last_modified" VARCHAR(512),
  "fetched_at" TIMESTAMP(3) NOT NULL,
  "processing_status" "assistant_source_revision_status" NOT NULL,
  "processing_error_code" VARCHAR(120),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "assistant_source_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "assistant_source_revisions_checksum_check" CHECK ("checksum" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "assistant_source_revisions_raw_check" CHECK ("raw_encoding" = 'gzip' AND "raw_size_bytes" > 0),
  CONSTRAINT "assistant_source_revisions_http_status_check" CHECK ("http_status" BETWEEN 200 AND 299),
  CONSTRAINT "assistant_source_revisions_status_check" CHECK (
    ("processing_status" = 'indexed' AND "processing_error_code" IS NULL) OR
    ("processing_status" = 'failed' AND "processing_error_code" IS NOT NULL)
  )
);

CREATE TABLE "assistant_source_facts" (
  "id" UUID NOT NULL,
  "source_id" UUID NOT NULL,
  "source_revision_id" UUID NOT NULL,
  "kind" "assistant_source_fact_kind" NOT NULL,
  "label" VARCHAR(300) NOT NULL,
  "value_json" JSONB NOT NULL,
  "value_hash" CHAR(64) NOT NULL,
  "search_text" TEXT NOT NULL,
  "canonical_url" VARCHAR(2048) NOT NULL,
  "observed_at" TIMESTAMP(3) NOT NULL,
  "valid_from" TIMESTAMP(3),
  "is_active" BOOLEAN NOT NULL DEFAULT TRUE,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "assistant_source_facts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "assistant_source_facts_value_hash_check" CHECK ("value_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "assistant_source_facts_value_json_check" CHECK (jsonb_typeof("value_json") IN ('object', 'string', 'number', 'boolean', 'array')),
  CONSTRAINT "assistant_source_facts_text_check" CHECK (btrim("label") <> '' AND btrim("search_text") <> '')
);

CREATE TABLE "assistant_source_chunks" (
  "id" UUID NOT NULL,
  "source_id" UUID NOT NULL,
  "source_revision_id" UUID NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "text" TEXT NOT NULL,
  "content_hash" CHAR(64) NOT NULL,
  "embedding" vector,
  "embedding_model" VARCHAR(160),
  "embedded_at" TIMESTAMP(3),
  "is_active" BOOLEAN NOT NULL DEFAULT TRUE,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "assistant_source_chunks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "assistant_source_chunks_content_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "assistant_source_chunks_text_check" CHECK (btrim("text") <> ''),
  CONSTRAINT "assistant_source_chunks_embedding_check" CHECK (
    ("embedding" IS NULL AND "embedding_model" IS NULL AND "embedded_at" IS NULL) OR
    ("embedding" IS NOT NULL AND "embedding_model" IS NOT NULL AND "embedded_at" IS NOT NULL)
  )
);

CREATE TABLE "assistant_source_jobs" (
  "id" UUID NOT NULL,
  "source_id" UUID NOT NULL,
  "trigger" "assistant_source_job_trigger" NOT NULL,
  "status" "assistant_source_job_status" NOT NULL DEFAULT 'pending',
  "idempotency_key" VARCHAR(160) NOT NULL,
  "requested_by_user_id" UUID,
  "attempt" SMALLINT NOT NULL DEFAULT 0,
  "max_attempts" SMALLINT NOT NULL DEFAULT 3,
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_owner" VARCHAR(100),
  "lease_expires_at" TIMESTAMP(3),
  "error_code" VARCHAR(120),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "assistant_source_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "assistant_source_jobs_attempt_check" CHECK ("attempt" BETWEEN 0 AND "max_attempts" AND "max_attempts" BETWEEN 1 AND 5),
  CONSTRAINT "assistant_source_jobs_state_check" CHECK (
    ("status" = 'pending' AND "lease_owner" IS NULL AND "lease_expires_at" IS NULL AND "completed_at" IS NULL) OR
    ("status" = 'running' AND "lease_owner" IS NOT NULL AND "lease_expires_at" IS NOT NULL AND "completed_at" IS NULL) OR
    ("status" = 'completed' AND "lease_owner" IS NULL AND "lease_expires_at" IS NULL AND "error_code" IS NULL AND "completed_at" IS NOT NULL) OR
    ("status" = 'failed' AND "lease_owner" IS NULL AND "lease_expires_at" IS NULL AND "error_code" IS NOT NULL AND "completed_at" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "assistant_knowledge_sources_canonical_url_key" ON "assistant_knowledge_sources"("canonical_url");
CREATE INDEX "assistant_knowledge_sources_state_next_refresh_at_idx" ON "assistant_knowledge_sources"("state", "next_refresh_at");
CREATE INDEX "assistant_knowledge_sources_project_key_idx" ON "assistant_knowledge_sources"("project_key");
CREATE INDEX "assistant_knowledge_sources_developer_key_idx" ON "assistant_knowledge_sources"("developer_key");
CREATE UNIQUE INDEX "assistant_source_revisions_previous_revision_id_key" ON "assistant_source_revisions"("previous_revision_id");
CREATE UNIQUE INDEX "assistant_source_revisions_source_id_checksum_key" ON "assistant_source_revisions"("source_id", "checksum");
CREATE INDEX "assistant_source_revisions_source_id_fetched_at_idx" ON "assistant_source_revisions"("source_id", "fetched_at");
CREATE UNIQUE INDEX "assistant_source_facts_source_revision_id_kind_value_hash_key" ON "assistant_source_facts"("source_revision_id", "kind", "value_hash");
CREATE INDEX "assistant_source_facts_source_id_kind_is_active_idx" ON "assistant_source_facts"("source_id", "kind", "is_active");
CREATE INDEX "assistant_source_facts_is_active_observed_at_idx" ON "assistant_source_facts"("is_active", "observed_at");
CREATE INDEX "assistant_source_facts_search_text_idx" ON "assistant_source_facts" USING GIN (to_tsvector('russian', "search_text"));
CREATE UNIQUE INDEX "assistant_source_chunks_source_revision_id_ordinal_key" ON "assistant_source_chunks"("source_revision_id", "ordinal");
CREATE INDEX "assistant_source_chunks_source_id_is_active_idx" ON "assistant_source_chunks"("source_id", "is_active");
CREATE INDEX "assistant_source_chunks_content_hash_embedding_model_idx" ON "assistant_source_chunks"("content_hash", "embedding_model");
CREATE INDEX "assistant_source_chunks_text_idx" ON "assistant_source_chunks" USING GIN (to_tsvector('russian', "text"));
CREATE UNIQUE INDEX "assistant_source_jobs_source_id_idempotency_key_key" ON "assistant_source_jobs"("source_id", "idempotency_key");
CREATE INDEX "assistant_source_jobs_status_available_at_idx" ON "assistant_source_jobs"("status", "available_at");
CREATE INDEX "assistant_source_jobs_source_id_created_at_idx" ON "assistant_source_jobs"("source_id", "created_at");

ALTER TABLE "assistant_knowledge_sources" ADD CONSTRAINT "assistant_knowledge_sources_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "assistant_source_revisions" ADD CONSTRAINT "assistant_source_revisions_source_id_fkey"
  FOREIGN KEY ("source_id") REFERENCES "assistant_knowledge_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "assistant_source_revisions" ADD CONSTRAINT "assistant_source_revisions_previous_revision_id_fkey"
  FOREIGN KEY ("previous_revision_id") REFERENCES "assistant_source_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "assistant_source_facts" ADD CONSTRAINT "assistant_source_facts_source_id_fkey"
  FOREIGN KEY ("source_id") REFERENCES "assistant_knowledge_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "assistant_source_facts" ADD CONSTRAINT "assistant_source_facts_source_revision_id_fkey"
  FOREIGN KEY ("source_revision_id") REFERENCES "assistant_source_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "assistant_source_chunks" ADD CONSTRAINT "assistant_source_chunks_source_id_fkey"
  FOREIGN KEY ("source_id") REFERENCES "assistant_knowledge_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "assistant_source_chunks" ADD CONSTRAINT "assistant_source_chunks_source_revision_id_fkey"
  FOREIGN KEY ("source_revision_id") REFERENCES "assistant_source_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "assistant_source_jobs" ADD CONSTRAINT "assistant_source_jobs_source_id_fkey"
  FOREIGN KEY ("source_id") REFERENCES "assistant_knowledge_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "assistant_source_jobs" ADD CONSTRAINT "assistant_source_jobs_requested_by_user_id_fkey"
  FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION prevent_assistant_source_revision_raw_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'assistant source revisions are retained indefinitely';
  END IF;
  IF OLD."source_id" IS DISTINCT FROM NEW."source_id"
    OR OLD."previous_revision_id" IS DISTINCT FROM NEW."previous_revision_id"
    OR OLD."checksum" IS DISTINCT FROM NEW."checksum"
    OR OLD."raw_payload" IS DISTINCT FROM NEW."raw_payload"
    OR OLD."raw_encoding" IS DISTINCT FROM NEW."raw_encoding"
    OR OLD."raw_size_bytes" IS DISTINCT FROM NEW."raw_size_bytes"
    OR OLD."content_type" IS DISTINCT FROM NEW."content_type"
    OR OLD."final_url" IS DISTINCT FROM NEW."final_url"
    OR OLD."http_status" IS DISTINCT FROM NEW."http_status"
    OR OLD."etag" IS DISTINCT FROM NEW."etag"
    OR OLD."last_modified" IS DISTINCT FROM NEW."last_modified"
    OR OLD."fetched_at" IS DISTINCT FROM NEW."fetched_at"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
  THEN
    RAISE EXCEPTION 'assistant source revision raw fields are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "assistant_source_revisions_immutable_raw"
  BEFORE UPDATE OR DELETE ON "assistant_source_revisions"
  FOR EACH ROW EXECUTE FUNCTION prevent_assistant_source_revision_raw_mutation();
