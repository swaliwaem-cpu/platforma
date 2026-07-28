require('reflect-metadata');

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { ConflictException } = require('@nestjs/common');
const {
  PrismaClient,
  TrainingAnswerStatus,
  TrainingAttemptQuestionStatus,
  TrainingAttemptStatus,
  TrainingJobKind,
  TrainingJobStatus,
  TrainingPassStatus,
  TrainingProjectStatus,
  TrainingQuestionType,
  TrainingVersionStatus,
  UserStatus,
} = require('@prisma/client');

const {
  TrainingAudioAccessService,
} = require('../dist/training/audio/training-audio-access.service.js');
const {
  FilesService,
} = require('../dist/files/files.service.js');
const {
  TrainingAudioError,
} = require('../dist/training/audio/training-audio.error.js');
const {
  TrainingAudioWorkerService,
} = require('../dist/training/audio/training-audio-worker.service.js');
const {
  TrainingAttemptEngineService,
} = require('../dist/training/training-attempt-engine.service.js');
const {
  DeterministicFakeTrainingEvaluationProvider,
  DeterministicFakeTrainingTranscriptionProvider,
} = require('../dist/training/training-attempt.providers.js');
const {
  DeterministicQuestionSelector,
  MutableTrainingClock,
} = require('./helpers/training-attempt-fake-prisma.cjs');

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL must point to the runner-created isolated training database',
  );
}

const prisma = new PrismaClient();
const fakeTranscription =
  new DeterministicFakeTrainingTranscriptionProvider();
const fakeEvaluation = new DeterministicFakeTrainingEvaluationProvider();

test.after(async () => {
  await prisma.$disconnect();
});

test('PostgreSQL audio lifecycle persists deterministic download and one private merged file', async () => {
  const fixture = await createFixture();
  const clock = createClock();
  const engine = createEngine(clock);
  const attempt = await startAttempt(engine, fixture);
  const question = currentQuestion(attempt);
  const fileUniqueId = 'same-file-inside-answer';

  await appendVoice(engine, clock, attempt.id, {
    updateId: 70_001n,
    fileUniqueId,
    transcript: 'первая часть ответа',
  });
  await appendVoice(engine, clock, attempt.id, {
    updateId: 70_002n,
    fileUniqueId,
    transcript: 'duplicate must be a no-op',
  });
  await appendVoice(engine, clock, attempt.id, {
    updateId: 70_003n,
    fileUniqueId: 'second-file',
    transcript: 'вторая часть ответа',
  });

  const answerBeforeFinish = await findAnswer(attempt.id);
  assert.equal(answerBeforeFinish.voiceSegments.length, 2);
  assert.deepEqual(
    answerBeforeFinish.voiceSegments.map(
      (segment) => segment.segmentIndex,
    ),
    [1, 2],
  );
  assert.equal(
    await prisma.trainingJob.count({
      where: {
        kind: TrainingJobKind.TELEGRAM_DOWNLOAD_SEGMENT,
        idempotencyKey: {
          startsWith: `attempt:${attempt.id}:answer:${answerBeforeFinish.id}:`,
        },
      },
    }),
    2,
  );
  assert.equal(
    await prisma.trainingJob.count({
      where: {
        kind: TrainingJobKind.ASSEMBLE_ANSWER_AUDIO,
        payloadJson: { path: ['answerId'], equals: answerBeforeFinish.id },
      },
    }),
    0,
  );

  await engine.finishAnswer({
    attemptId: attempt.id,
    attemptQuestionId: question.id,
  });
  const storage = createStorage();
  const ffmpeg = createFfmpegFixture(storage);
  const provider = createAudioProvider();
  const worker = createWorker({ storage, ffmpeg, provider });
  await drainAudio(worker);

  const answer = await findAnswer(attempt.id);
  assert.ok(
    answer.mergedAudioFile,
    JSON.stringify({
      jobs: await audioJobDiagnostics(attempt.id),
      providerCalls: provider.calls,
      objects: [...storage.objects.keys()],
      orders: ffmpeg.orders,
    }),
  );
  assert.equal(answer.mergedAudioFile.url, null);
  assert.equal(answer.mergedAudioFile.bucket, AUDIO_BUCKET);
  assert.equal(answer.mergedAudioFile.originalName, null);
  assert.equal(answer.voiceSegments.every((segment) => segment.originalFile), true);
  assert.equal(
    new Set(answer.voiceSegments.map((segment) => segment.originalFileId))
      .size,
    2,
  );
  assert.deepEqual(ffmpeg.orders, [[1, 2]]);
  assert.equal(provider.calls.length, 2);
  assert.equal(storage.objects.size, 3);
  assert.equal(
    await countAudioFilesForAttempt(attempt.id),
    3,
  );
  assert.equal(
    await prisma.trainingJob.count({
      where: {
        kind: TrainingJobKind.TRANSCRIBE_ANSWER,
        idempotencyKey: `attempt:${attempt.id}:answer:${answer.id}:transcribe`,
        status: TrainingJobStatus.PENDING,
      },
    }),
    1,
  );

  await drainAudio(worker);
  assert.equal(provider.calls.length, 2);
  assert.equal(storage.objects.size, 3);
  assert.equal(
    await countAudioFilesForAttempt(attempt.id),
    3,
  );
});

test('PostgreSQL historical result chain and linked audio File use RESTRICT without storage-first deletion', async () => {
  const fixture = await createFixture();
  const clock = createClock();
  const engine = createEngine(clock);
  const attempt = await startAttempt(engine, fixture);
  const question = currentQuestion(attempt);
  await appendVoice(engine, clock, attempt.id, {
    updateId: 70_501n,
    fileUniqueId: 'historical-restrict',
    transcript: 'исторический ответ',
  });
  await engine.finishAnswer({
    attemptId: attempt.id,
    attemptQuestionId: question.id,
  });
  const storage = createStorage();
  await drainAudio(
    createWorker({
      storage,
      provider: createAudioProvider(),
      ffmpeg: createFfmpegFixture(storage),
    }),
  );
  const answer = await findAnswer(attempt.id);
  assert.ok(answer.mergedAudioFile);
  const evaluation = await prisma.trainingAnswerEvaluation.create({
    data: {
      answerId: answer.id,
      evaluationNumber: 1,
      actualModelId: 'fake-history',
      promptVersion: '1',
      schemaVersion: '1',
      rubricVersion: '1',
      structuredResultJson: {},
      aiSuggestedScore: 1,
      serverScore: 1,
    },
  });
  await prisma.trainingScoreComponent.create({
    data: {
      evaluationId: evaluation.id,
      componentKey: 'history',
      awardedPoints: 1,
      maxPoints: 1,
    },
  });
  await prisma.trainingResultReview.create({
    data: {
      attemptId: attempt.id,
      reviewerId: fixture.publisherId,
      reviewNumber: 1,
      finalScore: 1,
      decision: 'APPROVED',
      comment: 'Historical result remains archived',
    },
  });

  const expectedConstraints = [
    'training_attempt_questions_attempt_id_fkey',
    'training_answers_attempt_question_id_fkey',
    'training_voice_segments_answer_id_fkey',
    'training_answer_evaluations_answer_id_fkey',
    'training_score_components_evaluation_id_fkey',
    'training_result_reviews_attempt_id_fkey',
    'training_answers_merged_audio_file_id_fkey',
    'training_voice_segments_original_file_id_fkey',
  ];
  const constraints = await prisma.$queryRawUnsafe(
    `SELECT conname, confdeltype
     FROM pg_constraint
     WHERE conname = ANY($1::text[])
     ORDER BY conname`,
    expectedConstraints,
  );
  assert.deepEqual(
    constraints.map((constraint) => constraint.conname),
    [...expectedConstraints].sort(),
  );
  assert.equal(
    constraints.every(
      (constraint) => constraint.confdeltype === 'r',
    ),
    true,
  );

  await assertForeignKeyViolation(() =>
    prisma.$executeRawUnsafe(
      'DELETE FROM training_attempts WHERE id = $1::uuid',
      attempt.id,
    ),
  );
  await assertForeignKeyViolation(() =>
    prisma.$executeRawUnsafe(
      'DELETE FROM training_attempt_questions WHERE id = $1::uuid',
      question.id,
    ),
  );
  await assertForeignKeyViolation(() =>
    prisma.$executeRawUnsafe(
      'DELETE FROM training_answers WHERE id = $1::uuid',
      answer.id,
    ),
  );

  const storageDeletes = [];
  const filesService = new FilesService(prisma, {
    deleteObject: async (key) => {
      storageDeletes.push(key);
    },
  });
  await assert.rejects(
    () => filesService.delete(answer.mergedAudioFile.id),
    ConflictException,
  );
  assert.deepEqual(storageDeletes, []);

  await prisma.trainingProject.update({
    where: { id: fixture.projectId },
    data: {
      status: TrainingProjectStatus.ARCHIVED,
      archivedAt: new Date(),
    },
  });
  assert.equal(
    await prisma.trainingAttempt.count({
      where: { id: attempt.id },
    }),
    1,
  );
  assert.equal(
    await prisma.trainingAttemptQuestion.count({
      where: { id: question.id },
    }),
    1,
  );
  assert.equal(
    await prisma.trainingAnswer.count({
      where: { id: answer.id },
    }),
    1,
  );
  assert.equal(
    await prisma.file.count({
      where: { id: answer.mergedAudioFile.id },
    }),
    1,
  );
});

