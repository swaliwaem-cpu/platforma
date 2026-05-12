const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const source = readFileSync(resolve(__dirname, '../src/importer.ts'), 'utf8');

test('full WordPress import archives previously imported objects that are no longer in the published source', () => {
  assert.match(source, /archiveImportedObjectsMissingFromSource\(mapped, context\)/);
  assert.match(source, /config\.wp\.importLimit === null/);
  assert.match(source, /ObjectStatus\.ARCHIVED/);
  assert.match(source, /wpPostId:\s*\{[\s\S]*?notIn:\s*sourceWpPostIds[\s\S]*?\}/);
  assert.match(source, /objectsArchived/);
});
