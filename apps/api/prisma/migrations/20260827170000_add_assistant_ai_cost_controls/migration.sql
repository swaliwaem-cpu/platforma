CREATE TABLE "assistant_ai_daily_budgets" (
    "provider" VARCHAR(40) NOT NULL,
    "usage_date" DATE NOT NULL,
    "budget_limit_usd" DECIMAL(18,8) NOT NULL,
    "reserved_cost_usd" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "settled_cost_usd" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_ai_daily_budgets_pkey" PRIMARY KEY ("provider", "usage_date"),
    CONSTRAINT "assistant_ai_daily_budgets_limit_check" CHECK ("budget_limit_usd" > 0),
    CONSTRAINT "assistant_ai_daily_budgets_reserved_check" CHECK ("reserved_cost_usd" >= 0),
    CONSTRAINT "assistant_ai_daily_budgets_settled_check" CHECK ("settled_cost_usd" >= 0)
);

CREATE TABLE "assistant_ai_usage_attempts" (
    "id" UUID NOT NULL,
    "operation_run_id" VARCHAR(160) NOT NULL,
    "attempt_ordinal" SMALLINT NOT NULL,
    "operation" VARCHAR(40) NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "requested_model" VARCHAR(160) NOT NULL,
    "actual_model" VARCHAR(160),
    "reasoning_effort" VARCHAR(20),
    "prompt_version" VARCHAR(120),
    "validator_version" VARCHAR(120),
    "is_fallback" BOOLEAN NOT NULL DEFAULT false,
    "status" VARCHAR(24) NOT NULL,
    "outcome" VARCHAR(40),
    "error_code" VARCHAR(120),
    "input_tokens" BIGINT,
    "cached_input_tokens" BIGINT,
    "cache_write_input_tokens" BIGINT,
    "output_tokens" BIGINT,
    "reasoning_tokens" BIGINT,
    "total_tokens" BIGINT,
    "web_search_calls" INTEGER,
    "pricing_catalog_version" VARCHAR(120) NOT NULL,
    "pricing_status" VARCHAR(32) NOT NULL,
    "reserved_cost_usd" DECIMAL(18,8) NOT NULL,
    "estimated_cost_usd" DECIMAL(18,8),
    "charged_cost_usd" DECIMAL(18,8),
    "duration_ms" INTEGER,
    "usage_date" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMP(3),

    CONSTRAINT "assistant_ai_usage_attempts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "assistant_ai_usage_attempts_ordinal_check" CHECK ("attempt_ordinal" > 0),
    CONSTRAINT "assistant_ai_usage_attempts_status_check" CHECK ("status" IN ('RESERVED', 'SETTLED')),
    CONSTRAINT "assistant_ai_usage_attempts_reserved_check" CHECK ("reserved_cost_usd" >= 0),
    CONSTRAINT "assistant_ai_usage_attempts_estimated_check" CHECK ("estimated_cost_usd" IS NULL OR "estimated_cost_usd" >= 0),
    CONSTRAINT "assistant_ai_usage_attempts_charged_check" CHECK ("charged_cost_usd" IS NULL OR "charged_cost_usd" >= 0),
    CONSTRAINT "assistant_ai_usage_attempts_tokens_check" CHECK (
      ("input_tokens" IS NULL OR "input_tokens" >= 0)
      AND ("cached_input_tokens" IS NULL OR "cached_input_tokens" >= 0)
      AND ("cache_write_input_tokens" IS NULL OR "cache_write_input_tokens" >= 0)
      AND ("output_tokens" IS NULL OR "output_tokens" >= 0)
      AND ("reasoning_tokens" IS NULL OR "reasoning_tokens" >= 0)
      AND ("total_tokens" IS NULL OR "total_tokens" >= 0)
      AND ("web_search_calls" IS NULL OR "web_search_calls" >= 0)
    )
);

CREATE INDEX "assistant_ai_daily_budgets_usage_date_idx"
ON "assistant_ai_daily_budgets"("usage_date");

CREATE UNIQUE INDEX "assistant_ai_usage_attempts_operation_run_id_attempt_ordinal_key"
ON "assistant_ai_usage_attempts"("operation_run_id", "attempt_ordinal");

CREATE INDEX "assistant_ai_usage_attempts_provider_usage_date_status_idx"
ON "assistant_ai_usage_attempts"("provider", "usage_date", "status");

CREATE INDEX "assistant_ai_usage_attempts_operation_created_at_idx"
ON "assistant_ai_usage_attempts"("operation", "created_at");
