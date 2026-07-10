CREATE TYPE "real_estate_object_type" AS ENUM ('residential', 'commercial');

ALTER TABLE "real_estate_objects" ADD COLUMN "type" "real_estate_object_type" NOT NULL DEFAULT 'residential';

CREATE INDEX "real_estate_objects_type_idx" ON "real_estate_objects"("type");
