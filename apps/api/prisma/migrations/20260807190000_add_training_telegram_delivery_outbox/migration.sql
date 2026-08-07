CREATE TYPE "training_telegram_outbox_event_type" AS ENUM (
  'answer_processed',
  'answer_failed',
  'attempt_state'
);

CREATE TYPE "training_telegram_outbox_status" AS ENUM (
  'pending',
  'processing',
  'sent',
  'failed'
);

CREATE TABLE "training_telegram_outbox" (
  "id" UUID NOT NULL,
  "event_type" "training_telegram_outbox_event_type" NOT NULL,
  "attempt_id" UUID NOT NULL,
  "answer_id" UUID,
  "deduplication_key" VARCHAR(160) NOT NULL,
  "status" "training_telegram_outbox_status" NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locked_at" TIMESTAMP(3),
  "locked_by" VARCHAR(160),
  "last_error_code" VARCHAR(64),
  "sent_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "training_telegram_outbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "training_telegram_outbox_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "training_telegram_outbox_event_reference_check" CHECK (
    ("event_type" IN ('answer_processed', 'answer_failed') AND "answer_id" IS NOT NULL)
    OR ("event_type" = 'attempt_state' AND "answer_id" IS NULL)
  ),
  CONSTRAINT "training_telegram_outbox_state_check" CHECK (
    (
      "status" = 'pending' AND
      "locked_at" IS NULL AND
      "locked_by" IS NULL AND
      "sent_at" IS NULL
    ) OR (
      "status" = 'processing' AND
      "locked_at" IS NOT NULL AND
      "locked_by" IS NOT NULL AND
      "sent_at" IS NULL
    ) OR (
      "status" = 'sent' AND
      "locked_at" IS NULL AND
      "locked_by" IS NULL AND
      "sent_at" IS NOT NULL
    ) OR (
      "status" = 'failed' AND
      "locked_at" IS NULL AND
      "locked_by" IS NULL AND
      "sent_at" IS NULL AND
      "last_error_code" IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX "training_telegram_outbox_deduplication_key_key"
  ON "training_telegram_outbox"("deduplication_key");

CREATE INDEX "training_telegram_outbox_pending_claim_idx"
  ON "training_telegram_outbox"("available_at", "created_at", "id")
  WHERE "status" = 'pending';

CREATE INDEX "training_telegram_outbox_processing_recovery_idx"
  ON "training_telegram_outbox"("locked_at", "created_at", "id")
  WHERE "status" = 'processing';

CREATE INDEX "training_telegram_outbox_attempt_id_idx"
  ON "training_telegram_outbox"("attempt_id");

CREATE INDEX "training_telegram_outbox_answer_id_idx"
  ON "training_telegram_outbox"("answer_id");

ALTER TABLE "training_telegram_outbox"
  ADD CONSTRAINT "training_telegram_outbox_attempt_id_fkey"
    FOREIGN KEY ("attempt_id") REFERENCES "training_attempts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "training_telegram_outbox_answer_id_fkey"
    FOREIGN KEY ("answer_id") REFERENCES "training_answers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