test('PostgreSQL merge waits for the unfinished segment without consuming an attempt and preserves order', async () => {
  const fixture = await createFixture();
  const clock = createClock();
  const engine = createEngine(clock);
  const attempt = await startAttempt(engine, fixture);
  const question = currentQuestion(attempt);
  await appendVoice(engine, clock, attempt.id, {
    updateId: 71_001n,
    fileUniqueId: 'order-first',
    transcript: 'first',
  });
  await appendVoice(engine, clock, attempt.id, {
    updateId: 71_002n,
    fileUniqueId: 'order-second',
    transcript: 'second',
  });
  await engine.finishAnswer({
    attemptId: attempt.id,
    attemptQuestionId: question.id,
  });
  const answer = await findAnswer(attempt.id);
  const delayedSegment = answer.voiceSegments[1];
  await prisma.trainingJob.update({
    where: {
      idempotencyKey: `attempt:${attempt.id}:answer:${answer.id}:segment:${delayedSegment.id}:download`,
    },
    data: { runAt: new Date('2099-01-01T00:00:00.000Z') },
  });
  const storage = createStorage();
  const ffmpeg = createFfmpegFixture(storage);
  const worker = createWorker({
    storage,
    ffmpeg,
    provider: createAudioProvider(),
  });
  await worker.drainNow();

  const waitingJob = await prisma.trainingJob.findUnique({
    where: {
      idempotencyKey: `attempt:${attempt.id}:answer:${answer.id}:assemble`,
    },
  });
  assert.equal(waitingJob.status, TrainingJobStatus.PENDING);
  assert.equal(waitingJob.attempts, 0);
  assert.equal((await findAnswer(attempt.id)).mergedAudioFileId, null);
  assert.deepEqual(ffmpeg.orders, []);

  await prisma.trainingJob.updateMany({
    where: {
      idempotencyKey: {
        startsWith: `attempt:${attempt.id}:answer:${answer.id}:`,
      },
      status: TrainingJobStatus.PENDING,
    },
    data: { runAt: new Date('2000-01-01T00:00:00.000Z') },
  });
  await drainAudio(worker);

  assert.deepEqual(ffmpeg.orders, [[1, 2]]);
  assert.ok((await findAnswer(attempt.id)).mergedAudioFile);
});

test('PostgreSQL recovery after bucket A to B config change uses persisted bucket and is idempotent', async () => {
  const fixture = await createFixture();
  const clock = createClock();
  const engine = createEngine(clock);
  const attempt = await startAttempt(engine, fixture);
  await appendVoice(engine, clock, attempt.id, {
    updateId: 72_001n,
    fileUniqueId: 'crash-before-db',
    transcript: 'crash fixture',
  });
  const answer = await findAnswer(attempt.id);
  const storage = createStorage();
  const provider = createAudioProvider();
  let failAfterUpload = true;
  const crashingWorker = createWorker({
    storage,
    provider,
    ffmpeg: createFfmpegFixture(storage),
    faultInjection: {
      afterObjectUpload: async () => {
        if (failAfterUpload) {
          failAfterUpload = false;
          throw new Error('simulated process loss after object upload');
        }
      },
    },
  });
  await crashingWorker.drainNow();

  assert.equal(storage.objects.size, 1);
  assert.equal((await findAnswer(attempt.id)).voiceSegments[0].originalFile, null);
  const intentAfterFailure =
    await prisma.trainingAudioUploadIntent.findFirst({
      where: {
        segmentId: answer.voiceSegments[0].id,
      },
    });
  assert.ok(intentAfterFailure);
  assert.equal(intentAfterFailure.state, 'PENDING');
  assert.equal(intentAfterFailure.bucket, AUDIO_BUCKET);
  const retrying = await prisma.trainingJob.findUnique({
    where: {
      idempotencyKey: `attempt:${attempt.id}:answer:${answer.id}:segment:${answer.voiceSegments[0].id}:download`,
    },
  });
  assert.equal(retrying.status, TrainingJobStatus.PENDING);

  await prisma.trainingJob.update({
    where: { id: retrying.id },
    data: { runAt: new Date('2000-01-01T00:00:00.000Z') },
  });
  const decoyInRotatedBucket = Buffer.from(
    'must not be read, overwritten or deleted',
  );
  storage.objectsForBucket(ROTATED_AUDIO_BUCKET).set(
    intentAfterFailure.objectKey,
    decoyInRotatedBucket,
  );
  storage.metadataForBucket(ROTATED_AUDIO_BUCKET).set(
    intentAfterFailure.objectKey,
    {
      exists: true,
      contentLength: decoyInRotatedBucket.length,
      contentType: 'audio/wav',
      sha256: createHash('sha256')
        .update(decoyInRotatedBucket)
        .digest('hex'),
    },
  );
  storage.setCurrentBucket(ROTATED_AUDIO_BUCKET);
  storage.heads.length = 0;
  const recoveryWorker = createWorker({
    storage,
    provider,
    ffmpeg: createFfmpegFixture(storage),
  });
  await drainAudio(recoveryWorker);
  await recoveryWorker.drainNow();

  assert.equal(storage.objects.size, 1);
  assert.equal(storage.puts.length, 1);
  const recoveredSegment =
    (await findAnswer(attempt.id)).voiceSegments[0];
  assert.equal(recoveredSegment.originalFile.bucket, AUDIO_BUCKET);
  assert.equal(
    recoveredSegment.originalStorageBucket,
    AUDIO_BUCKET,
  );
  assert.equal(
    storage
      .objectsForBucket(ROTATED_AUDIO_BUCKET)
      .get(intentAfterFailure.objectKey)
      .equals(decoyInRotatedBucket),
    true,
  );
  assert.equal(
    storage.heads.some(
      (head) =>
        head.bucket === AUDIO_BUCKET &&
        head.key === intentAfterFailure.objectKey,
    ),
    true,
  );
  assert.equal(
    storage.heads.some(
      (head) =>
        head.bucket === ROTATED_AUDIO_BUCKET &&
        head.key === intentAfterFailure.objectKey,
    ),
    false,
  );
  assert.equal(
    await countAudioFilesForAttempt(attempt.id),
    1,
  );
});

