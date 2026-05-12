-- CreateEnum
CREATE TYPE "catalog_quick_link_type" AS ENUM ('developer', 'krt', 'sales_start');

-- CreateTable
CREATE TABLE "catalog_quick_links" (
    "id" UUID NOT NULL,
    "type" "catalog_quick_link_type" NOT NULL,
    "label" VARCHAR(160) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "developer_id" UUID,
    "object_id" UUID,
    "krt_name" VARCHAR(240),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_quick_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "catalog_quick_links_type_sort_order_idx" ON "catalog_quick_links"("type", "sort_order");

-- CreateIndex
CREATE INDEX "catalog_quick_links_developer_id_idx" ON "catalog_quick_links"("developer_id");

-- CreateIndex
CREATE INDEX "catalog_quick_links_object_id_idx" ON "catalog_quick_links"("object_id");

-- AddForeignKey
ALTER TABLE "catalog_quick_links" ADD CONSTRAINT "catalog_quick_links_developer_id_fkey" FOREIGN KEY ("developer_id") REFERENCES "developers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_quick_links" ADD CONSTRAINT "catalog_quick_links_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "real_estate_objects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- SeedData
INSERT INTO "catalog_quick_links" ("id", "type", "label", "sort_order", "is_enabled", "developer_id", "object_id", "krt_name", "created_at", "updated_at")
VALUES
    ('11111111-1111-4111-8111-111111111201', 'developer', 'MR Group', 0, true, (SELECT "id" FROM "developers" WHERE lower("name") = lower('MR Group') LIMIT 1), NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('11111111-1111-4111-8111-111111111202', 'developer', 'FORMA', 1, true, (SELECT "id" FROM "developers" WHERE lower("name") = lower('FORMA') LIMIT 1), NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('11111111-1111-4111-8111-111111111203', 'developer', 'Эталон', 2, true, (SELECT "id" FROM "developers" WHERE lower("name") = lower('Эталон') LIMIT 1), NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('11111111-1111-4111-8111-111111111204', 'developer', 'Sminex', 3, true, (SELECT "id" FROM "developers" WHERE lower("name") = lower('Sminex') LIMIT 1), NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('11111111-1111-4111-8111-111111111205', 'developer', 'ФСК', 4, true, (SELECT "id" FROM "developers" WHERE lower("name") = lower('ФСК') LIMIT 1), NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('11111111-1111-4111-8111-111111111301', 'krt', 'Большое Сити', 0, true, NULL, NULL, 'Большое Сити', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('11111111-1111-4111-8111-111111111302', 'krt', 'Верейская', 1, true, NULL, NULL, 'Верейская', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('11111111-1111-4111-8111-111111111303', 'krt', 'ЗИЛ-Юг', 2, true, NULL, NULL, 'ЗИЛ-Юг', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('11111111-1111-4111-8111-111111111304', 'krt', 'Север', 3, true, NULL, NULL, 'Север', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('11111111-1111-4111-8111-111111111305', 'krt', 'Ленинградский', 4, true, NULL, NULL, 'Ленинградский', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('11111111-1111-4111-8111-111111111401', 'sales_start', 'Upside Мосфильмовская', 0, true, NULL, (SELECT "id" FROM "real_estate_objects" WHERE lower("title") = lower('Upside Мосфильмовская') AND "status" = 'published' LIMIT 1), NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('11111111-1111-4111-8111-111111111402', 'sales_start', 'Мастерс', 1, true, NULL, (SELECT "id" FROM "real_estate_objects" WHERE lower("title") = lower('Мастерс') AND "status" = 'published' LIMIT 1), NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('11111111-1111-4111-8111-111111111403', 'sales_start', 'Муза', 2, true, NULL, (SELECT "id" FROM "real_estate_objects" WHERE lower("title") = lower('Муза') AND "status" = 'published' LIMIT 1), NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('11111111-1111-4111-8111-111111111404', 'sales_start', 'Резиденции Воронцова', 3, true, NULL, (SELECT "id" FROM "real_estate_objects" WHERE lower("title") = lower('Резиденции Воронцова') AND "status" = 'published' LIMIT 1), NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('11111111-1111-4111-8111-111111111405', 'sales_start', 'Палашевский 11', 4, true, NULL, (SELECT "id" FROM "real_estate_objects" WHERE lower("title") = lower('Палашевский 11') AND "status" = 'published' LIMIT 1), NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
