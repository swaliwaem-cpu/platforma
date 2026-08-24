CREATE TYPE "assistant_message_role" AS ENUM ('user', 'assistant');
CREATE TYPE "assistant_run_status" AS ENUM ('pending', 'running', 'completed', 'failed');

CREATE TABLE "assistant_conversations" (
  "id" UUID NOT NULL,
  "owner_user_id" UUID NOT NULL,
  "title" VARCHAR(160) NOT NULL DEFAULT 'Новый разговор',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "assistant_conversations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "assistant_conversations_title_check" CHECK (btrim("title") <> '')
);

CREATE TABLE "assistant_messages" (
  "id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "role" "assistant_message_role" NOT NULL,
  "content" TEXT NOT NULL,
  "context_json" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "assistant_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "assistant_messages_content_check" CHECK (btrim("content") <> '')
);

CREATE TABLE "assistant_runs" (
  "id" UUID NOT NULL,
  "owner_user_id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "user_message_id" UUID NOT NULL,
  "assistant_message_id" UUID,
  "idempotency_key" UUID NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "status" "assistant_run_status" NOT NULL DEFAULT 'pending',
  "progress_json" JSONB NOT NULL DEFAULT '[]',
  "error_code" VARCHAR(120),
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "assistant_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "assistant_runs_state_check" CHECK (
    ("status" = 'pending' AND "started_at" IS NULL AND "completed_at" IS NULL AND "error_code" IS NULL) OR
    ("status" = 'running' AND "started_at" IS NOT NULL AND "completed_at" IS NULL AND "error_code" IS NULL) OR
    ("status" = 'completed' AND "started_at" IS NOT NULL AND "completed_at" IS NOT NULL AND "error_code" IS NULL AND "assistant_message_id" IS NOT NULL) OR
    ("status" = 'failed' AND "started_at" IS NOT NULL AND "completed_at" IS NOT NULL AND "error_code" IS NOT NULL)
  )
);

CREATE INDEX "assistant_conversations_owner_user_id_updated_at_idx"
  ON "assistant_conversations"("owner_user_id", "updated_at");
CREATE INDEX "assistant_messages_conversation_id_created_at_idx"
  ON "assistant_messages"("conversation_id", "created_at");
CREATE UNIQUE INDEX "assistant_runs_user_message_id_key"
  ON "assistant_runs"("user_message_id");
CREATE UNIQUE INDEX "assistant_runs_assistant_message_id_key"
  ON "assistant_runs"("assistant_message_id");
CREATE UNIQUE INDEX "assistant_runs_owner_user_id_idempotency_key_key"
  ON "assistant_runs"("owner_user_id", "idempotency_key");
CREATE INDEX "assistant_runs_conversation_id_created_at_idx"
  ON "assistant_runs"("conversation_id", "created_at");
CREATE INDEX "assistant_runs_owner_user_id_created_at_idx"
  ON "assistant_runs"("owner_user_id", "created_at");
CREATE INDEX "assistant_runs_status_updated_at_idx"
  ON "assistant_runs"("status", "updated_at");

ALTER TABLE "assistant_conversations"
  ADD CONSTRAINT "assistant_conversations_owner_user_id_fkey"
    FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "assistant_messages"
  ADD CONSTRAINT "assistant_messages_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "assistant_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "assistant_runs"
  ADD CONSTRAINT "assistant_runs_owner_user_id_fkey"
    FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "assistant_runs_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "assistant_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "assistant_runs_user_message_id_fkey"
    FOREIGN KEY ("user_message_id") REFERENCES "assistant_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "assistant_runs_assistant_message_id_fkey"
    FOREIGN KEY ("assistant_message_id") REFERENCES "assistant_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
