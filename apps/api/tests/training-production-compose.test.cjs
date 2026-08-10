const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');

const root = resolve(__dirname, '../../..');

function readRootFile(name) {
  return readFileSync(resolve(root, name), 'utf8');
}

function serviceBlock(compose, serviceName) {
  const marker = `  ${serviceName}:`;
  const start = compose.indexOf(marker);
  assert.notEqual(start, -1, `Missing Compose service ${serviceName}`);
  const remaining = compose.slice(start + marker.length);
  const nextService = remaining.search(/\n  [a-z0-9][a-z0-9-]*:\s*\n/u);
  return nextService === -1
    ? compose.slice(start)
    : compose.slice(start, start + marker.length + nextService);
}

function countServiceDeclarations(compose, serviceName) {
  return compose.split(`\n  ${serviceName}:`).length - 1;
}

test('production Compose has one dedicated voice worker and no API worker', () => {
  const base = readRootFile('docker-compose.yml');
  const production = readRootFile('docker-compose.production.yml');
  const baseApi = serviceBlock(base, 'api');
  const baseWorker = serviceBlock(base, 'training-voice-worker');
  const productionApi = serviceBlock(production, 'api');
  const productionWorker = serviceBlock(production, 'training-voice-worker');

  assert.equal(countServiceDeclarations(base, 'training-voice-worker'), 1);
  assert.equal(countServiceDeclarations(production, 'training-voice-worker'), 1);
  assert.match(baseApi, /TRAINING_VOICE_WORKER_ENABLED: "false"/u);
  assert.match(baseWorker, /TRAINING_VOICE_WORKER_ENABLED: "true"/u);
  assert.match(productionApi, /TRAINING_VOICE_WORKER_ENABLED: "false"/u);
  assert.match(productionWorker, /TRAINING_VOICE_WORKER_ENABLED: "true"/u);
  assert.match(productionApi, /TRAINING_MATERIAL_WORKER_ENABLED: "true"/u);
  assert.match(productionWorker, /TRAINING_MATERIAL_WORKER_ENABLED: "false"/u);
  assert.match(productionWorker, /TRAINING_TELEGRAM_OUTBOX_WORKER_ENABLED: "false"/u);
  assert.match(productionWorker, /deploy:\s*\n\s+replicas: 1/u);
});

test('production API and voice worker share one required image and safe lifecycle', () => {
  const base = readRootFile('docker-compose.yml');
  const production = readRootFile('docker-compose.production.yml');
  const baseApi = serviceBlock(base, 'api');
  const baseWorker = serviceBlock(base, 'training-voice-worker');
  const productionApi = serviceBlock(production, 'api');
  const productionWorker = serviceBlock(production, 'training-voice-worker');
  const imagePattern = /image: "(\$\{API_IMAGE:\?API_IMAGE is required\})"/u;

  assert.equal(productionApi.match(imagePattern)?.[1], '${API_IMAGE:?API_IMAGE is required}');
  assert.equal(productionWorker.match(imagePattern)?.[1], '${API_IMAGE:?API_IMAGE is required}');
  assert.match(productionApi, /init: true/u);
  assert.match(productionWorker, /init: true/u);
  assert.match(productionApi, /restart: unless-stopped/u);
  assert.match(productionWorker, /restart: unless-stopped/u);
  assert.match(baseApi, /stop_grace_period: 30s/u);
  assert.match(productionWorker, /stop_grace_period: 30s/u);
  assert.match(baseWorker, /command: \["node", "apps\/api\/dist\/training-voice-worker\.main\.js"\]/u);
  assert.match(productionWorker, /depends_on:\s*\n\s+api:\s*\n\s+condition: service_healthy/u);
});

test('production Compose is fail-closed and preserves the 100 MiB PDF contract', () => {
  const production = readRootFile('docker-compose.production.yml');
  const productionExample = readRootFile('.env.production.example');
  const productionApi = serviceBlock(production, 'api');
  const productionWorker = serviceBlock(production, 'training-voice-worker');

  for (const requiredName of [
    'API_IMAGE',
    'DATABASE_URL',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'OPENAI_API_KEY',
    'OPENAI_TRANSCRIPTION_MODEL',
    'OPENAI_QUESTION_GENERATION_MODEL',
    'OPENAI_EVALUATOR_MODEL',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_WEBHOOK_SECRET',
  ]) {
    assert.match(production, new RegExp(`\\$\\{${requiredName}:\\?`, 'u'));
  }

  assert.match(productionApi, /TRAINING_AI_MODE: openai/u);
  assert.match(productionWorker, /TRAINING_AI_MODE: openai/u);
  assert.match(productionApi, /TELEGRAM_TRANSPORT_MODE: real/u);
  assert.match(productionWorker, /TELEGRAM_TRANSPORT_MODE: real/u);
  assert.match(productionApi, /TRAINING_MATERIAL_MAX_BYTES: "104857600"/u);
  assert.match(productionExample, /^TRAINING_MATERIAL_MAX_BYTES=104857600$/mu);
  assert.match(productionExample, /^TRAINING_VOICE_WORKER_ENABLED=false$/mu);
  assert.doesNotMatch(production, /:-(?:development|fake)|change-me|platforma_password/iu);
});

test('production infrastructure stays private and runtime services restart', () => {
  const production = readRootFile('docker-compose.production.yml');

  for (const serviceName of ['postgres', 'redis', 'minio']) {
    const block = serviceBlock(production, serviceName);
    assert.match(block, /restart: unless-stopped/u);
    assert.match(block, /ports: !reset \[\]/u);
  }

  for (const serviceName of ['api', 'training-voice-worker', 'web']) {
    assert.match(serviceBlock(production, serviceName), /restart: unless-stopped/u);
  }

  assert.match(serviceBlock(production, 'api'), /127\.0\.0\.1:\$\{API_PORT:-3000\}:3000/u);
  assert.match(serviceBlock(production, 'web'), /127\.0\.0\.1:\$\{WEB_PORT:-5173\}:5173/u);
});
