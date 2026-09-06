ALTER TABLE "assistant_object_metro_route_facts"
DROP CONSTRAINT "assistant_object_metro_route_facts_values_check",
ADD CONSTRAINT "assistant_object_metro_route_facts_values_check" CHECK (
  "duration_seconds" >= 0
  AND "distance_meters" >= 0
  AND "object_latitude" BETWEEN -90 AND 90
  AND "object_longitude" BETWEEN -180 AND 180
  AND btrim("access_dataset_version") <> ''
  AND btrim("routing_profile") <> ''
);