test('PostgreSQL recovery covers failure before intent and after intent before upload', async () => {
  const fixture = await createFixture();
  const clock = createClock();
  const engine = createEngine(clock);
  const attempt = await startAttempt(engine, fixture);
  await appendVoice(engine, clock, attempt.id, {
    updateId: 72_101n,
    fileUniqueId: 'before-intent-failure',
    transcript: 'before intent',
  });
  const answer = await findAnswer(attempt.id);
  let providerCalls = 0;
  const provider = {
    downloadVoice: async () => {
      providerCalls += 1;
      if (providerCalls === 1) {
        throw new TrainingAudioError(
          'TELEGRAM_NETWORK_ERROR',
          true,
        );
      }
      return {
        body: Buffer.from('voice after provider recovery'),
        mimeType: 'audio/wav',
      };
    },
  };
  const storage = createStorage({ putFailures: 1 });
  const worker = createWorker({
    storage,
    provider,
    ffmpeg: createFfmpegFixture(storage),
  });

  await worker.drainNow();
  assert.equal(
    await prisma.trainingAudioUploadIntent.count({
      where: { segmentId: answer.voiceSegments[0].id },
    }),
    0,
  );
  const job = await prisma.trainingJob.findUnique({
    where: {
      idempotencyKey: `attempt:${attempt.id}:answer:${answer.id}:segment:${answer.voiceSegments[0].id}:download`,
    },
  });
  await prisma.trainingJob.update({
    where: { id: job.id },
    data: { runAt: new Date('2000-01-01T00:00:00.000Z') },
  });

  await worker.drainNow();
  const pendingIntent =
    await prisma.trainingAudioUploadIntent.findFirst({
      where: { segmentId: answer.voiceSegments[0].id },
    });
  assert.ok(pendingIntent);
  assert.equal(pendingIntent.state, 'PENDING');
  assert.equal(storage.objects.size, 0);

  await prisma.trainingJob.update({
    where: { id: job.id },
    data: { runAt: new Date('2000-01-01T00:00:00.000Z') },
  });
  await drainAudio(worker);
  const committedIntent =
    await prisma.trainingAudioUploadIntent.findUnique({
      where: { id: pendingIntent.id },
    });
  assert.equal(committedIntent.state, 'COMMITTED');
  assert.ok((await findAnswer(attempt.id)).voiceSegments[0].originalFile);
  assert.equal(storage.objects.size, 1);
});

test('PostgreSQL metadata mismatch is never linked and durable cleanup permits a safe retry', async () => {
  const fixture = await createFixture();
  const clock = createClock();
  const engine = createEngine(clock);
  const attempt = await startAttempt(engine, fixture);
  await appendVoice(engine, clock, attempt.id, {
    updateId: 72_201n,
    fileUniqueId: 'metadata-mismatch',
    transcript: 'metadata mismatch',
  });
  const answer = await findAnswer(attempt.id);
  const segment = answer.voiceSegments[0];
  const key = `training-audio/answers/${answer.id}/segments/${segment.id}.wav`;
  const storage = createStorage();
  storage.objects.set(key, Buffer.from('unknown object'));
  storage.metadata.set(key, {
    exists: true,
    contentLength: 14,
    contentType: 'audio/wav',
    sha256: '0'.repeat(64),
  });
  const worker = createWorker({
    storage,
    provider: createAudioProvider(),
    ffmpeg: createFfmpegFixture(storage),
  });
  await worker.drainNow();

  assert.equal((await findAnswer(attempt.id)).voiceSegments[0].originalFile, null);
  assert.equal(storage.objects.has(key), false);
  const intent = await prisma.trainingAudioUploadIntent.findFirst({
    where: { segmentId: segment.id },
  });
  assert.equal(intent.state, 'PENDING');
  const cleanup = await prisma.trainingJob.findFirst({
    where: {
      kind: TrainingJobKind.CLEANUP_TRAINING_AUDIO_OBJECT,
      payloadJson: { path: ['intentId'], equals: intent.id },
    },
  });
  assert.equal(cleanup.status, TrainingJobStatus.SUCCEEDED);

  const downloadJob = await prisma.trainingJob.findUnique({
    where: {
      idempotencyKey: `attempt:${attempt.id}:answer:${answer.id}:segment:${segment.id}:download`,
    },
  });
  await prisma.trainingJob.update({
    where: { id: downloadJob.id },
    data: { runAt: new Date('2000-01-01T00:00:00.000Z') },
  });
  await drainAudio(worker);
  assert.ok((await findAnswer(attempt.id)).voiceSegments[0].originalFile);
  assert.equal(
    await prisma.file.count({
      where: { bucket: AUDIO_BUCKET, key },
    }),
    1,
  );
});

test('PostgreSQL delete failure remains a retryable cleanup job and becomes visible as DEAD', async () => {
  const fixture = await createFixture();
  const clock = createClock();
  const engine = createEngine(clock);
  const attempt = await startAttempt(engine, fixture);
  await appendVoice(engine, clock, attempt.id, {
    updateId: 72_301n,
    fileUniqueId: 'cleanup-delete-failure',
    transcript: 'cleanup failure',
  });
  const answer = await findAnswer(attempt.id);
  const segment = answer.voiceSegments[0];
  const key = `training-audio/answers/${answer.id}/segments/${segment.id}.wav`;
  const storage = createStorage({ deleteFailures: 1 });
  storage.objects.set(key, Buffer.from('unknown object'));
  storage.metadata.set(key, {
    exists: true,
    contentLength: 14,
    contentType: 'audio/wav',
    sha256: 'f'.repeat(64),
  });
  const worker = createWorker({
    storage,
    provider: createAudioProvider(),
    ffmpeg: createFfmpegFixture(storage),
  });
  await worker.drainNow();
  const intent = await prisma.trainingAudioUploadIntent.findFirst({
    where: { segmentId: segment.id },
  });
  const cleanup = await prisma.trainingJob.findFirst({
    where: {
      kind: TrainingJobKind.CLEANUP_TRAINING_AUDIO_OBJECT,
      payloadJson: { path: ['intentId'], equals: intent.id },
    },
  });
  assert.equal(intent.state, 'CLEANUP_PENDING');
  assert.equal(cleanup.status, TrainingJobStatus.PENDING);
  assert.equal(cleanup.lastErrorCode, 'AUDIO_STORAGE_FAILED');
  assert.equal(storage.objects.has(key), true);
  await prisma.trainingJob.update({
    where: { id: cleanup.id },
    data: {
      maxAttempts: cleanup.attempts,
      runAt: new Date('2000-01-01T00:00:00.000Z'),
    },
  });
  await prisma.trainingJob.updateMany({
    where: {
      id: { not: cleanup.id },
      kind: TrainingJobKind.TELEGRAM_DOWNLOAD_SEGMENT,
      payloadJson: { path: ['answerId'], equals: answer.id },
    },
    data: { runAt: new Date('2099-01-01T00:00:00.000Z') },
  });
  await worker.drainNow();
  const dead = await prisma.trainingJob.findUnique({
    where: { id: cleanup.id },
  });
  assert.equal(dead.status, TrainingJobStatus.DEAD);
  assert.equal(dead.lastErrorCode, 'AUDIO_ATTEMPTS_EXHAUSTED');
  assert.equal(
    (
      await prisma.trainingAudioUploadIntent.findUnique({
        where: { id: intent.id },
      })
    ).state,
    'CLEANUP_PENDING',
  );
  assert.equal(
    storage.deletes.every(
      (entry) =>
        entry.bucket === AUDIO_BUCKET && entry.key === key,
    ),
    true,
  );
  assert.notEqual(
    (await prisma.trainingAttempt.findUnique({
      where: { id: attempt.id },
    })).status,
    TrainingAttemptStatus.TECHNICAL_FAILURE,
  );
});

