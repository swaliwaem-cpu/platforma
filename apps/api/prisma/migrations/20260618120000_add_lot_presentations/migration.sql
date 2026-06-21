ALTER TABLE "users" ADD COLUMN "broker_phone" VARCHAR(64);
ALTER TABLE "users" ADD COLUMN "broker_email" VARCHAR(320);

CREATE TABLE "lot_presentation_collections" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "lot_presentation_collections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "lot_presentation_collection_items" (
  "id" UUID NOT NULL,
  "collection_id" UUID NOT NULL,
  "unit_id" UUID NOT NULL,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "lot_presentation_collection_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "lot_presentation_documents" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "collection_id" UUID,
  "file_id" UUID NOT NULL,
  "title" VARCHAR(180) NOT NULL,
  "units_count" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "lot_presentation_documents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "lot_presentation_document_items" (
  "document_id" UUID NOT NULL,
  "unit_id" UUID NOT NULL,
  "sort_order" INTEGER NOT NULL,

  CONSTRAINT "lot_presentation_document_items_pkey" PRIMARY KEY ("document_id", "unit_id")
);

CREATE INDEX "lot_presentation_collections_user_id_created_at_idx" ON "lot_presentation_collections"("user_id", "created_at");
CREATE UNIQUE INDEX "lot_presentation_collection_items_collection_id_unit_id_key" ON "lot_presentation_collection_items"("collection_id", "unit_id");
CREATE INDEX "lot_presentation_collection_items_collection_id_sort_order_idx" ON "lot_presentation_collection_items"("collection_id", "sort_order");
CREATE INDEX "lot_presentation_collection_items_unit_id_idx" ON "lot_presentation_collection_items"("unit_id");
CREATE INDEX "lot_presentation_documents_user_id_created_at_idx" ON "lot_presentation_documents"("user_id", "created_at");
CREATE INDEX "lot_presentation_documents_collection_id_idx" ON "lot_presentation_documents"("collection_id");
CREATE INDEX "lot_presentation_documents_file_id_idx" ON "lot_presentation_documents"("file_id");
CREATE INDEX "lot_presentation_document_items_unit_id_idx" ON "lot_presentation_document_items"("unit_id");

ALTER TABLE "lot_presentation_collections"
  ADD CONSTRAINT "lot_presentation_collections_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lot_presentation_collection_items"
  ADD CONSTRAINT "lot_presentation_collection_items_collection_id_fkey"
  FOREIGN KEY ("collection_id") REFERENCES "lot_presentation_collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lot_presentation_collection_items"
  ADD CONSTRAINT "lot_presentation_collection_items_unit_id_fkey"
  FOREIGN KEY ("unit_id") REFERENCES "feed_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lot_presentation_documents"
  ADD CONSTRAINT "lot_presentation_documents_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lot_presentation_documents"
  ADD CONSTRAINT "lot_presentation_documents_collection_id_fkey"
  FOREIGN KEY ("collection_id") REFERENCES "lot_presentation_collections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "lot_presentation_documents"
  ADD CONSTRAINT "lot_presentation_documents_file_id_fkey"
  FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "lot_presentation_document_items"
  ADD CONSTRAINT "lot_presentation_document_items_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "lot_presentation_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lot_presentation_document_items"
  ADD CONSTRAINT "lot_presentation_document_items_unit_id_fkey"
  FOREIGN KEY ("unit_id") REFERENCES "feed_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
