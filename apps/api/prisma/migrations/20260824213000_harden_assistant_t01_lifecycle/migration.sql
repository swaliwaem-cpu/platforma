ALTER TABLE "assistant_conversations"
  ADD COLUMN "creation_key" UUID;

UPDATE "assistant_conversations"
SET "creation_key" = "id"
WHERE "creation_key" IS NULL;

ALTER TABLE "assistant_conversations"
  ALTER COLUMN "creation_key" SET NOT NULL;

CREATE UNIQUE INDEX "assistant_conversations_owner_user_id_creation_key_key"
  ON "assistant_conversations"("owner_user_id", "creation_key");

ALTER TABLE "assistant_runs"
  ADD COLUMN "lease_owner" VARCHAR(100),
  ADD COLUMN "lease_expires_at" TIMESTAMP(3);

UPDATE "assistant_runs"
SET
  "status" = 'pending',
  "progress_json" = '[]',
  "started_at" = NULL
WHERE "status" = 'running';

ALTER TABLE "assistant_runs"
  DROP CONSTRAINT "assistant_runs_state_check",
  ADD CONSTRAINT "assistant_runs_state_check" CHECK (
    ("status" = 'pending' AND "started_at" IS NULL AND "completed_at" IS NULL AND "error_code" IS NULL AND "assistant_message_id" IS NULL AND "lease_owner" IS NULL AND "lease_expires_at" IS NULL) OR
    ("status" = 'running' AND "started_at" IS NOT NULL AND "completed_at" IS NULL AND "error_code" IS NULL AND "assistant_message_id" IS NULL AND "lease_owner" IS NOT NULL AND "lease_expires_at" IS NOT NULL) OR
    ("status" = 'completed' AND "started_at" IS NOT NULL AND "completed_at" IS NOT NULL AND "error_code" IS NULL AND "assistant_message_id" IS NOT NULL AND "lease_owner" IS NULL AND "lease_expires_at" IS NULL) OR
    ("status" = 'failed' AND "started_at" IS NOT NULL AND "completed_at" IS NOT NULL AND "error_code" IS NOT NULL AND "assistant_message_id" IS NULL AND "lease_owner" IS NULL AND "lease_expires_at" IS NULL)
  );

ALTER TABLE "assistant_conversations"
  DROP CONSTRAINT "assistant_conversations_owner_user_id_fkey",
  ADD CONSTRAINT "assistant_conversations_owner_user_id_fkey"
    FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "assistant_messages"
  DROP CONSTRAINT "assistant_messages_conversation_id_fkey",
  ADD CONSTRAINT "assistant_messages_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "assistant_conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "assistant_runs"
  DROP CONSTRAINT "assistant_runs_owner_user_id_fkey",
  DROP CONSTRAINT "assistant_runs_conversation_id_fkey",
  DROP CONSTRAINT "assistant_runs_user_message_id_fkey",
  DROP CONSTRAINT "assistant_runs_assistant_message_id_fkey",
  ADD CONSTRAINT "assistant_runs_owner_user_id_fkey"
    FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "assistant_runs_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "assistant_conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "assistant_runs_user_message_id_fkey"
    FOREIGN KEY ("user_message_id") REFERENCES "assistant_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "assistant_runs_assistant_message_id_fkey"
    FOREIGN KEY ("assistant_message_id") REFERENCES "assistant_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
