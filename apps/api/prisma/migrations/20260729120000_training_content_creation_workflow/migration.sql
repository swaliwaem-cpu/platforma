-- Extend the durable training queue with official URL ingestion and fact suggestions.
ALTER TYPE "training_job_kind" ADD VALUE IF NOT EXISTS 'fetch_official_url_source';
ALTER TYPE "training_job_kind" ADD VALUE IF NOT EXISTS 'suggest_facts';

CREATE TYPE "training_fact_suggestion_run_status" AS ENUM (
  'pending',
  'running',
  'ready',
  'partial',
  'failed',
  'ambiguous',
  'dismissed'
);

CREATE TYPE "training_fact_suggestion_status" AS ENUM (
  'pending',
  'accepted',
  'rejected',
  'stale'
);

CREATE TABLE "training_official_url_sources" (
  "id" UUID NOT NULL,
  "project_version_id" UUID NOT NULL,
  "confirmed_by_id" UUID NOT NULL,
  "snapshot_file_id" UUID,
  "url" VARCHAR(2048) NOT NULL,
  "normalized_url" VARCHAR(2048) NOT NULL,
  "final_url" VARCHAR(2048),
  "hostname" VARCHAR(253) NOT NULL,
  "fetch_generation" INTEGER NOT NULL DEFAULT 1,
  "extraction_status" "training_source_extraction_status" NOT NULL DEFAULT 'pending',
  "extracted_text" TEXT,
  "content_hash" CHAR(64),
  "extraction_metadata_json" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "error_code" VARCHAR(120),
  "error_message" VARCHAR(2000),
  "confirmed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "fetched_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "training_official_url_sources_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "training_official_url_sources_https_check" CHECK (
    "url" ~* '^https://'
    AND "normalized_url" ~* '^https://'
    AND ("final_url" IS NULL OR "final_url" ~* '^https://')
  ),
  CONSTRAINT "training_official_url_sources_hostname_check" CHECK (
    length(btrim("hostname")) > 0
    AND lower("hostname") = "hostname"
    AND "hostname" !~ '[/@:[:space:]]'
  ),
  CONSTRAINT "training_official_url_sources_generation_check" CHECK (
    "fetch_generation" > 0
  ),
  CONSTRAINT "training_official_url_sources_content_hash_check" CHECK (
    "content_hash" IS NULL OR "content_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "training_official_url_sources_fetch_time_check" CHECK (
    "fetched_at" IS NULL OR "fetched_at" >= "confirmed_at"
  ),
  CONSTRAINT "training_official_url_sources_ready_check" CHECK (
    "extraction_status" <> 'ready'
    OR (
      "snapshot_file_id" IS NOT NULL
      AND "extracted_text" IS NOT NULL
      AND length(btrim("extracted_text")) > 0
      AND "content_hash" IS NOT NULL
      AND "final_url" IS NOT NULL
      AND "fetched_at" IS NOT NULL
    )
  )
);

CREATE TABLE "training_fact_suggestion_runs" (
  "id" UUID NOT NULL,
  "project_version_id" UUID NOT NULL,
  "created_by_id" UUID NOT NULL,
  "status" "training_fact_suggestion_run_status" NOT NULL DEFAULT 'pending',
  "idempotency_key" VARCHAR(128) NOT NULL,
  "request_payload_hash" CHAR(64) NOT NULL,
  "source_snapshot_json" JSONB NOT NULL,
  "prompt_version" VARCHAR(64) NOT NULL,
  "schema_version" VARCHAR(64) NOT NULL,
  "error_code" VARCHAR(120),
  "error_message" VARCHAR(2000),
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "training_fact_suggestion_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "training_fact_suggestion_runs_hash_check" CHECK (
    "request_payload_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "training_fact_suggestion_runs_time_check" CHECK (
    ("started_at" IS NULL OR "started_at" >= "created_at")
    AND ("completed_at" IS NULL OR "completed_at" >= COALESCE("started_at", "created_at"))
  )
);

