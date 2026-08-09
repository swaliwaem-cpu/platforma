CREATE TABLE "training_operations_job_retries" (
  "id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "actor_user_id" UUID NOT NULL,
  "idempotency_key" VARCHAR(128) NOT NULL,
  "request_payload_hash" CHAR(64) NOT NULL,
  "previous_status" "training_job_status" NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "training_operations_job_retries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "training_operations_job_retries_payload_hash_sha256"
    CHECK ("request_payload_hash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "uq_training_ops_retry_key"
  ON "training_operations_job_retries"(
    "job_id",
    "actor_user_id",
    "idempotency_key"
  );

CREATE INDEX "training_operations_job_retries_job_id_created_at_idx"
  ON "training_operations_job_retries"("job_id", "created_at");

CREATE INDEX "training_operations_job_retries_actor_user_id_created_at_idx"
  ON "training_operations_job_retries"("actor_user_id", "created_at");

ALTER TABLE "training_operations_job_retries"
  ADD CONSTRAINT "training_operations_job_retries_job_id_fkey"
  FOREIGN KEY ("job_id")
  REFERENCES "training_jobs"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

ALTER TABLE "training_operations_job_retries"
  ADD CONSTRAINT "training_operations_job_retries_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id")
  REFERENCES "users"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;
