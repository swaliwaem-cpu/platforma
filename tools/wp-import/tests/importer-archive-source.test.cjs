const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const source = readFileSync(resolve(__dirname, '../src/importer.ts'), 'utf8');

test('full WordPress import archives previously imported objects that are no longer in the published source', () => {
  assert.match(source, /archiveImportedObjectsMissingFromSource\(mapped, context\)/);
  assert.match(source, /config\.wp\.importLimit === null/);
  assert.match(source, /ObjectStatus\.ARCHIVED/);
  assert.match(source, /type:\s*mapped\.objectType/);
  assert.match(source, /wpPostId:\s*\{[\s\S]*?notIn:\s*sourceWpPostIds[\s\S]*?\}/);
  assert.match(source, /objectsArchived/);
});

test('WordPress import does not attach a cross-type slug match to the imported object', () => {
  assert.match(source, /existingBySlug\.type === object\.type/);
  assert.match(source, /slug = await getUniqueObjectSlug\(tx, object\.slug, object\.wpPostId\)/);
  assert.match(source, /object_slug_conflict/);
});
