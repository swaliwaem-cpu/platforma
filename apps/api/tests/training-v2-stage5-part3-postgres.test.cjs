require('reflect-metadata');

const assert = require('node:assert/strict');
const { fork, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { resolve } = require('node:path');
const { after, before, beforeEach, test } = require('node:test');
const {
  PrismaClient,
  TrainingAnswerProcessingStatus,
  TrainingProjectAccessMode,
  UserStatus,
} = require('@prisma/client');

const { TrainingAttemptStateService } = require('../dist/training/training-attempt-state.service.js');
const { TrainingAttemptService } = require('../dist/training/training-attempt.service.js');
const { DeterministicFakeTrainingEvaluator } = require('../dist/training/training-evaluator.js');
const { TrainingProjectService } = require('../dist/training/training-project.service.js');
const { TrainingProjectAccessService } = require('../dist/training/training-project-access.service.js');
const { FakeTrainingTelegramClient } = require('../dist/training/training-telegram-client.js');
const { TrainingOpenAIError } = require('../dist/training/training-openai-client.js');
const { TrainingTelegramService } = require('../dist/training/training-telegram.service.js');
const {
  TrainingTelegramOutboxWorkerService,
} = require('../dist/training/training-telegram-outbox-worker.service.js');
const { TrainingVoiceWorkerService } = require('../dist/training/training-voice-worker.service.js');
const {
  TrainingVoiceWorkerWakeupService,
} = require('../dist/training/training-voice-worker-wakeup.service.js');

const databaseUrl = process.env.TRAINING_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('Training Stage 5 Part 3 PostgreSQL scenarios require the targeted temporary database runner', () => {
    assert.equal(process.env.TRAINING_TEST_DATABASE_URL, undefined);
  });
} else {
  process.env.TRAINING_MODULE_ENABLED = 'true';
  process.env.TRAINING_VOICE_WORKER_ENABLED = 'true';
  process.env.TRAINING_VOICE_WORKER_CONCURRENCY = '3';
  process.env.TRAINING_VOICE_WORKER_POLL_INTERVAL_MS = '250';
  process.env.TRAINING_VOICE_HEARTBEAT_INTERVAL_MS = '250';
  process.env.TRAINING_VOICE_STALE_LOCK_MS = '1000';
  process.env.TRAINING_VOICE_WORKER_SHUTDOWN_DRAIN_MS = '250';

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const projectAccess = new TrainingProjectAccessService(prisma);
  const evaluator = new DeterministicFakeTrainingEvaluator();
  const voiceWorkerWakeup = new TrainingVoiceWorkerWakeupService();
  const state = new TrainingAttemptStateService(
    prisma,
    evaluator,
    { select: (candidates) => candidates.slice(0, 3) },
    projectAccess,
    voiceWorkerWakeup,
  );
  const attempts = new TrainingAttemptService(prisma, state, projectAccess);
  const projects = new TrainingProjectService(prisma);

  before(async () => prisma.$connect());
  beforeEach(async () => {
    process.env.TRAINING_MODULE_ENABLED = 'true';
    process.env.TRAINING_VOICE_WORKER_CONCURRENCY = '3';
    await clearTrainingData();
  });
  after(async () => {
    await clearTrainingData();
    await prisma.$disconnect();
  });

  test('one bot isolates 10 simultaneous users while provider concurrency stays bounded', async (context) => {
    const project = await createOpenProject('Part 3 ten users');
    const users = await createUsers(10, 'ten-users');
    const client = new FakeTrainingTelegramClient();
    const telegram = new TrainingTelegramService(prisma, state, projectAccess, client);
    const started = await Promise.all(users.map((user) =>
      attempts.startAttempt(project.id, user.id, {
        confirmed: true,
        idempotencyKey: randomUUID(),
      }),
    ));

    await prisma.trainingTelegramAccount.createMany({
      data: users.map((user, index) => ({
        userId: user.id,
        telegramUserId: BigInt(10_000 + index),
        chatId: BigInt(20_000 + index),
      })),
    });

    await Promise.all(started.map(async (attempt, index) => {
      const telegramUserId = 10_000 + index;
      const chatId = 20_000 + index;
      await telegram.handleUpdate(voiceUpdate(
        telegramUserId,
        chatId,
        30_000 + index,
        `file-${index}`,
        `unique-${index}`,
      ));
      await telegram.handleUpdate(finishUpdate(
        telegramUserId,
        chatId,
        attempt.currentQuestion.id,
        `finish-${index}`,
      ));
    }));

    const audio = new ImmediateAudio();
    const transcriber = new BoundedTranscriber(35);
    const worker = createWorker(audio, transcriber, evaluator, state, telegram);
    context.after(() => worker.shutdown());
    await worker.onModuleInit();
    try {
      await waitFor(async () =>
        (await prisma.trainingAnswer.count({
          where: { processingStatus: TrainingAnswerProcessingStatus.COMPLETED },
        })) === 10,
      );
    } catch (error) {
      const states = await prisma.trainingAnswer.groupBy({
        by: ['processingStatus', 'processingErrorCode'],
        _count: { _all: true },
      });
      throw new Error(`Timed out with answer states ${JSON.stringify(states)}`, { cause: error });
    }
    await worker.shutdown();

    const answers = await prisma.trainingAnswer.findMany({
      include: {
        segments: true,
        attemptQuestion: { include: { attempt: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    assert.equal(answers.length, 10);
    assert.equal(transcriber.calls, 10);
    assert.equal(transcriber.peakActive, 3);
    assert.equal(transcriber.peakActive <= Number(process.env.TRAINING_VOICE_WORKER_CONCURRENCY), true);
    assert.equal(audio.peakActive <= 3, true);
    assert.equal(new Set(answers.map((answer) => answer.attemptQuestion.attempt.userId)).size, 10);
    assert.equal(new Set(answers.map((answer) => answer.text)).size, 10);
    assert.equal(answers.every((answer) =>
      answer.text === `transcript:${answer.id}` &&
      answer.segments.length === 1 &&
      answer.segments[0].telegramFileUniqueId.startsWith('unique-') &&
      answer.processingAttempts === 1 &&
      answer.processingLockedBy === null
    ), true);
    assert.equal(client.sentMessages.every((message) =>
      users.some((_, index) => message.chatId === BigInt(20_000 + index))
    ), true);
    assert.equal(
      client.sentMessages.filter((message) => message.text.startsWith('Вопрос 2 из 4')).length,
      10,
    );
  });

  test('committed PROCESSING answer wakes a local idle worker without waiting for polling', async (context) => {
    process.env.TRAINING_VOICE_WORKER_POLL_INTERVAL_MS = '1000';
    const project = await createOpenProject('Part 3 local wakeup');
    const [user] = await createUsers(1, 'local-wakeup');
    const attempt = await attempts.startAttempt(project.id, user.id, {
      confirmed: true,
      idempotencyKey: randomUUID(),
    });
    const telegramUserId = 91_001;
    const chatId = 92_001;
    await prisma.trainingTelegramAccount.create({
      data: {
        userId: user.id,
        telegramUserId: BigInt(telegramUserId),
        chatId: BigInt(chatId),
      },
    });
    const client = new FakeTrainingTelegramClient();
    const telegram = new TrainingTelegramService(prisma, state, projectAccess, client);
    const transcriber = new BarrierTranscriber();
    const worker = createWorker(
      new ImmediateAudio(),
      transcriber,
      evaluator,
      state,
      telegram,
    );
    context.after(async () => {
      process.env.TRAINING_VOICE_WORKER_POLL_INTERVAL_MS = '250';
      transcriber.release();
      await worker.shutdown();
    });
    await worker.onModuleInit();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await telegram.handleUpdate(voiceUpdate(
      telegramUserId,
      chatId,
      93_001,
      'local-wakeup-file',
      'local-wakeup-unique',
    ));

    const startedAt = Date.now();
    await telegram.handleUpdate(finishUpdate(
      telegramUserId,
      chatId,
      attempt.currentQuestion.id,
      'local-wakeup-finish',
    ));
    await Promise.race([
      transcriber.waitUntilStarted(),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('Local worker wakeup was not immediate')),
        750,
      )),
    ]);
    assert.ok(Date.now() - startedAt < 750);
    transcriber.release();
    await waitFor(async () =>
      (await prisma.trainingAnswer.findFirst({
        where: { attemptQuestionId: attempt.currentQuestion.id },
        select: { processingStatus: true },
      }))?.processingStatus === TrainingAnswerProcessingStatus.COMPLETED,
    );
  });

  test('periodic polling recovers work when no local wakeup signal is delivered', async (context) => {
    process.env.TRAINING_VOICE_WORKER_POLL_INTERVAL_MS = '250';
    const transcriber = new BoundedTranscriber(0);
    const worker = createWorker(new ImmediateAudio(), transcriber, evaluator, state);
    context.after(() => worker.shutdown());
    await worker.onModuleInit();
    await new Promise((resolve) => setTimeout(resolve, 25));

    const [item] = await createProcessingAnswers(1, 'lost-wakeup-signal');
    await waitFor(async () =>
      (await prisma.trainingAnswer.findUniqueOrThrow({
        where: { id: item.answerId },
        select: { processingStatus: true },
      })).processingStatus === TrainingAnswerProcessingStatus.COMPLETED,
      4_000,
    );

    assert.equal(transcriber.calls, 1);
    assert.equal((await getAnswer(item.answerId)).processingAttempts, 1);
  });

  test('lost ownership cannot save a stale transcript and a fresh owner resumes it', async () => {
    const item = await createProcessingAnswers(1, 'lost-owner');
    const barrier = new BarrierTranscriber();
    const worker = createWorker(new ImmediateAudio(), barrier, evaluator, state);
    const running = worker.runOnce();
    await barrier.waitUntilStarted();
    const claimed = await prisma.trainingAnswer.findUniqueOrThrow({ where: { id: item[0].answerId } });
    assert.match(claimed.processingLockedBy, /^training-voice-/u);

    await prisma.trainingAnswer.update({
      where: { id: item[0].answerId },
      data: { processingLockedBy: 'new-owner', processingLockedAt: new Date(Date.now() - 10_000) },
    });
    barrier.release();
    assert.equal(await running, true);
    const staleResult = await prisma.trainingAnswer.findUniqueOrThrow({ where: { id: item[0].answerId } });
    assert.equal(staleResult.text, null);
    assert.equal(staleResult.processingStatus, TrainingAnswerProcessingStatus.PROCESSING);

    const resumed = createWorker(new ImmediateAudio(), new BoundedTranscriber(0), evaluator, state);
    assert.equal(await resumed.runOnce(), true);
    const completed = await prisma.trainingAnswer.findUniqueOrThrow({ where: { id: item[0].answerId } });
    assert.equal(completed.processingStatus, TrainingAnswerProcessingStatus.COMPLETED);
    assert.equal(completed.text, `transcript:${completed.id}`);
  });

  test('one worker recovers a stale crash claim while a second cannot duplicate it', async () => {
    const item = await createProcessingAnswers(1, 'two-workers');
    await prisma.trainingAnswer.update({
      where: { id: item[0].answerId },
      data: {
        processingAttempts: 1,
        processingLockedAt: new Date(Date.now() - 10_000),
        processingLockedBy: 'crashed-worker',
      },
    });
    const barrier = new BarrierTranscriber();
    const first = createWorker(new ImmediateAudio(), barrier, evaluator, state);
    const secondTranscriber = new BoundedTranscriber(0);
    const second = createWorker(new ImmediateAudio(), secondTranscriber, evaluator, state);
    const firstRun = first.runOnce();
    await barrier.waitUntilStarted();

    assert.equal(await second.runOnce(), false);
    assert.equal(secondTranscriber.calls, 0);
    barrier.release();
    assert.equal(await firstRun, true);
    const completed = await getAnswer(item[0].answerId);
    assert.equal(completed.processingStatus, 'COMPLETED');
    assert.equal(completed.processingAttempts, 2);
  });

  test('two worker processes share one deployment-wide provider concurrency limit', async (context) => {
    process.env.TRAINING_VOICE_WORKER_CONCURRENCY = '3';
    const items = await createProcessingAnswers(12, 'two-worker-processes');
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "training_voice_worker_test_stats" (
        "id" integer PRIMARY KEY,
        "active" integer NOT NULL,
        "peak" integer NOT NULL,
        "total" integer NOT NULL
      )
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "training_voice_worker_test_stats" ("id", "active", "peak", "total")
      VALUES (1, 0, 0, 0)
      ON CONFLICT ("id") DO UPDATE SET "active" = 0, "peak" = 0, "total" = 0
    `);

    const children = [startWorkerProcess(), startWorkerProcess()];
    context.after(async () => {
      await Promise.all(children.map((child) => stopWorkerProcess(child)));
      await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "training_voice_worker_test_stats"');
    });
    await Promise.all(children.map((child) => waitForWorkerProcess(child)));
    await waitFor(async () =>
      (await prisma.trainingAnswer.count({
        where: {
          id: { in: items.map((item) => item.answerId) },
          processingStatus: TrainingAnswerProcessingStatus.COMPLETED,
        },
      })) === items.length,
    );
    await Promise.all(children.map((child) => stopWorkerProcess(child)));

    const [stats] = await prisma.$queryRawUnsafe(
      'SELECT "active", "peak", "total" FROM "training_voice_worker_test_stats" WHERE "id" = 1',
    );
    assert.equal(stats.active, 0);
    assert.equal(stats.total, items.length);
    assert.equal(stats.peak, 3);
  });

  test('disable before claim and between claim/external call makes no call and re-enable resumes', async () => {
    const item = await createProcessingAnswers(1, 'disable-race');
    const audio = new ImmediateAudio();
    const transcriber = new BoundedTranscriber(0);
    const worker = createWorker(audio, transcriber, evaluator, state);

    process.env.TRAINING_MODULE_ENABLED = 'false';
    assert.equal(await worker.runOnce(), false);
    assert.equal(audio.calls, 0);
    assert.equal((await getAnswer(item[0].answerId)).processingAttempts, 0);

    process.env.TRAINING_MODULE_ENABLED = 'true';
    const gate = new StateGate(state);
    const claimedWorker = createWorker(audio, transcriber, evaluator, gate);
    const running = claimedWorker.runOnce();
    await gate.waitUntilClaimed();
    process.env.TRAINING_MODULE_ENABLED = 'false';
    gate.release();
    assert.equal(await running, true);
    const disabled = await getAnswer(item[0].answerId);
    assert.equal(audio.calls, 0);
    assert.equal(transcriber.calls, 0);
    assert.equal(disabled.processingAttempts, 0);
    assert.equal(disabled.processingLockedBy, null);

    process.env.TRAINING_MODULE_ENABLED = 'true';
    assert.equal(await worker.runOnce(), true);
    assert.equal((await getAnswer(item[0].answerId)).processingStatus, 'COMPLETED');
  });

  test('shutdown stops new claims, bounds drain and restart completes persisted work', async (context) => {
    process.env.TRAINING_VOICE_WORKER_CONCURRENCY = '1';
    const items = await createProcessingAnswers(3, 'shutdown');
    const barrier = new BarrierTranscriber();
    const worker = createWorker(new ImmediateAudio(), barrier, evaluator, state);
    context.after(async () => {
      barrier.release();
      await worker.shutdown();
    });
    await worker.onModuleInit();
    await barrier.waitUntilStarted();
    await worker.shutdown();

    const afterShutdown = await prisma.trainingAnswer.findMany({
      where: { id: { in: items.map((item) => item.answerId) } },
      orderBy: { createdAt: 'asc' },
    });
    assert.equal(barrier.calls, 1);
    assert.deepEqual(
      afterShutdown.map((answer) => answer.processingAttempts).sort((left, right) => left - right),
      [0, 0, 1],
    );
    assert.equal(afterShutdown.every((answer) => answer.processingStatus === 'PROCESSING'), true);
    assert.equal(afterShutdown.every((answer) => answer.processingLockedBy === null), true);

    barrier.release();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const restartTranscriber = new BoundedTranscriber(5);
    const restarted = createWorker(new ImmediateAudio(), restartTranscriber, evaluator, state);
    context.after(() => restarted.shutdown());
    await restarted.onModuleInit();
    await waitFor(async () =>
      (await prisma.trainingAnswer.count({
        where: { id: { in: items.map((item) => item.answerId) }, processingStatus: 'COMPLETED' },
      })) === 3,
    );
    await restarted.shutdown();
    assert.equal(restartTranscriber.calls, 3);
    assert.equal(
      (await prisma.trainingAnswer.findMany({
        where: {
          id: { in: items.map((item) => item.answerId) },
        },
      }))
        .every((answer) => answer.processingLockedBy === null),
      true,
    );
  });

  test('shutdown waits for an in-flight claim and releases it before Prisma teardown', async () => {
    const item = await createProcessingAnswers(1, 'shutdown-during-claim');
    let releaseClaimQuery;
    let signalClaimQuery;
    const claimQueryStarted = new Promise((resolve) => { signalClaimQuery = resolve; });
    const claimQueryBarrier = new Promise((resolve) => { releaseClaimQuery = resolve; });
    const originalTransaction = prisma.$transaction.bind(prisma);
    let gateNextTransaction = true;
    const gatedPrisma = new Proxy(prisma, {
      get(target, property) {
        if (property === '$transaction') {
          return async (...args) => {
            if (gateNextTransaction) {
              gateNextTransaction = false;
              signalClaimQuery();
              await claimQueryBarrier;
            }
            return originalTransaction(...args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const worker = new TrainingVoiceWorkerService(
      gatedPrisma,
      new ImmediateAudio(),
      new BoundedTranscriber(0),
      evaluator,
      state,
      { notifyAnswerProcessed: async () => undefined, notifyAnswerFailed: async () => undefined },
    );

    worker.kick();
    await claimQueryStarted;
    const shutdown = worker.shutdown();
    releaseClaimQuery();
    await shutdown;

    const released = await getAnswer(item[0].answerId);
    assert.equal(released.processingStatus, 'PROCESSING');
    assert.equal(released.processingAttempts, 0);
    assert.equal(released.processingLockedBy, null);

    const restarted = createWorker(new ImmediateAudio(), new BoundedTranscriber(0), evaluator, state);
    assert.equal(await restarted.runOnce(), true);
    assert.equal((await getAnswer(item[0].answerId)).processingStatus, 'COMPLETED');
  });

  test('shutdown remains bounded when an in-flight claim query does not settle', async () => {
    const item = await createProcessingAnswers(1, 'bounded-claim-query');
    let releaseClaimQuery;
    let signalClaimQuery;
    const claimQueryStarted = new Promise((resolve) => { signalClaimQuery = resolve; });
    const claimQueryBarrier = new Promise((resolve) => { releaseClaimQuery = resolve; });
    const originalTransaction = prisma.$transaction.bind(prisma);
    const gatedPrisma = new Proxy(prisma, {
      get(target, property) {
        if (property === '$transaction') {
          return async (...args) => {
            signalClaimQuery();
            await claimQueryBarrier;
            return originalTransaction(...args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const worker = new TrainingVoiceWorkerService(
      gatedPrisma,
      new ImmediateAudio(),
      new BoundedTranscriber(0),
      evaluator,
      state,
      { notifyAnswerProcessed: async () => undefined, notifyAnswerFailed: async () => undefined },
    );

    worker.kick();
    await claimQueryStarted;
    const startedAt = Date.now();
    await worker.shutdown();
    const elapsedMs = Date.now() - startedAt;
    assert.equal(elapsedMs >= 150, true);
    assert.equal(elapsedMs < 750, true);

    releaseClaimQuery();
    await waitFor(async () => {
      const answer = await getAnswer(item[0].answerId);
      return answer.processingAttempts === 0 && answer.processingLockedBy === null;
    });
  });

  test('shutdown saves a completed transcription checkpoint inside the grace bound', async (context) => {
    process.env.TRAINING_VOICE_WORKER_CONCURRENCY = '1';
    const item = await createProcessingAnswers(1, 'bounded-drain');
    const barrier = new BarrierTranscriber();
    const worker = createWorker(new ImmediateAudio(), barrier, evaluator, state);
    context.after(async () => {
      barrier.release();
      await worker.shutdown();
    });
    await worker.onModuleInit();
    await barrier.waitUntilStarted();
    const shutdown = worker.shutdown();
    setTimeout(() => barrier.release(), 50);
    await shutdown;

    const answer = await getAnswer(item[0].answerId);
    assert.equal(answer.processingStatus, 'PROCESSING');
    assert.equal(answer.processingLockedBy, null);
    assert.equal(answer.transcriptionStatus, 'COMPLETED');
    assert.equal(answer.evaluationStatus, 'PENDING');

    const skippedTranscriber = new BoundedTranscriber(0);
    const restarted = createWorker(
      new ImmediateAudio(),
      skippedTranscriber,
      evaluator,
      state,
    );
    assert.equal(await restarted.runOnce(), true);
    assert.equal(skippedTranscriber.calls, 0);
    assert.equal((await getAnswer(item[0].answerId)).processingStatus, 'COMPLETED');
  });

  test('shutdown aborts an in-flight transcription and restart resumes the pending checkpoint', async () => {
    process.env.TRAINING_VOICE_WORKER_CONCURRENCY = '1';
    const item = await createProcessingAnswers(1, 'abort-transcription');
    const transcriber = new AbortAwareTranscriber();
    const worker = createWorker(new ImmediateAudio(), transcriber, evaluator, state);
    const running = worker.runOnce();

    await transcriber.waitUntilStarted();
    await worker.shutdown();
    assert.equal(await running, true);

    const cancelled = await getAnswer(item[0].answerId);
    assert.equal(transcriber.aborted, true);
    assert.equal(cancelled.processingStatus, 'PROCESSING');
    assert.equal(cancelled.processingAttempts, 1);
    assert.equal(cancelled.processingLockedBy, null);
    assert.equal(cancelled.transcriptionStatus, 'PENDING');

    const restartedTranscriber = new BoundedTranscriber(0);
    const restarted = createWorker(
      new ImmediateAudio(),
      restartedTranscriber,
      evaluator,
      state,
    );
    assert.equal(await restarted.runOnce(), true);
    assert.equal(restartedTranscriber.calls, 1);
    assert.equal((await getAnswer(item[0].answerId)).processingStatus, 'COMPLETED');
  });

  test('shutdown before the first provider call rolls back the processing attempt', async (context) => {
    process.env.TRAINING_VOICE_WORKER_CONCURRENCY = '1';
    const item = await createProcessingAnswers(1, 'before-provider');
    const audio = new BarrierAudio();
    const transcriber = new BoundedTranscriber(0);
    const worker = createWorker(audio, transcriber, evaluator, state);
    context.after(async () => {
      audio.release();
      await worker.shutdown();
    });
    await worker.onModuleInit();
    await audio.waitUntilStarted();
    await worker.shutdown();

    const released = await getAnswer(item[0].answerId);
    assert.equal(transcriber.calls, 0);
    assert.equal(released.processingStatus, 'PROCESSING');
    assert.equal(released.processingAttempts, 0);
    assert.equal(released.processingLockedBy, null);
    audio.release();
    await audio.waitUntilFinished();

    const restarted = createWorker(
      new ImmediateAudio(),
      transcriber,
      evaluator,
      state,
    );
    assert.equal(await restarted.runOnce(), true);
    assert.equal(transcriber.calls, 1);
    assert.equal((await getAnswer(item[0].answerId)).processingAttempts, 1);
  });

  test('shutdown between checkpoints preserves transcription and restart does not repeat it', async () => {
    process.env.TRAINING_VOICE_WORKER_CONCURRENCY = '1';
    const item = await createProcessingAnswers(1, 'transcription-checkpoint');
    const transcriber = new BoundedTranscriber(0);
    const barrierEvaluator = new AbortAwareEvaluator(evaluator);
    const worker = createWorker(
      new ImmediateAudio(),
      transcriber,
      barrierEvaluator,
      state,
    );
    const running = worker.runOnce();

    await barrierEvaluator.waitUntilStarted();
    const checkpoint = await getAnswer(item[0].answerId);
    assert.equal(checkpoint.transcriptionStatus, 'COMPLETED');
    assert.equal(checkpoint.evaluationStatus, 'PENDING');
    await worker.shutdown();
    assert.equal(await running, true);

    const cancelled = await getAnswer(item[0].answerId);
    assert.equal(barrierEvaluator.aborted, true);
    assert.equal(cancelled.processingStatus, 'PROCESSING');
    assert.equal(cancelled.processingLockedBy, null);
    assert.equal(cancelled.transcriptionStatus, 'COMPLETED');
    assert.equal(cancelled.evaluationStatus, 'PENDING');

    const skippedTranscriber = new BoundedTranscriber(0);
    const restarted = createWorker(
      new ImmediateAudio(),
      skippedTranscriber,
      evaluator,
      state,
    );
    assert.equal(await restarted.runOnce(), true);
    assert.equal(skippedTranscriber.calls, 0);
    assert.equal((await getAnswer(item[0].answerId)).processingStatus, 'COMPLETED');
  });

  test('restart after the evaluation checkpoint repeats neither paid provider step', async (context) => {
    process.env.TRAINING_VOICE_WORKER_CONCURRENCY = '1';
    const item = await createProcessingAnswers(1, 'evaluation-checkpoint');
    const transcriber = new BoundedTranscriber(0);
    const countingEvaluator = new CountingEvaluator(evaluator);
    const completionGate = new CompletionGate(state);
    const worker = createWorker(
      new ImmediateAudio(),
      transcriber,
      countingEvaluator,
      completionGate,
    );
    context.after(async () => {
      completionGate.release();
      await worker.shutdown();
    });
    await worker.onModuleInit();
    await completionGate.waitUntilStarted();

    const checkpoint = await getAnswer(item[0].answerId);
    assert.equal(checkpoint.transcriptionStatus, 'COMPLETED');
    assert.equal(checkpoint.evaluationStatus, 'COMPLETED');
    await worker.shutdown();

    const released = await getAnswer(item[0].answerId);
    assert.equal(released.processingStatus, 'PROCESSING');
    assert.equal(released.processingLockedBy, null);
    assert.equal(released.transcriptionStatus, 'COMPLETED');
    assert.equal(released.evaluationStatus, 'COMPLETED');
    completionGate.release();
    await completionGate.waitUntilFinished();

    const skippedTranscriber = new BoundedTranscriber(0);
    const skippedEvaluator = new CountingEvaluator(evaluator);
    const restarted = createWorker(
      new ImmediateAudio(),
      skippedTranscriber,
      skippedEvaluator,
      state,
    );
    assert.equal(await restarted.runOnce(), true);
    assert.equal(skippedTranscriber.calls, 0);
    assert.equal(skippedEvaluator.calls, 0);
    assert.equal(transcriber.calls, 1);
    assert.equal(countingEvaluator.calls, 1);
    assert.equal((await getAnswer(item[0].answerId)).processingStatus, 'COMPLETED');
  });

  test('pre-deploy probe reports active claim age and requires explicit confirmation', async () => {
    const item = await createProcessingAnswers(1, 'predeploy-probe');
    await prisma.trainingAnswer.update({
      where: { id: item[0].answerId },
      data: {
        processingAttempts: 1,
        processingLockedAt: new Date(),
        processingLockedBy: 'predeploy-probe-owner',
      },
    });
    const root = resolve(__dirname, '../../..');
    const script = resolve(__dirname, '../scripts/training-voice-worker-predeploy.cjs');
    const environment = { ...process.env, DATABASE_URL: databaseUrl };
    const blocked = spawnSync(process.execPath, [script], {
      cwd: root,
      env: environment,
      encoding: 'utf8',
    });

    assert.equal(blocked.status, 2);
    const blockedReport = JSON.parse(blocked.stdout);
    assert.equal(blockedReport.event, 'training_voice_worker_predeploy');
    assert.equal(blockedReport.activeClaims, 1);
    assert.equal(Number.isInteger(blockedReport.oldestActiveAgeSeconds), true);
    assert.equal(blockedReport.oldestActiveAgeSeconds >= 0, true);
    assert.equal(blockedReport.activeDeployConfirmed, false);
    assert.match(blocked.stderr, /deploy blocked/u);

    const confirmed = spawnSync(process.execPath, [script, '--confirm-active'], {
      cwd: root,
      env: environment,
      encoding: 'utf8',
    });
    const confirmedReport = JSON.parse(confirmed.stdout);
    assert.equal(confirmed.status, 0);
    assert.equal(confirmedReport.activeClaims, 1);
    assert.equal(confirmedReport.activeDeployConfirmed, true);
  });

  async function createProcessingAnswers(count, label) {
    const project = await createOpenProject(`Project ${label}`);
    const users = await createUsers(count, label);
    const started = await Promise.all(users.map((user) => attempts.startAttempt(project.id, user.id, {
      confirmed: true,
      idempotencyKey: randomUUID(),
    })));

    return Promise.all(started.map(async (attempt, index) => {
      const answer = await prisma.trainingAnswer.create({
        data: {
          attemptQuestionId: attempt.currentQuestion.id,
          source: 'TELEGRAM',
          processingStatus: 'PROCESSING',
          submittedAt: new Date(),
          segments: {
            create: {
              position: 1,
              telegramMessageId: BigInt(40_000 + index),
              telegramFileId: `processing-file-${randomUUID()}`,
              telegramFileUniqueId: `processing-unique-${randomUUID()}`,
              durationSeconds: 10,
              sizeBytes: 64n,
            },
          },
        },
      });
      return { answerId: answer.id, attempt, user: users[index] };
    }));
  }

  async function createOpenProject(title) {
    const project = await projects.createProject({
      title,
      description: null,
      realEstateObjectId: null,
      sortOrder: 0,
      attemptLimit: 3,
      timeLimitSeconds: 420,
      passScore: 75,
      allowRetakeAfterPass: true,
      accessMode: TrainingProjectAccessMode.ALL_PARTICIPANTS,
    });
    await projects.updateDraft(project.id, {
      title,
      description: null,
      realEstateObjectId: null,
      sortOrder: 0,
      attemptLimit: 3,
      timeLimitSeconds: 420,
      passScore: 75,
      allowRetakeAfterPass: true,
      accessMode: TrainingProjectAccessMode.ALL_PARTICIPANTS,
      mainQuestion: `${title} main`,
      followUpQuestions: Array.from({ length: 10 }, (_, index) => `${title} follow-up ${index + 1}`),
      facts: Array.from({ length: 11 }, (_, index) => ({
        id: null,
        questionType: index === 0 ? 'MAIN' : 'FOLLOW_UP',
        questionPosition: index === 0 ? 1 : index,
        statement: `${title} approved fact ${index + 1}`,
        aliases: [`term ${index + 1}`],
        isRequired: true,
        position: 1,
      })),
      criteria: [
        { id: null, questionType: 'MAIN', code: 'main', title: 'Main', guidance: '', maxPoints: 55, position: 1 },
        { id: null, questionType: 'FOLLOW_UP', code: 'follow_up', title: 'Follow-up', guidance: '', maxPoints: 15, position: 1 },
      ],
    });
    await projects.publishProject(project.id);
    return projects.setAvailability(project.id, true);
  }

  async function createUsers(count, label) {
    const permission = await prisma.permission.upsert({
      where: { key: 'training:participate' },
      update: {},
      create: { key: 'training:participate', description: 'Participate' },
    });
    const role = await prisma.role.create({
      data: {
        name: `training-stage5-part3-${randomUUID()}`,
        permissions: { create: { permissionId: permission.id } },
      },
    });
    return Promise.all(Array.from({ length: count }, (_, index) => prisma.user.create({
      data: {
        email: `${label}-${index}-${randomUUID()}@training-part3.test`,
        passwordHash: 'test-hash',
        name: `${label}-${index}`,
        status: UserStatus.ACTIVE,
        roleId: role.id,
      },
    })));
  }

  function createWorker(audio, transcriber, workerEvaluator, attemptState, telegram = null) {
    return new TrainingVoiceWorkerService(
      prisma,
      audio,
      transcriber,
      workerEvaluator,
      attemptState,
      telegram
        ? new TrainingTelegramOutboxWorkerService(prisma, telegram)
        : { notifyAnswerProcessed: async () => undefined, notifyAnswerFailed: async () => undefined },
      voiceWorkerWakeup,
    );
  }

  function startWorkerProcess() {
    return fork(resolve(__dirname, 'training-v2-voice-worker-process.cjs'), [], {
      cwd: resolve(__dirname, '..'),
      env: {
        ...process.env,
        TRAINING_TEST_DATABASE_URL: databaseUrl,
        TRAINING_TEST_PROVIDER_DELAY_MS: '250',
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
  }

  function waitForWorkerProcess(child) {
    return new Promise((resolveReady, rejectReady) => {
      const timeout = setTimeout(
        () => rejectReady(new Error('Timed out starting voice worker process')),
        10_000,
      );
      const onExit = (code) => {
        clearTimeout(timeout);
        rejectReady(new Error(`Voice worker process exited before ready: ${code}`));
      };

      child.once('exit', onExit);
      child.on('message', (message) => {
        if (message?.event === 'ready') {
          clearTimeout(timeout);
          child.off('exit', onExit);
          resolveReady();
        } else if (message?.event === 'error') {
          clearTimeout(timeout);
          child.off('exit', onExit);
          rejectReady(new Error(`Voice worker process failed: ${message.code}`));
        }
      });
    });
  }

  function stopWorkerProcess(child) {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

    return new Promise((resolveStopped) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
      }, 2_000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolveStopped();
      });
      child.kill('SIGTERM');
    });
  }

  function voiceUpdate(telegramUserId, chatId, messageId, fileId, uniqueId) {
    return {
      update_id: messageId,
      message: {
        message_id: messageId,
        from: { id: telegramUserId },
        chat: { id: chatId, type: 'private' },
        voice: { file_id: fileId, file_unique_id: uniqueId, duration: 10, file_size: 64 },
      },
    };
  }

  function finishUpdate(telegramUserId, chatId, questionId, callbackId) {
    return {
      update_id: Math.floor(Math.random() * 1_000_000),
      callback_query: {
        id: callbackId,
        from: { id: telegramUserId },
        message: { message_id: 1, chat: { id: chatId, type: 'private' } },
        data: `tr:finish:${questionId}`,
      },
    };
  }

  async function getAnswer(answerId) {
    return prisma.trainingAnswer.findUniqueOrThrow({ where: { id: answerId } });
  }

  async function waitFor(predicate, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for Training worker state');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function clearTrainingData() {
    await prisma.trainingAnswerSegment.deleteMany();
    await prisma.trainingAnswer.deleteMany();
    await prisma.trainingAttemptQuestion.deleteMany();
    await prisma.trainingAttempt.deleteMany();
    await prisma.trainingTelegramLinkToken.deleteMany();
    await prisma.trainingTelegramAccount.deleteMany();
    await prisma.trainingProjectAssignment.deleteMany();
    await prisma.trainingFact.deleteMany();
    await prisma.trainingCriterion.deleteMany();
    await prisma.trainingQuestion.deleteMany();
    await prisma.trainingProject.deleteMany();
    await prisma.file.deleteMany({
      where: {
        OR: [
          { key: { startsWith: 'training-stage5-part3-test/' } },
          { key: { startsWith: 'training-worker-process-test/' } },
        ],
      },
    });
    await prisma.user.deleteMany({ where: { email: { endsWith: '@training-part3.test' } } });
    await prisma.role.deleteMany({ where: { name: { startsWith: 'training-stage5-part3-' } } });
  }

  class ImmediateAudio {
    constructor() { this.calls = 0; this.active = 0; this.peakActive = 0; }
    async prepareAnswerAudio(answerId) {
      this.calls += 1;
      this.active += 1;
      this.peakActive = Math.max(this.peakActive, this.active);
      const wav = Buffer.alloc(64);
      wav.write('RIFF', 0, 'ascii');
      wav.write('WAVE', 8, 'ascii');
      const current = await prisma.trainingAnswer.findUniqueOrThrow({ where: { id: answerId } });
      let fileId = current.mergedAudioFileId;

      if (!fileId) {
        const file = await prisma.file.create({
          data: {
            storage: 'MINIO',
            bucket: 'training-stage5-part3-private',
            key: `training-stage5-part3-test/${answerId}.wav`,
            url: null,
            originalName: 'answer.wav',
            mimeType: 'audio/wav',
            sizeBytes: BigInt(wav.length),
            checksum: `checksum-${answerId}`,
          },
        });
        fileId = file.id;
        await prisma.trainingAnswer.update({
          where: { id: answerId },
          data: { mergedAudioFileId: fileId },
        });
      }
      this.active -= 1;
      return {
        answerId,
        fileId,
        mimeType: 'audio/wav',
        sizeBytes: wav.length,
        checksum: `checksum:${answerId}`,
        wav,
      };
    }
  }

  class BoundedTranscriber {
    constructor(delayMs) { this.delayMs = delayMs; this.calls = 0; this.active = 0; this.peakActive = 0; }
    async transcribe(input) {
      this.calls += 1;
      this.active += 1;
      this.peakActive = Math.max(this.peakActive, this.active);
      if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      this.active -= 1;
      return {
        text: `transcript:${input.answerId}`,
        model: 'local-stub-transcriber',
        requestId: `stub:${input.answerId}`,
        latencyMs: this.delayMs,
        attempts: 1,
        usage: null,
      };
    }
  }

  class BarrierAudio {
    constructor() {
      this.delegate = new ImmediateAudio();
      this.started = new Promise((resolve) => { this.signalStarted = resolve; });
      this.barrier = new Promise((resolve) => { this.releaseBarrier = resolve; });
      this.finished = new Promise((resolve) => { this.signalFinished = resolve; });
    }
    async prepareAnswerAudio(answerId) {
      this.signalStarted();
      await this.barrier;
      try {
        return await this.delegate.prepareAnswerAudio(answerId);
      } finally {
        this.signalFinished();
      }
    }
    waitUntilStarted() { return this.started; }
    waitUntilFinished() { return this.finished; }
    release() { this.releaseBarrier(); }
  }

  class BarrierTranscriber extends BoundedTranscriber {
    constructor() {
      super(0);
      this.started = new Promise((resolve) => { this.signalStarted = resolve; });
      this.barrier = new Promise((resolve) => { this.releaseBarrier = resolve; });
    }
    async transcribe(input) {
      this.calls += 1;
      this.active += 1;
      this.peakActive = Math.max(this.peakActive, this.active);
      this.signalStarted();
      await this.barrier;
      this.active -= 1;
      return {
        text: `transcript:${input.answerId}`,
        model: 'local-barrier-transcriber',
        requestId: `stub:${input.answerId}`,
        latencyMs: 1,
        attempts: 1,
        usage: null,
      };
    }
    waitUntilStarted() { return this.started; }
    release() { this.releaseBarrier(); }
  }

  class AbortAwareTranscriber extends BoundedTranscriber {
    constructor() {
      super(0);
      this.aborted = false;
      this.started = new Promise((resolve) => { this.signalStarted = resolve; });
    }
    async transcribe(_input, options) {
      this.calls += 1;
      this.signalStarted();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          this.aborted = true;
          reject(new TrainingOpenAIError(
            'OPENAI_ABORTED',
            true,
            1,
          ));
        }, { once: true });
      });
    }
    waitUntilStarted() { return this.started; }
  }

  class AbortAwareEvaluator {
    constructor(delegate) {
      this.delegate = delegate;
      this.version = delegate.version;
      this.aborted = false;
      this.started = new Promise((resolve) => { this.signalStarted = resolve; });
    }
    async evaluate(_input, options) {
      this.signalStarted();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          this.aborted = true;
          reject(new TrainingOpenAIError(
            'OPENAI_ABORTED',
            true,
            1,
          ));
        }, { once: true });
      });
    }
    waitUntilStarted() { return this.started; }
  }

  class CountingEvaluator {
    constructor(delegate) {
      this.delegate = delegate;
      this.version = delegate.version;
      this.calls = 0;
    }
    evaluate(input, options) {
      this.calls += 1;
      return this.delegate.evaluate(input, options);
    }
  }

  class StateGate {
    constructor(delegate) {
      this.delegate = delegate;
      this.claimed = new Promise((resolve) => { this.signalClaimed = resolve; });
      this.barrier = new Promise((resolve) => { this.releaseBarrier = resolve; });
    }
    async finalizeAttemptIfExpired(...args) {
      this.signalClaimed();
      await this.barrier;
      return this.delegate.finalizeAttemptIfExpired(...args);
    }
    completeEvaluatedTelegramVoiceAnswer(...args) {
      return this.delegate.completeEvaluatedTelegramVoiceAnswer(...args);
    }
    completeTelegramVoiceAnswer(...args) {
      return this.delegate.completeTelegramVoiceAnswer(...args);
    }
    failTelegramVoiceAttempt(...args) {
      return this.delegate.failTelegramVoiceAttempt(...args);
    }
    waitUntilClaimed() { return this.claimed; }
    release() { this.releaseBarrier(); }
  }

  class CompletionGate {
    constructor(delegate) {
      this.delegate = delegate;
      this.started = new Promise((resolve) => { this.signalStarted = resolve; });
      this.barrier = new Promise((resolve) => { this.releaseBarrier = resolve; });
      this.finished = new Promise((resolve) => { this.signalFinished = resolve; });
    }
    finalizeAttemptIfExpired(...args) {
      return this.delegate.finalizeAttemptIfExpired(...args);
    }
    async completeEvaluatedTelegramVoiceAnswer(...args) {
      this.signalStarted();
      await this.barrier;
      try {
        return await this.delegate.completeEvaluatedTelegramVoiceAnswer(...args);
      } finally {
        this.signalFinished();
      }
    }
    completeTelegramVoiceAnswer(...args) {
      return this.delegate.completeTelegramVoiceAnswer(...args);
    }
    failTelegramVoiceAttempt(...args) {
      return this.delegate.failTelegramVoiceAttempt(...args);
    }
    waitUntilStarted() { return this.started; }
    waitUntilFinished() { return this.finished; }
    release() { this.releaseBarrier(); }
  }
}
