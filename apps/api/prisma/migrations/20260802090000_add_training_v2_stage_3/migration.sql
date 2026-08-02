CREATE TYPE "training_ai_step_status" AS ENUM ('pending', 'completed', 'failed');
CREATE TYPE "training_review_status" AS ENUM ('not_required', 'pending', 'resolved');
CREATE TYPE "training_review_decision" AS ENUM ('approved', 'overridden');

ALTER TABLE "training_projects"
  ADD COLUMN "content_schema_version" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT "training_projects_content_schema_version_check"
    CHECK ("content_schema_version" IN (1, 2));

CREATE TABLE "training_facts" (
  "id" UUID NOT NULL,
  "question_id" UUID NOT NULL,
  "statement" TEXT NOT NULL,
  "aliases_json" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "is_required" BOOLEAN NOT NULL DEFAULT true,
  "position" INTEGER NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "training_facts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "training_facts_statement_check" CHECK (btrim("statement") <> ''),
  CONSTRAINT "training_facts_position_check" CHECK ("position" > 0),
  CONSTRAINT "training_facts_aliases_check" CHECK (
    jsonb_typeof("aliases_json") = 'array' AND jsonb_array_length("aliases_json") <= 20
  )
);

CREATE TABLE "training_criteria" (
  "id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "question_type" "training_question_type" NOT NULL,
  "code" VARCHAR(64) NOT NULL,
  "title" VARCHAR(240) NOT NULL,
  "guidance" TEXT NOT NULL,
  "max_points" INTEGER NOT NULL,
  "position" INTEGER NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "training_criteria_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "training_criteria_code_check" CHECK (btrim("code") <> ''),
  CONSTRAINT "training_criteria_title_check" CHECK (btrim("title") <> ''),
  CONSTRAINT "training_criteria_max_points_check" CHECK ("max_points" > 0),
  CONSTRAINT "training_criteria_position_check" CHECK ("position" > 0)
);

CREATE UNIQUE INDEX "training_facts_question_id_position_key"
  ON "training_facts"("question_id", "position");
CREATE UNIQUE INDEX "training_criteria_project_id_question_type_code_key"
  ON "training_criteria"("project_id", "question_type", "code");
CREATE UNIQUE INDEX "training_criteria_project_id_question_type_position_key"
  ON "training_criteria"("project_id", "question_type", "position");

ALTER TABLE "training_facts"
  ADD CONSTRAINT "training_facts_question_id_fkey"
  FOREIGN KEY ("question_id") REFERENCES "training_questions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "training_criteria"
  ADD CONSTRAINT "training_criteria_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "training_projects"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "training_attempts"
  ADD COLUMN "calculated_score" INTEGER,
  ADD COLUMN "review_status" "training_review_status" NOT NULL DEFAULT 'not_required',
  ADD COLUMN "review_decision" "training_review_decision",
  ADD COLUMN "reviewed_by_id" UUID,
  ADD COLUMN "reviewed_at" TIMESTAMP(3),
  ADD COLUMN "review_comment" TEXT,
  ADD COLUMN "review_final_score" INTEGER,
  ADD COLUMN "counts_toward_attempt_limit" BOOLEAN NOT NULL DEFAULT true;

UPDATE "training_attempts"
SET "calculated_score" = "final_score"
WHERE "status" IN ('completed', 'timed_out');

UPDATE "training_attempts" AS attempt
SET
  "calculated_score" = LEAST(100, GREATEST(0, COALESCE(scores.total_score, 0))),
  "review_status" = 'pending'
FROM (
  SELECT question."attempt_id", SUM(COALESCE(answer."score", 0))::integer AS total_score
  FROM "training_attempt_questions" AS question
  LEFT JOIN "training_answers" AS answer ON answer."attempt_question_id" = question."id"
  GROUP BY question."attempt_id"
) AS scores
WHERE attempt."id" = scores."attempt_id"
  AND attempt."status" = 'requires_review';

