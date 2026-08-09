CREATE TYPE "training_provider_kind" AS ENUM (
  'transcription',
  'evaluation'
);

CREATE TYPE "training_provider_run_type" AS ENUM (
  'primary',
  'reprocess',
  'review'
);

CREATE TYPE "training_provider_run_status" AS ENUM (
  'pending',
  'requesting',
  'succeeded',
  'failed',
  'ambiguous'
);

ALTER TABLE "training_answers"
ADD COLUMN "active_transcription_id" UUID,
ADD COLUMN "active_evaluation_id" UUID;

ALTER TABLE "training_answer_evaluations"
ADD COLUMN "provider_run_id" UUID;

CREATE TABLE "training_provider_runs" (
  "id" UUID NOT NULL,
  "answer_id" UUID NOT NULL,
  "kind" "training_provider_kind" NOT NULL,
  "run_type" "training_provider_run_type" NOT NULL DEFAULT 'primary',
  "status" "training_provider_run_status" NOT NULL DEFAULT 'pending',
  "idempotency_key" VARCHAR(240) NOT NULL,
  "requested_model_id" VARCHAR(120) NOT NULL,
  "actual_model_id" VARCHAR(120),
  "reasoning_effort" VARCHAR(32),
  "source_file_id" UUID,
  "source_checksum" VARCHAR(64),
  "transcript_hash" VARCHAR(64),
  "input_hash" VARCHAR(64) NOT NULL,
  "input_metadata_json" JSONB NOT NULL DEFAULT '{}',
  "prompt_version" VARCHAR(64),
  "schema_version" VARCHAR(64),
  "rubric_version" VARCHAR(64),
  "request_id" VARCHAR(160),
  "response_status" VARCHAR(64),
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

  CONSTRAINT "training_provider_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "training_provider_runs_input_hash_sha256" CHECK (
    "input_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "training_provider_runs_source_checksum_sha256" CHECK (
    "source_checksum" IS NULL OR "source_checksum" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "training_provider_runs_transcript_hash_sha256" CHECK (
    "transcript_hash" IS NULL OR "transcript_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "training_provider_runs_retry_count_nonnegative" CHECK (
    "retry_count" >= 0
  )
);

CREATE TABLE "training_answer_transcriptions" (
  "id" UUID NOT NULL,
  "answer_id" UUID NOT NULL,
  "provider_run_id" UUID NOT NULL,
  "transcription_number" INTEGER NOT NULL,
  "transcript" TEXT NOT NULL,
  "language" VARCHAR(16) NOT NULL,
  "word_count" INTEGER NOT NULL DEFAULT 0,
  "vocabulary_version" VARCHAR(64),
  "vocabulary_hash" VARCHAR(64),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "training_answer_transcriptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "training_answer_transcriptions_number_positive" CHECK (
    "transcription_number" > 0
  ),
  CONSTRAINT "training_answer_transcriptions_word_count_nonnegative" CHECK (
    "word_count" >= 0
  ),
  CONSTRAINT "training_answer_transcriptions_vocabulary_hash_sha256" CHECK (
    "vocabulary_hash" IS NULL OR "vocabulary_hash" ~ '^[0-9a-f]{64}$'
  )
);

CREATE UNIQUE INDEX "training_answers_active_transcription_id_key"
ON "training_answers"("active_transcription_id");

CREATE UNIQUE INDEX "training_answers_active_evaluation_id_key"
ON "training_answers"("active_evaluation_id");

CREATE UNIQUE INDEX "training_answer_evaluations_provider_run_id_key"
ON "training_answer_evaluations"("provider_run_id");

CREATE UNIQUE INDEX "training_provider_runs_idempotency_key_key"
ON "training_provider_runs"("idempotency_key");

CREATE INDEX "training_provider_runs_answer_id_kind_created_at_idx"
ON "training_provider_runs"("answer_id", "kind", "created_at");

CREATE INDEX "training_provider_runs_status_updated_at_idx"
ON "training_provider_runs"("status", "updated_at");

CREATE INDEX "training_provider_runs_request_id_idx"
ON "training_provider_runs"("request_id");

CREATE UNIQUE INDEX "training_answer_transcriptions_provider_run_id_key"
ON "training_answer_transcriptions"("provider_run_id");

CREATE UNIQUE INDEX "training_answer_transcriptions_answer_id_transcription_number_key"
ON "training_answer_transcriptions"("answer_id", "transcription_number");

CREATE INDEX "training_answer_transcriptions_answer_id_created_at_idx"
ON "training_answer_transcriptions"("answer_id", "created_at");

ALTER TABLE "training_provider_runs"
ADD CONSTRAINT "training_provider_runs_answer_id_fkey"
FOREIGN KEY ("answer_id")
REFERENCES "training_answers"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;

ALTER TABLE "training_provider_runs"
ADD CONSTRAINT "training_provider_runs_source_file_id_fkey"
FOREIGN KEY ("source_file_id")
REFERENCES "files"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;

ALTER TABLE "training_answer_transcriptions"
ADD CONSTRAINT "training_answer_transcriptions_answer_id_fkey"
FOREIGN KEY ("answer_id")
REFERENCES "training_answers"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;

ALTER TABLE "training_answer_transcriptions"
ADD CONSTRAINT "training_answer_transcriptions_provider_run_id_fkey"
FOREIGN KEY ("provider_run_id")
REFERENCES "training_provider_runs"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;

ALTER TABLE "training_answer_evaluations"
ADD CONSTRAINT "training_answer_evaluations_provider_run_id_fkey"
FOREIGN KEY ("provider_run_id")
REFERENCES "training_provider_runs"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;

ALTER TABLE "training_answers"
ADD CONSTRAINT "training_answers_active_transcription_id_fkey"
FOREIGN KEY ("active_transcription_id")
REFERENCES "training_answer_transcriptions"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;

ALTER TABLE "training_answers"
ADD CONSTRAINT "training_answers_active_evaluation_id_fkey"
FOREIGN KEY ("active_evaluation_id")
REFERENCES "training_answer_evaluations"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;
