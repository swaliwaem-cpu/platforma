const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '../../..');
const schemaPath = path.join(rootDir, 'apps/api/prisma/schema.prisma');
const migrationPath = path.join(
  rootDir,
  'apps/api/prisma/migrations/20260605190000_add_object_aerotour_url/migration.sql',
);

function readProjectFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

test('Prisma schema defines optional object aerotour url', () => {
  const schema = readProjectFile(schemaPath);

  assert.match(
    schema,
    /model RealEstateObject \{[\s\S]*aerotourUrl\s+String\?\s+@map\("aerotour_url"\)\s+@db\.VarChar\(2048\)[\s\S]*layoutsUrl\s+String\?\s+@map\("layouts_url"\)\s+@db\.VarChar\(2048\)[\s\S]*\}/,
  );
});

test('object aerotour migration adds nullable url column', () => {
  assert.equal(fs.existsSync(migrationPath), true);

  const migration = readProjectFile(migrationPath);

  assert.match(
    migration,
    /ALTER TABLE "real_estate_objects" ADD COLUMN "aerotour_url" VARCHAR\(2048\)/,
  );
});