ALTER TABLE "training_attempts"
  ADD CONSTRAINT "training_attempts_calculated_score_check"
    CHECK ("calculated_score" IS NULL OR "calculated_score" BETWEEN 0 AND 100),
  ADD CONSTRAINT "training_attempts_review_final_score_check"
    CHECK ("review_final_score" IS NULL OR "review_final_score" BETWEEN 0 AND 100),
  ADD CONSTRAINT "training_attempts_review_state_check" CHECK (
    (
      "review_status" = 'not_required' AND
      "review_decision" IS NULL AND "reviewed_by_id" IS NULL AND
      "reviewed_at" IS NULL AND "review_comment" IS NULL AND
      "review_final_score" IS NULL
    ) OR
    (
      "review_status" = 'pending' AND
      "review_decision" IS NULL AND "reviewed_by_id" IS NULL AND
      "reviewed_at" IS NULL AND "review_comment" IS NULL AND
      "review_final_score" IS NULL
    ) OR
    (
      "review_status" = 'resolved' AND
      "review_decision" = 'approved' AND "reviewed_by_id" IS NOT NULL AND
      "reviewed_at" IS NOT NULL AND "review_final_score" IS NULL
    ) OR
    (
      "review_status" = 'resolved' AND
      "review_decision" = 'overridden' AND "reviewed_by_id" IS NOT NULL AND
      "reviewed_at" IS NOT NULL AND "review_final_score" IS NOT NULL AND
      btrim(COALESCE("review_comment", '')) <> ''
    )
  );

DROP INDEX "training_attempts_one_in_progress_per_user_project_idx";
CREATE UNIQUE INDEX "training_attempts_one_in_progress_per_user_project_idx"
  ON "training_attempts"("user_id", "project_id") WHERE "status" = 'in_progress';
CREATE INDEX "training_attempts_reviewed_by_id_idx" ON "training_attempts"("reviewed_by_id");

ALTER TABLE "training_attempts"
  ADD CONSTRAINT "training_attempts_reviewed_by_id_fkey"
  FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "training_attempts" DROP CONSTRAINT "training_attempts_state_check";
ALTER TABLE "training_attempts" ADD CONSTRAINT "training_attempts_state_check" CHECK (
  (
    "status" = 'in_progress' AND "completion_reason" IS NULL AND
    "completed_at" IS NULL AND "calculated_score" IS NULL AND
    "final_score" IS NULL AND "is_passed" IS NULL AND
    "review_status" = 'not_required' AND "counts_toward_attempt_limit" = true
  ) OR
  (
    "status" = 'completed' AND "completion_reason" = 'completed' AND
    "completed_at" IS NOT NULL AND "calculated_score" IS NOT NULL AND
    "final_score" IS NOT NULL AND "is_passed" IS NOT NULL AND
    "review_status" IN ('not_required', 'resolved') AND
    "counts_toward_attempt_limit" = true
  ) OR
  (
    "status" = 'requires_review' AND "completion_reason" = 'completed' AND
    "completed_at" IS NOT NULL AND "calculated_score" IS NOT NULL AND
    "final_score" IS NULL AND "is_passed" IS NULL AND
    "review_status" = 'pending' AND "counts_toward_attempt_limit" = true
  ) OR
  (
    "status" = 'timed_out' AND "completion_reason" = 'timeout' AND
    "completed_at" IS NOT NULL AND "calculated_score" IS NOT NULL AND
    "final_score" IS NOT NULL AND "is_passed" = false AND
    "review_status" = 'not_required' AND "counts_toward_attempt_limit" = true
  ) OR
  (
    "status" = 'technical_failed' AND "completion_reason" = 'technical_failure' AND
    "completed_at" IS NOT NULL AND "calculated_score" IS NULL AND
    "final_score" IS NULL AND "is_passed" = false AND
    "review_status" = 'not_required' AND "counts_toward_attempt_limit" = false
  )
);