test('PostgreSQL terminal attempt never links an unfinished intent and durably removes its object', async () => {
  const fixture = await createFixture();
  const clock = createClock();
  const engine = createEngine(clock);
  const attempt = await startAttempt(engine, fixture);
  await appendVoice(engine, clock, attempt.id, {
    updateId: 72_401n,
    fileUniqueId: 'terminal-cleanup',
    transcript: 'terminal cleanup',
  });
  const answer = await findAnswer(attempt.id);
  const storage = createStorage();
  let injectFailure = true;
  const firstWorker = createWorker({
    storage,
    provider: createAudioProvider(),
    ffmpeg: createFfmpegFixture(storage),
    faultInjection: {
      afterObjectUpload: async () => {
        if (injectFailure) {
          injectFailure = false;
          throw new Error('crash after upload');
        }
      },
    },
  });
  await firstWorker.drainNow();
  assert.equal(storage.objects.size, 1);
  const intent = await prisma.trainingAudioUploadIntent.findFirst({
    where: { segmentId: answer.voiceSegments[0].id },
  });
  const objectInRotatedBucket = Buffer.from(
    'same key in rotated bucket must survive terminal cleanup',
  );
  storage.objectsForBucket(ROTATED_AUDIO_BUCKET).set(
    intent.objectKey,
    objectInRotatedBucket,
  );
  storage.metadataForBucket(ROTATED_AUDIO_BUCKET).set(
    intent.objectKey,
    {
      exists: true,
      contentLength: objectInRotatedBucket.length,
      contentType: 'audio/wav',
      sha256: createHash('sha256')
        .update(objectInRotatedBucket)
        .digest('hex'),
    },
  );
  storage.setCurrentBucket(ROTATED_AUDIO_BUCKET);
  await prisma.trainingAttempt.update({
    where: { id: attempt.id },
    data: {
      status: TrainingAttemptStatus.TECHNICAL_FAILURE,
      completedAt: new Date(),
    },
  });
  const job = await prisma.trainingJob.findUnique({
    where: {
      idempotencyKey: `attempt:${attempt.id}:answer:${answer.id}:segment:${answer.voiceSegments[0].id}:download`,
    },
  });
  await prisma.trainingJob.update({
    where: { id: job.id },
    data: { runAt: new Date('2000-01-01T00:00:00.000Z') },
  });
  await drainAudio(
    createWorker({
      storage,
      provider: createAudioProvider(),
      ffmpeg: createFfmpegFixture(storage),
    }),
  );
  const cleaned =
    await prisma.trainingAudioUploadIntent.findUnique({
      where: { id: intent.id },
    });
  assert.equal(cleaned.state, 'CLEANED');
  assert.equal(cleaned.committedFileId, null);
  assert.equal(storage.objects.size, 0);
  assert.equal(
    storage
      .objectsForBucket(ROTATED_AUDIO_BUCKET)
      .get(intent.objectKey)
      .equals(objectInRotatedBucket),
    true,
  );
  assert.equal(
    storage.deletes.some(
      (entry) =>
        entry.bucket === AUDIO_BUCKET &&
        entry.key === intent.objectKey,
    ),
    true,
  );
  assert.equal(
    storage.deletes.some(
      (entry) =>
        entry.bucket === ROTATED_AUDIO_BUCKET &&
        entry.key === intent.objectKey,
    ),
    false,
  );
  assert.equal((await findAnswer(attempt.id)).voiceSegments[0].originalFile, null);
});

test('PostgreSQL crash after DB commit restarts without a second download or object', async () => {
  const fixture = await createFixture();
  const clock = createClock();
  const engine = createEngine(clock);
  const attempt = await startAttempt(engine, fixture);
  await appendVoice(engine, clock, attempt.id, {
    updateId: 73_001n,
    fileUniqueId: 'crash-after-db',
    transcript: 'restart fixture',
  });
  const answer = await findAnswer(attempt.id);
  const storage = createStorage();
  const provider = createAudioProvider();
  let failCompletion = true;
  const crashingPrisma = proxyPrisma({
    trainingJobUpdateMany: async (delegate, args) => {
      if (
        failCompletion &&
        args.data?.status === TrainingJobStatus.SUCCEEDED
      ) {
        failCompletion = false;
        throw new Error('simulated process crash after DB commit');
      }
      return delegate.updateMany(args);
    },
  });
  await createWorker({
    prismaClient: crashingPrisma,
    storage,
    provider,
    ffmpeg: createFfmpegFixture(storage),
  }).drainNow();

  const segmentAfterCrash = (await findAnswer(attempt.id)).voiceSegments[0];
  assert.ok(
    segmentAfterCrash.originalFile,
    JSON.stringify({
      jobs: await audioJobDiagnostics(attempt.id),
      providerCalls: provider.calls,
      objects: [...storage.objects.keys()],
    }),
  );
  assert.equal(storage.objects.size, 1);
  assert.equal(provider.calls.length, 1);
  const job = await prisma.trainingJob.findUnique({
    where: {
      idempotencyKey: `attempt:${attempt.id}:answer:${answer.id}:segment:${segmentAfterCrash.id}:download`,
    },
  });
  assert.equal(job.status, TrainingJobStatus.PENDING);
  await prisma.trainingJob.update({
    where: { id: job.id },
    data: { runAt: new Date('2000-01-01T00:00:00.000Z') },
  });

  await drainAudio(
    createWorker({
      storage,
      provider,
      ffmpeg: createFfmpegFixture(storage),
    }),
  );

  assert.equal(provider.calls.length, 1);
  assert.equal(storage.objects.size, 1);
  assert.equal(
    await countAudioFilesForAttempt(attempt.id),
    1,
  );
});

test('PostgreSQL two audio workers claim one job and persist one segment', async () => {
  const fixture = await createFixture();
  const clock = createClock();
  const engine = createEngine(clock);
  const attempt = await startAttempt(engine, fixture);
  await appendVoice(engine, clock, attempt.id, {
    updateId: 74_001n,
    fileUniqueId: 'two-worker-claim',
    transcript: 'claim fixture',
  });
  const storage = createStorage();
  const provider = {
    calls: 0,
    downloadVoice: async () => {
      provider.calls += 1;
      await new Promise((resolvePromise) =>
        setTimeout(resolvePromise, 50),
      );
      return {
        body: Buffer.from('one claimed voice'),
        mimeType: 'audio/wav',
      };
    },
  };
  const first = createWorker({
    storage,
    provider,
    ffmpeg: createFfmpegFixture(storage),
  });
  const second = createWorker({
    storage,
    provider,
    ffmpeg: createFfmpegFixture(storage),
  });
  await Promise.all([first.drainNow(), second.drainNow()]);

  assert.equal(provider.calls, 1);
  assert.equal(storage.objects.size, 1);
  assert.equal(
    await countAudioFilesForAttempt(attempt.id),
    1,
  );
});

test('PostgreSQL runtime disable after audio claim prevents provider call and restart resumes the same job', async () => {
  const fixture = await createFixture();
  const clock = createClock();
  const engine = createEngine(clock);
  const attempt = await startAttempt(engine, fixture);
  await appendVoice(engine, clock, attempt.id, {
    updateId: 74_101n,
    fileUniqueId: 'runtime-disable-audio',
    transcript: 'runtime disable fixture',
  });
  let enabled = true;
  let providerCalls = 0;
  const trainingConfig = {
    isEnabled: () => enabled,
  };
  const pausedPrisma = proxyPrismaTrainingJob({
    async updateMany(delegate, args) {
      const result = await delegate.updateMany(args);
      if (
        result.count === 1 &&
        args.data?.status === TrainingJobStatus.RUNNING &&
        args.data?.lockOwner
      ) {
        enabled = false;
      }
      return result;
    },
  });
  const storage = createStorage();
  await createWorker({
    prismaClient: pausedPrisma,
    storage,
    provider: {
      async downloadVoice() {
        providerCalls += 1;
        return {
          body: Buffer.from('must not be downloaded while disabled'),
          mimeType: 'audio/wav',
        };
      },
    },
    ffmpeg: createFfmpegFixture(storage),
    trainingConfig,
  }).drainNow();

  let job = await prisma.trainingJob.findFirstOrThrow({
    where: {
      kind: TrainingJobKind.TELEGRAM_DOWNLOAD_SEGMENT,
      idempotencyKey: { startsWith: `attempt:${attempt.id}:answer:` },
    },
  });
  assert.equal(providerCalls, 0);
  assert.equal(job.status, TrainingJobStatus.PENDING);
  assert.equal(job.attempts, 0);
  assert.equal(job.lockOwner, null);
  assert.equal(job.lastErrorCode, 'TRAINING_DISABLED_AFTER_CLAIM');

  enabled = true;
  const resumedProvider = createAudioProvider();
  await drainAudio(
    createWorker({
      storage,
      provider: resumedProvider,
      ffmpeg: createFfmpegFixture(storage),
      trainingConfig,
    }),
  );
  job = await prisma.trainingJob.findUnique({ where: { id: job.id } });
  assert.equal(job.status, TrainingJobStatus.SUCCEEDED);
  assert.equal(job.attempts, 1);
  assert.equal(resumedProvider.calls.length, 1);
  assert.ok((await findAnswer(attempt.id)).voiceSegments[0].originalFile);
});

