BEGIN;

ALTER TABLE "assistant_ai_usage_attempts"
ADD COLUMN "execution_id" UUID,
ADD COLUMN "reservation_expires_at" TIMESTAMP(3),
ADD COLUMN "daily_budget_usd" DECIMAL(18,8),
ADD COLUMN "service_tier" VARCHAR(24) NOT NULL DEFAULT 'default';

CREATE TABLE "assistant_ai_execution_fences" (
    "operation_run_id" VARCHAR(160) NOT NULL,
    "execution_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_ai_execution_fences_pkey" PRIMARY KEY ("operation_run_id")
);

CREATE FUNCTION "assistant_ai_usage_attempts_fill_recovery_fields"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    "legacy_hash" TEXT;
    "current_execution_id" UUID;
BEGIN
    IF NEW."execution_id" IS NULL THEN
        "legacy_hash" := md5(NEW."operation_run_id");
        NEW."execution_id" := (
            substr("legacy_hash", 1, 8) || '-' ||
            substr("legacy_hash", 9, 4) || '-' ||
            substr("legacy_hash", 13, 4) || '-' ||
            substr("legacy_hash", 17, 4) || '-' ||
            substr("legacy_hash", 21, 12)
        )::uuid;
    END IF;

    IF NEW."reservation_expires_at" IS NULL THEN
        NEW."reservation_expires_at" := CURRENT_TIMESTAMP + INTERVAL '4 minutes';
    END IF;

    INSERT INTO "assistant_ai_execution_fences" (
        "operation_run_id", "execution_id", "updated_at"
    ) VALUES (
        NEW."operation_run_id", NEW."execution_id", CURRENT_TIMESTAMP
    )
    ON CONFLICT ("operation_run_id") DO NOTHING;

    SELECT "execution_id"
    INTO "current_execution_id"
    FROM "assistant_ai_execution_fences"
    WHERE "operation_run_id" = NEW."operation_run_id"
    FOR UPDATE;

    IF "current_execution_id" <> NEW."execution_id" THEN
        RAISE EXCEPTION 'ASSISTANT_AI_EXECUTION_STALE' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "assistant_ai_usage_attempts_recovery_fields_trigger"
BEFORE INSERT ON "assistant_ai_usage_attempts"
FOR EACH ROW
EXECUTE FUNCTION "assistant_ai_usage_attempts_fill_recovery_fields"();

UPDATE "assistant_ai_usage_attempts"
SET "execution_id" = (
    substr(md5("operation_run_id"), 1, 8) || '-' ||
    substr(md5("operation_run_id"), 9, 4) || '-' ||
    substr(md5("operation_run_id"), 13, 4) || '-' ||
    substr(md5("operation_run_id"), 17, 4) || '-' ||
    substr(md5("operation_run_id"), 21, 12)
)::uuid;

UPDATE "assistant_ai_usage_attempts" AS "attempt"
SET "daily_budget_usd" = "budget"."budget_limit_usd"
FROM "assistant_ai_daily_budgets" AS "budget"
WHERE "attempt"."provider" = "budget"."provider"
  AND "attempt"."usage_date" = "budget"."usage_date";

UPDATE "assistant_ai_usage_attempts"
SET "reservation_expires_at" = CASE
    WHEN "status" = 'RESERVED' THEN GREATEST(
        "created_at" + INTERVAL '4 minutes',
        CURRENT_TIMESTAMP + INTERVAL '4 minutes'
    )
    ELSE COALESCE("settled_at", "created_at")
END;

INSERT INTO "assistant_ai_execution_fences" (
    "operation_run_id", "execution_id", "updated_at"
)
SELECT "operation_run_id", MIN("execution_id"::text)::uuid, CURRENT_TIMESTAMP
FROM "assistant_ai_usage_attempts"
GROUP BY "operation_run_id";

ALTER TABLE "assistant_ai_usage_attempts"
ALTER COLUMN "execution_id" SET NOT NULL,
ALTER COLUMN "reservation_expires_at" SET NOT NULL;

ALTER TABLE "assistant_ai_usage_attempts"
ADD CONSTRAINT "assistant_ai_usage_attempts_service_tier_check"
CHECK ("service_tier" IN ('default'));

ALTER TABLE "assistant_ai_usage_attempts"
ADD CONSTRAINT "assistant_ai_usage_attempts_daily_budget_check"
CHECK ("daily_budget_usd" IS NULL OR "daily_budget_usd" > 0);

CREATE UNIQUE INDEX "assistant_ai_usage_attempts_run_execution_ordinal_key"
ON "assistant_ai_usage_attempts"("operation_run_id", "execution_id", "attempt_ordinal");

DROP INDEX "assistant_ai_usage_attempts_operation_run_id_attempt_ordinal_key";

COMMIT;
