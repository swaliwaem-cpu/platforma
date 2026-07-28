CREATE TYPE "training_policy_acceptance_source" AS ENUM (
  'platform',
  'telegram'
);

CREATE TABLE "training_policy_versions" (
  "id" UUID NOT NULL,
  "version" VARCHAR(64) NOT NULL,
  "title" VARCHAR(240) NOT NULL,
  "body" TEXT NOT NULL,
  "checksum" VARCHAR(64) NOT NULL,
  "effective_at" TIMESTAMP(3) NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT false,
  "approval_status" VARCHAR(64) NOT NULL,
  "created_by_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "training_policy_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "training_policy_versions_checksum_sha256"
    CHECK ("checksum" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "training_policy_versions_approval_status_allowed"
    CHECK ("approval_status" IN ('REQUIRES_MANAGER_APPROVAL', 'APPROVED'))
);

CREATE TABLE "training_policy_acceptances" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "policy_version_id" UUID NOT NULL,
  "source" "training_policy_acceptance_source" NOT NULL,
  "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "training_policy_acceptances_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "training_policy_acceptances_revoked_after_acceptance"
    CHECK ("revoked_at" IS NULL OR "revoked_at" >= "accepted_at")
);

CREATE TABLE "training_worker_heartbeats" (
  "id" UUID NOT NULL,
  "worker_kind" VARCHAR(64) NOT NULL,
  "instance_id" VARCHAR(160) NOT NULL,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata_json" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "training_worker_heartbeats_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "training_policy_versions_version_key"
  ON "training_policy_versions"("version");

CREATE UNIQUE INDEX "training_policy_versions_checksum_key"
  ON "training_policy_versions"("checksum");

CREATE UNIQUE INDEX "training_policy_versions_one_active_idx"
  ON "training_policy_versions"((1))
  WHERE "is_active" = true;

CREATE INDEX "training_policy_versions_is_active_effective_at_idx"
  ON "training_policy_versions"("is_active", "effective_at");

CREATE INDEX "training_policy_versions_created_by_id_idx"
  ON "training_policy_versions"("created_by_id");

CREATE UNIQUE INDEX "training_policy_acceptances_active_user_version_idx"
  ON "training_policy_acceptances"("user_id", "policy_version_id")
  WHERE "revoked_at" IS NULL;

CREATE INDEX "training_policy_acceptances_user_id_accepted_at_idx"
  ON "training_policy_acceptances"("user_id", "accepted_at");

CREATE INDEX "training_policy_acceptances_policy_version_id_accepted_at_idx"
  ON "training_policy_acceptances"("policy_version_id", "accepted_at");

CREATE INDEX "training_policy_acceptances_revoked_at_idx"
  ON "training_policy_acceptances"("revoked_at");

CREATE UNIQUE INDEX "training_worker_heartbeats_instance_id_key"
  ON "training_worker_heartbeats"("instance_id");

CREATE INDEX "training_worker_heartbeats_worker_kind_last_seen_at_idx"
  ON "training_worker_heartbeats"("worker_kind", "last_seen_at");

ALTER TABLE "training_policy_versions"
  ADD CONSTRAINT "training_policy_versions_created_by_id_fkey"
  FOREIGN KEY ("created_by_id")
  REFERENCES "users"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

ALTER TABLE "training_policy_acceptances"
  ADD CONSTRAINT "training_policy_acceptances_user_id_fkey"
  FOREIGN KEY ("user_id")
  REFERENCES "users"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

ALTER TABLE "training_policy_acceptances"
  ADD CONSTRAINT "training_policy_acceptances_policy_version_id_fkey"
  FOREIGN KEY ("policy_version_id")
  REFERENCES "training_policy_versions"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;
