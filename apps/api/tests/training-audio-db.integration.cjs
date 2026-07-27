require('reflect-metadata');

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
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

test('PostgreSQL crash after storage upload rolls the object back and restart stores one segment', async () => {
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
  let failTransaction = true;
  const crashingPrisma = proxyPrisma({
    transaction: async (operation, options) => {
      if (failTransaction) {
        failTransaction = false;
        throw new Error('simulated crash before DB commit');
      }
      return prisma.$transaction(operation, options);
    },
  });
  const crashingWorker = createWorker({
    prismaClient: crashingPrisma,
    storage,
    provider,
    ffmpeg: createFfmpegFixture(storage),
  });
  await crashingWorker.drainNow();

  assert.equal(storage.objects.size, 0);
  assert.equal((await findAnswer(attempt.id)).voiceSegments[0].originalFile, null);
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
  await drainAudio(
    createWorker({
      storage,
      provider,
      ffmpeg: createFfmpegFixture(storage),
    }),
  );

  assert.equal(storage.objects.size, 1);
  assert.ok((await findAnswer(attempt.id)).voiceSegments[0].originalFile);
  assert.equal(
    await countAudioFilesForAttempt(attempt.id),
    1,
  );
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
  const engine = createEngine(clock);
  const started = await startAttempt(engine, fixture);
  const storage = createStorage();
  const provider = createAudioProvider();
  const ffmpeg = createFfmpegFixture(storage);
  const worker = createWorker({ storage, provider, ffmpeg });

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
    });
    await engine.finishAnswer({
      attemptId: started.id,
      attemptQuestionId: question.id,
    });
    await drainAudio(worker);
    clock.set(new Date(Date.now() + 1_000));
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
            include: { voiceSegments: true },
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
});

const AUDIO_BUCKET = 'platforma-training-audio-test-private';
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

function createEngine(clock) {
  return new TrainingAttemptEngineService(
    prisma,
    clock,
    new DeterministicQuestionSelector(),
    fakeTranscription,
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
}) {
  return new TrainingAudioWorkerService(
    prismaClient,
    audioConfig(configOverrides),
    storage,
    ffmpeg,
    provider,
  );
}

function createStorage() {
  const objects = new Map();
  const puts = [];
  const deletes = [];
  return {
    objects,
    puts,
    deletes,
    getTrainingAudioBucket: () => AUDIO_BUCKET,
    putPrivateTrainingAudioObject: async ({ key, body }) => {
      puts.push(key);
      objects.set(key, Buffer.from(body));
    },
    putPrivateTrainingAudioFile: async ({ key }) => {
      puts.push(key);
      objects.set(key, Buffer.from(MERGED_BODY));
    },
    deletePrivateTrainingAudioObject: async (key) => {
      deletes.push(key);
      objects.delete(key);
    },
    readStoredFile: async (file) => {
      const body = objects.get(file.key);
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
        assert.ok(storage.objects.has(input.file.key));
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
  { updateId, fileUniqueId, transcript },
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
