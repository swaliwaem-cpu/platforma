-- Alter feed source fallback object to be optional for multi-object feeds.
ALTER TABLE "feed_sources" DROP CONSTRAINT IF EXISTS "feed_sources_object_id_fkey";
ALTER TABLE "feed_sources" ALTER COLUMN "object_id" DROP NOT NULL;
ALTER TABLE "feed_sources" ADD CONSTRAINT "feed_sources_object_id_fkey"
  FOREIGN KEY ("object_id") REFERENCES "real_estate_objects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "feed_source_mappings" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "object_id" UUID NOT NULL,
    "source_key" VARCHAR(255) NOT NULL,
    "source_title" VARCHAR(300) NOT NULL,
    "filter_json" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feed_source_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "feed_source_mappings_source_id_source_key_key" ON "feed_source_mappings"("source_id", "source_key");

-- CreateIndex
CREATE INDEX "feed_source_mappings_source_id_is_active_idx" ON "feed_source_mappings"("source_id", "is_active");

-- CreateIndex
CREATE INDEX "feed_source_mappings_object_id_idx" ON "feed_source_mappings"("object_id");

-- AddForeignKey
ALTER TABLE "feed_source_mappings" ADD CONSTRAINT "feed_source_mappings_source_id_fkey"
  FOREIGN KEY ("source_id") REFERENCES "feed_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feed_source_mappings" ADD CONSTRAINT "feed_source_mappings_object_id_fkey"
  FOREIGN KEY ("object_id") REFERENCES "real_estate_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
