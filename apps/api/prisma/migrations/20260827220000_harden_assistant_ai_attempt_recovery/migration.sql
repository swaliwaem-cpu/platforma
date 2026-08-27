ALTER TABLE "assistant_ai_usage_attempts"
ADD COLUMN "execution_id" UUID,
ADD COLUMN "reservation_expires_at" TIMESTAMP(3),
ADD COLUMN "daily_budget_usd" DECIMAL(18,8),
ADD COLUMN "service_tier" VARCHAR(24) NOT NULL DEFAULT 'default';

WITH "legacy_executions" AS (
    SELECT DISTINCT ON ("operation_run_id")
        "operation_run_id",
        "id" AS "execution_id"
    FROM "assistant_ai_usage_attempts"
    ORDER BY "operation_run_id", "created_at", "id"
)
UPDATE "assistant_ai_usage_attempts" AS "attempt"
SET "execution_id" = "legacy_executions"."execution_id"
FROM "legacy_executions"
WHERE "attempt"."operation_run_id" = "legacy_executions"."operation_run_id";

UPDATE "assistant_ai_usage_attempts" AS "attempt"
SET "daily_budget_usd" = "budget"."budget_limit_usd"
FROM "assistant_ai_daily_budgets" AS "budget"
WHERE "attempt"."provider" = "budget"."provider"
  AND "attempt"."usage_date" = "budget"."usage_date";

UPDATE "assistant_ai_usage_attempts"
SET "reservation_expires_at" = CASE
    WHEN "status" = 'RESERVED' THEN GREATEST(
        "created_at" + INTERVAL '3 minutes',
        CURRENT_TIMESTAMP + INTERVAL '3 minutes'
    )
    ELSE COALESCE("settled_at", "created_at")
END;

ALTER TABLE "assistant_ai_usage_attempts"
ALTER COLUMN "execution_id" SET NOT NULL,
ALTER COLUMN "daily_budget_usd" SET NOT NULL,
ALTER COLUMN "reservation_expires_at" SET NOT NULL;

ALTER TABLE "assistant_ai_usage_attempts"
ADD CONSTRAINT "assistant_ai_usage_attempts_service_tier_check"
CHECK ("service_tier" IN ('default'));

ALTER TABLE "assistant_ai_usage_attempts"
ADD CONSTRAINT "assistant_ai_usage_attempts_daily_budget_check"
CHECK ("daily_budget_usd" > 0);

CREATE UNIQUE INDEX "assistant_ai_usage_attempts_run_execution_ordinal_key"
ON "assistant_ai_usage_attempts"("operation_run_id", "execution_id", "attempt_ordinal");

DROP INDEX "assistant_ai_usage_attempts_operation_run_id_attempt_ordinal_key";

CREATE INDEX "assistant_ai_usage_attempts_run_status_expiry_idx"
ON "assistant_ai_usage_attempts"("operation_run_id", "status", "reservation_expires_at");
