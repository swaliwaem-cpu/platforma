const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '../../..');
const schemaPath = path.join(rootDir, 'apps/api/prisma/schema.prisma');
const sharedTypesPath = path.join(rootDir, 'packages/shared/src/index.ts');
const migrationPath = path.join(
  rootDir,
  'apps/api/prisma/migrations/20260512120000_add_catalog_quick_links/migration.sql',
);

function readProjectFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

test('Prisma schema defines catalog quick links with typed targets', () => {
  const schema = readProjectFile(schemaPath);

  assert.match(schema, /enum CatalogQuickLinkType \{[\s\S]*DEVELOPER[\s\S]*KRT[\s\S]*SALES_START[\s\S]*@@map\("catalog_quick_link_type"\)[\s\S]*\}/);
  assert.match(schema, /model CatalogQuickLink \{[\s\S]*type\s+CatalogQuickLinkType[\s\S]*label\s+String\s+@db\.VarChar\(160\)[\s\S]*sortOrder\s+Int\s+@default\(0\)\s+@map\("sort_order"\)[\s\S]*isEnabled\s+Boolean\s+@default\(true\)\s+@map\("is_enabled"\)[\s\S]*\}/);
  assert.match(schema, /model CatalogQuickLink \{[\s\S]*developerId\s+String\?\s+@map\("developer_id"\)\s+@db\.Uuid[\s\S]*objectId\s+String\?\s+@map\("object_id"\)\s+@db\.Uuid[\s\S]*krtName\s+String\?\s+@map\("krt_name"\)\s+@db\.VarChar\(240\)[\s\S]*\}/);
  assert.match(schema, /developer\s+Developer\?\s+@relation\(fields: \[developerId\], references: \[id\], onDelete: SetNull\)/);
  assert.match(schema, /object\s+RealEstateObject\?\s+@relation\(fields: \[objectId\], references: \[id\], onDelete: SetNull\)/);
  assert.match(schema, /@@index\(\[type, sortOrder\]\)/);
  assert.match(schema, /@@map\("catalog_quick_links"\)/);
});

test('catalog quick links migration creates table and seed rows', () => {
  const migration = readProjectFile(migrationPath);

  assert.match(migration, /CREATE TYPE "catalog_quick_link_type" AS ENUM \('developer', 'krt', 'sales_start'\)/);
  assert.match(migration, /CREATE TABLE "catalog_quick_links"/);
  assert.match(migration, /"developer_id" UUID/);
  assert.match(migration, /"object_id" UUID/);
  assert.match(migration, /"krt_name" VARCHAR\(240\)/);
  assert.match(migration, /FOREIGN KEY \("developer_id"\) REFERENCES "developers"\("id"\) ON DELETE SET NULL ON UPDATE CASCADE/);
  assert.match(migration, /FOREIGN KEY \("object_id"\) REFERENCES "real_estate_objects"\("id"\) ON DELETE SET NULL ON UPDATE CASCADE/);

  const expectedLabels = [
    'MR Group',
    'FORMA',
    'Эталон',
    'Sminex',
    'ФСК',
    'Большое Сити',
    'Верейская',
    'ЗИЛ-Юг',
    'Север',
    'Ленинградский',
    'Upside Мосфильмовская',
    'Мастерс',
    'Муза',
    'Резиденции Воронцова',
    'Палашевский 11',
  ];

  for (const label of expectedLabels) {
    assert.match(migration, new RegExp(label));
  }

  const seedRows = migration.match(/\('[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}'/g) ?? [];
  assert.equal(seedRows.length, 15);
});

test('shared package exports public and admin catalog links contracts', () => {
  const sharedTypes = readProjectFile(sharedTypesPath);

  assert.match(sharedTypes, /export type CatalogQuickLinkType = 'DEVELOPER' \| 'KRT' \| 'SALES_START';/);
  assert.match(sharedTypes, /export type PublicCatalogQuickLink = \{[\s\S]*developerId: string \| null;[\s\S]*krtName: string \| null;[\s\S]*objectSlug: string \| null;[\s\S]*\};/);
  assert.match(sharedTypes, /export type CatalogLinksResponse = \{[\s\S]*items: PublicCatalogQuickLink\[\];[\s\S]*\};/);
  assert.match(sharedTypes, /export type AdminCatalogQuickLink = \{[\s\S]*isEnabled: boolean;[\s\S]*developer: ObjectDeveloper \| null;[\s\S]*object: AdminCatalogQuickLinkObject \| null;[\s\S]*\};/);
  assert.match(sharedTypes, /export type AdminCatalogLinksResponse = \{[\s\S]*items: AdminCatalogQuickLink\[\];[\s\S]*\};/);
  assert.match(sharedTypes, /export type UpdateCatalogLinksRequest = \{[\s\S]*items: UpdateCatalogQuickLinkInput\[\];[\s\S]*\};/);
});
