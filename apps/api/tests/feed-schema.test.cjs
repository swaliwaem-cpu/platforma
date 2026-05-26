const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '../../..');
const schemaPath = path.join(rootDir, 'apps/api/prisma/schema.prisma');
const migrationPath = path.join(
  rootDir,
  'apps/api/prisma/migrations/20260523100000_add_feed_schema/migration.sql',
);
const feedSourceFilterMigrationPath = path.join(
  rootDir,
  'apps/api/prisma/migrations/20260526190000_add_feed_source_filter_json/migration.sql',
);
const feedSourceMappingsMigrationPath = path.join(
  rootDir,
  'apps/api/prisma/migrations/20260526210000_add_feed_source_mappings/migration.sql',
);

function readProjectFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

test('Prisma schema defines feed enums', () => {
  const schema = readProjectFile(schemaPath);

  assert.match(schema, /enum FeedFormat \{[\s\S]*YANDEX_REALTY\s+@map\("yandex_realty"\)[\s\S]*CIAN_XML\s+@map\("cian_xml"\)[\s\S]*@@map\("feed_format"\)[\s\S]*\}/);
  assert.match(schema, /enum FeedSourceKind \{[\s\S]*URL\s+@map\("url"\)[\s\S]*FILE\s+@map\("file"\)[\s\S]*@@map\("feed_source_kind"\)[\s\S]*\}/);
  assert.match(schema, /enum FeedUnitType \{[\s\S]*RESIDENTIAL\s+@map\("residential"\)[\s\S]*COMMERCIAL\s+@map\("commercial"\)[\s\S]*@@map\("feed_unit_type"\)[\s\S]*\}/);
  assert.match(schema, /enum FeedUnitStatus \{[\s\S]*AVAILABLE\s+@map\("available"\)[\s\S]*BOOKED\s+@map\("booked"\)[\s\S]*RESERVED\s+@map\("reserved"\)[\s\S]*SOLD\s+@map\("sold"\)[\s\S]*ARCHIVED\s+@map\("archived"\)[\s\S]*UNKNOWN\s+@map\("unknown"\)[\s\S]*@@map\("feed_unit_status"\)[\s\S]*\}/);
});

test('Prisma schema defines feed sources and import runs', () => {
  const schema = readProjectFile(schemaPath);

  assert.match(schema, /model FeedSource \{[\s\S]*id\s+String\s+@id @default\(uuid\(\)\) @db\.Uuid[\s\S]*sourceKind\s+FeedSourceKind\s+@default\(URL\) @map\("source_kind"\)[\s\S]*url\s+String\?\s+@db\.VarChar\(2048\)[\s\S]*xmlFileId\s+String\?\s+@map\("xml_file_id"\) @db\.Uuid[\s\S]*format\s+FeedFormat[\s\S]*filterJson\s+Json\?\s+@map\("filter_json"\)[\s\S]*developerId\s+String\s+@map\("developer_id"\) @db\.Uuid[\s\S]*objectId\s+String\?\s+@map\("object_id"\) @db\.Uuid[\s\S]*isActive\s+Boolean\s+@default\(true\) @map\("is_active"\)[\s\S]*lastPreviewAt\s+DateTime\?\s+@map\("last_preview_at"\)[\s\S]*lastRunAt\s+DateTime\?\s+@map\("last_run_at"\)[\s\S]*lastSuccessAt\s+DateTime\?\s+@map\("last_success_at"\)[\s\S]*mappings\s+FeedSourceMapping\[\][\s\S]*\}/);
  assert.match(schema, /xmlFile\s+File\?\s+@relation\("FeedXmlFile", fields: \[xmlFileId\], references: \[id\], onDelete: Restrict\)/);
  assert.match(schema, /developer\s+Developer\s+@relation\(fields: \[developerId\], references: \[id\], onDelete: Restrict\)/);
  assert.match(schema, /object\s+RealEstateObject\?\s+@relation\(fields: \[objectId\], references: \[id\], onDelete: SetNull\)/);
  assert.match(schema, /@@index\(\[sourceKind\]\)/);
  assert.match(schema, /@@index\(\[xmlFileId\]\)/);
  assert.match(schema, /@@index\(\[developerId\]\)/);
  assert.match(schema, /@@index\(\[objectId, isActive\]\)/);
  assert.match(schema, /@@map\("feed_sources"\)/);

  assert.match(schema, /model FeedImportRun \{[\s\S]*sourceId\s+String\s+@map\("source_id"\) @db\.Uuid[\s\S]*mode\s+ImportMode[\s\S]*status\s+ImportStatus\s+@default\(PENDING\)[\s\S]*summaryJson\s+Json\?\s+@map\("summary_json"\)[\s\S]*warningsJson\s+Json\?\s+@map\("warnings_json"\)[\s\S]*errorsJson\s+Json\?\s+@map\("errors_json"\)[\s\S]*\}/);
  assert.match(schema, /source\s+FeedSource\s+@relation\(fields: \[sourceId\], references: \[id\], onDelete: Cascade\)/);
  assert.match(schema, /@@index\(\[sourceId, startedAt\]\)/);
  assert.match(schema, /@@index\(\[mode, status\]\)/);
  assert.match(schema, /@@map\("feed_import_runs"\)/);
});

