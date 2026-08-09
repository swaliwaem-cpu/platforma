DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "training_answers" AS answer
    JOIN "training_answer_transcriptions" AS transcription
      ON transcription."id" = answer."active_transcription_id"
    WHERE transcription."answer_id" <> answer."id"
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce training active transcription ownership: cross-answer rows exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "training_answers" AS answer
    JOIN "training_answer_evaluations" AS evaluation
      ON evaluation."id" = answer."active_evaluation_id"
    WHERE evaluation."answer_id" <> answer."id"
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce training active evaluation ownership: cross-answer rows exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "training_answer_transcriptions" AS transcription
    JOIN "training_provider_runs" AS provider_run
      ON provider_run."id" = transcription."provider_run_id"
    WHERE provider_run."answer_id" <> transcription."answer_id"
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce training transcription provider ownership: cross-answer rows exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "training_answer_evaluations" AS evaluation
    JOIN "training_provider_runs" AS provider_run
      ON provider_run."id" = evaluation."provider_run_id"
    WHERE evaluation."provider_run_id" IS NOT NULL
      AND provider_run."answer_id" <> evaluation."answer_id"
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce training evaluation provider ownership: cross-answer rows exist';
  END IF;
END
$$;

ALTER TABLE "training_result_reviews"
ADD COLUMN "idempotency_key" VARCHAR(128),
ADD COLUMN "request_payload_hash" VARCHAR(64);

ALTER TABLE "training_result_reviews"
ADD CONSTRAINT "training_result_reviews_idempotency_pair"
CHECK (
  ("idempotency_key" IS NULL AND "request_payload_hash" IS NULL)
  OR
  ("idempotency_key" IS NOT NULL AND "request_payload_hash" IS NOT NULL)
),
ADD CONSTRAINT "training_result_reviews_request_payload_hash_sha256"
CHECK (
  "request_payload_hash" IS NULL
  OR "request_payload_hash" ~ '^[0-9a-f]{64}$'
);

CREATE UNIQUE INDEX "training_result_reviews_attempt_reviewer_idempotency_key"
ON "training_result_reviews"(
  "attempt_id",
  "reviewer_id",
  "idempotency_key"
);

CREATE UNIQUE INDEX "training_provider_runs_id_answer_id_key"
ON "training_provider_runs"("id", "answer_id");

CREATE UNIQUE INDEX "training_answers_active_transcription_id_id_key"
ON "training_answers"("active_transcription_id", "id");

CREATE UNIQUE INDEX "training_answers_active_evaluation_id_id_key"
ON "training_answers"("active_evaluation_id", "id");

CREATE UNIQUE INDEX "training_answer_transcriptions_id_answer_id_key"
ON "training_answer_transcriptions"("id", "answer_id");

CREATE UNIQUE INDEX "training_answer_transcriptions_provider_run_answer_key"
ON "training_answer_transcriptions"("provider_run_id", "answer_id");

CREATE UNIQUE INDEX "training_answer_evaluations_id_answer_id_key"
ON "training_answer_evaluations"("id", "answer_id");

CREATE UNIQUE INDEX "training_answer_evaluations_provider_run_answer_key"
ON "training_answer_evaluations"("provider_run_id", "answer_id");

ALTER TABLE "training_answer_transcriptions"
DROP CONSTRAINT "training_answer_transcriptions_provider_run_id_fkey",
ADD CONSTRAINT "training_answer_transcriptions_provider_run_answer_fkey"
FOREIGN KEY ("provider_run_id", "answer_id")
REFERENCES "training_provider_runs"("id", "answer_id")
ON DELETE RESTRICT
ON UPDATE CASCADE;

ALTER TABLE "training_answer_evaluations"
DROP CONSTRAINT "training_answer_evaluations_provider_run_id_fkey",
ADD CONSTRAINT "training_answer_evaluations_provider_run_answer_fkey"
FOREIGN KEY ("provider_run_id", "answer_id")
REFERENCES "training_provider_runs"("id", "answer_id")
ON DELETE RESTRICT
ON UPDATE CASCADE;

ALTER TABLE "training_answers"
DROP CONSTRAINT "training_answers_active_transcription_id_fkey",
ADD CONSTRAINT "training_answers_active_transcription_answer_fkey"
FOREIGN KEY ("active_transcription_id", "id")
REFERENCES "training_answer_transcriptions"("id", "answer_id")
ON DELETE RESTRICT
ON UPDATE CASCADE;

ALTER TABLE "training_answers"
DROP CONSTRAINT "training_answers_active_evaluation_id_fkey",
ADD CONSTRAINT "training_answers_active_evaluation_answer_fkey"
FOREIGN KEY ("active_evaluation_id", "id")
REFERENCES "training_answer_evaluations"("id", "answer_id")
ON DELETE RESTRICT
ON UPDATE CASCADE;
