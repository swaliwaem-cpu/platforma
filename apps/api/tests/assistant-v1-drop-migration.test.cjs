const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const migration = readFileSync(
  resolve(__dirname, '../prisma/migrations/20260926140000_drop_assistant_v1/migration.sql'),
  'utf8',
);
const schema = readFileSync(resolve(__dirname, '../prisma/schema.prisma'), 'utf8');

test('assistant v1 removal keeps the metro walk tables, the v2 turn log and pgvector', () => {
  const droppedTables = [...migration.matchAll(/"(assistant_[a-z_]+)"/gu)].map(([, name]) => name);

  for (const kept of ['assistant_metro_access_points', 'assistant_object_metro_route_facts', 'assistant_turns']) {
    assert.ok(!droppedTables.includes(kept), kept);
  }
  assert.doesNotMatch(migration, /EXTENSION/u);
  assert.doesNotMatch(migration, /\bCASCADE\b/u);
  assert.match(migration, /DROP TABLE[\s\S]*"assistant_runs"[\s\S]*"assistant_knowledge_sources";/u);
  assert.equal((migration.match(/DROP FUNCTION/gu) ?? []).length, 5);
  assert.match(migration, /DELETE FROM "permissions" WHERE "key" IN \('assistant:audit:read', 'assistant:sources:manage'\)/u);

  assert.match(schema, /model AssistantMetroAccessPoint \{/u);
  assert.match(schema, /model AssistantObjectMetroRouteFact \{/u);
  assert.match(schema, /assistantMetroRouteFact\s+AssistantObjectMetroRouteFact\?/u);
  assert.doesNotMatch(schema, /model AssistantRun \{|enum AssistantRunStatus \{|AssistantKnowledgeSource/u);
});