test('Prisma schema defines feed source mappings for multi-object routing', () => {
  const schema = readProjectFile(schemaPath);

  assert.match(schema, /model FeedSourceMapping \{[\s\S]*id\s+String\s+@id @default\(uuid\(\)\) @db\.Uuid[\s\S]*sourceId\s+String\s+@map\("source_id"\) @db\.Uuid[\s\S]*objectId\s+String\s+@map\("object_id"\) @db\.Uuid[\s\S]*sourceKey\s+String\s+@map\("source_key"\) @db\.VarChar\(255\)[\s\S]*sourceTitle\s+String\s+@map\("source_title"\) @db\.VarChar\(300\)[\s\S]*filterJson\s+Json\s+@map\("filter_json"\)[\s\S]*isActive\s+Boolean\s+@default\(true\) @map\("is_active"\)[\s\S]*\}/);
  assert.match(schema, /source\s+FeedSource\s+@relation\(fields: \[sourceId\], references: \[id\], onDelete: Cascade\)/);
  assert.match(schema, /object\s+RealEstateObject\s+@relation\(fields: \[objectId\], references: \[id\], onDelete: Cascade\)/);
  assert.match(schema, /@@unique\(\[sourceId, sourceKey\]\)/);
  assert.match(schema, /@@index\(\[sourceId, isActive\]\)/);
  assert.match(schema, /@@index\(\[objectId\]\)/);
  assert.match(schema, /@@map\("feed_source_mappings"\)/);
}
);

test('Prisma schema defines feed units, details and media', () => {
  const schema = readProjectFile(schemaPath);

  assert.match(schema, /model FeedUnit \{[\s\S]*sourceId\s+String\s+@map\("source_id"\) @db\.Uuid[\s\S]*objectId\s+String\s+@map\("object_id"\) @db\.Uuid[\s\S]*externalId\s+String\s+@map\("external_id"\) @db\.VarChar\(255\)[\s\S]*type\s+FeedUnitType[\s\S]*status\s+FeedUnitStatus\s+@default\(UNKNOWN\)[\s\S]*price\s+Decimal\?\s+@db\.Decimal\(14, 2\)[\s\S]*area\s+Decimal\?\s+@db\.Decimal\(10, 2\)[\s\S]*pricePerMeter\s+Decimal\?\s+@map\("price_per_meter"\) @db\.Decimal\(14, 2\)[\s\S]*rawPayload\s+Json\?\s+@map\("raw_payload"\)[\s\S]*\}/);
  assert.match(schema, /@@unique\(\[sourceId, externalId\]\)/);
  assert.match(schema, /@@index\(\[objectId, status\]\)/);
  assert.match(schema, /@@index\(\[price\]\)/);
  assert.match(schema, /@@index\(\[area\]\)/);
  assert.match(schema, /@@map\("feed_units"\)/);

  assert.match(schema, /model FeedResidentialUnitDetails \{[\s\S]*unitId\s+String\s+@id @map\("unit_id"\) @db\.Uuid[\s\S]*apartmentNumber\s+String\?\s+@map\("apartment_number"\) @db\.VarChar\(120\)[\s\S]*livingArea\s+Decimal\?\s+@map\("living_area"\) @db\.Decimal\(10, 2\)[\s\S]*detailsJson\s+Json\s+@default\("\{\}"\) @map\("details_json"\)[\s\S]*\}/);
  assert.match(schema, /model FeedCommercialUnitDetails \{[\s\S]*unitId\s+String\s+@id @map\("unit_id"\) @db\.Uuid[\s\S]*commercialType\s+String\?\s+@map\("commercial_type"\) @db\.VarChar\(120\)[\s\S]*ceilingHeight\s+Decimal\?\s+@map\("ceiling_height"\) @db\.Decimal\(5, 2\)[\s\S]*detailsJson\s+Json\s+@default\("\{\}"\) @map\("details_json"\)[\s\S]*\}/);

  assert.match(schema, /model FeedMediaAsset \{[\s\S]*sourceUrl\s+String\s+@unique @map\("source_url"\) @db\.VarChar\(2048\)[\s\S]*fileId\s+String\?\s+@map\("file_id"\) @db\.Uuid[\s\S]*file\s+File\?\s+@relation\("FeedMediaFile", fields: \[fileId\], references: \[id\], onDelete: SetNull\)[\s\S]*@@index\(\[fileId\]\)[\s\S]*@@map\("feed_media_assets"\)[\s\S]*\}/);
  assert.match(schema, /model FeedUnitMedia \{[\s\S]*unitId\s+String\s+@map\("unit_id"\) @db\.Uuid[\s\S]*mediaAssetId\s+String\s+@map\("media_asset_id"\) @db\.Uuid[\s\S]*sortOrder\s+Int\s+@default\(0\) @map\("sort_order"\)[\s\S]*@@id\(\[unitId, mediaAssetId\]\)[\s\S]*@@index\(\[mediaAssetId\]\)[\s\S]*@@map\("feed_unit_media"\)[\s\S]*\}/);
});

