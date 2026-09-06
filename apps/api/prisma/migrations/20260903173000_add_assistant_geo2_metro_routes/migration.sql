CREATE TABLE "assistant_metro_access_points" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_external_id" VARCHAR(160) NOT NULL,
    "station_name" VARCHAR(200) NOT NULL,
    "dataset_version" VARCHAR(80) NOT NULL,
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "location" geography(Point, 4326) NOT NULL,
    "source_properties" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assistant_metro_access_points_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "assistant_metro_access_points_coordinates_check" CHECK (
      "latitude" BETWEEN -90 AND 90
      AND "longitude" BETWEEN -180 AND 180
      AND ST_IsValid("location"::geometry)
      AND ST_SRID("location") = 4326
    ),
    CONSTRAINT "assistant_metro_access_points_name_check" CHECK (btrim("station_name") <> '')
);

CREATE UNIQUE INDEX "assistant_metro_access_points_dataset_version_source_external_id_key"
ON "assistant_metro_access_points"("dataset_version", "source_external_id");
CREATE INDEX "assistant_metro_access_points_location_gist_idx"
ON "assistant_metro_access_points" USING GIST ("location");

CREATE TABLE "assistant_object_metro_route_facts" (
    "object_id" UUID NOT NULL,
    "metro_access_point_id" UUID NOT NULL,
    "object_latitude" DECIMAL(9,6) NOT NULL,
    "object_longitude" DECIMAL(9,6) NOT NULL,
    "access_dataset_version" VARCHAR(80) NOT NULL,
    "routing_profile" VARCHAR(80) NOT NULL,
    "duration_seconds" INTEGER NOT NULL,
    "distance_meters" INTEGER NOT NULL,
    "calculated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assistant_object_metro_route_facts_pkey" PRIMARY KEY ("object_id"),
    CONSTRAINT "assistant_object_metro_route_facts_values_check" CHECK (
      "duration_seconds" > 0
      AND "distance_meters" >= 0
      AND "object_latitude" BETWEEN -90 AND 90
      AND "object_longitude" BETWEEN -180 AND 180
      AND btrim("access_dataset_version") <> ''
      AND btrim("routing_profile") <> ''
    )
);

CREATE INDEX "assistant_object_metro_route_facts_metro_access_point_id_idx"
ON "assistant_object_metro_route_facts"("metro_access_point_id");

ALTER TABLE "assistant_object_metro_route_facts"
ADD CONSTRAINT "assistant_object_metro_route_facts_object_id_fkey"
FOREIGN KEY ("object_id") REFERENCES "real_estate_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "assistant_object_metro_route_facts"
ADD CONSTRAINT "assistant_object_metro_route_facts_metro_access_point_id_fkey"
FOREIGN KEY ("metro_access_point_id") REFERENCES "assistant_metro_access_points"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
