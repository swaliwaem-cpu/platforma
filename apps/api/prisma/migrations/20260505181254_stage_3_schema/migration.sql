-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('active', 'blocked', 'invited');

-- CreateEnum
CREATE TYPE "object_status" AS ENUM ('draft', 'published', 'archived');

-- CreateEnum
CREATE TYPE "location_type" AS ENUM ('area', 'district', 'custom');

-- CreateEnum
CREATE TYPE "file_storage" AS ENUM ('local', 'minio');

-- CreateEnum
CREATE TYPE "object_file_type" AS ENUM ('presentation', 'floor_plan', 'document', 'other');

-- CreateEnum
CREATE TYPE "import_mode" AS ENUM ('preview', 'run');

-- CreateEnum
CREATE TYPE "import_status" AS ENUM ('pending', 'success', 'partial', 'failed');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT,
    "status" "user_status" NOT NULL DEFAULT 'invited',
    "role_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "key" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "developers" (
    "id" UUID NOT NULL,
    "wp_term_id" INTEGER,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "developers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" UUID NOT NULL,
    "wp_term_id" INTEGER,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "type" "location_type" NOT NULL DEFAULT 'custom',
    "parent_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metro_stations" (
    "id" UUID NOT NULL,
    "wp_term_id" INTEGER,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "line_name" TEXT,
    "line_color" VARCHAR(32),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "metro_stations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "real_estate_objects" (
    "id" UUID NOT NULL,
    "wp_post_id" INTEGER,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "object_status" NOT NULL DEFAULT 'draft',
    "description" TEXT,
    "short_description" TEXT,
    "price_from" DECIMAL(14,2),
    "price_per_meter_from" DECIMAL(14,2),
    "completion_year" INTEGER,
    "completion_quarter" INTEGER,
    "address" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "features_json" JSONB NOT NULL DEFAULT '{}',
    "developer_id" UUID,
    "primary_location_id" UUID,
    "published_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "real_estate_objects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "object_locations" (
    "object_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "object_locations_pkey" PRIMARY KEY ("object_id","location_id")
);

-- CreateTable
CREATE TABLE "object_metro_stations" (
    "object_id" UUID NOT NULL,
    "metro_station_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "object_metro_stations_pkey" PRIMARY KEY ("object_id","metro_station_id")
);

-- CreateTable
CREATE TABLE "files" (
    "id" UUID NOT NULL,
    "wp_attachment_id" INTEGER,
    "storage" "file_storage" NOT NULL DEFAULT 'minio',
    "bucket" TEXT,
    "key" TEXT NOT NULL,
    "url" TEXT,
    "original_name" TEXT,
    "mime_type" TEXT,
    "size_bytes" BIGINT,
    "checksum" TEXT,
    "uploaded_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "object_images" (
    "id" UUID NOT NULL,
    "object_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_cover" BOOLEAN NOT NULL DEFAULT false,
    "alt" TEXT,
    "title" TEXT,
    "source_meta_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "object_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "object_files" (
    "id" UUID NOT NULL,
    "object_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "type" "object_file_type" NOT NULL DEFAULT 'other',
    "title" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "source_meta_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "object_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_user_id" UUID,
    "action" VARCHAR(120) NOT NULL,
    "entity_type" VARCHAR(120) NOT NULL,
    "entity_id" VARCHAR(120),
    "object_id" UUID,
    "metadata" JSONB,
    "ip_address" VARCHAR(64),
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_reports" (
    "id" UUID NOT NULL,
    "mode" "import_mode" NOT NULL,
    "status" "import_status" NOT NULL DEFAULT 'pending',
    "source" VARCHAR(120) NOT NULL DEFAULT 'wordpress',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "summary_json" JSONB,
    "warnings_json" JSONB,
    "errors_json" JSONB,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_id_idx" ON "users"("role_id");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");

-- CreateIndex
CREATE INDEX "role_permissions_permission_id_idx" ON "role_permissions"("permission_id");

-- CreateIndex
CREATE UNIQUE INDEX "developers_wp_term_id_key" ON "developers"("wp_term_id");

-- CreateIndex
CREATE UNIQUE INDEX "developers_name_key" ON "developers"("name");

-- CreateIndex
CREATE UNIQUE INDEX "developers_slug_key" ON "developers"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "locations_wp_term_id_key" ON "locations"("wp_term_id");

-- CreateIndex
CREATE INDEX "locations_parent_id_idx" ON "locations"("parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "locations_type_slug_key" ON "locations"("type", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "metro_stations_wp_term_id_key" ON "metro_stations"("wp_term_id");

-- CreateIndex
CREATE INDEX "metro_stations_line_name_idx" ON "metro_stations"("line_name");

-- CreateIndex
CREATE UNIQUE INDEX "metro_stations_line_name_slug_key" ON "metro_stations"("line_name", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "real_estate_objects_wp_post_id_key" ON "real_estate_objects"("wp_post_id");

-- CreateIndex
CREATE UNIQUE INDEX "real_estate_objects_slug_key" ON "real_estate_objects"("slug");

-- CreateIndex
CREATE INDEX "real_estate_objects_status_idx" ON "real_estate_objects"("status");

-- CreateIndex
CREATE INDEX "real_estate_objects_developer_id_idx" ON "real_estate_objects"("developer_id");

-- CreateIndex
CREATE INDEX "real_estate_objects_primary_location_id_idx" ON "real_estate_objects"("primary_location_id");

-- CreateIndex
CREATE INDEX "real_estate_objects_price_from_idx" ON "real_estate_objects"("price_from");

-- CreateIndex
CREATE INDEX "real_estate_objects_completion_year_idx" ON "real_estate_objects"("completion_year");

-- CreateIndex
CREATE INDEX "real_estate_objects_latitude_longitude_idx" ON "real_estate_objects"("latitude", "longitude");

-- CreateIndex
CREATE INDEX "object_locations_location_id_idx" ON "object_locations"("location_id");

-- CreateIndex
CREATE INDEX "object_metro_stations_metro_station_id_idx" ON "object_metro_stations"("metro_station_id");

-- CreateIndex
CREATE UNIQUE INDEX "files_wp_attachment_id_key" ON "files"("wp_attachment_id");

-- CreateIndex
CREATE INDEX "files_uploaded_by_id_idx" ON "files"("uploaded_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "files_storage_bucket_key_key" ON "files"("storage", "bucket", "key");

-- CreateIndex
CREATE INDEX "object_images_file_id_idx" ON "object_images"("file_id");

-- CreateIndex
CREATE INDEX "object_images_object_id_is_cover_idx" ON "object_images"("object_id", "is_cover");

-- CreateIndex
CREATE UNIQUE INDEX "object_images_object_id_file_id_key" ON "object_images"("object_id", "file_id");

-- CreateIndex
CREATE INDEX "object_files_file_id_idx" ON "object_files"("file_id");

-- CreateIndex
CREATE INDEX "object_files_object_id_type_idx" ON "object_files"("object_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "object_files_object_id_file_id_type_key" ON "object_files"("object_id", "file_id", "type");

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_idx" ON "audit_logs"("actor_user_id");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_object_id_idx" ON "audit_logs"("object_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "import_reports_mode_status_idx" ON "import_reports"("mode", "status");

-- CreateIndex
CREATE INDEX "import_reports_created_by_id_idx" ON "import_reports"("created_by_id");

-- CreateIndex
CREATE INDEX "import_reports_created_at_idx" ON "import_reports"("created_at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "real_estate_objects" ADD CONSTRAINT "real_estate_objects_developer_id_fkey" FOREIGN KEY ("developer_id") REFERENCES "developers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "real_estate_objects" ADD CONSTRAINT "real_estate_objects_primary_location_id_fkey" FOREIGN KEY ("primary_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "object_locations" ADD CONSTRAINT "object_locations_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "real_estate_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "object_locations" ADD CONSTRAINT "object_locations_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "object_metro_stations" ADD CONSTRAINT "object_metro_stations_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "real_estate_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "object_metro_stations" ADD CONSTRAINT "object_metro_stations_metro_station_id_fkey" FOREIGN KEY ("metro_station_id") REFERENCES "metro_stations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "object_images" ADD CONSTRAINT "object_images_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "real_estate_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "object_images" ADD CONSTRAINT "object_images_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "object_files" ADD CONSTRAINT "object_files_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "real_estate_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "object_files" ADD CONSTRAINT "object_files_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "real_estate_objects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_reports" ADD CONSTRAINT "import_reports_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
