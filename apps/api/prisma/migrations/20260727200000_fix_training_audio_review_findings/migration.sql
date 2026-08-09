ALTER TYPE "training_job_kind"
ADD VALUE 'cleanup_training_audio_object';

CREATE TYPE "training_audio_upload_kind" AS ENUM (
  'original_segment',
  'merged_answer'
);

CREATE TYPE "training_audio_upload_state" AS ENUM (
  'pending',
  'uploaded',
  'committed',
  'cleanup_pending',
  'cleaned'
);

CREATE TABLE "training_audio_upload_intents" (
  "id" UUID NOT NULL,
  "kind" "training_audio_upload_kind" NOT NULL,
  "state" "training_audio_upload_state" NOT NULL DEFAULT 'pending',
  "segment_id" UUID,
  "answer_id" UUID,
  "committed_file_id" UUID,
  "bucket" VARCHAR(255) NOT NULL,
  "object_key" VARCHAR(1024) NOT NULL,
  "expected_checksum" VARCHAR(64) NOT NULL,
  "expected_size_bytes" BIGINT NOT NULL,
  "expected_mime_type" VARCHAR(120) NOT NULL,
  "recovery_key" VARCHAR(160) NOT NULL,
  "uploaded_at" TIMESTAMP(3),
  "committed_at" TIMESTAMP(3),
  "cleanup_requested_at" TIMESTAMP(3),
  "cleanup_generation" INTEGER NOT NULL DEFAULT 0,
  "cleaned_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "training_audio_upload_intents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "training_audio_upload_intents_owner_check" CHECK (
    (
      "kind" = 'original_segment'
      AND "segment_id" IS NOT NULL
      AND "answer_id" IS NULL
    )
    OR
    (
      "kind" = 'merged_answer'
      AND "answer_id" IS NOT NULL
      AND "segment_id" IS NULL
    )
  ),
  CONSTRAINT "training_audio_upload_intents_checksum_sha256" CHECK (
    "expected_checksum" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "training_audio_upload_intents_size_positive" CHECK (
    "expected_size_bytes" > 0
  )
);

CREATE UNIQUE INDEX "training_audio_upload_intents_segment_id_key"
ON "training_audio_upload_intents"("segment_id");

CREATE UNIQUE INDEX "training_audio_upload_intents_answer_id_key"
ON "training_audio_upload_intents"("answer_id");

CREATE UNIQUE INDEX "training_audio_upload_intents_committed_file_id_key"
ON "training_audio_upload_intents"("committed_file_id");

CREATE UNIQUE INDEX "training_audio_upload_intents_recovery_key_key"
ON "training_audio_upload_intents"("recovery_key");

CREATE UNIQUE INDEX "training_audio_upload_intents_bucket_object_key_key"
ON "training_audio_upload_intents"("bucket", "object_key");

CREATE INDEX "training_audio_upload_intents_state_updated_at_idx"
ON "training_audio_upload_intents"("state", "updated_at");

ALTER TABLE "training_audio_upload_intents"
ADD CONSTRAINT "training_audio_upload_intents_segment_id_fkey"
FOREIGN KEY ("segment_id")
REFERENCES "training_voice_segments"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;

ALTER TABLE "training_audio_upload_intents"
ADD CONSTRAINT "training_audio_upload_intents_answer_id_fkey"
FOREIGN KEY ("answer_id")
REFERENCES "training_answers"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;

ALTER TABLE "training_audio_upload_intents"
ADD CONSTRAINT "training_audio_upload_intents_committed_file_id_fkey"
FOREIGN KEY ("committed_file_id")
REFERENCES "files"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;

ALTER TABLE "training_attempt_questions"
DROP CONSTRAINT "training_attempt_questions_attempt_id_fkey";

ALTER TABLE "training_attempt_questions"
ADD CONSTRAINT "training_attempt_questions_attempt_id_fkey"
FOREIGN KEY ("attempt_id")
REFERENCES "training_attempts"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;

ALTER TABLE "training_answers"
DROP CONSTRAINT "training_answers_attempt_question_id_fkey";

ALTER TABLE "training_answers"
ADD CONSTRAINT "training_answers_attempt_question_id_fkey"
FOREIGN KEY ("attempt_question_id")
REFERENCES "training_attempt_questions"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;

ALTER TABLE "training_voice_segments"
DROP CONSTRAINT "training_voice_segments_answer_id_fkey";

ALTER TABLE "training_voice_segments"
ADD CONSTRAINT "training_voice_segments_answer_id_fkey"
FOREIGN KEY ("answer_id")
REFERENCES "training_answers"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;

ALTER TABLE "training_answer_evaluations"
DROP CONSTRAINT "training_answer_evaluations_answer_id_fkey";

ALTER TABLE "training_answer_evaluations"
ADD CONSTRAINT "training_answer_evaluations_answer_id_fkey"
FOREIGN KEY ("answer_id")
REFERENCES "training_answers"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;

ALTER TABLE "training_score_components"
DROP CONSTRAINT "training_score_components_evaluation_id_fkey";

ALTER TABLE "training_score_components"
ADD CONSTRAINT "training_score_components_evaluation_id_fkey"
FOREIGN KEY ("evaluation_id")
REFERENCES "training_answer_evaluations"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;

ALTER TABLE "training_result_reviews"
DROP CONSTRAINT "training_result_reviews_attempt_id_fkey";

ALTER TABLE "training_result_reviews"
ADD CONSTRAINT "training_result_reviews_attempt_id_fkey"
FOREIGN KEY ("attempt_id")
REFERENCES "training_attempts"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;
