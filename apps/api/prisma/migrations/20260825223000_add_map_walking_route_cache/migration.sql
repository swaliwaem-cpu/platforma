CREATE TABLE "map_walking_route_cache" (
  "cache_key" CHAR(64) NOT NULL,
  "provider" VARCHAR(40) NOT NULL,
  "profile" VARCHAR(40) NOT NULL,
  "origin_latitude" DECIMAL(9, 6) NOT NULL,
  "origin_longitude" DECIMAL(9, 6) NOT NULL,
  "destination_latitude" DECIMAL(9, 6) NOT NULL,
  "destination_longitude" DECIMAL(9, 6) NOT NULL,
  "distance_meters" INTEGER,
  "duration_seconds" INTEGER,
  "calculated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "map_walking_route_cache_pkey" PRIMARY KEY ("cache_key")
);
