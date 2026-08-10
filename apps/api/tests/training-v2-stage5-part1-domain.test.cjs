require('reflect-metadata');

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const { BadRequestException, NotFoundException } = require('@nestjs/common');

const {
  TrainingAudioAccessService,
} = require('../dist/training/training-audio-access.service.js');
const {
  parseTrainingAdminResultsQuery,
} = require('../dist/training/training.validation.js');

const answerId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const attemptId = '33333333-3333-4333-8333-333333333333';
const projectId = '44444444-4444-4444-8444-444444444444';
const fileId = '55555555-5555-4555-8555-555555555555';

test('Stage 5 Part 1 results query applies bounded defaults and rejects inconsistent ranges', () => {
  const parsed = parseTrainingAdminResultsQuery({
    search: ' сотрудник ',
    passed: 'false',
    scoreMin: '10',
    scoreMax: '90',
    source: 'TELEGRAM',
    sort: 'DURATION_DESC',
  });

  assert.equal(parsed.page, 1);
  assert.equal(parsed.limit, 20);
  assert.equal(parsed.search, 'сотрудник');
  assert.equal(parsed.passed, false);
  assert.equal(parsed.source, 'TELEGRAM');
  assert.equal(parsed.sort, 'DURATION_DESC');
  assert.throws(() => parseTrainingAdminResultsQuery({ limit: '101' }), BadRequestException);
  assert.throws(
    () => parseTrainingAdminResultsQuery({ scoreMin: '80', scoreMax: '20' }),
    BadRequestException,
  );
  assert.throws(
    () => parseTrainingAdminResultsQuery({ startedFrom: '2026-08-03', startedTo: '2026-08-02' }),
    BadRequestException,
  );
});

test('Stage 5 Part 1 protected audio verifies the private WAV and records a bounded audit', async () => {
  const wav = Buffer.alloc(48);
  wav.write('RIFF', 0, 'ascii');
  wav.write('WAVE', 8, 'ascii');
  const auditWrites = [];
  const prisma = {
    trainingAnswer: { findUnique: async () => answerRecord(wav) },
    auditLog: { create: async (input) => auditWrites.push(input.data) },
  };
  const storage = {
    getBucket: () => 'platforma',
    getObject: async () => wav,
  };
  const audio = await new TrainingAudioAccessService(prisma, storage)
    .readAnswerAudio(answerId, actorId);

  assert.equal(audio.mimeType, 'audio/wav');
  assert.deepEqual(audio.buffer, wav);
  assert.deepEqual(auditWrites, [{
    actorUserId: actorId,
    action: 'training.audio.read',
    entityType: 'training_answer',
    entityId: answerId,
    metadata: { attemptId, projectId, fileId, sizeBytes: 48 },
  }]);
  assert.doesNotMatch(JSON.stringify(auditWrites), /bucket|key|checksum/iu);
});

test('Stage 5 Part 1 protected audio fails closed without an audit on invalid storage data', async () => {
  const wav = Buffer.alloc(48);
  wav.write('RIFF', 0, 'ascii');
  wav.write('WAVE', 8, 'ascii');
  const auditWrites = [];
  const prisma = {
    trainingAnswer: { findUnique: async () => answerRecord(wav) },
    auditLog: { create: async (input) => auditWrites.push(input.data) },
  };
  const storage = {
    getBucket: () => 'platforma',
    getObject: async () => Buffer.from('not-a-wave'),
  };

  await assert.rejects(
    new TrainingAudioAccessService(prisma, storage).readAnswerAudio(answerId, actorId),
    NotFoundException,
  );
  assert.deepEqual(auditWrites, []);
});

test('protected audio serves new private WebM Opus files without weakening the audit', async () => {
  const webm = Buffer.alloc(64);
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).copy(webm);
  const auditWrites = [];
  const prisma = {
    trainingAnswer: { findUnique: async () => answerRecord(webm, 'webm') },
    auditLog: { create: async (input) => auditWrites.push(input.data) },
  };
  const storage = {
    getBucket: () => 'platforma',
    getObject: async () => webm,
  };

  const audio = await new TrainingAudioAccessService(prisma, storage)
    .readAnswerAudio(answerId, actorId);

  assert.equal(audio.mimeType, 'audio/webm');
  assert.equal(audio.fileName, 'training-answer-audio.webm');
  assert.equal(auditWrites.length, 1);
});

function answerRecord(audio, format = 'wav') {
  const mimeType = format === 'webm' ? 'audio/webm' : 'audio/wav';
  return {
    id: answerId,
    source: 'TELEGRAM',
    mergedAudioFile: {
      id: fileId,
      storage: 'MINIO',
      bucket: 'platforma-training-audio',
      key: `training-v2/answers/${answerId}/merged.${format}`,
      url: null,
      mimeType,
      sizeBytes: BigInt(audio.length),
      checksum: createHash('sha256').update(audio).digest('hex'),
    },
    attemptQuestion: { attempt: { id: attemptId, projectId } },
  };
}
