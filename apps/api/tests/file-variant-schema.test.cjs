const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '../../..');
const apiPackagePath = path.join(rootDir, 'apps/api/package.json');
const wpImportPackagePath = path.join(rootDir, 'tools/wp-import/package.json');
const schemaPath = path.join(rootDir, 'apps/api/prisma/schema.prisma');
const sharedTypesPath = path.join(rootDir, 'packages/shared/src/index.ts');
const migrationPath = path.join(
  rootDir,
  'apps/api/prisma/migrations/20260512130000_add_file_variants/migration.sql',
);

function readProjectFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function readJsonFile(filePath) {
  return JSON.parse(readProjectFile(filePath));
}

test('image variant packages depend on sharp', () => {
  const apiPackage = readJsonFile(apiPackagePath);
  const wpImportPackage = readJsonFile(wpImportPackagePath);

  assert.equal(typeof apiPackage.dependencies.sharp, 'string');
  assert.equal(typeof wpImportPackage.dependencies.sharp, 'string');
});

test('Prisma schema defines file variants with one variant kind per file', () => {
  const schema = readProjectFile(schemaPath);

  assert.match(schema, /enum FileVariantKind \{[\s\S]*THUMBNAIL\s+@map\("thumbnail"\)[\s\S]*CARD\s+@map\("card"\)[\s\S]*DETAIL\s+@map\("detail"\)[\s\S]*@@map\("file_variant_kind"\)[\s\S]*\}/);
  assert.match(schema, /model File \{[\s\S]*variants\s+FileVariant\[\][\s\S]*@@map\("files"\)[\s\S]*\}/);
  assert.match(schema, /model FileVariant \{[\s\S]*fileId\s+String\s+@map\("file_id"\)\s+@db\.Uuid[\s\S]*variant\s+FileVariantKind[\s\S]*storage\s+FileStorage\s+@default\(MINIO\)[\s\S]*key\s+String[\s\S]*mimeType\s+String\s+@map\("mime_type"\)[\s\S]*width\s+Int[\s\S]*height\s+Int[\s\S]*sizeBytes\s+BigInt\s+@map\("size_bytes"\)[\s\S]*\}/);
  assert.match(schema, /file\s+File\s+@relation\(fields: \[fileId\], references: \[id\], onDelete: Cascade\)/);
  assert.match(schema, /@@id\(\[fileId, variant\]\)/);
  assert.match(schema, /@@unique\(\[storage, bucket, key\]\)/);
  assert.match(schema, /@@map\("file_variants"\)/);
});

test('file variants migration creates enum, table and file cascade relation', () => {
  const migration = readProjectFile(migrationPath);

  assert.match(migration, /CREATE TYPE "file_variant_kind" AS ENUM \('thumbnail', 'card', 'detail'\)/);
  assert.match(migration, /CREATE TABLE "file_variants"/);
  assert.match(migration, /"file_id" UUID NOT NULL/);
  assert.match(migration, /"variant" "file_variant_kind" NOT NULL/);
  assert.match(migration, /"storage" "file_storage" NOT NULL DEFAULT 'minio'/);
  assert.match(migration, /"mime_type" TEXT NOT NULL/);
  assert.match(migration, /"width" INTEGER NOT NULL/);
  assert.match(migration, /"height" INTEGER NOT NULL/);
  assert.match(migration, /"size_bytes" BIGINT NOT NULL/);
  assert.match(migration, /PRIMARY KEY \("file_id", "variant"\)/);
  assert.match(migration, /CREATE UNIQUE INDEX "file_variants_storage_bucket_key_key" ON "file_variants"\("storage", "bucket", "key"\)/);
  assert.match(migration, /FOREIGN KEY \("file_id"\) REFERENCES "files"\("id"\) ON DELETE CASCADE ON UPDATE CASCADE/);
});

test('shared package exports file variant contract', () => {
  const sharedTypes = readProjectFile(sharedTypesPath);

  assert.match(sharedTypes, /export type FileVariant = 'THUMBNAIL' \| 'CARD' \| 'DETAIL';/);
});
