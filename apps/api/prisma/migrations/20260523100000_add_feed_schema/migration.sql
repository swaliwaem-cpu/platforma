-- CreateEnum
CREATE TYPE "feed_format" AS ENUM ('yandex_realty', 'cian_xml');

-- CreateEnum
CREATE TYPE "feed_unit_type" AS ENUM ('residential', 'commercial');

-- CreateEnum
CREATE TYPE "feed_unit_status" AS ENUM ('available', 'booked', 'reserved', 'sold', 'archived', 'unknown');

-- AlterTable
ALTER TABLE "real_estate_objects" ADD COLUMN "feed_price_from" DECIMAL(14,2);
ALTER TABLE "real_estate_objects" ADD COLUMN "feed_price_per_meter_from" DECIMAL(14,2);
ALTER TABLE "real_estate_objects" ADD COLUMN "feed_area_range" VARCHAR(120);
ALTER TABLE "real_estate_objects" ADD COLUMN "feed_floor_range" VARCHAR(120);
ALTER TABLE "real_estate_objects" ADD COLUMN "feed_units_count" INTEGER;
ALTER TABLE "real_estate_objects" ADD COLUMN "feed_units_count_text" VARCHAR(120);
ALTER TABLE "real_estate_objects" ADD COLUMN "feed_completion_year" INTEGER;
ALTER TABLE "real_estate_objects" ADD COLUMN "feed_completion_quarter" INTEGER;
ALTER TABLE "real_estate_objects" ADD COLUMN "feed_updated_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "feed_sources" (
    "id" UUID NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "format" "feed_format" NOT NULL,
    "developer_id" UUID NOT NULL,
    "object_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_preview_at" TIMESTAMP(3),
    "last_run_at" TIMESTAMP(3),
    "last_success_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feed_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feed_import_runs" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "mode" "import_mode" NOT NULL,
    "status" "import_status" NOT NULL DEFAULT 'pending',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "summary_json" JSONB,
    "warnings_json" JSONB,
    "errors_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feed_import_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feed_units" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "object_id" UUID NOT NULL,
    "external_id" VARCHAR(255) NOT NULL,
    "type" "feed_unit_type" NOT NULL,
    "status" "feed_unit_status" NOT NULL DEFAULT 'unknown',
    "title" VARCHAR(300),
    "address" VARCHAR(512),
    "building" VARCHAR(120),
    "section" VARCHAR(120),
    "floor" INTEGER,
    "rooms" INTEGER,
    "price" DECIMAL(14,2),
    "currency" VARCHAR(12),
    "area" DECIMAL(10,2),
    "price_per_meter" DECIMAL(14,2),
    "completion_year" INTEGER,
    "completion_quarter" INTEGER,
    "raw_payload" JSONB,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feed_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feed_residential_unit_details" (
    "unit_id" UUID NOT NULL,
    "apartment_number" VARCHAR(120),
    "layout_type" VARCHAR(120),
    "living_area" DECIMAL(10,2),
    "kitchen_area" DECIMAL(10,2),
    "balcony_count" INTEGER,
    "details_json" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "feed_residential_unit_details_pkey" PRIMARY KEY ("unit_id")
);

-- CreateTable
CREATE TABLE "feed_commercial_unit_details" (
    "unit_id" UUID NOT NULL,
    "commercial_type" VARCHAR(120),
    "entrance" VARCHAR(120),
    "ceiling_height" DECIMAL(5,2),
    "power_kw" DECIMAL(8,2),
    "separate_entrance" BOOLEAN,
    "details_json" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "feed_commercial_unit_details_pkey" PRIMARY KEY ("unit_id")
);

-- CreateTable
CREATE TABLE "feed_media_assets" (
    "id" UUID NOT NULL,
    "source_url" VARCHAR(2048) NOT NULL,
    "file_id" UUID,
    "content_type" VARCHAR(120),
    "checksum" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feed_media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feed_unit_media" (
    "unit_id" UUID NOT NULL,
    "media_asset_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "label" VARCHAR(120),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feed_unit_media_pkey" PRIMARY KEY ("unit_id", "media_asset_id")
);

