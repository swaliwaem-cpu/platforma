CREATE TYPE "training_answer_source" AS ENUM ('text', 'telegram');
CREATE TYPE "training_answer_processing_status" AS ENUM ('collecting', 'processing', 'completed', 'failed');

ALTER TABLE "training_answers"
  ALTER COLUMN "text" DROP NOT NULL,
  ALTER COLUMN "score" DROP NOT NULL,
  ALTER COLUMN "fake_outcome" DROP NOT NULL,
  ALTER COLUMN "safe_breakdown_json" DROP NOT NULL,
  ALTER COLUMN "submitted_at" DROP DEFAULT,
  ALTER COLUMN "submitted_at" DROP NOT NULL,
  ADD COLUMN "source" "training_answer_source" NOT NULL DEFAULT 'text',
  ADD COLUMN "processing_status" "training_answer_processing_status" NOT NULL DEFAULT 'completed',
  ADD COLUMN "merged_audio_file_id" UUID,
  ADD COLUMN "processing_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "processing_locked_at" TIMESTAMP(3),
  ADD COLUMN "processing_locked_by" VARCHAR(128),
  ADD COLUMN "processing_error_code" VARCHAR(64);

CREATE TABLE "training_telegram_accounts" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "telegram_user_id" BIGINT NOT NULL,
  "chat_id" BIGINT NOT NULL,
  "username" VARCHAR(64),
  "linked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "training_telegram_accounts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "training_telegram_link_tokens" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "token_hash" CHAR(64) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "used_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "training_telegram_link_tokens_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "training_answer_segments" (
  "id" UUID NOT NULL,
  "answer_id" UUID NOT NULL,
  "position" INTEGER NOT NULL,
  "telegram_message_id" BIGINT NOT NULL,
  "telegram_file_id" VARCHAR(512) NOT NULL,
  "telegram_file_unique_id" VARCHAR(512) NOT NULL,
  "duration_seconds" INTEGER NOT NULL,
  "size_bytes" BIGINT,
  "stored_file_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "training_answer_segments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "training_answer_segments_position_check" CHECK ("position" > 0),
  CONSTRAINT "training_answer_segments_duration_check" CHECK ("duration_seconds" >= 0),
  CONSTRAINT "training_answer_segments_size_check" CHECK ("size_bytes" IS NULL OR "size_bytes" > 0)
);

ALTER TABLE "training_answers"
  ADD CONSTRAINT "training_answers_processing_attempts_check" CHECK ("processing_attempts" >= 0),
  ADD CONSTRAINT "training_answers_processing_lock_check" CHECK (
    ("processing_locked_at" IS NULL AND "processing_locked_by" IS NULL) OR
    ("processing_status" = 'processing' AND "processing_locked_at" IS NOT NULL AND "processing_locked_by" IS NOT NULL)
  ),
  ADD CONSTRAINT "training_answers_payload_state_check" CHECK (
    (
      "source" = 'text' AND
      "processing_status" = 'completed' AND
      "text" IS NOT NULL AND
      "score" IS NOT NULL AND
      "fake_outcome" IS NOT NULL AND
      "safe_breakdown_json" IS NOT NULL AND
      "submitted_at" IS NOT NULL AND
      "merged_audio_file_id" IS NULL AND
      "processing_error_code" IS NULL
    ) OR
    (
      "source" = 'telegram' AND
      "processing_status" IN ('collecting', 'processing') AND
      "text" IS NULL AND
      "score" IS NULL AND
      "fake_outcome" IS NULL AND
      "safe_breakdown_json" IS NULL AND
      "processing_error_code" IS NULL
    ) OR
    (
      "source" = 'telegram' AND
      "processing_status" = 'completed' AND
      "text" IS NOT NULL AND
      "score" IS NOT NULL AND
      "fake_outcome" IS NOT NULL AND
      "safe_breakdown_json" IS NOT NULL AND
      "submitted_at" IS NOT NULL AND
      "merged_audio_file_id" IS NOT NULL AND
      "processing_error_code" IS NULL
    ) OR
    (
      "source" = 'telegram' AND
      "processing_status" = 'failed' AND
      "text" IS NULL AND
      "score" IS NULL AND
      "fake_outcome" IS NULL AND
      "safe_breakdown_json" IS NULL AND
      "processing_error_code" IS NOT NULL
    )
  );

CREATE UNIQUE INDEX "training_answers_merged_audio_file_id_key" ON "training_answers"("merged_audio_file_id");
CREATE INDEX "training_answers_processing_status_processing_locked_at_created_at_idx" ON "training_answers"("processing_status", "processing_locked_at", "created_at");

CREATE INDEX "training_telegram_accounts_user_id_idx" ON "training_telegram_accounts"("user_id");
CREATE INDEX "training_telegram_accounts_telegram_user_id_idx" ON "training_telegram_accounts"("telegram_user_id");
CREATE INDEX "training_telegram_accounts_chat_id_idx" ON "training_telegram_accounts"("chat_id");
CREATE UNIQUE INDEX "training_telegram_accounts_active_user_idx" ON "training_telegram_accounts"("user_id") WHERE "revoked_at" IS NULL;
CREATE UNIQUE INDEX "training_telegram_accounts_active_telegram_user_idx" ON "training_telegram_accounts"("telegram_user_id") WHERE "revoked_at" IS NULL;

CREATE UNIQUE INDEX "training_telegram_link_tokens_token_hash_key" ON "training_telegram_link_tokens"("token_hash");
CREATE INDEX "training_telegram_link_tokens_user_id_used_at_idx" ON "training_telegram_link_tokens"("user_id", "used_at");
CREATE INDEX "training_telegram_link_tokens_project_id_idx" ON "training_telegram_link_tokens"("project_id");
CREATE INDEX "training_telegram_link_tokens_expires_at_idx" ON "training_telegram_link_tokens"("expires_at");

CREATE UNIQUE INDEX "training_answer_segments_answer_id_position_key" ON "training_answer_segments"("answer_id", "position");
CREATE UNIQUE INDEX "training_answer_segments_answer_id_telegram_message_id_key" ON "training_answer_segments"("answer_id", "telegram_message_id");
CREATE UNIQUE INDEX "training_answer_segments_answer_id_telegram_file_unique_id_key" ON "training_answer_segments"("answer_id", "telegram_file_unique_id");
CREATE INDEX "training_answer_segments_stored_file_id_idx" ON "training_answer_segments"("stored_file_id");

ALTER TABLE "training_telegram_accounts" ADD CONSTRAINT "training_telegram_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "training_telegram_link_tokens" ADD CONSTRAINT "training_telegram_link_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "training_telegram_link_tokens" ADD CONSTRAINT "training_telegram_link_tokens_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "training_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "training_answers" ADD CONSTRAINT "training_answers_merged_audio_file_id_fkey" FOREIGN KEY ("merged_audio_file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "training_answer_segments" ADD CONSTRAINT "training_answer_segments_answer_id_fkey" FOREIGN KEY ("answer_id") REFERENCES "training_answers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "training_answer_segments" ADD CONSTRAINT "training_answer_segments_stored_file_id_fkey" FOREIGN KEY ("stored_file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
