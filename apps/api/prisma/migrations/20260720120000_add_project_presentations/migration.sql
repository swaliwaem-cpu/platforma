CREATE TYPE "project_presentation_document_status" AS ENUM ('PENDING', 'RUNNING', 'READY', 'FAILED');

CREATE TABLE "project_presentation_drafts" (
  "id" UUID NOT NULL,
  "owner_user_id" UUID NOT NULL,
  "title" VARCHAR(180) NOT NULL,
  "cover_title" VARCHAR(180),
  "cover_subtitle" VARCHAR(500),
  "client_name" VARCHAR(180),
  "issue_label" VARCHAR(180),
  "cover_image_id" UUID,
  "template_version" VARCHAR(64) NOT NULL DEFAULT 'project-catalog-4x5-v1',
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "project_presentation_drafts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "project_presentation_draft_objects" (
  "id" UUID NOT NULL,
  "draft_id" UUID NOT NULL,
  "object_id" UUID NOT NULL,
  "sort_order" INTEGER NOT NULL,
  "manual_title" VARCHAR(180),
  "manual_description" VARCHAR(2000),
  "manual_property_class" VARCHAR(180),
  "manual_completion" VARCHAR(180),
  "manual_price" VARCHAR(180),
  "manual_district" VARCHAR(180),
  "manual_developer" VARCHAR(180),
  "manual_metro" VARCHAR(300),
  "image_ids" JSONB NOT NULL DEFAULT '[]',
  "advantages" JSONB NOT NULL DEFAULT '[]',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "project_presentation_draft_objects_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "project_presentation_documents" (
  "id" UUID NOT NULL,
  "owner_user_id" UUID NOT NULL,
  "draft_id" UUID,
  "file_id" UUID,
  "title" VARCHAR(180) NOT NULL,
  "status" "project_presentation_document_status" NOT NULL DEFAULT 'PENDING',
  "template_version" VARCHAR(64) NOT NULL,
  "snapshot_version" INTEGER NOT NULL DEFAULT 1,
  "snapshot_json" JSONB NOT NULL,
  "objects_count" INTEGER NOT NULL,
  "progress" INTEGER NOT NULL DEFAULT 0,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "idempotency_key" VARCHAR(80),
  "error_message" VARCHAR(1000),
  "heartbeat_at" TIMESTAMP(3),
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "project_presentation_documents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "project_presentation_document_objects" (
  "id" UUID NOT NULL,
  "document_id" UUID NOT NULL,
  "object_id" UUID,
  "source_object_id" UUID NOT NULL,
  "sort_order" INTEGER NOT NULL,
  CONSTRAINT "project_presentation_document_objects_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "project_presentation_document_assets" (
  "id" UUID NOT NULL,
  "document_id" UUID NOT NULL,
  "file_id" UUID NOT NULL,
  "source_object_id" UUID,
  "role" VARCHAR(64) NOT NULL,
  "sort_order" INTEGER NOT NULL,
  CONSTRAINT "project_presentation_document_assets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "project_presentation_drafts_owner_user_id_updated_at_idx" ON "project_presentation_drafts"("owner_user_id", "updated_at");
CREATE INDEX "project_presentation_drafts_updated_at_idx" ON "project_presentation_drafts"("updated_at");
CREATE UNIQUE INDEX "project_presentation_draft_objects_draft_id_object_id_key" ON "project_presentation_draft_objects"("draft_id", "object_id");
CREATE UNIQUE INDEX "project_presentation_draft_objects_draft_id_sort_order_key" ON "project_presentation_draft_objects"("draft_id", "sort_order");
CREATE INDEX "project_presentation_draft_objects_object_id_idx" ON "project_presentation_draft_objects"("object_id");
CREATE UNIQUE INDEX "project_presentation_documents_owner_user_id_idempotency_key_key" ON "project_presentation_documents"("owner_user_id", "idempotency_key");
CREATE INDEX "project_presentation_documents_status_created_at_idx" ON "project_presentation_documents"("status", "created_at");
CREATE INDEX "project_presentation_documents_owner_user_id_created_at_idx" ON "project_presentation_documents"("owner_user_id", "created_at");
CREATE INDEX "project_presentation_documents_draft_id_idx" ON "project_presentation_documents"("draft_id");
CREATE INDEX "project_presentation_documents_file_id_idx" ON "project_presentation_documents"("file_id");
CREATE UNIQUE INDEX "project_presentation_document_objects_document_id_source_object_id_key" ON "project_presentation_document_objects"("document_id", "source_object_id");
CREATE UNIQUE INDEX "project_presentation_document_objects_document_id_sort_order_key" ON "project_presentation_document_objects"("document_id", "sort_order");
CREATE INDEX "project_presentation_document_objects_object_id_idx" ON "project_presentation_document_objects"("object_id");
CREATE INDEX "project_presentation_document_assets_document_id_sort_order_idx" ON "project_presentation_document_assets"("document_id", "sort_order");
CREATE INDEX "project_presentation_document_assets_file_id_idx" ON "project_presentation_document_assets"("file_id");

ALTER TABLE "project_presentation_drafts" ADD CONSTRAINT "project_presentation_drafts_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_presentation_draft_objects" ADD CONSTRAINT "project_presentation_draft_objects_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "project_presentation_drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_presentation_draft_objects" ADD CONSTRAINT "project_presentation_draft_objects_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "real_estate_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_presentation_documents" ADD CONSTRAINT "project_presentation_documents_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_presentation_documents" ADD CONSTRAINT "project_presentation_documents_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "project_presentation_drafts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "project_presentation_documents" ADD CONSTRAINT "project_presentation_documents_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_presentation_document_objects" ADD CONSTRAINT "project_presentation_document_objects_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "project_presentation_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_presentation_document_objects" ADD CONSTRAINT "project_presentation_document_objects_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "real_estate_objects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "project_presentation_document_assets" ADD CONSTRAINT "project_presentation_document_assets_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "project_presentation_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_presentation_document_assets" ADD CONSTRAINT "project_presentation_document_assets_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