test('Prisma schema adds feed aggregates to real estate objects', () => {
  const schema = readProjectFile(schemaPath);

  assert.match(schema, /model RealEstateObject \{[\s\S]*feedPriceFrom\s+Decimal\?\s+@map\("feed_price_from"\) @db\.Decimal\(14, 2\)[\s\S]*feedPricePerMeterFrom\s+Decimal\?\s+@map\("feed_price_per_meter_from"\) @db\.Decimal\(14, 2\)[\s\S]*feedAreaRange\s+String\?\s+@map\("feed_area_range"\) @db\.VarChar\(120\)[\s\S]*feedFloorRange\s+String\?\s+@map\("feed_floor_range"\) @db\.VarChar\(120\)[\s\S]*feedUnitsCount\s+Int\?\s+@map\("feed_units_count"\)[\s\S]*feedUnitsCountText\s+String\?\s+@map\("feed_units_count_text"\) @db\.VarChar\(120\)[\s\S]*feedCompletionYear\s+Int\?\s+@map\("feed_completion_year"\)[\s\S]*feedCompletionQuarter\s+Int\?\s+@map\("feed_completion_quarter"\)[\s\S]*feedUpdatedAt\s+DateTime\?\s+@map\("feed_updated_at"\)[\s\S]*\}/);
  assert.match(schema, /feedSources\s+FeedSource\[\]/);
  assert.match(schema, /feedUnits\s+FeedUnit\[\]/);
  assert.match(schema, /@@index\(\[feedPriceFrom\]\)/);
  assert.match(schema, /@@index\(\[feedPricePerMeterFrom\]\)/);
});

