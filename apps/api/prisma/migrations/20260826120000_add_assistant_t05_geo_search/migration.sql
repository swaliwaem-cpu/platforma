ALTER TABLE "real_estate_objects"
  ADD COLUMN "search_point" geography(Point, 4326)
  GENERATED ALWAYS AS (
    CASE
      WHEN "latitude" IS NOT NULL
        AND "longitude" IS NOT NULL
        AND "latitude" BETWEEN -90 AND 90
        AND "longitude" BETWEEN -180 AND 180
      THEN ST_SetSRID(
        ST_MakePoint("longitude"::double precision, "latitude"::double precision),
        4326
      )::geography
      ELSE NULL
    END
  ) STORED;

CREATE INDEX "real_estate_objects_search_point_gist"
  ON "real_estate_objects" USING GIST ("search_point")
  WHERE "search_point" IS NOT NULL;

ALTER TABLE "assistant_messages"
  ADD COLUMN "geo_context_json" JSONB;

ALTER TABLE "assistant_messages"
  ADD CONSTRAINT "assistant_messages_geo_context_json_check" CHECK (
    "geo_context_json" IS NULL OR jsonb_typeof("geo_context_json") = 'object'
  );

ALTER TYPE "assistant_source_fact_kind" ADD VALUE 'address';

CREATE TABLE "assistant_geo_aliases" (
  "id" UUID NOT NULL,
  "normalized_query" VARCHAR(240) NOT NULL,
  "query" VARCHAR(240) NOT NULL,
  "locale" VARCHAR(16) NOT NULL,
  "country" VARCHAR(2) NOT NULL DEFAULT '',
  "label" VARCHAR(300) NOT NULL,
  "city" VARCHAR(160),
  "country_code" VARCHAR(2),
  "latitude" DECIMAL(10,7) NOT NULL,
  "longitude" DECIMAL(10,7) NOT NULL,
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "assistant_geo_aliases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "assistant_geo_aliases_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "assistant_geo_aliases_coordinates_check" CHECK (
    "latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180
  ),
  CONSTRAINT "assistant_geo_aliases_country_code_check" CHECK (
    "country_code" IS NULL OR "country_code" ~ '^[a-z]{2}$'
  )
);

CREATE UNIQUE INDEX "assistant_geo_aliases_normalized_query_locale_country_key"
  ON "assistant_geo_aliases"("normalized_query", "locale", "country");
CREATE INDEX "assistant_geo_aliases_created_by_user_id_updated_at_idx"
  ON "assistant_geo_aliases"("created_by_user_id", "updated_at");

CREATE TABLE "assistant_geo_cache" (
  "cache_key" CHAR(64) NOT NULL,
  "normalized_query" VARCHAR(240) NOT NULL,
  "locale" VARCHAR(16) NOT NULL,
  "country" VARCHAR(2) NOT NULL DEFAULT '',
  "viewbox_key" VARCHAR(120) NOT NULL,
  "provider" VARCHAR(40) NOT NULL,
  "candidates_json" JSONB NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "assistant_geo_cache_pkey" PRIMARY KEY ("cache_key"),
  CONSTRAINT "assistant_geo_cache_candidates_json_check" CHECK (jsonb_typeof("candidates_json") = 'array')
);

CREATE INDEX "assistant_geo_cache_expires_at_idx" ON "assistant_geo_cache"("expires_at");

CREATE TABLE "assistant_geo_provider_daily_usage" (
  "provider" VARCHAR(40) NOT NULL,
  "usage_date" DATE NOT NULL,
  "request_count" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "assistant_geo_provider_daily_usage_pkey" PRIMARY KEY ("provider", "usage_date"),
  CONSTRAINT "assistant_geo_provider_daily_usage_request_count_check" CHECK ("request_count" >= 0)
);
