CREATE TABLE "assistant_geo_usage_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "operation_id" UUID NOT NULL,
    "attempt_ordinal" SMALLINT NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "outcome" VARCHAR(40),
    "error_code" VARCHAR(120),
    "duration_ms" INTEGER,
    "minute_started_at" TIMESTAMPTZ(3) NOT NULL,
    "day_started_at" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMPTZ(3),

    CONSTRAINT "assistant_geo_usage_attempts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "assistant_geo_usage_attempts_operation_id_fkey"
      FOREIGN KEY ("operation_id") REFERENCES "assistant_geo_operations"("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "assistant_geo_usage_attempts_ordinal_check"
      CHECK ("attempt_ordinal" > 0),
    CONSTRAINT "assistant_geo_usage_attempts_provider_check"
      CHECK ("provider" IN ('locationiq', 'overpass')),
    CONSTRAINT "assistant_geo_usage_attempts_state_check" CHECK (
      (
        "status" = 'RESERVED'
        AND "outcome" IS NULL
        AND "error_code" IS NULL
        AND "duration_ms" IS NULL
        AND "settled_at" IS NULL
      ) OR (
        "status" = 'SETTLED'
        AND (
          ("outcome" = 'SUCCESS' AND "error_code" IS NULL)
          OR ("outcome" = 'ERROR' AND "error_code" IS NOT NULL)
        )
        AND "duration_ms" IS NOT NULL
        AND "duration_ms" >= 0
        AND "settled_at" IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX "assistant_geo_usage_attempts_operation_ordinal_key"
  ON "assistant_geo_usage_attempts"("operation_id", "attempt_ordinal");
CREATE INDEX "assistant_geo_usage_attempts_operation_status_idx"
  ON "assistant_geo_usage_attempts"("operation_id", "status");
CREATE INDEX "assistant_geo_usage_attempts_provider_created_at_idx"
  ON "assistant_geo_usage_attempts"("provider", "created_at");
