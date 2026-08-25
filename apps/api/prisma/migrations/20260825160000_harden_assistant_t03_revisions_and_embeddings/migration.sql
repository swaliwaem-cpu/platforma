DROP INDEX "assistant_source_revisions_source_id_checksum_key";
CREATE INDEX "assistant_source_revisions_source_id_checksum_idx"
  ON "assistant_source_revisions"("source_id", "checksum");

ALTER TABLE "assistant_source_chunks"
  ADD COLUMN "embedding_dimensions" SMALLINT;

UPDATE "assistant_source_chunks"
SET "embedding_dimensions" = vector_dims("embedding")
WHERE "embedding" IS NOT NULL;

ALTER TABLE "assistant_source_chunks"
  DROP CONSTRAINT "assistant_source_chunks_embedding_check";

ALTER TABLE "assistant_source_chunks"
  ADD CONSTRAINT "assistant_source_chunks_embedding_check" CHECK (
    ("embedding" IS NULL AND "embedding_model" IS NULL AND "embedding_dimensions" IS NULL AND "embedded_at" IS NULL) OR
    ("embedding" IS NOT NULL AND "embedding_model" IS NOT NULL AND "embedding_dimensions" BETWEEN 1 AND 4096 AND "embedded_at" IS NOT NULL)
  );

DROP INDEX "assistant_source_chunks_content_hash_embedding_model_idx";
CREATE INDEX "assistant_source_chunks_content_hash_embedding_model_embedding_dimensions_idx"
  ON "assistant_source_chunks"("content_hash", "embedding_model", "embedding_dimensions");
