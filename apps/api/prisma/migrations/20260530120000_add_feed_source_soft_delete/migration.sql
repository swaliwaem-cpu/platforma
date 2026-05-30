ALTER TABLE "feed_sources" ADD COLUMN "deleted_at" TIMESTAMP(3);

CREATE INDEX "feed_sources_deleted_at_idx" ON "feed_sources"("deleted_at");
