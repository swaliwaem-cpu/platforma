-- CreateEnum
CREATE TYPE "file_variant_kind" AS ENUM ('thumbnail', 'card', 'detail');

-- CreateTable
CREATE TABLE "file_variants" (
    "file_id" UUID NOT NULL,
    "variant" "file_variant_kind" NOT NULL,
    "storage" "file_storage" NOT NULL DEFAULT 'minio',
    "bucket" TEXT,
    "key" TEXT NOT NULL,
    "url" TEXT,
    "mime_type" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "checksum" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_variants_pkey" PRIMARY KEY ("file_id", "variant")
);

-- CreateIndex
CREATE UNIQUE INDEX "file_variants_storage_bucket_key_key" ON "file_variants"("storage", "bucket", "key");

-- AddForeignKey
ALTER TABLE "file_variants" ADD CONSTRAINT "file_variants_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;