test('PostgreSQL lost lease prevents mutation and stale recovery completes after restart', async () => {
  const fixture = await createFixture();
  const clock = createClock();
  const engine = createEngine(clock);
  const attempt = await startAttempt(engine, fixture);
  await appendVoice(engine, clock, attempt.id, {
    updateId: 75_001n,
    fileUniqueId: 'lost-lease',
    transcript: 'lease fixture',
  });
  const storage = createStorage();
  const download = deferred();
  let calls = 0;
  const provider = {
    downloadVoice: async () => {
      calls += 1;
      if (calls === 1) return download.promise;
      return {
        body: Buffer.from('recovered voice'),
        mimeType: 'audio/wav',
      };
    },
  };
  const worker = createWorker({
    storage,
    provider,
    ffmpeg: createFfmpegFixture(storage),
  });
  const drain = worker.drainNow();
  const running = await waitForJob(attempt.id, TrainingJobStatus.RUNNING);
  await prisma.trainingJob.update({
    where: { id: running.id },
    data: { lockOwner: 'replacement-worker' },
  });
  download.resolve({
    body: Buffer.from('lost voice'),
    mimeType: 'audio/wav',
  });
  await drain;

  assert.equal(storage.objects.size, 0);
  assert.equal((await findAnswer(attempt.id)).voiceSegments[0].originalFile, null);
  await prisma.trainingJob.update({
    where: { id: running.id },
    data: {
      lockedAt: new Date('2000-01-01T00:00:00.000Z'),
      heartbeatAt: new Date('2000-01-01T00:00:00.000Z'),
    },
  });
  await drainAudio(
    createWorker({
      storage,
      provider,
      ffmpeg: createFfmpegFixture(storage),
    }),
  );

  assert.equal(storage.objects.size, 1);
  assert.equal(storage.puts.length, 1);
  assert.ok((await findAnswer(attempt.id)).voiceSegments[0].originalFile);
  const recovered = await prisma.trainingJob.findUnique({
    where: { id: running.id },
  });
  assert.equal(recovered.status, TrainingJobStatus.SUCCEEDED);
  assert.equal(recovered.attempts, 2);
});

test('PostgreSQL stale exhausted audio job becomes DEAD and terminalizes the attempt', async () => {
  const fixture = await createFixture();
  const clock = createClock();
  const engine = createEngine(clock);
  const attempt = await startAttempt(engine, fixture);
  const question = currentQuestion(attempt);
  await appendVoice(engine, clock, attempt.id, {
    updateId: 75_101n,
    fileUniqueId: 'stale-exhausted',
    transcript: 'stale fixture',
  });
  await engine.finishAnswer({
    attemptId: attempt.id,
    attemptQuestionId: question.id,
  });
  const answer = await findAnswer(attempt.id);
  const downloadJob = await prisma.trainingJob.findUnique({
    where: {
      idempotencyKey: `attempt:${attempt.id}:answer:${answer.id}:segment:${answer.voiceSegments[0].id}:download`,
    },
  });
  await prisma.trainingJob.update({
    where: { id: downloadJob.id },
    data: {
      status: TrainingJobStatus.RUNNING,
      attempts: downloadJob.maxAttempts,
      lockOwner: 'crashed-worker',
      lockedAt: new Date('2000-01-01T00:00:00.000Z'),
      heartbeatAt: new Date('2000-01-01T00:00:00.000Z'),
    },
  });

  await createWorker({
    storage: createStorage(),
    provider: createAudioProvider(),
    ffmpeg: createFfmpegFixture(createStorage()),
  }).drainNow();

  const dead = await prisma.trainingJob.findUnique({
    where: { id: downloadJob.id },
  });
  const terminalAttempt = await prisma.trainingAttempt.findUnique({
    where: { id: attempt.id },
  });
  assert.equal(dead.status, TrainingJobStatus.DEAD);
  assert.equal(dead.lastErrorCode, 'STALE_AUDIO_JOB_DEAD');
  assert.equal(
    terminalAttempt.status,
    TrainingAttemptStatus.TECHNICAL_FAILURE,
  );
  assert.equal((await findAnswer(attempt.id)).combinedTranscript, null);
  assert.equal(
    await prisma.trainingJob.count({
      where: {
        idempotencyKey: `attempt:${attempt.id}:answer:${answer.id}:assemble`,
        status: TrainingJobStatus.SUCCEEDED,
      },
    }),
    1,
  );
});

test('PostgreSQL bounded shutdown releases an owned audio job and restart completes it', async () => {
  const fixture = await createFixture();
  const clock = createClock();
  const engine = createEngine(clock);
  const attempt = await startAttempt(engine, fixture);
  await appendVoice(engine, clock, attempt.id, {
    updateId: 75_201n,
    fileUniqueId: 'shutdown-restart',
    transcript: 'shutdown fixture',
  });
  const storage = createStorage();
  const download = deferred();
  const providerStarted = deferred();
  let calls = 0;
  const provider = {
    downloadVoice: async () => {
      calls += 1;
      if (calls === 1) {
        providerStarted.resolve();
        return download.promise;
      }
      return {
        body: Buffer.from('voice after restart'),
        mimeType: 'audio/wav',
      };
    },
  };
  const worker = createWorker({
    storage,
    provider,
    ffmpeg: createFfmpegFixture(storage),
    configOverrides: { workerDrainTimeoutMs: 30 },
  });
  const activeDrain = worker.drainNow();
  await providerStarted.promise;
  await worker.onModuleDestroy();
  const released = await prisma.trainingJob.findFirst({
    where: {
      idempotencyKey: { startsWith: `attempt:${attempt.id}:answer:` },
      kind: TrainingJobKind.TELEGRAM_DOWNLOAD_SEGMENT,
    },
  });
  assert.equal(released.status, TrainingJobStatus.PENDING);
  assert.equal(released.lockOwner, null);
  assert.equal(released.lastErrorCode, 'AUDIO_SHUTDOWN_RELEASE');

  download.resolve({
    body: Buffer.from('late voice from stopped worker'),
    mimeType: 'audio/wav',
  });
  await activeDrain;
  assert.equal(storage.objects.size, 0);
  await drainAudio(
    createWorker({
      storage,
      provider,
      ffmpeg: createFfmpegFixture(storage),
    }),
  );
  assert.equal(calls, 2);
  assert.ok((await findAnswer(attempt.id)).voiceSegments[0].originalFile);
});

test('PostgreSQL permanent audio failure is terminal, closes sibling jobs and supports refund', async () => {
  const fixture = await createFixture();
  const clock = createClock();
  const engine = createEngine(clock);
  const attempt = await startAttempt(engine, fixture);
  await prisma.trainingTelegramAccount.create({
    data: {
      userId: fixture.userId,
      telegramUserId: 8_877_600_001n,
      chatId: 8_877_600_001n,
      firstName: 'Stage 7',
    },
  });
  const question = currentQuestion(attempt);
  await appendVoice(engine, clock, attempt.id, {
    updateId: 76_001n,
    fileUniqueId: 'terminal-failure',
    transcript: 'failure fixture',
  });
  await engine.finishAnswer({
    attemptId: attempt.id,
    attemptQuestionId: question.id,
  });
  const worker = createWorker({
    storage: createStorage(),
    ffmpeg: createFfmpegFixture(createStorage()),
    provider: {
      downloadVoice: async () => {
        throw new TrainingAudioError(
          'TELEGRAM_PERMANENT_CLIENT_ERROR',
          false,
        );
      },
    },
  });
  await drainAudio(worker);

  const failedAttempt = await prisma.trainingAttempt.findUnique({
    where: { id: attempt.id },
  });
  const failedAnswer = await findAnswer(attempt.id);
  assert.equal(
    failedAttempt.status,
    TrainingAttemptStatus.TECHNICAL_FAILURE,
  );
  assert.equal(failedAttempt.isConsumed, true);
  assert.equal(failedAnswer.status, TrainingAnswerStatus.FAILED);
  assert.equal(failedAnswer.combinedTranscript, null);
  const jobs = await prisma.trainingJob.findMany({
    where: {
      idempotencyKey: { startsWith: `attempt:${attempt.id}:` },
    },
  });
  assert.equal(
    jobs.some((job) => job.status === TrainingJobStatus.RUNNING),
    false,
  );
  assert.equal(
    jobs
      .filter((job) =>
        [
          TrainingJobKind.TELEGRAM_DOWNLOAD_SEGMENT,
          TrainingJobKind.ASSEMBLE_ANSWER_AUDIO,
        ].includes(job.kind),
      )
      .every((job) =>
        [
          TrainingJobStatus.DEAD,
          TrainingJobStatus.SUCCEEDED,
        ].includes(job.status),
      ),
    true,
  );
  assert.equal(
    await prisma.trainingJob.count({
      where: {
        kind: TrainingJobKind.SEND_TELEGRAM_MESSAGE,
        idempotencyKey: `telegram:attempt-technical-failure:${attempt.id}`,
      },
    }),
    1,
  );

  await engine.refundTechnicalFailure({
    attemptId: attempt.id,
    actorUserId: fixture.publisherId,
    reason: 'Audio infrastructure failure',
  });
  const refunded = await prisma.trainingAttempt.findUnique({
    where: { id: attempt.id },
  });
  assert.equal(refunded.isConsumed, false);
  assert.equal(
    await prisma.auditLog.count({
      where: {
        action: 'training.attempt.refund',
        entityId: attempt.id,
      },
    }),
    1,
  );
});

