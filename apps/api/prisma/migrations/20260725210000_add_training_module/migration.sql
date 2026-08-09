-- CreateEnum
CREATE TYPE "training_project_status" AS ENUM ('draft', 'open', 'closed', 'archived');

-- CreateEnum
CREATE TYPE "training_version_status" AS ENUM ('draft', 'published', 'superseded');

-- CreateEnum
CREATE TYPE "training_question_type" AS ENUM ('main', 'follow_up');

-- CreateEnum
CREATE TYPE "training_attempt_status" AS ENUM ('started', 'awaiting_main', 'processing_main', 'awaiting_follow_up', 'processing_follow_up', 'finalizing', 'completed', 'requires_review', 'expired', 'technical_failure');

-- CreateEnum
CREATE TYPE "training_attempt_question_status" AS ENUM ('pending', 'presented', 'collecting', 'locked', 'processing', 'scored', 'skipped_timeout');

-- CreateEnum
CREATE TYPE "training_answer_status" AS ENUM ('collecting', 'ready', 'downloading', 'transcribing', 'evaluating', 'scored', 'failed');

-- CreateEnum
CREATE TYPE "training_fact_verdict" AS ENUM ('correct', 'partial', 'missing', 'incorrect', 'unsupported');

-- CreateEnum
CREATE TYPE "training_review_status" AS ENUM ('not_required', 'pending', 'approved', 'overridden');

-- CreateEnum
CREATE TYPE "training_pass_status" AS ENUM ('pending', 'passed', 'failed');

-- CreateEnum
CREATE TYPE "training_job_status" AS ENUM ('pending', 'running', 'succeeded', 'failed', 'dead');

-- CreateEnum
CREATE TYPE "training_job_kind" AS ENUM ('telegram_download_segment', 'assemble_answer_audio', 'transcribe_answer', 'analyze_acoustics', 'evaluate_answer', 'finalize_attempt', 'send_telegram_message', 'send_timer_warning', 'expire_attempt', 'extract_source_document');

-- CreateEnum
CREATE TYPE "training_source_extraction_status" AS ENUM ('pending', 'processing', 'ready', 'needs_manual_text', 'failed');

-- CreateEnum
CREATE TYPE "training_source_document_type" AS ENUM ('pdf', 'docx', 'pptx', 'xlsx');

-- CreateEnum
CREATE TYPE "training_processed_update_status" AS ENUM ('received', 'processing', 'processed', 'failed');

