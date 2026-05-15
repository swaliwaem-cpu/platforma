CREATE TYPE "object_image_section" AS ENUM ('architecture', 'interiors', 'filling');

ALTER TABLE "object_images" ADD COLUMN "section" "object_image_section";

CREATE INDEX "object_images_object_id_section_idx" ON "object_images"("object_id", "section");
