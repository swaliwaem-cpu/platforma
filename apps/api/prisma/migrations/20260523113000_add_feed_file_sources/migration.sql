CREATE TYPE "feed_source_kind" AS ENUM ('url', 'file');

ALTER TABLE "feed_sources" ADD COLUMN "source_kind" "feed_source_kind" NOT NULL DEFAULT 'url';
ALTER TABLE "feed_sources" ALTER COLUMN "url" DROP NOT NULL;
ALTER TABLE "feed_sources" ADD COLUMN "xml_file_id" UUID;

ALTER TABLE "feed_sources" ADD CONSTRAINT "feed_sources_xml_file_id_fkey"
  FOREIGN KEY ("xml_file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "feed_sources" ADD CONSTRAINT "feed_sources_source_payload_check"
  CHECK (
    ("source_kind" = 'url' AND "url" IS NOT NULL AND "xml_file_id" IS NULL)
    OR
    ("source_kind" = 'file' AND "url" IS NULL AND "xml_file_id" IS NOT NULL)
  );

CREATE INDEX "feed_sources_source_kind_idx" ON "feed_sources"("source_kind");
CREATE INDEX "feed_sources_xml_file_id_idx" ON "feed_sources"("xml_file_id");