test('feed schema migration creates tables, aggregates and indexes', () => {
  assert.equal(fs.existsSync(migrationPath), true);

  const migration = readProjectFile(migrationPath);

  assert.match(migration, /CREATE TYPE "feed_format" AS ENUM \('yandex_realty', 'cian_xml'\)/);
  assert.match(migration, /CREATE TYPE "feed_unit_type" AS ENUM \('residential', 'commercial'\)/);
  assert.match(migration, /CREATE TYPE "feed_unit_status" AS ENUM \('available', 'booked', 'reserved', 'sold', 'archived', 'unknown'\)/);
  assert.match(migration, /ALTER TABLE "real_estate_objects" ADD COLUMN "feed_price_from" DECIMAL\(14,2\)/);
  assert.match(migration, /CREATE TABLE "feed_sources"/);
  assert.match(migration, /CREATE TABLE "feed_import_runs"/);
  assert.match(migration, /CREATE TABLE "feed_units"/);
  assert.match(migration, /CREATE TABLE "feed_residential_unit_details"/);
  assert.match(migration, /CREATE TABLE "feed_commercial_unit_details"/);
  assert.match(migration, /CREATE TABLE "feed_media_assets"/);
  assert.match(migration, /CREATE TABLE "feed_unit_media"/);
  assert.match(migration, /CREATE UNIQUE INDEX "feed_units_source_id_external_id_key" ON "feed_units"\("source_id", "external_id"\)/);
  assert.match(migration, /CREATE INDEX "feed_units_object_id_status_idx" ON "feed_units"\("object_id", "status"\)/);
  assert.match(migration, /CREATE INDEX "feed_units_price_idx" ON "feed_units"\("price"\)/);
  assert.match(migration, /CREATE INDEX "feed_units_area_idx" ON "feed_units"\("area"\)/);
  assert.match(migration, /CREATE UNIQUE INDEX "feed_media_assets_source_url_key" ON "feed_media_assets"\("source_url"\)/);
  assert.match(migration, /FOREIGN KEY \("file_id"\) REFERENCES "files"\("id"\) ON DELETE SET NULL ON UPDATE CASCADE/);
});

test('feed file source migration adds source kind and XML file relation', () => {
  const migrationPath = path.join(
    rootDir,
    'apps/api/prisma/migrations/20260523113000_add_feed_file_sources/migration.sql',
  );

  assert.equal(fs.existsSync(migrationPath), true);

  const migration = readProjectFile(migrationPath);

  assert.match(migration, /CREATE TYPE "feed_source_kind" AS ENUM \('url', 'file'\)/);
  assert.match(migration, /ALTER TABLE "feed_sources" ADD COLUMN "source_kind" "feed_source_kind" NOT NULL DEFAULT 'url'/);
  assert.match(migration, /ALTER TABLE "feed_sources" ALTER COLUMN "url" DROP NOT NULL/);
  assert.match(migration, /ALTER TABLE "feed_sources" ADD COLUMN "xml_file_id" UUID/);
  assert.match(migration, /FOREIGN KEY \("xml_file_id"\) REFERENCES "files"\("id"\) ON DELETE RESTRICT ON UPDATE CASCADE/);
  assert.match(migration, /CREATE INDEX "feed_sources_source_kind_idx" ON "feed_sources"\("source_kind"\)/);
  assert.match(migration, /CREATE INDEX "feed_sources_xml_file_id_idx" ON "feed_sources"\("xml_file_id"\)/);
  assert.match(migration, /CONSTRAINT "feed_sources_source_payload_check"/);
});

test('feed source filter migration adds optional JSON filter payload', () => {
  assert.equal(fs.existsSync(feedSourceFilterMigrationPath), true);

  const migration = readProjectFile(feedSourceFilterMigrationPath);

  assert.match(migration, /ALTER TABLE "feed_sources" ADD COLUMN "filter_json" JSONB/);
});

test('feed source mappings migration makes source object optional and creates mapping table', () => {
  assert.equal(fs.existsSync(feedSourceMappingsMigrationPath), true);

  const migration = readProjectFile(feedSourceMappingsMigrationPath);

  assert.match(migration, /ALTER TABLE "feed_sources" ALTER COLUMN "object_id" DROP NOT NULL/);
  assert.match(migration, /CREATE TABLE "feed_source_mappings"/);
  assert.match(migration, /"source_key" VARCHAR\(255\) NOT NULL/);
  assert.match(migration, /"filter_json" JSONB NOT NULL/);
  assert.match(migration, /CREATE UNIQUE INDEX "feed_source_mappings_source_id_source_key_key" ON "feed_source_mappings"\("source_id", "source_key"\)/);
  assert.match(migration, /CREATE INDEX "feed_source_mappings_source_id_is_active_idx" ON "feed_source_mappings"\("source_id", "is_active"\)/);
  assert.match(migration, /FOREIGN KEY \("source_id"\) REFERENCES "feed_sources"\("id"\) ON DELETE CASCADE ON UPDATE CASCADE/);
  assert.match(migration, /FOREIGN KEY \("object_id"\) REFERENCES "real_estate_objects"\("id"\) ON DELETE CASCADE ON UPDATE CASCADE/);
});