test('PostgreSQL protected audio access reads private bytes, audits admin and rejects IDOR', async () => {
  const fixture = await createFixture();
  const clock = createClock();
  const engine = createEngine(clock);
  const attempt = await startAttempt(engine, fixture);
  const question = currentQuestion(attempt);
  await appendVoice(engine, clock, attempt.id, {
    updateId: 77_001n,
    fileUniqueId: 'protected-audio',
    transcript: 'private fixture',
  });
  await engine.finishAnswer({
    attemptId: attempt.id,
    attemptQuestionId: question.id,
  });
  const storage = createStorage();
  await drainAudio(
    createWorker({
      storage,
      provider: createAudioProvider(),
      ffmpeg: createFfmpegFixture(storage),
    }),
  );
  const answer = await findAnswer(attempt.id);
  const access = new TrainingAudioAccessService(prisma, storage);

  const ownerResult = await access.getAnswerAudio(
    answer.id,
    {
      id: fixture.userId,
      permissions: ['training:audio:read'],
    },
    {},
  );
  const adminResult = await access.getAnswerAudio(
    answer.id,
    {
      id: fixture.publisherId,
      permissions: [
        'training:audio:read',
        'training:results:read',
      ],
    },
    { ip: '127.0.0.1', headers: { 'user-agent': 'stage7-test' } },
  );
  assert.equal(ownerResult.mimeType, 'audio/wav');
  assert.equal(adminResult.buffer.equals(MERGED_BODY), true);
  assert.equal(
    await prisma.auditLog.count({
      where: {
        action: 'training.audio.read',
        entityId: answer.id,
      },
    }),
    2,
  );
  await assert.rejects(() =>
    access.getAnswerAudio(
      answer.id,
      {
        id: '00000000-0000-4000-8000-000000000099',
        permissions: ['training:audio:read'],
      },
      {},
    ),
  );
});

test('PostgreSQL fake audio pipeline completes the full 1 plus 3 flow and reuses file_unique_id across answers', async () => {
  const fixture = await createFixture({ passScore: 75 });
  const clock = createClock();
  const transcriptionInputs = [];
  const tracedTranscription = {
    transcribe: async (input) => {
      transcriptionInputs.push(structuredClone(input));
      return fakeTranscription.transcribe(input);
    },
  };
  let engine = createEngine(clock, tracedTranscription);
  const started = await startAttempt(engine, fixture);
  const storage = createStorage();
  const provider = createAudioProvider();
  const ffmpeg = createFfmpegFixture(storage);
  const correlationByAnswer = new Map();

  for (let index = 0; index < 4; index += 1) {
    clock.set(new Date(Date.now() - 1_000));
    const current = (
      await engine.getAttempt(started.id)
    ).attempt;
    const question = currentQuestion(current);
    assert.ok(
      question,
      JSON.stringify({
        status: current.status,
        questions: current.attemptQuestions.map((item) => ({
          status: item.status,
          answerStatus: item.answer?.status,
        })),
        jobs: await audioJobDiagnostics(started.id),
      }),
    );
    await appendVoice(engine, clock, started.id, {
      updateId: BigInt(78_001 + index),
      fileUniqueId: 'allowed-in-another-answer',
      transcript:
        index === 0 ? 'полный главный ответ' : `ответ ${index}`,
      correlationId: `telegram-update:${78_001 + index}`,
    });
    const answerBeforeFinish = await findAnswer(started.id);
    const correlationId = `telegram-update:${78_001 + index}`;
    correlationByAnswer.set(answerBeforeFinish.id, correlationId);
    await engine.finishAnswer({
      attemptId: started.id,
      attemptQuestionId: question.id,
      correlationId,
    });
    await drainAudio(createWorker({ storage, provider, ffmpeg }));
    clock.set(new Date(Date.now() + 1_000));
    engine = createEngine(clock, tracedTranscription);
    await engine.recoverPendingProcessing();
    await engine.recoverPendingProcessing();
  }
  await engine.recoverPendingProcessing();

  const completed = await prisma.trainingAttempt.findUnique({
    where: { id: started.id },
    include: {
      attemptQuestions: {
        include: {
          answer: {
            include: {
              voiceSegments: true,
              mergedAudioFile: true,
            },
          },
        },
      },
    },
  });
  assert.equal(completed.status, TrainingAttemptStatus.COMPLETED);
  assert.equal(completed.passStatus, TrainingPassStatus.PASSED);
  assert.equal(completed.finalScore.toFixed(2), '100.00');
  assert.equal(
    completed.attemptQuestions.every(
      (item) =>
        item.status === TrainingAttemptQuestionStatus.SCORED &&
        item.answer.status === TrainingAnswerStatus.SCORED &&
        item.answer.combinedTranscript,
    ),
    true,
  );
  assert.equal(
    completed.attemptQuestions.flatMap(
      (item) => item.answer.voiceSegments,
    ).length,
    4,
  );
  assert.equal(
    new Set(
      completed.attemptQuestions.flatMap((item) =>
        item.answer.voiceSegments.map((segment) => segment.answerId),
      ),
    ).size,
    4,
  );
  assert.equal(provider.calls.length, 4);
  assert.equal(ffmpeg.orders.length, 4);
  const correlatedJobs = await prisma.trainingJob.findMany({
    where: {
      idempotencyKey: { startsWith: `attempt:${started.id}:answer:` },
      kind: {
        in: [
          TrainingJobKind.TELEGRAM_DOWNLOAD_SEGMENT,
          TrainingJobKind.ASSEMBLE_ANSWER_AUDIO,
          TrainingJobKind.TRANSCRIBE_ANSWER,
          TrainingJobKind.EVALUATE_ANSWER,
        ],
      },
    },
  });
  for (const job of correlatedJobs) {
    assert.equal(
      job.payloadJson.correlationId,
      correlationByAnswer.get(job.payloadJson.answerId),
      `${job.kind}:${job.id}`,
    );
  }
  const providerRuns = await prisma.trainingProviderRun.findMany({
    where: {
      answerId: { in: [...correlationByAnswer.keys()] },
    },
  });
  assert.ok(providerRuns.length >= 8);
  for (const run of providerRuns) {
    assert.equal(
      run.inputMetadataJson.correlationId,
      correlationByAnswer.get(run.answerId),
      `${run.kind}:${run.id}`,
    );
  }
  const finalizationJob = await prisma.trainingJob.findUniqueOrThrow({
    where: { idempotencyKey: `attempt:${started.id}:finalize` },
  });
  assert.equal(
    finalizationJob.payloadJson.correlationId,
    'telegram-update:78004',
  );
  const resultOutbox = await prisma.trainingJob.findUnique({
    where: { idempotencyKey: `telegram:attempt-result:${started.id}` },
  });
  if (resultOutbox) {
    assert.equal(
      resultOutbox.payloadJson.correlationId,
      'telegram-update:78004',
    );
  }
  const answersById = new Map(
    completed.attemptQuestions.map((item) => [
      item.answer.id,
      {
        attemptQuestionId: item.id,
        answer: item.answer,
      },
    ]),
  );
  const currentAttemptInputs = transcriptionInputs.filter((input) =>
    answersById.has(input.answerId),
  );
  assert.equal(
    new Set(
      currentAttemptInputs.map((input) => input.answerId),
    ).size,
    4,
  );
  for (const input of currentAttemptInputs) {
    const expected = answersById.get(input.answerId);
    assert.ok(expected);
    assert.equal(input.attemptQuestionId, expected.attemptQuestionId);
    assert.deepEqual(input.audio, {
      fileId: expected.answer.mergedAudioFile.id,
      bucket: expected.answer.mergedAudioFile.bucket,
      key: expected.answer.mergedAudioFile.key,
      mimeType: expected.answer.mergedAudioFile.mimeType,
      sizeBytes: Number(expected.answer.mergedAudioFile.sizeBytes),
      checksum: expected.answer.mergedAudioFile.checksum,
      durationMilliseconds:
        expected.answer.mergedAudioDurationMilliseconds,
      segmentCount: expected.answer.voiceSegments.length,
    });
  }
});

