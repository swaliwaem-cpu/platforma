CREATE TYPE "assistant_geo_landmark_kind" AS ENUM ('point', 'line', 'area');
CREATE TYPE "assistant_geo_confirmation_state" AS ENUM ('verified', 'confirmed', 'rejected');

CREATE TABLE "assistant_geo_landmarks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" "assistant_geo_landmark_kind" NOT NULL,
    "label" VARCHAR(300) NOT NULL,
    "normalized_query" VARCHAR(240) NOT NULL,
    "aliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "locale" VARCHAR(16) NOT NULL,
    "country" VARCHAR(2) NOT NULL DEFAULT '',
    "city" VARCHAR(160),
    "geometry" geometry(Geometry, 4326) NOT NULL,
    "source_provider" VARCHAR(40) NOT NULL,
    "source_external_id" VARCHAR(160),
    "source_metadata" JSONB NOT NULL DEFAULT '{}'::JSONB,
    "confirmation_state" "assistant_geo_confirmation_state" NOT NULL DEFAULT 'verified',
    "confirmed_by_user_id" UUID,
    "confirmed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_geo_landmarks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "assistant_geo_landmarks_geometry_valid" CHECK (
      ST_SRID("geometry") = 4326
      AND ST_NDims("geometry") = 2
      AND NOT ST_IsEmpty("geometry")
      AND ST_IsValid("geometry")
      AND ST_NPoints("geometry") BETWEEN 1 AND 20000
      AND ST_XMin(Box2D("geometry")) >= -180
      AND ST_XMax(Box2D("geometry")) <= 180
      AND ST_YMin(Box2D("geometry")) >= -90
      AND ST_YMax(Box2D("geometry")) <= 90
    ),
    CONSTRAINT "assistant_geo_landmarks_kind_geometry" CHECK (
      ("kind" = 'point' AND GeometryType("geometry") = 'POINT')
      OR ("kind" = 'line' AND GeometryType("geometry") IN ('LINESTRING', 'MULTILINESTRING') AND ST_Length("geometry"::geography) > 0)
      OR ("kind" = 'area' AND GeometryType("geometry") IN ('POLYGON', 'MULTIPOLYGON') AND ST_Area("geometry"::geography) > 0)
    ),
    CONSTRAINT "assistant_geo_landmarks_confirmation_expiry" CHECK (
      ("confirmation_state" = 'confirmed' AND "expires_at" IS NULL AND "confirmed_at" IS NOT NULL)
      OR ("confirmation_state" = 'verified' AND "expires_at" IS NOT NULL)
      OR "confirmation_state" = 'rejected'
    ),
    CONSTRAINT "assistant_geo_landmarks_source_metadata_object" CHECK (jsonb_typeof("source_metadata") = 'object')
);

ALTER TABLE "assistant_geo_landmarks"
  ADD CONSTRAINT "assistant_geo_landmarks_confirmed_by_user_id_fkey"
  FOREIGN KEY ("confirmed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "assistant_geo_landmarks_source_identity_key"
  ON "assistant_geo_landmarks"("source_provider", "source_external_id")
  WHERE "source_external_id" IS NOT NULL;
CREATE INDEX "assistant_geo_landmarks_query_idx"
  ON "assistant_geo_landmarks"("normalized_query", "locale", "country");
CREATE INDEX "assistant_geo_landmarks_aliases_gin"
  ON "assistant_geo_landmarks" USING GIN ("aliases");
CREATE INDEX "assistant_geo_landmarks_geometry_gist"
  ON "assistant_geo_landmarks" USING GIST ("geometry");
CREATE INDEX "assistant_geo_landmarks_confirmation_expiry_idx"
  ON "assistant_geo_landmarks"("confirmation_state", "expires_at");
CREATE INDEX "assistant_geo_landmarks_confirmed_by_user_id_updated_at_idx"
  ON "assistant_geo_landmarks"("confirmed_by_user_id", "updated_at");

INSERT INTO "assistant_geo_landmarks" (
  "id", "kind", "label", "normalized_query", "aliases", "locale", "country", "city",
  "geometry", "source_provider", "source_external_id", "source_metadata",
  "confirmation_state", "confirmed_by_user_id", "confirmed_at", "expires_at", "created_at", "updated_at"
)
SELECT
  "id", 'point', "label", "normalized_query", ARRAY["normalized_query"], "locale", "country", "city",
  ST_SetSRID(ST_MakePoint("longitude"::double precision, "latitude"::double precision), 4326),
  'manual_alias', "id"::text, jsonb_build_object('version', 1),
  'confirmed', "created_by_user_id", "created_at", NULL, "created_at", "updated_at"
FROM "assistant_geo_aliases";
