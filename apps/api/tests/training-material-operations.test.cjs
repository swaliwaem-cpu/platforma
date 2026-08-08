const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');

const root = resolve(__dirname, '../../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

test('material creation endpoints expose durable asynchronous operations', () => {
  const controller = read('apps/api/src/training/training-material.controller.ts');
  const shared = read('packages/shared/src/training.ts');

  assert.match(controller, /@HttpCode\(HttpStatus\.ACCEPTED\)[\s\S]*queueObjectImport/u);
  assert.match(controller, /response\.status\(HttpStatus\.ACCEPTED\)[\s\S]*queueOfficialUrl/u);
  assert.match(controller, /@HttpCode\(HttpStatus\.ACCEPTED\)[\s\S]*queuePdf/u);
  assert.match(controller, /material-operations\/:operationId\/retry/u);
  assert.match(controller, /parseUuid\(idempotencyKey, 'Idempotency-Key'\)/u);
  for (const status of ['QUEUED', 'STORING', 'EXTRACTING', 'GENERATING', 'PERSISTING', 'READY', 'FAILED', 'CANCELLED']) {
    assert.match(shared, new RegExp(`'${status}'`, 'u'));
  }
});

test('material worker uses PostgreSQL claims, fencing, checkpoints and bounded concurrency', () => {
  const worker = read('apps/api/src/training/training-material-operation.service.ts');
  const material = read('apps/api/src/training/training-material.service.ts');

  assert.match(worker, /FOR UPDATE OF operation SKIP LOCKED/u);
  assert.match(worker, /pg_advisory_xact_lock/u);
  assert.match(worker, /active\."project_id" = operation\."project_id"/u);
  assert.match(worker, /lockedBy: claim\.lockOwner/u);
  assert.match(worker, /recoverStoringOperations/u);
  assert.match(worker, /MATERIAL_SOURCE_UPLOAD_INTERRUPTED/u);
  assert.match(worker, /item\.status !== TrainingMaterialOperationStatus\.QUEUED/u);
  assert.match(worker, /baseKnowledgeVersion: project\.knowledgeVersion/u);
  assert.match(material, /checkpoint: 'QUESTIONS_PERSISTED'/u);
  assert.match(material, /checkpointedItemKeys\.has\(operationItemKey\)/u);
  assert.match(material, /QUESTION_KNOWLEDGE_STALE/u);
  assert.match(material, /expectedProjectKnowledgeVersion/u);
});

test('PDF data flows through temporary files instead of a request-sized heap buffer', () => {
  const upload = read('apps/api/src/training/training-material-upload.ts');
  const storage = read('apps/api/src/files/s3-storage.service.ts');
  const extraction = read('apps/api/src/training/training-material-extraction.ts');
  const files = read('apps/api/src/files/files.service.ts');

  assert.match(upload, /pipeline\(file\.stream, meter, createWriteStream/u);
  assert.match(upload, /checksum\.update/u);
  assert.match(storage, /getObjectToFile/u);
  assert.match(storage, /pipeline\(source, meter, createWriteStream/u);
  assert.match(extraction, /extractPdfFile/u);
  assert.match(files, /training-v2\/material-operations\//u);
  assert.match(files, /trainingMaterialOperations/u);
});

test('additive migration protects operation invariants and queue access paths', () => {
  const migration = read('apps/api/prisma/migrations/20260808120000_add_training_material_operations/migration.sql');

  assert.match(migration, /CREATE TABLE "training_material_operations"/u);
  assert.match(migration, /CREATE TABLE "training_material_operation_items"/u);
  assert.match(migration, /training_material_operations_progress_check/u);
  assert.match(migration, /training_material_operations_lock_pair_check/u);
  assert.match(migration, /WHERE "status" = 'queued'/u);
  assert.match(migration, /WHERE "status" IN \('extracting', 'generating', 'persisting'\)/u);
  assert.match(migration, /training_material_operations_project_active_idx/u);
  assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN|TRUNCATE/u);
});
