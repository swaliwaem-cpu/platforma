ALTER TYPE "feed_source_kind" ADD VALUE 'index_url';

ALTER TABLE "feed_sources" DROP CONSTRAINT "feed_sources_source_payload_check";

ALTER TABLE "feed_sources" ADD CONSTRAINT "feed_sources_source_payload_check"
CHECK (
  (
    "source_kind"::text IN ('url', 'index_url') AND "url" IS NOT NULL AND "xml_file_id" IS NULL
  )
  OR
  (
    "source_kind" = 'file' AND "url" IS NULL AND "xml_file_id" IS NOT NULL
  )
);
