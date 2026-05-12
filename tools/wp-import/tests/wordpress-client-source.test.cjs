const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const source = readFileSync(resolve(__dirname, '../src/wordpress-client.ts'), 'utf8');

test('WordPress import reads only published site objects', () => {
  assert.match(source, /const params: unknown\[\] = \[this\.config\.postType, 'publish'\]/);
  assert.match(source, /AND post_status = \?/);
  assert.doesNotMatch(source, /'draft'/);
  assert.doesNotMatch(source, /'private'/);
  assert.doesNotMatch(source, /post_status IN \(\?, \?, \?\)/);
});