const AUDIO_BUCKET = 'platforma-training-audio-test-private';
const ROTATED_AUDIO_BUCKET =
  'platforma-training-audio-test-private-rotated';
const MERGED_BODY = Buffer.from('normalized private training audio');

function audioConfig(overrides = {}) {
  return {
    maxSegmentBytes: 1024 * 1024,
    maxAnswerBytes: 4 * 1024 * 1024,
    maxSegments: 32,
    maxAnswerDurationSeconds: 600,
    downloadTimeoutMs: 1000,
    ffmpegTimeoutMs: 1000,
    transcriptionTimeoutMs: 1000,
    workerPollMs: 20,
    workerConcurrency: 1,
    workerLeaseMs: 5_000,
    workerHeartbeatMs: 500,
    workerDrainTimeoutMs: 500,
    tempDir: '/tmp/platforma-training-audio-db-test',
    retentionDays: 0,
    ...overrides,
  };
}

function createClock() {
  return new MutableTrainingClock(
    new Date(Date.now() - 5_000),
  );
}

function createEngine(clock, transcriptionProvider = fakeTranscription) {
  return new TrainingAttemptEngineService(
    prisma,
    clock,
    new DeterministicQuestionSelector(),
    transcriptionProvider,
    fakeEvaluation,
    audioConfig(),
  );
}

function createWorker({
  prismaClient = prisma,
  storage,
  ffmpeg,
  provider,
  configOverrides,
  faultInjection,
  trainingConfig,
}) {
  return new TrainingAudioWorkerService(
    prismaClient,
    audioConfig(configOverrides),
    storage,
    ffmpeg,
    provider,
    faultInjection,
    trainingConfig,
  );
}

function proxyPrismaTrainingJob(overrides) {
  const trainingJob = new Proxy(prisma.trainingJob, {
    get(delegate, property) {
      if (property in overrides) {
        return (...args) => overrides[property](delegate, ...args);
      }
      const value = Reflect.get(delegate, property, delegate);
      return typeof value === 'function' ? value.bind(delegate) : value;
    },
  });
  return new Proxy(prisma, {
    get(client, property) {
      if (property === 'trainingJob') return trainingJob;
      const value = Reflect.get(client, property, client);
      return typeof value === 'function' ? value.bind(client) : value;
    },
  });
}

function createStorage(options = {}) {
  const objects = new Map();
  const metadata = new Map();
  const objectsByBucket = new Map([[AUDIO_BUCKET, objects]]);
  const metadataByBucket = new Map([[AUDIO_BUCKET, metadata]]);
  const puts = [];
  const deletes = [];
  const heads = [];
  let currentBucket = options.currentBucket ?? AUDIO_BUCKET;
  let putFailuresRemaining = options.putFailures ?? 0;
  let deleteFailuresRemaining = options.deleteFailures ?? 0;
  const objectsForBucket = (bucket) => {
    let bucketObjects = objectsByBucket.get(bucket);
    if (!bucketObjects) {
      bucketObjects = new Map();
      objectsByBucket.set(bucket, bucketObjects);
    }
    return bucketObjects;
  };
  const metadataForBucket = (bucket) => {
    let bucketMetadata = metadataByBucket.get(bucket);
    if (!bucketMetadata) {
      bucketMetadata = new Map();
      metadataByBucket.set(bucket, bucketMetadata);
    }
    return bucketMetadata;
  };
  return {
    objects,
    metadata,
    objectsForBucket,
    metadataForBucket,
    puts,
    deletes,
    heads,
    getTrainingAudioBucket: () => currentBucket,
    setCurrentBucket: (bucket) => {
      currentBucket = bucket;
    },
    putPrivateTrainingAudioObject: async ({
      bucket,
      key,
      body,
      mimeType,
      checksum,
    }) => {
      puts.push({ bucket, key });
      if (putFailuresRemaining > 0) {
        putFailuresRemaining -= 1;
        throw new Error('simulated storage put failure');
      }
      objectsForBucket(bucket).set(key, Buffer.from(body));
      metadataForBucket(bucket).set(key, {
        exists: true,
        contentLength: body.length,
        contentType: mimeType,
        sha256: checksum,
      });
    },
    putPrivateTrainingAudioFile: async ({
      bucket,
      key,
      mimeType,
      checksum,
      sizeBytes,
    }) => {
      puts.push({ bucket, key });
      if (putFailuresRemaining > 0) {
        putFailuresRemaining -= 1;
        throw new Error('simulated storage put failure');
      }
      objectsForBucket(bucket).set(key, Buffer.from(MERGED_BODY));
      metadataForBucket(bucket).set(key, {
        exists: true,
        contentLength: sizeBytes,
        contentType: mimeType,
        sha256: checksum,
      });
    },
    headPrivateTrainingAudioObject: async (bucket, key) => {
      heads.push({ bucket, key });
      return (
        metadataForBucket(bucket).get(key) ?? {
          exists: false,
          contentLength: null,
          contentType: null,
          sha256: null,
        }
      );
    },
    deletePrivateTrainingAudioObject: async (bucket, key) => {
      deletes.push({ bucket, key });
      if (deleteFailuresRemaining > 0) {
        deleteFailuresRemaining -= 1;
        throw new Error('simulated storage delete failure');
      }
      objectsForBucket(bucket).delete(key);
      metadataForBucket(bucket).delete(key);
    },
    readStoredFile: async (file) => {
      if (!file.bucket) {
        throw new Error('persisted file bucket requires manual review');
      }
      const body = objectsForBucket(file.bucket).get(file.key);
      if (!body) throw new Error('private object is missing');
      return Buffer.from(body);
    },
  };
}

function createAudioProvider() {
  const calls = [];
  return {
    calls,
    downloadVoice: async (input) => {
      calls.push(input.fileId);
      return {
        body: Buffer.from(`RIFF:${input.fileId}`),
        mimeType: 'audio/wav',
      };
    },
  };
}

function createFfmpegFixture(storage) {
  const orders = [];
  return {
    orders,
    withPreparedAudio: async (inputs, operation) => {
      orders.push(inputs.map((input) => input.segmentIndex));
      for (const input of inputs) {
        assert.equal(input.answerId, inputs[0].answerId);
        assert.ok(
          storage
            .objectsForBucket(input.file.bucket)
            .has(input.file.key),
        );
      }
      return operation({
        path: '/tmp/internal-generated-normalized.wav',
        mimeType: 'audio/wav',
        sizeBytes: MERGED_BODY.length,
        checksum: createHash('sha256').update(MERGED_BODY).digest('hex'),
        durationMilliseconds: inputs.length * 1000,
        segments: inputs.map((input) => ({
          id: input.id,
          segmentIndex: input.segmentIndex,
          durationMilliseconds: 1000,
          codec: 'pcm_s16le',
          channels: 1,
          sampleRate: 16000,
        })),
        metrics: {
          version: 1,
          segmentCount: inputs.length,
          totalOriginalBytes: inputs.reduce(
            (total, input) => total + Number(input.file.sizeBytes),
            0,
          ),
          totalDurationSeconds: inputs.length,
          segmentDurationsSeconds: inputs.map(() => 1),
          technicalIntervalsSeconds: inputs.slice(1).map(() => 0),
          silence: {
            thresholdDb: -35,
            minimumPauseSeconds: 0.8,
            pauseCount: 0,
            totalPauseSeconds: 0,
            maximumPauseSeconds: 0,
            speechDurationSeconds: inputs.length,
            silenceRatio: 0,
          },
        },
      });
    },
  };
}

