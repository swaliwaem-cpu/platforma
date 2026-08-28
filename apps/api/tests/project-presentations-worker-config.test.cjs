const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  isProjectPresentationsWorkerEnabled,
} = require('../dist/project-presentations/project-presentations-worker.service.js');

test('project presentation worker stays enabled by default', () => {
  assert.equal(isProjectPresentationsWorkerEnabled({}), true);
  assert.equal(isProjectPresentationsWorkerEnabled({ PROJECT_PRESENTATIONS_WORKER_ENABLED: 'true' }), true);
});

test('project presentation worker can be disabled for an isolated runtime', () => {
  assert.equal(isProjectPresentationsWorkerEnabled({ PROJECT_PRESENTATIONS_WORKER_ENABLED: 'false' }), false);
});

test('project presentation worker rejects ambiguous configuration', () => {
  assert.throws(
    () => isProjectPresentationsWorkerEnabled({ PROJECT_PRESENTATIONS_WORKER_ENABLED: 'yes' }),
    /PROJECT_PRESENTATIONS_WORKER_ENABLED_INVALID/u,
  );
});
