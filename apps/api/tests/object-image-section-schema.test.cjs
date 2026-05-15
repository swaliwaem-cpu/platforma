const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '../../..');
const schemaPath = path.join(rootDir, 'apps/api/prisma/schema.prisma');
const sharedTypesPath = path.join(rootDir, 'packages/shared/src/index.ts');
const migrationPath = path.join(
  rootDir,
  'apps/api/prisma/migrations/20260515120000_add_object_image_sections/migration.sql',
);

function readProjectFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

test('Prisma schema defines optional object image sections', () => {
  const schema = readProjectFile(schemaPath);

  assert.match(schema, /enum ObjectImageSection \{[\s\S]*ARCHITECTURE\s+@map\("architecture"\)[\s\S]*INTERIORS\s+@map\("interiors"\)[\s\S]*FILLING\s+@map\("filling"\)[\s\S]*@@map\("object_image_section"\)[\s\S]*\}/);
  assert.match(schema, /model ObjectImage \{[\s\S]*section\s+ObjectImageSection\?\s+@map\("section"\)[\s\S]*\}/);
  assert.match(schema, /@@index\(\[objectId, section\]\)/);
});

test('object image sections migration creates enum, column and index', () => {
  const migration = readProjectFile(migrationPath);

  assert.match(migration, /CREATE TYPE "object_image_section" AS ENUM \('architecture', 'interiors', 'filling'\)/);
  assert.match(migration, /ALTER TABLE "object_images" ADD COLUMN "section" "object_image_section"/);
  assert.match(migration, /CREATE INDEX "object_images_object_id_section_idx" ON "object_images"\("object_id", "section"\)/);
});

test('shared package exports object image section contract', () => {
  const sharedTypes = readProjectFile(sharedTypesPath);

  assert.match(sharedTypes, /export type ObjectImageSection = 'ARCHITECTURE' \| 'INTERIORS' \| 'FILLING';/);
  assert.match(sharedTypes, /export type ObjectImage = \{[\s\S]*section: ObjectImageSection \| null;[\s\S]*\};/);
});
