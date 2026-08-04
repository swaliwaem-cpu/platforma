const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const repositoryRoot = resolve(__dirname, '../../..');
const read = (path) => readFileSync(resolve(repositoryRoot, path), 'utf8');

const compose = read('docker-compose.yml');
const productionCompose = read('docker-compose.production.yml');
const dockerfile = read('apps/api/Dockerfile');
const transitionMigration = read(
  'apps/api/prisma/migrations/20260731120000_replace_training_v1_with_v2/migration.sql',
);

test('production Compose runs Training V2 workers inside the protected API service', () => {
  assert.match(compose, /api:[\s\S]*init: true[\s\S]*PLATFORMA_API_IMAGE/);
  assert.match(compose, /TRAINING_MATERIAL_BUCKET/);
  assert.match(compose, /TRAINING_VOICE_WORKER_ENABLED/);
  assert.doesNotMatch(compose, /^  training-worker:/mu);

  assert.match(productionCompose, /TRAINING_AI_MODE: openai/);
  assert.match(productionCompose, /TELEGRAM_TRANSPORT_MODE: real/);
  assert.match(productionCompose, /TRAINING_MATERIAL_BUCKET:[\s\S]*is required/);
  assert.match(productionCompose, /TRAINING_AUDIO_BUCKET:[\s\S]*is required/);
  assert.doesNotMatch(productionCompose, /^  training-worker:/mu);
});

test('container validates production runtime before applying migrations', () => {
  const preflight = dockerfile.indexOf('training-runtime-preflight.js');
  const migration = dockerfile.indexOf('prisma migrate deploy');

  assert.ok(preflight >= 0);
  assert.ok(migration > preflight);
});

test('V1 replacement migration is prefix-scoped and ordered before V2', () => {
  assert.ok('20260731120000_replace_training_v1_with_v2' < '20260801120000_add_training_v2_stage_1');
  assert.match(transitionMigration, /schemaname = 'public'/);
  assert.match(transitionMigration, /tablename LIKE 'training\\_%' ESCAPE '\\'/);
  assert.match(transitionMigration, /procedure\.proname LIKE 'training\\_%' ESCAPE '\\'/);
  assert.match(transitionMigration, /type\.typname LIKE 'training\\_%' ESCAPE '\\'/);
  assert.match(transitionMigration, /DROP TABLE %I\.%I CASCADE/);
  assert.match(transitionMigration, /DROP FUNCTION %I\.%I\(%s\) CASCADE/);
  assert.match(transitionMigration, /DROP TYPE %I\.%I CASCADE/);
});