ALTER TABLE "training_answers"
  ADD COLUMN "transcription_status" "training_ai_step_status" NOT NULL DEFAULT 'pending',
  ADD COLUMN "evaluation_status" "training_ai_step_status" NOT NULL DEFAULT 'pending',
  ADD COLUMN "transcription_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "evaluation_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "transcription_model" VARCHAR(120),
  ADD COLUMN "evaluation_model" VARCHAR(120),
  ADD COLUMN "transcription_request_id" VARCHAR(160),
  ADD COLUMN "evaluation_request_id" VARCHAR(160),
  ADD COLUMN "transcription_latency_ms" INTEGER,
  ADD COLUMN "evaluation_latency_ms" INTEGER,
  ADD COLUMN "evaluation_schema_version" VARCHAR(64),
  ADD COLUMN "evaluation_json" JSONB,
  ADD COLUMN "objective_metrics_json" JSONB;

UPDATE "training_answers"
SET
  "transcription_status" = CASE
    WHEN "processing_status" = 'completed' THEN 'completed'::"training_ai_step_status"
    WHEN "processing_status" = 'failed' THEN 'failed'::"training_ai_step_status"
    ELSE 'pending'::"training_ai_step_status"
  END,
  "evaluation_status" = CASE
    WHEN "processing_status" = 'completed' THEN 'completed'::"training_ai_step_status"
    ELSE 'pending'::"training_ai_step_status"
  END;

ALTER TABLE "training_answers"
  ADD CONSTRAINT "training_answers_transcription_attempts_check" CHECK ("transcription_attempts" >= 0),
  ADD CONSTRAINT "training_answers_evaluation_attempts_check" CHECK ("evaluation_attempts" >= 0),
  ADD CONSTRAINT "training_answers_transcription_latency_check" CHECK ("transcription_latency_ms" IS NULL OR "transcription_latency_ms" >= 0),
  ADD CONSTRAINT "training_answers_evaluation_latency_check" CHECK ("evaluation_latency_ms" IS NULL OR "evaluation_latency_ms" >= 0),
  ADD CONSTRAINT "training_answers_ai_steps_check" CHECK (
    ("transcription_status" = 'completed' AND "text" IS NOT NULL) OR
    ("transcription_status" <> 'completed' AND "text" IS NULL) OR
    ("processing_status" = 'failed' AND "text" IS NOT NULL)
  ),
  ADD CONSTRAINT "training_answers_evaluation_step_check" CHECK (
    ("evaluation_status" = 'completed' AND "transcription_status" = 'completed' AND "score" IS NOT NULL) OR
    ("evaluation_status" <> 'completed' AND "score" IS NULL)
  );

ALTER TABLE "training_answers" DROP CONSTRAINT "training_answers_payload_state_check";
ALTER TABLE "training_answers" ADD CONSTRAINT "training_answers_payload_state_check" CHECK (
  (
    "source" = 'text' AND "processing_status" = 'completed' AND
    "text" IS NOT NULL AND "score" IS NOT NULL AND
    "fake_outcome" IS NOT NULL AND "safe_breakdown_json" IS NOT NULL AND
    "submitted_at" IS NOT NULL AND "merged_audio_file_id" IS NULL AND
    "processing_error_code" IS NULL
  ) OR
  (
    "source" = 'telegram' AND "processing_status" = 'collecting' AND
    "text" IS NULL AND "score" IS NULL AND "fake_outcome" IS NULL AND
    "safe_breakdown_json" IS NULL AND "merged_audio_file_id" IS NULL AND
    "processing_error_code" IS NULL
  ) OR
  (
    "source" = 'telegram' AND "processing_status" = 'processing' AND
    "processing_error_code" IS NULL AND
    (("score" IS NULL AND "fake_outcome" IS NULL AND "safe_breakdown_json" IS NULL) OR
     ("score" IS NOT NULL AND "fake_outcome" IS NOT NULL AND "safe_breakdown_json" IS NOT NULL))
  ) OR
  (
    "source" = 'telegram' AND "processing_status" = 'completed' AND
    "text" IS NOT NULL AND "score" IS NOT NULL AND
    "fake_outcome" IS NOT NULL AND "safe_breakdown_json" IS NOT NULL AND
    "submitted_at" IS NOT NULL AND "merged_audio_file_id" IS NOT NULL AND
    "processing_error_code" IS NULL
  ) OR
  (
    "source" = 'telegram' AND "processing_status" = 'failed' AND
    "processing_error_code" IS NOT NULL
  )
);