async function createFixture(options = {}) {
  const unique = `${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  const role = await prisma.role.create({
    data: {
      name: `training-stage7-${unique}`,
      description: 'Stage 7 isolated integration role',
    },
  });
  const publisher = await prisma.user.create({
    data: {
      email: `training-stage7-publisher-${unique}@example.test`,
      passwordHash: 'not-used-in-domain-test',
      name: 'Stage 7 Publisher',
      status: UserStatus.ACTIVE,
      roleId: role.id,
    },
  });
  const user = await prisma.user.create({
    data: {
      email: `training-stage7-user-${unique}@example.test`,
      passwordHash: 'not-used-in-domain-test',
      name: 'Stage 7 User',
      status: UserStatus.ACTIVE,
      roleId: role.id,
    },
  });
  const project = await prisma.trainingProject.create({
    data: {
      slug: `training-stage7-${unique}`,
      title: 'Stage 7 integration project',
      status: TrainingProjectStatus.DRAFT,
    },
  });
  const version = await prisma.trainingProjectVersion.create({
    data: {
      projectId: project.id,
      versionNumber: 1,
      status: TrainingVersionStatus.DRAFT,
      passScore: options.passScore ?? 75,
      attemptLimit: 3,
      cooldownMinutes: 60,
      totalTimeLimitSeconds: 420,
      finishGraceSeconds: 90,
      warningSecondsJson: [60, 20],
      allowRetakeAfterPass: true,
    },
  });
  const main = await prisma.trainingQuestion.create({
    data: {
      projectVersionId: version.id,
      type: TrainingQuestionType.MAIN,
      text: 'Главный вопрос',
      position: 1,
      maxScore: 55,
    },
  });
  await prisma.trainingQuestion.createMany({
    data: Array.from({ length: 10 }, (_, index) => ({
      projectVersionId: version.id,
      type: TrainingQuestionType.FOLLOW_UP,
      text: `Дополнительный вопрос ${index + 1}`,
      position: index + 1,
      maxScore: 15,
    })),
  });
  const fact = await prisma.trainingFact.create({
    data: {
      projectVersionId: version.id,
      code: 'main.fact',
      topicCode: 'main',
      statement: 'Утверждённый факт',
      isApproved: true,
    },
  });
  await prisma.trainingQuestionFactLink.create({
    data: {
      questionId: main.id,
      factId: fact.id,
      isRequired: true,
    },
  });
  await prisma.trainingEvaluationCriterion.createMany({
    data: [
      {
        projectVersionId: version.id,
        questionType: TrainingQuestionType.MAIN,
        code: 'main-total',
        title: 'Главный ответ',
        maxPoints: 55,
        sortOrder: 1,
      },
      {
        projectVersionId: version.id,
        questionType: TrainingQuestionType.FOLLOW_UP,
        code: 'follow-total',
        title: 'Дополнительный ответ',
        maxPoints: 15,
        sortOrder: 1,
      },
    ],
  });
  await prisma.trainingProjectVersion.update({
    where: { id: version.id },
    data: {
      status: TrainingVersionStatus.PUBLISHED,
      publishedAt: new Date(),
      publishedById: publisher.id,
    },
  });
  await prisma.trainingProject.update({
    where: { id: project.id },
    data: {
      status: TrainingProjectStatus.OPEN,
      activeVersionId: version.id,
    },
  });

  return {
    projectId: project.id,
    publisherId: publisher.id,
    userId: user.id,
  };
}

async function startAttempt(engine, fixture) {
  return (
    await engine.confirmStart({
      userId: fixture.userId,
      projectId: fixture.projectId,
      confirmed: true,
    })
  ).attempt;
}

async function appendVoice(
  engine,
  clock,
  attemptId,
  { updateId, fileUniqueId, transcript, correlationId },
) {
  return engine.appendVoiceSegment({
    attemptId,
    kind: 'VOICE',
    updateId,
    fakeTranscript: transcript,
    recordingStartedAt: clock.now(),
    telegramMessageId: updateId,
    telegramChatId: 987654321n,
    telegramFileId: `file-${updateId}`,
    fileUniqueId,
    correlationId,
    durationSeconds: 5,
  });
}

function currentQuestion(attempt) {
  return attempt.attemptQuestions.find((question) =>
    [
      TrainingAttemptQuestionStatus.PRESENTED,
      TrainingAttemptQuestionStatus.COLLECTING,
    ].includes(question.status),
  );
}

function findAnswer(attemptId) {
  return prisma.trainingAnswer.findFirst({
    where: {
      attemptQuestion: { attemptId },
      status: { not: TrainingAnswerStatus.SCORED },
    },
    orderBy: { createdAt: 'desc' },
    include: {
      mergedAudioFile: true,
      voiceSegments: {
        orderBy: { segmentIndex: 'asc' },
        include: { originalFile: true },
      },
    },
  });
}

async function waitForJob(attemptId, status) {
  for (let index = 0; index < 200; index += 1) {
    const job = await prisma.trainingJob.findFirst({
      where: {
        idempotencyKey: { startsWith: `attempt:${attemptId}:answer:` },
        kind: TrainingJobKind.TELEGRAM_DOWNLOAD_SEGMENT,
        status,
      },
    });
    if (job) return job;
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  assert.fail(
    `Audio job did not reach ${status}: ${JSON.stringify(
      await audioJobDiagnostics(attemptId),
    )}`,
  );
}

function audioJobDiagnostics(attemptId) {
  return prisma.trainingJob.findMany({
    where: {
      idempotencyKey: { startsWith: `attempt:${attemptId}:answer:` },
      kind: {
        in: [
          TrainingJobKind.TELEGRAM_DOWNLOAD_SEGMENT,
          TrainingJobKind.ASSEMBLE_ANSWER_AUDIO,
        ],
      },
    },
    select: {
      kind: true,
      status: true,
      attempts: true,
      runAt: true,
      lockOwner: true,
      lastErrorCode: true,
      lastErrorMessage: true,
    },
    orderBy: { createdAt: 'asc' },
  });
}

async function drainAudio(worker) {
  await worker.drainNow();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  await worker.drainNow();
}

function countAudioFilesForAttempt(attemptId) {
  return prisma.file.count({
    where: {
      bucket: AUDIO_BUCKET,
      OR: [
        {
          trainingVoiceSegments: {
            some: {
              answer: {
                attemptQuestion: { attemptId },
              },
            },
          },
        },
        {
          trainingAnswerAudio: {
            some: {
              attemptQuestion: { attemptId },
            },
          },
        },
      ],
    },
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function assertForeignKeyViolation(operation) {
  await assert.rejects(operation, (error) => {
    assert.equal(
      error?.meta?.code === '23503' ||
        error?.code === 'P2003' ||
        /foreign key constraint/iu.test(error?.message ?? ''),
      true,
      error?.message,
    );
    return true;
  });
}

function proxyPrisma(overrides) {
  const trainingJob = new Proxy(prisma.trainingJob, {
    get(delegate, property) {
      if (
        property === 'updateMany' &&
        overrides.trainingJobUpdateMany
      ) {
        return (...args) =>
          overrides.trainingJobUpdateMany(delegate, ...args);
      }
      const value = Reflect.get(delegate, property, delegate);
      return typeof value === 'function'
        ? value.bind(delegate)
        : value;
    },
  });
  return new Proxy(prisma, {
    get(client, property) {
      if (property === 'trainingJob') return trainingJob;
      if (property === '$transaction' && overrides.transaction) {
        return overrides.transaction;
      }
      const value = Reflect.get(client, property, client);
      return typeof value === 'function'
        ? value.bind(client)
        : value;
    },
  });
}