-- CreateIndex
CREATE INDEX "real_estate_objects_feed_price_from_idx" ON "real_estate_objects"("feed_price_from");

-- CreateIndex
CREATE INDEX "real_estate_objects_feed_price_per_meter_from_idx" ON "real_estate_objects"("feed_price_per_meter_from");

-- CreateIndex
CREATE INDEX "real_estate_objects_feed_updated_at_idx" ON "real_estate_objects"("feed_updated_at");

-- CreateIndex
CREATE INDEX "feed_sources_developer_id_idx" ON "feed_sources"("developer_id");

-- CreateIndex
CREATE INDEX "feed_sources_object_id_is_active_idx" ON "feed_sources"("object_id", "is_active");

-- CreateIndex
CREATE INDEX "feed_sources_format_idx" ON "feed_sources"("format");

-- CreateIndex
CREATE INDEX "feed_import_runs_source_id_started_at_idx" ON "feed_import_runs"("source_id", "started_at");

-- CreateIndex
CREATE INDEX "feed_import_runs_mode_status_idx" ON "feed_import_runs"("mode", "status");

-- CreateIndex
CREATE INDEX "feed_import_runs_created_at_idx" ON "feed_import_runs"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "feed_units_source_id_external_id_key" ON "feed_units"("source_id", "external_id");

-- CreateIndex
CREATE INDEX "feed_units_object_id_status_idx" ON "feed_units"("object_id", "status");

-- CreateIndex
CREATE INDEX "feed_units_source_id_status_idx" ON "feed_units"("source_id", "status");

-- CreateIndex
CREATE INDEX "feed_units_type_idx" ON "feed_units"("type");

-- CreateIndex
CREATE INDEX "feed_units_status_idx" ON "feed_units"("status");

-- CreateIndex
CREATE INDEX "feed_units_price_idx" ON "feed_units"("price");

-- CreateIndex
CREATE INDEX "feed_units_price_per_meter_idx" ON "feed_units"("price_per_meter");

-- CreateIndex
CREATE INDEX "feed_units_area_idx" ON "feed_units"("area");

-- CreateIndex
CREATE UNIQUE INDEX "feed_media_assets_source_url_key" ON "feed_media_assets"("source_url");

-- CreateIndex
CREATE INDEX "feed_media_assets_file_id_idx" ON "feed_media_assets"("file_id");

-- CreateIndex
CREATE INDEX "feed_unit_media_media_asset_id_idx" ON "feed_unit_media"("media_asset_id");

-- CreateIndex
CREATE INDEX "feed_unit_media_unit_id_sort_order_idx" ON "feed_unit_media"("unit_id", "sort_order");

-- AddForeignKey
ALTER TABLE "feed_sources" ADD CONSTRAINT "feed_sources_developer_id_fkey" FOREIGN KEY ("developer_id") REFERENCES "developers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feed_sources" ADD CONSTRAINT "feed_sources_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "real_estate_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feed_import_runs" ADD CONSTRAINT "feed_import_runs_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "feed_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feed_units" ADD CONSTRAINT "feed_units_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "feed_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feed_units" ADD CONSTRAINT "feed_units_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "real_estate_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feed_residential_unit_details" ADD CONSTRAINT "feed_residential_unit_details_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "feed_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feed_commercial_unit_details" ADD CONSTRAINT "feed_commercial_unit_details_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "feed_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feed_media_assets" ADD CONSTRAINT "feed_media_assets_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feed_unit_media" ADD CONSTRAINT "feed_unit_media_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "feed_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feed_unit_media" ADD CONSTRAINT "feed_unit_media_media_asset_id_fkey" FOREIGN KEY ("media_asset_id") REFERENCES "feed_media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
