CREATE TYPE "assistant_feedback_rating" AS ENUM ('like', 'dislike');
CREATE TYPE "assistant_feedback_reason" AS ENUM (
  'wrong_fact',
  'missing_result',
  'irrelevant',
  'stale_data',
  'broken_link',
  'slow_response',
  'other'
);
CREATE TYPE "assistant_review_status" AS ENUM ('pending', 'reviewed');
CREATE TYPE "assistant_review_classification" AS ENUM (
  'confirmed_error',
  'user_rating_incorrect',
  'no_error',
  'inconclusive'
);
CREATE TYPE "assistant_usage_window" AS ENUM ('minute', 'day');

ALTER TABLE "assistant_runs"
  ADD COLUMN "audit_json" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "quality_flags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "latency_ms" INTEGER;

CREATE INDEX "assistant_runs_created_at_status_idx"
  ON "assistant_runs" ("created_at", "status");
CREATE INDEX "assistant_runs_quality_flags_gin"
  ON "assistant_runs" USING GIN ("quality_flags");

CREATE TABLE "assistant_feedback" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "run_id" UUID NOT NULL,
  "owner_user_id" UUID NOT NULL,
  "rating" "assistant_feedback_rating" NOT NULL,
  "reason" "assistant_feedback_reason",
  "comment" VARCHAR(500),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "assistant_feedback_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "assistant_feedback_run_id_key" UNIQUE ("run_id"),
  CONSTRAINT "assistant_feedback_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "assistant_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "assistant_feedback_owner_user_id_fkey"
    FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "assistant_feedback_owner_user_id_created_at_idx"
  ON "assistant_feedback" ("owner_user_id", "created_at");
CREATE INDEX "assistant_feedback_rating_created_at_idx"
  ON "assistant_feedback" ("rating", "created_at");

CREATE TABLE "assistant_review_items" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "run_id" UUID NOT NULL,
  "feedback_id" UUID NOT NULL,
  "status" "assistant_review_status" NOT NULL DEFAULT 'pending',
  "classification" "assistant_review_classification",
  "reviewer_user_id" UUID,
  "reviewer_comment" VARCHAR(500),
  "reviewed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "assistant_review_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "assistant_review_items_run_id_key" UNIQUE ("run_id"),
  CONSTRAINT "assistant_review_items_feedback_id_key" UNIQUE ("feedback_id"),
  CONSTRAINT "assistant_review_items_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "assistant_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "assistant_review_items_feedback_id_fkey"
    FOREIGN KEY ("feedback_id") REFERENCES "assistant_feedback"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "assistant_review_items_reviewer_user_id_fkey"
    FOREIGN KEY ("reviewer_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "assistant_review_items_status_created_at_idx"
  ON "assistant_review_items" ("status", "created_at");
CREATE INDEX "assistant_review_items_classification_reviewed_at_idx"
  ON "assistant_review_items" ("classification", "reviewed_at");
CREATE INDEX "assistant_review_items_reviewer_user_id_idx"
  ON "assistant_review_items" ("reviewer_user_id");

CREATE TABLE "assistant_geo_operations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "actor_user_id" UUID,
  "normalized_query" VARCHAR(240) NOT NULL,
  "provider" VARCHAR(40) NOT NULL,
  "status" VARCHAR(64) NOT NULL,
  "duration_ms" INTEGER NOT NULL,
  "cache_hit" BOOLEAN NOT NULL DEFAULT FALSE,
  "provider_call_count" INTEGER NOT NULL DEFAULT 0,
  "error_code" VARCHAR(120),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "assistant_geo_operations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "assistant_geo_operations_actor_user_id_fkey"
    FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "assistant_geo_operations_created_at_idx"
  ON "assistant_geo_operations" ("created_at");
CREATE INDEX "assistant_geo_operations_provider_status_created_at_idx"
  ON "assistant_geo_operations" ("provider", "status", "created_at");
CREATE INDEX "assistant_geo_operations_actor_user_id_created_at_idx"
  ON "assistant_geo_operations" ("actor_user_id", "created_at");

CREATE TABLE "assistant_usage_metrics" (
  "provider" VARCHAR(40) NOT NULL,
  "model" VARCHAR(160) NOT NULL DEFAULT '',
  "window" "assistant_usage_window" NOT NULL,
  "window_started_at" TIMESTAMPTZ NOT NULL,
  "request_count" INTEGER NOT NULL DEFAULT 0,
  "completed_count" INTEGER NOT NULL DEFAULT 0,
  "error_count" INTEGER NOT NULL DEFAULT 0,
  "input_tokens" BIGINT NOT NULL DEFAULT 0,
  "output_tokens" BIGINT NOT NULL DEFAULT 0,
  "reasoning_tokens" BIGINT NOT NULL DEFAULT 0,
  "total_tokens" BIGINT NOT NULL DEFAULT 0,
  "total_latency_ms" BIGINT NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "assistant_usage_metrics_pkey"
    PRIMARY KEY ("provider", "model", "window", "window_started_at")
);

CREATE INDEX "assistant_usage_metrics_window_started_at_idx"
  ON "assistant_usage_metrics" ("window_started_at");