-- CreateTable
CREATE TABLE "training_projects" (
    "id" UUID NOT NULL,
    "real_estate_object_id" UUID,
    "slug" VARCHAR(160) NOT NULL,
    "title" VARCHAR(240) NOT NULL,
    "description" VARCHAR(2000),
    "status" "training_project_status" NOT NULL DEFAULT 'draft',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "available_from" TIMESTAMP(3),
    "deadline_at" TIMESTAMP(3),
    "active_version_id" UUID,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "training_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_project_versions" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "status" "training_version_status" NOT NULL DEFAULT 'draft',
    "pass_score" INTEGER NOT NULL DEFAULT 75,
    "attempt_limit" INTEGER NOT NULL DEFAULT 3,
    "cooldown_minutes" INTEGER NOT NULL DEFAULT 60,
    "total_time_limit_seconds" INTEGER NOT NULL DEFAULT 420,
    "finish_grace_seconds" INTEGER NOT NULL DEFAULT 90,
    "warning_seconds_json" JSONB NOT NULL DEFAULT '[60,20]',
    "allow_retake_after_pass" BOOLEAN NOT NULL DEFAULT false,
    "main_max_score" INTEGER NOT NULL DEFAULT 55,
    "follow_up_max_score" INTEGER NOT NULL DEFAULT 15,
    "scoring_config_json" JSONB NOT NULL DEFAULT '{}',
    "prompt_version" VARCHAR(64) NOT NULL DEFAULT '1',
    "schema_version" VARCHAR(64) NOT NULL DEFAULT '1',
    "published_by_id" UUID,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "training_project_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_questions" (
    "id" UUID NOT NULL,
    "project_version_id" UUID NOT NULL,
    "type" "training_question_type" NOT NULL,
    "text" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "max_score" INTEGER NOT NULL,
    "topic_codes_json" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "training_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_facts" (
    "id" UUID NOT NULL,
    "project_version_id" UUID NOT NULL,
    "code" VARCHAR(120) NOT NULL,
    "topic_code" VARCHAR(120) NOT NULL,
    "statement" TEXT NOT NULL,
    "accepted_aliases_json" JSONB NOT NULL DEFAULT '[]',
    "importance" INTEGER NOT NULL DEFAULT 1,
    "source_document_id" UUID,
    "source_locator_json" JSONB,
    "is_approved" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "training_facts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_question_fact_links" (
    "question_id" UUID NOT NULL,
    "fact_id" UUID NOT NULL,
    "weight" DECIMAL(6,3),
    "is_required" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "training_question_fact_links_pkey" PRIMARY KEY ("question_id","fact_id")
);

-- CreateTable
CREATE TABLE "training_evaluation_criteria" (
    "id" UUID NOT NULL,
    "project_version_id" UUID NOT NULL,
    "question_type" "training_question_type" NOT NULL,
    "code" VARCHAR(120) NOT NULL,
    "title" VARCHAR(240) NOT NULL,
    "max_points" DECIMAL(6,2) NOT NULL,
    "description" TEXT,
    "anchors_json" JSONB NOT NULL DEFAULT '[]',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "training_evaluation_criteria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_source_documents" (
    "id" UUID NOT NULL,
    "project_version_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "document_type" "training_source_document_type" NOT NULL,
    "checksum" VARCHAR(128) NOT NULL,
    "extraction_status" "training_source_extraction_status" NOT NULL DEFAULT 'pending',
    "extracted_text" TEXT,
    "extraction_metadata_json" JSONB NOT NULL DEFAULT '{}',
    "error_message" VARCHAR(2000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "training_source_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_telegram_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "telegram_user_id" BIGINT NOT NULL,
    "chat_id" BIGINT NOT NULL,
    "username" VARCHAR(64),
    "first_name" VARCHAR(128),
    "last_name" VARCHAR(128),
    "linked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "training_telegram_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_link_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "project_id" UUID,
    "token_hash" VARCHAR(128) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "training_link_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_attempts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "project_version_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "status" "training_attempt_status" NOT NULL DEFAULT 'started',
    "is_consumed" BOOLEAN NOT NULL DEFAULT true,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "grace_expires_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "settings_snapshot_json" JSONB NOT NULL,
    "ai_score" DECIMAL(6,2),
    "server_score" DECIMAL(6,2),
    "admin_score" DECIMAL(6,2),
    "final_score" DECIMAL(6,2),
    "pass_status" "training_pass_status" NOT NULL DEFAULT 'pending',
    "review_status" "training_review_status" NOT NULL DEFAULT 'not_required',
    "summary" VARCHAR(2000),
    "total_duration_seconds" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "training_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_attempt_questions" (
    "id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" "training_attempt_question_status" NOT NULL DEFAULT 'pending',
    "presented_at" TIMESTAMP(3),
    "first_segment_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "response_time_seconds" INTEGER,
    "answer_duration_seconds" INTEGER,
    "selection_random_index" INTEGER,
    "selection_metadata_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "training_attempt_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_answers" (
    "id" UUID NOT NULL,
    "attempt_question_id" UUID NOT NULL,
    "status" "training_answer_status" NOT NULL DEFAULT 'collecting',
    "combined_transcript" TEXT,
    "normalized_language" VARCHAR(16),
    "acoustic_metrics_json" JSONB,
    "transcription_provider" VARCHAR(64),
    "transcription_model" VARCHAR(120),
    "transcription_request_id" VARCHAR(160),
    "processing_started_at" TIMESTAMP(3),
    "processing_finished_at" TIMESTAMP(3),
    "error_code" VARCHAR(120),
    "error_message" VARCHAR(2000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "training_answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_voice_segments" (
    "id" UUID NOT NULL,
    "answer_id" UUID NOT NULL,
    "segment_index" INTEGER NOT NULL,
    "telegram_update_id" BIGINT NOT NULL,
    "telegram_message_id" BIGINT NOT NULL,
    "telegram_chat_id" BIGINT NOT NULL,
    "telegram_file_id" VARCHAR(256) NOT NULL,
    "file_unique_id" VARCHAR(256) NOT NULL,
    "original_storage_bucket" VARCHAR(255),
    "original_storage_key" VARCHAR(1024),
    "mime_type" VARCHAR(120),
    "size_bytes" BIGINT,
    "duration_seconds" INTEGER,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "training_voice_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_answer_evaluations" (
    "id" UUID NOT NULL,
    "answer_id" UUID NOT NULL,
    "evaluation_number" INTEGER NOT NULL DEFAULT 1,
    "actual_model_id" VARCHAR(120) NOT NULL,
    "reasoning_effort" VARCHAR(32),
    "prompt_version" VARCHAR(64) NOT NULL,
    "schema_version" VARCHAR(64) NOT NULL,
    "rubric_version" VARCHAR(64) NOT NULL,
    "structured_result_json" JSONB NOT NULL,
    "ai_suggested_score" DECIMAL(6,2) NOT NULL,
    "server_score" DECIMAL(6,2) NOT NULL,
    "summary" VARCHAR(2000),
    "requires_review" BOOLEAN NOT NULL DEFAULT false,
    "review_reasons_json" JSONB NOT NULL DEFAULT '[]',
    "provider_usage_json" JSONB,
    "latency_ms" INTEGER,
    "request_id" VARCHAR(160),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "training_answer_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_score_components" (
    "id" UUID NOT NULL,
    "evaluation_id" UUID NOT NULL,
    "criterion_id" UUID,
    "fact_id" UUID,
    "component_key" VARCHAR(160) NOT NULL,
    "title" VARCHAR(240),
    "awarded_points" DECIMAL(6,2) NOT NULL,
    "max_points" DECIMAL(6,2) NOT NULL,
    "fact_verdict" "training_fact_verdict",
    "evidence_json" JSONB,
    "penalty_points" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "training_score_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_result_reviews" (
    "id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "reviewer_id" UUID NOT NULL,
    "review_number" INTEGER NOT NULL DEFAULT 1,
    "previous_final_score" DECIMAL(6,2),
    "admin_score" DECIMAL(6,2),
    "final_score" DECIMAL(6,2) NOT NULL,
    "decision" "training_review_status" NOT NULL,
    "comment" VARCHAR(2000) NOT NULL,
    "unsupported_claims_decisions_json" JSONB NOT NULL DEFAULT '[]',
    "reviewed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "training_result_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_processed_updates" (
    "id" UUID NOT NULL,
    "update_id" BIGINT NOT NULL,
    "status" "training_processed_update_status" NOT NULL DEFAULT 'received',
    "update_type" VARCHAR(64),
    "payload_hash" VARCHAR(128),
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "error_code" VARCHAR(120),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "training_processed_updates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_jobs" (
    "id" UUID NOT NULL,
    "kind" "training_job_kind" NOT NULL,
    "status" "training_job_status" NOT NULL DEFAULT 'pending',
    "payload_json" JSONB NOT NULL,
    "idempotency_key" VARCHAR(160) NOT NULL,
    "run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "lock_owner" VARCHAR(160),
    "locked_at" TIMESTAMP(3),
    "heartbeat_at" TIMESTAMP(3),
    "last_error_code" VARCHAR(120),
    "last_error_message" VARCHAR(2000),
    "error_details_json" JSONB,
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "training_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "training_projects_slug_key" ON "training_projects"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "training_projects_active_version_id_key" ON "training_projects"("active_version_id");

-- CreateIndex
CREATE INDEX "training_projects_real_estate_object_id_idx" ON "training_projects"("real_estate_object_id");

-- CreateIndex
CREATE INDEX "training_projects_status_sort_order_idx" ON "training_projects"("status", "sort_order");

-- CreateIndex
CREATE INDEX "training_projects_available_from_deadline_at_idx" ON "training_projects"("available_from", "deadline_at");

-- CreateIndex
CREATE INDEX "training_project_versions_project_id_status_idx" ON "training_project_versions"("project_id", "status");

-- CreateIndex
CREATE INDEX "training_project_versions_published_by_id_idx" ON "training_project_versions"("published_by_id");

-- CreateIndex
CREATE INDEX "training_project_versions_published_at_idx" ON "training_project_versions"("published_at");

-- CreateIndex
CREATE UNIQUE INDEX "training_project_versions_project_id_version_number_key" ON "training_project_versions"("project_id", "version_number");

-- CreateIndex
CREATE INDEX "training_questions_project_version_id_type_is_active_idx" ON "training_questions"("project_version_id", "type", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "training_questions_project_version_id_type_position_key" ON "training_questions"("project_version_id", "type", "position");

-- CreateIndex
CREATE INDEX "training_facts_project_version_id_topic_code_idx" ON "training_facts"("project_version_id", "topic_code");

-- CreateIndex
CREATE INDEX "training_facts_source_document_id_idx" ON "training_facts"("source_document_id");

-- CreateIndex
CREATE UNIQUE INDEX "training_facts_project_version_id_code_key" ON "training_facts"("project_version_id", "code");

-- CreateIndex
CREATE INDEX "training_question_fact_links_fact_id_idx" ON "training_question_fact_links"("fact_id");

-- CreateIndex
CREATE INDEX "training_evaluation_criteria_project_version_id_question_ty_idx" ON "training_evaluation_criteria"("project_version_id", "question_type");

-- CreateIndex
CREATE UNIQUE INDEX "training_criteria_version_type_code_key" ON "training_evaluation_criteria"("project_version_id", "question_type", "code");

-- CreateIndex
CREATE UNIQUE INDEX "training_criteria_version_type_order_key" ON "training_evaluation_criteria"("project_version_id", "question_type", "sort_order");

-- CreateIndex
CREATE INDEX "training_source_documents_file_id_idx" ON "training_source_documents"("file_id");

-- CreateIndex
CREATE INDEX "training_source_documents_project_version_id_extraction_sta_idx" ON "training_source_documents"("project_version_id", "extraction_status");

-- CreateIndex
CREATE UNIQUE INDEX "training_source_documents_project_version_id_file_id_key" ON "training_source_documents"("project_version_id", "file_id");

-- CreateIndex
CREATE UNIQUE INDEX "training_source_documents_project_version_id_checksum_key" ON "training_source_documents"("project_version_id", "checksum");

-- CreateIndex
CREATE UNIQUE INDEX "training_telegram_accounts_user_id_key" ON "training_telegram_accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "training_telegram_accounts_telegram_user_id_key" ON "training_telegram_accounts"("telegram_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "training_telegram_accounts_chat_id_key" ON "training_telegram_accounts"("chat_id");

-- CreateIndex
CREATE INDEX "training_telegram_accounts_revoked_at_idx" ON "training_telegram_accounts"("revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "training_link_tokens_token_hash_key" ON "training_link_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "training_link_tokens_user_id_expires_at_idx" ON "training_link_tokens"("user_id", "expires_at");

-- CreateIndex
CREATE INDEX "training_link_tokens_project_id_idx" ON "training_link_tokens"("project_id");

-- CreateIndex
CREATE INDEX "training_link_tokens_expires_at_idx" ON "training_link_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "training_attempts_user_id_status_idx" ON "training_attempts"("user_id", "status");

-- CreateIndex
CREATE INDEX "training_attempts_project_id_status_idx" ON "training_attempts"("project_id", "status");

-- CreateIndex
CREATE INDEX "training_attempts_project_version_id_idx" ON "training_attempts"("project_version_id");

-- CreateIndex
CREATE INDEX "training_attempts_completed_at_idx" ON "training_attempts"("completed_at");

-- CreateIndex
CREATE INDEX "training_attempts_review_status_completed_at_idx" ON "training_attempts"("review_status", "completed_at");

-- CreateIndex
CREATE UNIQUE INDEX "training_attempts_user_id_project_id_attempt_number_key" ON "training_attempts"("user_id", "project_id", "attempt_number");

-- CreateIndex
CREATE INDEX "training_attempt_questions_question_id_idx" ON "training_attempt_questions"("question_id");

-- CreateIndex
CREATE INDEX "training_attempt_questions_attempt_id_status_idx" ON "training_attempt_questions"("attempt_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "training_attempt_questions_attempt_id_sequence_key" ON "training_attempt_questions"("attempt_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "training_attempt_questions_attempt_id_question_id_key" ON "training_attempt_questions"("attempt_id", "question_id");

-- CreateIndex
CREATE UNIQUE INDEX "training_answers_attempt_question_id_key" ON "training_answers"("attempt_question_id");

-- CreateIndex
CREATE INDEX "training_answers_status_updated_at_idx" ON "training_answers"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "training_voice_segments_telegram_update_id_key" ON "training_voice_segments"("telegram_update_id");

-- CreateIndex
CREATE INDEX "training_voice_segments_answer_id_received_at_idx" ON "training_voice_segments"("answer_id", "received_at");

-- CreateIndex
CREATE INDEX "training_voice_segments_file_unique_id_idx" ON "training_voice_segments"("file_unique_id");

-- CreateIndex
CREATE UNIQUE INDEX "training_voice_segments_answer_id_segment_index_key" ON "training_voice_segments"("answer_id", "segment_index");

-- CreateIndex
CREATE UNIQUE INDEX "training_voice_segments_telegram_chat_id_telegram_message_i_key" ON "training_voice_segments"("telegram_chat_id", "telegram_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "training_voice_segments_original_storage_bucket_original_st_key" ON "training_voice_segments"("original_storage_bucket", "original_storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "training_answer_evaluations_request_id_key" ON "training_answer_evaluations"("request_id");

-- CreateIndex
CREATE INDEX "training_answer_evaluations_answer_id_created_at_idx" ON "training_answer_evaluations"("answer_id", "created_at");

-- CreateIndex
CREATE INDEX "training_answer_evaluations_requires_review_idx" ON "training_answer_evaluations"("requires_review");

-- CreateIndex
CREATE UNIQUE INDEX "training_answer_evaluations_answer_id_evaluation_number_key" ON "training_answer_evaluations"("answer_id", "evaluation_number");

-- CreateIndex
CREATE INDEX "training_score_components_criterion_id_idx" ON "training_score_components"("criterion_id");

-- CreateIndex
CREATE INDEX "training_score_components_fact_id_idx" ON "training_score_components"("fact_id");

-- CreateIndex
CREATE UNIQUE INDEX "training_score_components_evaluation_id_component_key_key" ON "training_score_components"("evaluation_id", "component_key");

-- CreateIndex
CREATE INDEX "training_result_reviews_reviewer_id_reviewed_at_idx" ON "training_result_reviews"("reviewer_id", "reviewed_at");

-- CreateIndex
CREATE INDEX "training_result_reviews_attempt_id_reviewed_at_idx" ON "training_result_reviews"("attempt_id", "reviewed_at");

-- CreateIndex
CREATE UNIQUE INDEX "training_result_reviews_attempt_id_review_number_key" ON "training_result_reviews"("attempt_id", "review_number");

-- CreateIndex
CREATE UNIQUE INDEX "training_processed_updates_update_id_key" ON "training_processed_updates"("update_id");

-- CreateIndex
CREATE INDEX "training_processed_updates_status_received_at_idx" ON "training_processed_updates"("status", "received_at");

-- CreateIndex
CREATE INDEX "training_processed_updates_processed_at_idx" ON "training_processed_updates"("processed_at");

-- CreateIndex
CREATE UNIQUE INDEX "training_jobs_idempotency_key_key" ON "training_jobs"("idempotency_key");

-- CreateIndex
CREATE INDEX "training_jobs_status_run_at_created_at_idx" ON "training_jobs"("status", "run_at", "created_at");

-- CreateIndex
CREATE INDEX "training_jobs_locked_at_idx" ON "training_jobs"("locked_at");

-- CreateIndex
CREATE INDEX "training_jobs_heartbeat_at_idx" ON "training_jobs"("heartbeat_at");

-- AddForeignKey
ALTER TABLE "training_projects" ADD CONSTRAINT "training_projects_real_estate_object_id_fkey" FOREIGN KEY ("real_estate_object_id") REFERENCES "real_estate_objects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_projects" ADD CONSTRAINT "training_projects_active_version_id_fkey" FOREIGN KEY ("active_version_id") REFERENCES "training_project_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_project_versions" ADD CONSTRAINT "training_project_versions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "training_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_project_versions" ADD CONSTRAINT "training_project_versions_published_by_id_fkey" FOREIGN KEY ("published_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_questions" ADD CONSTRAINT "training_questions_project_version_id_fkey" FOREIGN KEY ("project_version_id") REFERENCES "training_project_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_facts" ADD CONSTRAINT "training_facts_project_version_id_fkey" FOREIGN KEY ("project_version_id") REFERENCES "training_project_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_facts" ADD CONSTRAINT "training_facts_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "training_source_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_question_fact_links" ADD CONSTRAINT "training_question_fact_links_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "training_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_question_fact_links" ADD CONSTRAINT "training_question_fact_links_fact_id_fkey" FOREIGN KEY ("fact_id") REFERENCES "training_facts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_evaluation_criteria" ADD CONSTRAINT "training_evaluation_criteria_project_version_id_fkey" FOREIGN KEY ("project_version_id") REFERENCES "training_project_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_source_documents" ADD CONSTRAINT "training_source_documents_project_version_id_fkey" FOREIGN KEY ("project_version_id") REFERENCES "training_project_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_source_documents" ADD CONSTRAINT "training_source_documents_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_telegram_accounts" ADD CONSTRAINT "training_telegram_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_link_tokens" ADD CONSTRAINT "training_link_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_link_tokens" ADD CONSTRAINT "training_link_tokens_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "training_projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_attempts" ADD CONSTRAINT "training_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_attempts" ADD CONSTRAINT "training_attempts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "training_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_attempts" ADD CONSTRAINT "training_attempts_project_version_id_fkey" FOREIGN KEY ("project_version_id") REFERENCES "training_project_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_attempt_questions" ADD CONSTRAINT "training_attempt_questions_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "training_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_attempt_questions" ADD CONSTRAINT "training_attempt_questions_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "training_questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_answers" ADD CONSTRAINT "training_answers_attempt_question_id_fkey" FOREIGN KEY ("attempt_question_id") REFERENCES "training_attempt_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_voice_segments" ADD CONSTRAINT "training_voice_segments_answer_id_fkey" FOREIGN KEY ("answer_id") REFERENCES "training_answers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_answer_evaluations" ADD CONSTRAINT "training_answer_evaluations_answer_id_fkey" FOREIGN KEY ("answer_id") REFERENCES "training_answers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_score_components" ADD CONSTRAINT "training_score_components_evaluation_id_fkey" FOREIGN KEY ("evaluation_id") REFERENCES "training_answer_evaluations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_score_components" ADD CONSTRAINT "training_score_components_criterion_id_fkey" FOREIGN KEY ("criterion_id") REFERENCES "training_evaluation_criteria"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_score_components" ADD CONSTRAINT "training_score_components_fact_id_fkey" FOREIGN KEY ("fact_id") REFERENCES "training_facts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_result_reviews" ADD CONSTRAINT "training_result_reviews_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "training_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_result_reviews" ADD CONSTRAINT "training_result_reviews_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Domain checks
ALTER TABLE "training_projects"
  ADD CONSTRAINT "training_projects_sort_order_check" CHECK ("sort_order" >= 0),
  ADD CONSTRAINT "training_projects_availability_window_check" CHECK (
    "available_from" IS NULL OR "deadline_at" IS NULL OR "deadline_at" > "available_from"
  ),
  ADD CONSTRAINT "training_projects_archive_state_check" CHECK (
    ("status" = 'archived' AND "archived_at" IS NOT NULL)
    OR ("status" <> 'archived' AND "archived_at" IS NULL)
  );

ALTER TABLE "training_project_versions"
  ADD CONSTRAINT "training_project_versions_number_check" CHECK ("version_number" > 0),
  ADD CONSTRAINT "training_project_versions_pass_score_check" CHECK ("pass_score" BETWEEN 0 AND 100),
  ADD CONSTRAINT "training_project_versions_attempt_limit_check" CHECK ("attempt_limit" > 0),
  ADD CONSTRAINT "training_project_versions_cooldown_check" CHECK ("cooldown_minutes" BETWEEN 60 AND 1440),
  ADD CONSTRAINT "training_project_versions_time_limit_check" CHECK ("total_time_limit_seconds" BETWEEN 300 AND 420),
  ADD CONSTRAINT "training_project_versions_finish_grace_check" CHECK ("finish_grace_seconds" >= 0),
  ADD CONSTRAINT "training_project_versions_score_caps_check" CHECK (
    "main_max_score" = 55 AND "follow_up_max_score" = 15
  ),
  ADD CONSTRAINT "training_project_versions_publish_state_check" CHECK (
    ("status" = 'draft' AND "published_at" IS NULL)
    OR ("status" IN ('published', 'superseded') AND "published_at" IS NOT NULL)
  );

ALTER TABLE "training_questions"
  ADD CONSTRAINT "training_questions_position_check" CHECK (
    ("type" = 'main' AND "position" = 1)
    OR ("type" = 'follow_up' AND "position" BETWEEN 1 AND 10)
  ),
  ADD CONSTRAINT "training_questions_max_score_check" CHECK (
    ("type" = 'main' AND "max_score" = 55)
    OR ("type" = 'follow_up' AND "max_score" = 15)
  );

ALTER TABLE "training_facts"
  ADD CONSTRAINT "training_facts_importance_check" CHECK ("importance" > 0);

ALTER TABLE "training_question_fact_links"
  ADD CONSTRAINT "training_question_fact_links_weight_check" CHECK ("weight" IS NULL OR "weight" > 0);

ALTER TABLE "training_evaluation_criteria"
  ADD CONSTRAINT "training_evaluation_criteria_max_points_check" CHECK ("max_points" >= 0),
  ADD CONSTRAINT "training_evaluation_criteria_sort_order_check" CHECK ("sort_order" >= 0);

ALTER TABLE "training_source_documents"
  ADD CONSTRAINT "training_source_documents_checksum_check" CHECK (length(btrim("checksum")) > 0);

ALTER TABLE "training_telegram_accounts"
  ADD CONSTRAINT "training_telegram_accounts_ids_check" CHECK (
    "telegram_user_id" > 0 AND "chat_id" > 0
  ),
  ADD CONSTRAINT "training_telegram_accounts_revoke_time_check" CHECK (
    "revoked_at" IS NULL OR "revoked_at" >= "linked_at"
  );

ALTER TABLE "training_link_tokens"
  ADD CONSTRAINT "training_link_tokens_expiry_check" CHECK ("expires_at" > "created_at"),
  ADD CONSTRAINT "training_link_tokens_usage_time_check" CHECK (
    ("used_at" IS NULL OR "used_at" >= "created_at")
    AND ("revoked_at" IS NULL OR "revoked_at" >= "created_at")
  );

ALTER TABLE "training_attempts"
  ADD CONSTRAINT "training_attempts_number_check" CHECK ("attempt_number" > 0),
  ADD CONSTRAINT "training_attempts_expiry_check" CHECK (
    "expires_at" > "started_at" AND "grace_expires_at" >= "expires_at"
  ),
  ADD CONSTRAINT "training_attempts_completion_time_check" CHECK (
    "completed_at" IS NULL OR "completed_at" >= "started_at"
  ),
  ADD CONSTRAINT "training_attempts_scores_check" CHECK (
    ("ai_score" IS NULL OR "ai_score" BETWEEN 0 AND 100)
    AND ("server_score" IS NULL OR "server_score" BETWEEN 0 AND 100)
    AND ("admin_score" IS NULL OR "admin_score" BETWEEN 0 AND 100)
    AND ("final_score" IS NULL OR "final_score" BETWEEN 0 AND 100)
  ),
  ADD CONSTRAINT "training_attempts_duration_check" CHECK (
    "total_duration_seconds" IS NULL OR "total_duration_seconds" >= 0
  );

ALTER TABLE "training_attempt_questions"
  ADD CONSTRAINT "training_attempt_questions_sequence_check" CHECK ("sequence" BETWEEN 1 AND 4),
  ADD CONSTRAINT "training_attempt_questions_durations_check" CHECK (
    ("response_time_seconds" IS NULL OR "response_time_seconds" >= 0)
    AND ("answer_duration_seconds" IS NULL OR "answer_duration_seconds" >= 0)
    AND ("selection_random_index" IS NULL OR "selection_random_index" >= 0)
  );

ALTER TABLE "training_answers"
  ADD CONSTRAINT "training_answers_processing_time_check" CHECK (
    "processing_finished_at" IS NULL
    OR "processing_started_at" IS NULL
    OR "processing_finished_at" >= "processing_started_at"
  );

ALTER TABLE "training_voice_segments"
  ADD CONSTRAINT "training_voice_segments_index_check" CHECK ("segment_index" > 0),
  ADD CONSTRAINT "training_voice_segments_telegram_ids_check" CHECK (
    "telegram_update_id" >= 0 AND "telegram_message_id" > 0 AND "telegram_chat_id" > 0
  ),
  ADD CONSTRAINT "training_voice_segments_media_check" CHECK (
    ("size_bytes" IS NULL OR "size_bytes" >= 0)
    AND ("duration_seconds" IS NULL OR "duration_seconds" >= 0)
  ),
  ADD CONSTRAINT "training_voice_segments_private_storage_check" CHECK (
    ("original_storage_bucket" IS NULL AND "original_storage_key" IS NULL)
    OR (
      length(btrim("original_storage_bucket")) > 0
      AND length(btrim("original_storage_key")) > 0
    )
  );

ALTER TABLE "training_answer_evaluations"
  ADD CONSTRAINT "training_answer_evaluations_number_check" CHECK ("evaluation_number" > 0),
  ADD CONSTRAINT "training_answer_evaluations_scores_check" CHECK (
    "ai_suggested_score" BETWEEN 0 AND 100 AND "server_score" BETWEEN 0 AND 100
  ),
  ADD CONSTRAINT "training_answer_evaluations_latency_check" CHECK ("latency_ms" IS NULL OR "latency_ms" >= 0),
  ADD CONSTRAINT "training_answer_evaluations_time_check" CHECK (
    "completed_at" IS NULL OR "started_at" IS NULL OR "completed_at" >= "started_at"
  );

ALTER TABLE "training_score_components"
  ADD CONSTRAINT "training_score_components_points_check" CHECK (
    "max_points" >= 0
    AND "awarded_points" >= 0
    AND "awarded_points" <= "max_points"
    AND "penalty_points" >= 0
  );

ALTER TABLE "training_result_reviews"
  ADD CONSTRAINT "training_result_reviews_number_check" CHECK ("review_number" > 0),
  ADD CONSTRAINT "training_result_reviews_scores_check" CHECK (
    ("previous_final_score" IS NULL OR "previous_final_score" BETWEEN 0 AND 100)
    AND ("admin_score" IS NULL OR "admin_score" BETWEEN 0 AND 100)
    AND "final_score" BETWEEN 0 AND 100
  ),
  ADD CONSTRAINT "training_result_reviews_decision_check" CHECK (
    "decision" IN ('approved', 'overridden')
  ),
  ADD CONSTRAINT "training_result_reviews_comment_check" CHECK (length(btrim("comment")) > 0);

ALTER TABLE "training_processed_updates"
  ADD CONSTRAINT "training_processed_updates_id_check" CHECK ("update_id" >= 0),
  ADD CONSTRAINT "training_processed_updates_time_check" CHECK (
    "processed_at" IS NULL OR "processed_at" >= "received_at"
  );

ALTER TABLE "training_jobs"
  ADD CONSTRAINT "training_jobs_attempts_check" CHECK (
    "attempts" >= 0 AND "max_attempts" > 0 AND "attempts" <= "max_attempts"
  ),
  ADD CONSTRAINT "training_jobs_lock_state_check" CHECK (
    ("locked_at" IS NULL AND "lock_owner" IS NULL)
    OR ("locked_at" IS NOT NULL AND length(btrim("lock_owner")) > 0)
  );

-- Partial uniqueness for active domain state.
CREATE UNIQUE INDEX "training_project_versions_one_draft_per_project_key"
  ON "training_project_versions" ("project_id")
  WHERE "status" = 'draft';

CREATE UNIQUE INDEX "training_questions_one_active_main_per_version_key"
  ON "training_questions" ("project_version_id")
  WHERE "type" = 'main' AND "is_active" = true;

CREATE UNIQUE INDEX "training_attempts_one_active_per_user_project_key"
  ON "training_attempts" ("user_id", "project_id")
  WHERE "status" IN (
    'started',
    'awaiting_main',
    'processing_main',
    'awaiting_follow_up',
    'processing_follow_up',
    'finalizing'
  );

CREATE INDEX "training_jobs_claim_idx"
  ON "training_jobs" ("run_at", "created_at")
  WHERE "status" = 'pending';

-- Cross-relation integrity.
CREATE FUNCTION "training_validate_active_version"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  version_project_id UUID;
  version_status "training_version_status";
BEGIN
  IF NEW."active_version_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "project_id", "status"
  INTO version_project_id, version_status
  FROM "training_project_versions"
  WHERE "id" = NEW."active_version_id";

  IF version_project_id IS DISTINCT FROM NEW."id" THEN
    RAISE EXCEPTION 'Active training version must belong to its project';
  END IF;

  IF version_status <> 'published' THEN
    RAISE EXCEPTION 'Active training version must be published';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "training_projects_validate_active_version"
BEFORE INSERT OR UPDATE OF "active_version_id"
ON "training_projects"
FOR EACH ROW
EXECUTE FUNCTION "training_validate_active_version"();

CREATE FUNCTION "training_validate_question_fact_version"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  question_version_id UUID;
  fact_version_id UUID;
BEGIN
  SELECT "project_version_id"
  INTO question_version_id
  FROM "training_questions"
  WHERE "id" = NEW."question_id";

  SELECT "project_version_id"
  INTO fact_version_id
  FROM "training_facts"
  WHERE "id" = NEW."fact_id";

  IF question_version_id IS DISTINCT FROM fact_version_id THEN
    RAISE EXCEPTION 'Training question and fact must belong to the same version';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "training_question_fact_links_validate_version"
BEFORE INSERT OR UPDATE
ON "training_question_fact_links"
FOR EACH ROW
EXECUTE FUNCTION "training_validate_question_fact_version"();

CREATE FUNCTION "training_validate_attempt_version"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  version_project_id UUID;
  version_status "training_version_status";
BEGIN
  SELECT "project_id", "status"
  INTO version_project_id, version_status
  FROM "training_project_versions"
  WHERE "id" = NEW."project_version_id";

  IF version_project_id IS DISTINCT FROM NEW."project_id" THEN
    RAISE EXCEPTION 'Training attempt version must belong to its project';
  END IF;

  IF version_status NOT IN ('published', 'superseded') THEN
    RAISE EXCEPTION 'Training attempt must be pinned to a published version';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "training_attempts_validate_version"
BEFORE INSERT OR UPDATE OF "project_id", "project_version_id"
ON "training_attempts"
FOR EACH ROW
EXECUTE FUNCTION "training_validate_attempt_version"();

CREATE FUNCTION "training_validate_attempt_question_version"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  attempt_version_id UUID;
  question_version_id UUID;
BEGIN
  SELECT "project_version_id"
  INTO attempt_version_id
  FROM "training_attempts"
  WHERE "id" = NEW."attempt_id";

  SELECT "project_version_id"
  INTO question_version_id
  FROM "training_questions"
  WHERE "id" = NEW."question_id";

  IF attempt_version_id IS DISTINCT FROM question_version_id THEN
    RAISE EXCEPTION 'Training attempt question must belong to the pinned version';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "training_attempt_questions_validate_version"
BEFORE INSERT OR UPDATE OF "attempt_id", "question_id"
ON "training_attempt_questions"
FOR EACH ROW
EXECUTE FUNCTION "training_validate_attempt_question_version"();

-- Published and superseded content is immutable. Only the status transition
-- from published to superseded may update a published version row.
CREATE FUNCTION "training_prevent_published_version_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" NOT IN ('published', 'superseded') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Published training versions are immutable';
  END IF;

  IF OLD."status" = 'published'
    AND NEW."status" = 'superseded'
    AND (to_jsonb(NEW) - ARRAY['status', 'updated_at'])
      = (to_jsonb(OLD) - ARRAY['status', 'updated_at'])
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Published training versions are immutable';
END;
$$;

CREATE TRIGGER "training_project_versions_prevent_published_mutation"
BEFORE UPDATE OR DELETE
ON "training_project_versions"
FOR EACH ROW
EXECUTE FUNCTION "training_prevent_published_version_mutation"();

CREATE FUNCTION "training_prevent_published_content_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  old_version_status "training_version_status";
  new_version_status "training_version_status";
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT "status"
    INTO old_version_status
    FROM "training_project_versions"
    WHERE "id" = OLD."project_version_id";

    IF old_version_status IN ('published', 'superseded') THEN
      RAISE EXCEPTION 'Published training content is immutable';
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT "status"
    INTO new_version_status
    FROM "training_project_versions"
    WHERE "id" = NEW."project_version_id";

    IF new_version_status IN ('published', 'superseded') THEN
      RAISE EXCEPTION 'Published training content is immutable';
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "training_questions_prevent_published_mutation"
BEFORE INSERT OR UPDATE OR DELETE
ON "training_questions"
FOR EACH ROW
EXECUTE FUNCTION "training_prevent_published_content_mutation"();

CREATE TRIGGER "training_facts_prevent_published_mutation"
BEFORE INSERT OR UPDATE OR DELETE
ON "training_facts"
FOR EACH ROW
EXECUTE FUNCTION "training_prevent_published_content_mutation"();

CREATE TRIGGER "training_criteria_prevent_published_mutation"
BEFORE INSERT OR UPDATE OR DELETE
ON "training_evaluation_criteria"
FOR EACH ROW
EXECUTE FUNCTION "training_prevent_published_content_mutation"();

CREATE TRIGGER "training_documents_prevent_published_mutation"
BEFORE INSERT OR UPDATE OR DELETE
ON "training_source_documents"
FOR EACH ROW
EXECUTE FUNCTION "training_prevent_published_content_mutation"();

CREATE FUNCTION "training_prevent_published_fact_link_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  old_version_status "training_version_status";
  new_version_status "training_version_status";
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT v."status"
    INTO old_version_status
    FROM "training_questions" q
    JOIN "training_project_versions" v ON v."id" = q."project_version_id"
    WHERE q."id" = OLD."question_id";

    IF old_version_status IN ('published', 'superseded') THEN
      RAISE EXCEPTION 'Published training content is immutable';
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT v."status"
    INTO new_version_status
    FROM "training_questions" q
    JOIN "training_project_versions" v ON v."id" = q."project_version_id"
    WHERE q."id" = NEW."question_id";

    IF new_version_status IN ('published', 'superseded') THEN
      RAISE EXCEPTION 'Published training content is immutable';
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "training_question_fact_links_prevent_published_mutation"
BEFORE INSERT OR UPDATE OR DELETE
ON "training_question_fact_links"
FOR EACH ROW
EXECUTE FUNCTION "training_prevent_published_fact_link_mutation"();