CREATE TABLE "training_fact_suggestion_provider_runs" (
  "id" UUID NOT NULL,
  "project_version_id" UUID NOT NULL,
  "suggestion_run_id" UUID NOT NULL,
  "source_document_id" UUID,
  "source_official_url_id" UUID,
  "chunk_index" INTEGER NOT NULL,
  "status" "training_provider_run_status" NOT NULL DEFAULT 'pending',
  "idempotency_key" VARCHAR(240) NOT NULL,
  "requested_model_id" VARCHAR(120) NOT NULL,
  "actual_model_id" VARCHAR(120),
  "reasoning_effort" VARCHAR(32),
  "source_content_hash" CHAR(64) NOT NULL,
  "input_hash" CHAR(64) NOT NULL,
  "input_metadata_json" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "prompt_version" VARCHAR(64) NOT NULL,
  "schema_version" VARCHAR(64) NOT NULL,
  "request_id" VARCHAR(160),
  "response_status" VARCHAR(64),
  "response_hash" CHAR(64),
  "provider_usage_json" JSONB,
  "latency_ms" INTEGER,
  "retry_count" INTEGER NOT NULL DEFAULT 0,
  "error_code" VARCHAR(120),
  "error_class" VARCHAR(120),
  "ambiguous_outcome" BOOLEAN NOT NULL DEFAULT false,
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "training_fact_suggestion_provider_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "training_fact_provider_runs_source_xor_check" CHECK (
    num_nonnulls("source_document_id", "source_official_url_id") = 1
  ),
  CONSTRAINT "training_fact_provider_runs_chunk_check" CHECK ("chunk_index" >= 0),
  CONSTRAINT "training_fact_provider_runs_hashes_check" CHECK (
    "source_content_hash" ~ '^[0-9a-f]{64}$'
    AND "input_hash" ~ '^[0-9a-f]{64}$'
    AND ("response_hash" IS NULL OR "response_hash" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "training_fact_provider_runs_metrics_check" CHECK (
    "retry_count" >= 0 AND ("latency_ms" IS NULL OR "latency_ms" >= 0)
  ),
  CONSTRAINT "training_fact_provider_runs_time_check" CHECK (
    ("started_at" IS NULL OR "started_at" >= "created_at")
    AND ("completed_at" IS NULL OR "completed_at" >= COALESCE("started_at", "created_at"))
  ),
  CONSTRAINT "training_fact_provider_runs_ambiguous_check" CHECK (
    ("status" = 'ambiguous') = "ambiguous_outcome"
  )
);

CREATE TABLE "training_fact_suggestions" (
  "id" UUID NOT NULL,
  "project_version_id" UUID NOT NULL,
  "suggestion_run_id" UUID NOT NULL,
  "provider_run_id" UUID NOT NULL,
  "suggestion_index" INTEGER NOT NULL,
  "status" "training_fact_suggestion_status" NOT NULL DEFAULT 'pending',
  "suggested_code" VARCHAR(120) NOT NULL,
  "topic_code" VARCHAR(120) NOT NULL,
  "statement" TEXT NOT NULL,
  "accepted_aliases_json" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "importance" INTEGER NOT NULL DEFAULT 1,
  "source_quote" TEXT NOT NULL,
  "source_locator_json" JSONB NOT NULL,
  "source_content_hash" CHAR(64) NOT NULL,
  "accepted_fact_id" UUID,
  "reviewed_by_id" UUID,
  "reviewed_at" TIMESTAMP(3),
  "review_comment" VARCHAR(2000),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "training_fact_suggestions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "training_fact_suggestions_index_check" CHECK ("suggestion_index" >= 0),
  CONSTRAINT "training_fact_suggestions_importance_check" CHECK ("importance" > 0),
  CONSTRAINT "training_fact_suggestions_text_check" CHECK (
    length(btrim("suggested_code")) > 0
    AND length(btrim("topic_code")) > 0
    AND length(btrim("statement")) > 0
    AND length(btrim("source_quote")) > 0
  ),
  CONSTRAINT "training_fact_suggestions_hash_check" CHECK (
    "source_content_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "training_fact_suggestions_decision_check" CHECK (
    (
      "status" = 'pending'
      AND "accepted_fact_id" IS NULL
      AND "reviewed_by_id" IS NULL
      AND "reviewed_at" IS NULL
    )
    OR (
      "status" = 'accepted'
      AND "accepted_fact_id" IS NOT NULL
      AND "reviewed_by_id" IS NOT NULL
      AND "reviewed_at" IS NOT NULL
    )
    OR (
      "status" = 'rejected'
      AND "accepted_fact_id" IS NULL
      AND "reviewed_by_id" IS NOT NULL
      AND "reviewed_at" IS NOT NULL
    )
    OR (
      "status" = 'stale'
      AND "accepted_fact_id" IS NULL
    )
  ),
  CONSTRAINT "training_fact_suggestions_review_time_check" CHECK (
    "reviewed_at" IS NULL OR "reviewed_at" >= "created_at"
  )
);

ALTER TABLE "training_facts"
  ADD COLUMN "source_official_url_id" UUID,
  ADD CONSTRAINT "training_facts_source_xor_check" CHECK (
    num_nonnulls("source_document_id", "source_official_url_id") <= 1
  );

CREATE UNIQUE INDEX "uq_training_url_source_version_normalized"
  ON "training_official_url_sources" ("project_version_id", "normalized_url");
CREATE INDEX "idx_training_url_source_version_status"
  ON "training_official_url_sources" ("project_version_id", "extraction_status");
CREATE INDEX "idx_training_url_source_hostname"
  ON "training_official_url_sources" ("hostname");
CREATE INDEX "idx_training_url_source_confirmer"
  ON "training_official_url_sources" ("confirmed_by_id", "confirmed_at");
CREATE INDEX "idx_training_url_source_snapshot_file"
  ON "training_official_url_sources" ("snapshot_file_id");

CREATE UNIQUE INDEX "uq_training_fact_suggestion_run_key"
  ON "training_fact_suggestion_runs" (
    "project_version_id",
    "created_by_id",
    "idempotency_key"
  );
CREATE INDEX "idx_training_fact_suggestion_run_status"
  ON "training_fact_suggestion_runs" ("project_version_id", "status", "created_at");
CREATE INDEX "idx_training_fact_suggestion_run_creator"
  ON "training_fact_suggestion_runs" ("created_by_id", "created_at");

CREATE UNIQUE INDEX "training_fact_suggestion_provider_runs_idempotency_key_key"
  ON "training_fact_suggestion_provider_runs" ("idempotency_key");
CREATE UNIQUE INDEX "uq_training_fact_provider_document_chunk"
  ON "training_fact_suggestion_provider_runs" (
    "suggestion_run_id",
    "source_document_id",
    "chunk_index"
  )
  WHERE "source_document_id" IS NOT NULL;
CREATE UNIQUE INDEX "uq_training_fact_provider_url_chunk"
  ON "training_fact_suggestion_provider_runs" (
    "suggestion_run_id",
    "source_official_url_id",
    "chunk_index"
  )
  WHERE "source_official_url_id" IS NOT NULL;
CREATE INDEX "idx_training_fact_provider_run_status"
  ON "training_fact_suggestion_provider_runs" ("suggestion_run_id", "status", "created_at");
CREATE INDEX "idx_training_fact_provider_version_status"
  ON "training_fact_suggestion_provider_runs" ("project_version_id", "status", "updated_at");
CREATE INDEX "idx_training_fact_provider_document"
  ON "training_fact_suggestion_provider_runs" ("source_document_id");
CREATE INDEX "idx_training_fact_provider_url"
  ON "training_fact_suggestion_provider_runs" ("source_official_url_id");
CREATE INDEX "idx_training_fact_provider_request"
  ON "training_fact_suggestion_provider_runs" ("request_id");

CREATE UNIQUE INDEX "training_fact_suggestions_accepted_fact_id_key"
  ON "training_fact_suggestions" ("accepted_fact_id");
CREATE UNIQUE INDEX "uq_training_fact_suggestion_provider_index"
  ON "training_fact_suggestions" ("provider_run_id", "suggestion_index");
CREATE INDEX "idx_training_fact_suggestion_item_run_status"
  ON "training_fact_suggestions" ("suggestion_run_id", "status", "created_at");
CREATE INDEX "idx_training_fact_suggestion_version_status"
  ON "training_fact_suggestions" ("project_version_id", "status", "created_at");
CREATE INDEX "idx_training_fact_suggestion_reviewer"
  ON "training_fact_suggestions" ("reviewed_by_id", "reviewed_at");

CREATE INDEX "training_facts_source_official_url_id_idx"
  ON "training_facts" ("source_official_url_id");

ALTER TABLE "training_official_url_sources"
  ADD CONSTRAINT "training_official_url_sources_project_version_id_fkey"
    FOREIGN KEY ("project_version_id") REFERENCES "training_project_versions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "training_official_url_sources_confirmed_by_id_fkey"
    FOREIGN KEY ("confirmed_by_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "training_official_url_sources_snapshot_file_id_fkey"
    FOREIGN KEY ("snapshot_file_id") REFERENCES "files"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "training_fact_suggestion_runs"
  ADD CONSTRAINT "training_fact_suggestion_runs_project_version_id_fkey"
    FOREIGN KEY ("project_version_id") REFERENCES "training_project_versions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "training_fact_suggestion_runs_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "training_fact_suggestion_provider_runs"
  ADD CONSTRAINT "training_fact_provider_runs_project_version_id_fkey"
    FOREIGN KEY ("project_version_id") REFERENCES "training_project_versions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "training_fact_provider_runs_suggestion_run_id_fkey"
    FOREIGN KEY ("suggestion_run_id") REFERENCES "training_fact_suggestion_runs"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "training_fact_provider_runs_source_document_id_fkey"
    FOREIGN KEY ("source_document_id") REFERENCES "training_source_documents"("id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "training_fact_provider_runs_source_official_url_id_fkey"
    FOREIGN KEY ("source_official_url_id") REFERENCES "training_official_url_sources"("id")
    ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "training_fact_suggestions"
  ADD CONSTRAINT "training_fact_suggestions_project_version_id_fkey"
    FOREIGN KEY ("project_version_id") REFERENCES "training_project_versions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "training_fact_suggestions_suggestion_run_id_fkey"
    FOREIGN KEY ("suggestion_run_id") REFERENCES "training_fact_suggestion_runs"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "training_fact_suggestions_provider_run_id_fkey"
    FOREIGN KEY ("provider_run_id") REFERENCES "training_fact_suggestion_provider_runs"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "training_fact_suggestions_accepted_fact_id_fkey"
    FOREIGN KEY ("accepted_fact_id") REFERENCES "training_facts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "training_fact_suggestions_reviewed_by_id_fkey"
    FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "training_facts"
  ADD CONSTRAINT "training_facts_source_official_url_id_fkey"
    FOREIGN KEY ("source_official_url_id") REFERENCES "training_official_url_sources"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- All new version-owned data remains immutable after publication.
CREATE TRIGGER "training_official_url_sources_prevent_published_mutation"
BEFORE INSERT OR UPDATE OR DELETE
ON "training_official_url_sources"
FOR EACH ROW
EXECUTE FUNCTION "training_prevent_published_content_mutation"();

CREATE TRIGGER "training_fact_suggestion_runs_prevent_published_mutation"
BEFORE INSERT OR UPDATE OR DELETE
ON "training_fact_suggestion_runs"
FOR EACH ROW
EXECUTE FUNCTION "training_prevent_published_content_mutation"();

CREATE TRIGGER "training_fact_provider_runs_prevent_published_mutation"
BEFORE INSERT OR UPDATE OR DELETE
ON "training_fact_suggestion_provider_runs"
FOR EACH ROW
EXECUTE FUNCTION "training_prevent_published_content_mutation"();

CREATE TRIGGER "training_fact_suggestions_prevent_published_mutation"
BEFORE INSERT OR UPDATE OR DELETE
ON "training_fact_suggestions"
FOR EACH ROW
EXECUTE FUNCTION "training_prevent_published_content_mutation"();

CREATE FUNCTION "training_validate_fact_official_url_version"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  source_version_id UUID;
BEGIN
  IF NEW."source_official_url_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "project_version_id"
  INTO source_version_id
  FROM "training_official_url_sources"
  WHERE "id" = NEW."source_official_url_id";

  IF source_version_id IS DISTINCT FROM NEW."project_version_id" THEN
    RAISE EXCEPTION 'Training fact and official URL source must belong to the same version';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "training_facts_validate_official_url_version"
BEFORE INSERT OR UPDATE OF "project_version_id", "source_official_url_id"
ON "training_facts"
FOR EACH ROW
EXECUTE FUNCTION "training_validate_fact_official_url_version"();

CREATE FUNCTION "training_validate_fact_provider_run_version"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  run_version_id UUID;
  source_version_id UUID;
BEGIN
  SELECT "project_version_id"
  INTO run_version_id
  FROM "training_fact_suggestion_runs"
  WHERE "id" = NEW."suggestion_run_id";

  IF run_version_id IS DISTINCT FROM NEW."project_version_id" THEN
    RAISE EXCEPTION 'Training fact provider run must belong to its suggestion run version';
  END IF;

  IF NEW."source_document_id" IS NOT NULL THEN
    SELECT "project_version_id"
    INTO source_version_id
    FROM "training_source_documents"
    WHERE "id" = NEW."source_document_id";
  ELSE
    SELECT "project_version_id"
    INTO source_version_id
    FROM "training_official_url_sources"
    WHERE "id" = NEW."source_official_url_id";
  END IF;

  IF source_version_id IS DISTINCT FROM NEW."project_version_id" THEN
    RAISE EXCEPTION 'Training fact provider source must belong to its version';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "training_fact_provider_runs_validate_version"
BEFORE INSERT OR UPDATE OF
  "project_version_id",
  "suggestion_run_id",
  "source_document_id",
  "source_official_url_id"
ON "training_fact_suggestion_provider_runs"
FOR EACH ROW
EXECUTE FUNCTION "training_validate_fact_provider_run_version"();

CREATE FUNCTION "training_validate_fact_suggestion_version"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  run_version_id UUID;
  provider_version_id UUID;
  provider_suggestion_run_id UUID;
  fact_version_id UUID;
BEGIN
  SELECT "project_version_id"
  INTO run_version_id
  FROM "training_fact_suggestion_runs"
  WHERE "id" = NEW."suggestion_run_id";

  SELECT "project_version_id", "suggestion_run_id"
  INTO provider_version_id, provider_suggestion_run_id
  FROM "training_fact_suggestion_provider_runs"
  WHERE "id" = NEW."provider_run_id";

  IF run_version_id IS DISTINCT FROM NEW."project_version_id"
    OR provider_version_id IS DISTINCT FROM NEW."project_version_id"
    OR provider_suggestion_run_id IS DISTINCT FROM NEW."suggestion_run_id"
  THEN
    RAISE EXCEPTION 'Training fact suggestion relations must belong to the same version and run';
  END IF;

  IF NEW."accepted_fact_id" IS NOT NULL THEN
    SELECT "project_version_id"
    INTO fact_version_id
    FROM "training_facts"
    WHERE "id" = NEW."accepted_fact_id";

    IF fact_version_id IS DISTINCT FROM NEW."project_version_id" THEN
      RAISE EXCEPTION 'Accepted training fact must belong to the suggestion version';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "training_fact_suggestions_validate_version"
BEFORE INSERT OR UPDATE OF
  "project_version_id",
  "suggestion_run_id",
  "provider_run_id",
  "accepted_fact_id"
ON "training_fact_suggestions"
FOR EACH ROW
EXECUTE FUNCTION "training_validate_fact_suggestion_version"();

-- Provider output is append-only. Review fields may change, but the suggested
-- content, evidence, source hash and ownership never change in place.
CREATE FUNCTION "training_prevent_fact_suggestion_original_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY[
      'status',
      'accepted_fact_id',
      'reviewed_by_id',
      'reviewed_at',
      'review_comment',
      'updated_at'
    ])
    IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY[
      'status',
      'accepted_fact_id',
      'reviewed_by_id',
      'reviewed_at',
      'review_comment',
      'updated_at'
    ])
  THEN
    RAISE EXCEPTION 'Original training fact suggestion is immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "training_fact_suggestions_prevent_original_mutation"
BEFORE UPDATE
ON "training_fact_suggestions"
FOR EACH ROW
EXECUTE FUNCTION "training_prevent_fact_suggestion_original_mutation"();
