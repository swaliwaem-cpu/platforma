CREATE TABLE "training_ai_usage_events" (
  "id" UUID NOT NULL,
  "operation_run_id" UUID NOT NULL,
  "provider" VARCHAR(32) NOT NULL,
  "operation" VARCHAR(64) NOT NULL,
  "requested_model" VARCHAR(120) NOT NULL,
  "model" VARCHAR(120) NOT NULL,
  "reasoning_effort" VARCHAR(16),
  "prompt_version" VARCHAR(64),
  "compiler_version" VARCHAR(64),
  "schema_version" VARCHAR(64),
  "project_id" UUID,
  "attempt_id" UUID,
  "question_id" UUID,
  "attempt_ordinal" INTEGER NOT NULL,
  "client_request_id" VARCHAR(160),
  "request_id" VARCHAR(160),
  "response_id" VARCHAR(160),
  "http_status" SMALLINT,
  "outcome" VARCHAR(32) NOT NULL,
  "error_code" VARCHAR(120),
  "fallback_reason" VARCHAR(120),
  "is_retry" BOOLEAN NOT NULL,
  "is_fallback" BOOLEAN NOT NULL,
  "input_tokens" INTEGER,
  "cached_tokens" INTEGER,
  "cache_write_tokens" INTEGER,
  "output_tokens" INTEGER,
  "reasoning_tokens" INTEGER,
  "total_tokens" INTEGER,
  "pricing_version" VARCHAR(64),
  "pricing_status" VARCHAR(32) NOT NULL,
  "estimated_cost_usd" NUMERIC(18, 8),
  "latency_ms" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "training_ai_usage_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "training_ai_usage_events_attempt_ordinal_check"
    CHECK ("attempt_ordinal" >= 1),
  CONSTRAINT "training_ai_usage_events_http_status_check"
    CHECK ("http_status" IS NULL OR "http_status" BETWEEN 100 AND 599),
  CONSTRAINT "training_ai_usage_events_outcome_check"
    CHECK ("outcome" IN (
      'accepted',
      'local_validation_failed',
      'transport_error',
      'provider_error'
    )),
  CONSTRAINT "training_ai_usage_events_error_code_check"
    CHECK (
      ("outcome" = 'accepted' AND "error_code" IS NULL) OR
      ("outcome" <> 'accepted' AND "error_code" IS NOT NULL)
    ),
  CONSTRAINT "training_ai_usage_events_retry_fallback_check"
    CHECK (NOT ("is_retry" AND "is_fallback")),
  CONSTRAINT "training_ai_usage_events_fallback_reason_check"
    CHECK (
      ("is_fallback" AND "fallback_reason" IS NOT NULL) OR
      (NOT "is_fallback" AND "fallback_reason" IS NULL)
    ),
  CONSTRAINT "training_ai_usage_events_token_counts_check"
    CHECK (
      ("input_tokens" IS NULL OR "input_tokens" >= 0) AND
      ("cached_tokens" IS NULL OR "cached_tokens" >= 0) AND
      ("cache_write_tokens" IS NULL OR "cache_write_tokens" >= 0) AND
      ("output_tokens" IS NULL OR "output_tokens" >= 0) AND
      ("reasoning_tokens" IS NULL OR "reasoning_tokens" >= 0) AND
      ("total_tokens" IS NULL OR "total_tokens" >= 0)
    ),
  CONSTRAINT "training_ai_usage_events_latency_check"
    CHECK ("latency_ms" >= 0),
  CONSTRAINT "training_ai_usage_events_pricing_status_check"
    CHECK ("pricing_status" IN (
      'estimated',
      'usage_incomplete',
      'model_unpriced',
      'snapshot_unavailable'
    )),
  CONSTRAINT "training_ai_usage_events_pricing_value_check"
    CHECK (
      (
        "pricing_status" = 'estimated' AND
        "pricing_version" IS NOT NULL AND
        "estimated_cost_usd" IS NOT NULL AND
        "estimated_cost_usd" >= 0
      ) OR
      ("pricing_status" <> 'estimated' AND "estimated_cost_usd" IS NULL)
    )
);

CREATE UNIQUE INDEX "training_ai_usage_events_run_attempt_key"
  ON "training_ai_usage_events"("operation_run_id", "attempt_ordinal");

CREATE INDEX "training_ai_usage_events_created_at_idx"
  ON "training_ai_usage_events"("created_at");

CREATE INDEX "training_ai_usage_events_project_created_at_idx"
  ON "training_ai_usage_events"("project_id", "created_at");

CREATE INDEX "training_ai_usage_events_attempt_created_at_idx"
  ON "training_ai_usage_events"("attempt_id", "created_at");

CREATE INDEX "training_ai_usage_events_question_id_idx"
  ON "training_ai_usage_events"("question_id");

CREATE INDEX "training_ai_usage_events_operation_created_at_idx"
  ON "training_ai_usage_events"("operation", "created_at");

CREATE INDEX "training_ai_usage_events_model_created_at_idx"
  ON "training_ai_usage_events"("model", "created_at");

ALTER TABLE "training_ai_usage_events"
  ADD CONSTRAINT "training_ai_usage_events_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "training_projects"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "training_ai_usage_events_attempt_id_fkey"
    FOREIGN KEY ("attempt_id") REFERENCES "training_attempts"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "training_ai_usage_events_question_id_fkey"
    FOREIGN KEY ("question_id") REFERENCES "training_questions"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
