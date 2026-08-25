const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const migrationPath = resolve(
  __dirname,
  '../prisma/migrations/20260825234500_sync_moscow_metro_directory/migration.sql',
);

test('metro directory migration adds the complete source snapshot without destructive writes', () => {
  const migration = readFileSync(migrationPath, 'utf8');

  assert.match(migration, /Snapshot fetched from https:\/\/api\.hh\.ru\/metro\/1 on 2026-08-25/);
  assert.equal((migration.match(/\('hh-/g) ?? []).length, 449);
  assert.match(migration, /'Славянский бульвар', 'Арбатско-Покровская', '#0072BA'/);
  assert.match(migration, /'Парк Победы', 'Солнцевская', '#FFCD1C'/);
  assert.match(migration, /'Академическая', 'Троицкая', '#03795F'/);
  assert.match(migration, /'ЗИЛ', 'МЦК', '#CC4C6E'/);
  assert.match(migration, /'ЗИЛ', 'Троицкая', '#03795F'/);
  assert.match(migration, /UPDATE "metro_stations" AS target/);
  assert.match(migration, /INSERT INTO "metro_stations"/);
  assert.match(migration, /WHERE NOT EXISTS/);
  assert.doesNotMatch(migration, /\bDELETE\b|\bTRUNCATE\b|DROP\s+TABLE/i);
});
