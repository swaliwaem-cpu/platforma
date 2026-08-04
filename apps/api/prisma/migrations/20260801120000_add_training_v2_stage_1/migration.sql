CREATE TYPE "training_project_status" AS ENUM ('draft', 'published', 'archived');
CREATE TYPE "training_question_type" AS ENUM ('main', 'follow_up');
CREATE TYPE "training_attempt_status" AS ENUM ('in_progress', 'completed', 'requires_review', 'timed_out');
CREATE TYPE "training_attempt_completion_reason" AS ENUM ('completed', 'timeout');
CREATE TYPE "training_attempt_question_status" AS ENUM ('presented', 'answered', 'skipped_timeout');
CREATE TYPE "training_fake_outcome" AS ENUM ('scored', 'requires_review');

CREATE TABLE "training_projects" (
  "id" UUID NOT NULL,
  "real_estate_object_id" UUID,
  "title" VARCHAR(240) NOT NULL,
  "description" TEXT,
  "status" "training_project_status" NOT NULL DEFAULT 'draft',
  "is_open" BOOLEAN NOT NULL DEFAULT false,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "attempt_limit" INTEGER NOT NULL DEFAULT 3,
  "time_limit_seconds" INTEGER NOT NULL DEFAULT 420,
  "pass_score" INTEGER NOT NULL DEFAULT 75,
  "allow_retake_after_pass" BOOLEAN NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "training_projects_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "training_projects_attempt_limit_check" CHECK ("attempt_limit" > 0),
  CONSTRAINT "training_projects_time_limit_seconds_check" CHECK ("time_limit_seconds" > 0),
  CONSTRAINT "training_projects_pass_score_check" CHECK ("pass_score" BETWEEN 0 AND 100),
  CONSTRAINT "training_projects_open_status_check" CHECK (NOT "is_open" OR "status" = 'published')
);

CREATE TABLE "training_questions" (
  "id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "type" "training_question_type" NOT NULL,
  "text" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "training_questions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "training_questions_type_position_check" CHECK (
    ("type" = 'main' AND "position" = 1) OR
    ("type" = 'follow_up' AND "position" BETWEEN 1 AND 10)
  )
);

CREATE TABLE "training_attempts" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "attempt_number" INTEGER NOT NULL,
  "start_idempotency_key" UUID NOT NULL,
  "status" "training_attempt_status" NOT NULL DEFAULT 'in_progress',
  "completion_reason" "training_attempt_completion_reason",
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "completed_at" TIMESTAMP(3),
  "final_score" INTEGER,
  "is_passed" BOOLEAN,
  "project_snapshot_json" JSONB NOT NULL,
  "fake_evaluation_version" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "training_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "training_attempts_attempt_number_check" CHECK ("attempt_number" > 0),
  CONSTRAINT "training_attempts_expiry_check" CHECK ("expires_at" > "started_at"),
  CONSTRAINT "training_attempts_final_score_check" CHECK ("final_score" IS NULL OR "final_score" BETWEEN 0 AND 100),
  CONSTRAINT "training_attempts_state_check" CHECK (
    ("status" = 'in_progress' AND "completion_reason" IS NULL AND "completed_at" IS NULL AND "final_score" IS NULL AND "is_passed" IS NULL) OR
    ("status" = 'completed' AND "completion_reason" = 'completed' AND "completed_at" IS NOT NULL AND "final_score" IS NOT NULL AND "is_passed" IS NOT NULL) OR
    ("status" = 'requires_review' AND "completion_reason" = 'completed' AND "completed_at" IS NOT NULL AND "final_score" IS NULL AND "is_passed" IS NULL) OR
    ("status" = 'timed_out' AND "completion_reason" = 'timeout' AND "completed_at" IS NOT NULL AND "final_score" IS NOT NULL AND "is_passed" = false)
  )
);

CREATE TABLE "training_attempt_questions" (
  "id" UUID NOT NULL,
  "attempt_id" UUID NOT NULL,
  "source_question_id" UUID,
  "sequence" INTEGER NOT NULL,
  "type" "training_question_type" NOT NULL,
  "question_text_snapshot" TEXT NOT NULL,
  "max_score" INTEGER NOT NULL,
  "status" "training_attempt_question_status" NOT NULL DEFAULT 'presented',
  "presented_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "answered_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "training_attempt_questions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "training_attempt_questions_sequence_check" CHECK (
    ("sequence" = 1 AND "type" = 'main' AND "max_score" = 55) OR
    ("sequence" BETWEEN 2 AND 4 AND "type" = 'follow_up' AND "max_score" = 15)
  )
);

CREATE TABLE "training_answers" (
  "id" UUID NOT NULL,
  "attempt_question_id" UUID NOT NULL,
  "text" TEXT NOT NULL,
  "score" INTEGER NOT NULL,
  "fake_outcome" "training_fake_outcome" NOT NULL,
  "safe_breakdown_json" JSONB NOT NULL,
  "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "training_answers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "training_answers_score_check" CHECK ("score" BETWEEN 0 AND 55)
);

CREATE INDEX "training_projects_real_estate_object_id_idx" ON "training_projects"("real_estate_object_id");
CREATE INDEX "training_projects_status_is_open_sort_order_idx" ON "training_projects"("status", "is_open", "sort_order");
CREATE UNIQUE INDEX "training_questions_project_id_type_position_key" ON "training_questions"("project_id", "type", "position");
CREATE UNIQUE INDEX "training_attempts_user_id_project_id_attempt_number_key" ON "training_attempts"("user_id", "project_id", "attempt_number");
CREATE UNIQUE INDEX "training_attempts_user_id_project_id_start_idempotency_key_key" ON "training_attempts"("user_id", "project_id", "start_idempotency_key");
CREATE UNIQUE INDEX "training_attempts_one_in_progress_per_user_project_idx" ON "training_attempts"("user_id", "project_id") WHERE "status" = 'in_progress';
CREATE INDEX "training_attempts_project_id_started_at_idx" ON "training_attempts"("project_id", "started_at");
CREATE UNIQUE INDEX "training_attempt_questions_attempt_id_sequence_key" ON "training_attempt_questions"("attempt_id", "sequence");
CREATE UNIQUE INDEX "training_attempt_questions_attempt_id_source_question_id_key" ON "training_attempt_questions"("attempt_id", "source_question_id");
CREATE INDEX "training_attempt_questions_source_question_id_idx" ON "training_attempt_questions"("source_question_id");
CREATE UNIQUE INDEX "training_answers_attempt_question_id_key" ON "training_answers"("attempt_question_id");

ALTER TABLE "training_projects" ADD CONSTRAINT "training_projects_real_estate_object_id_fkey" FOREIGN KEY ("real_estate_object_id") REFERENCES "real_estate_objects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "training_questions" ADD CONSTRAINT "training_questions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "training_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "training_attempts" ADD CONSTRAINT "training_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "training_attempts" ADD CONSTRAINT "training_attempts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "training_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "training_attempt_questions" ADD CONSTRAINT "training_attempt_questions_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "training_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "training_attempt_questions" ADD CONSTRAINT "training_attempt_questions_source_question_id_fkey" FOREIGN KEY ("source_question_id") REFERENCES "training_questions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "training_answers" ADD CONSTRAINT "training_answers_attempt_question_id_fkey" FOREIGN KEY ("attempt_question_id") REFERENCES "training_attempt_questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
