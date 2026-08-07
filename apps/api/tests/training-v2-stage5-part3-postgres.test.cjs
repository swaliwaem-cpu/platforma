require('reflect-metadata');

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
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
const { TrainingTelegramService } = require('../dist/training/training-telegram.service.js');
const {
  TrainingTelegramOutboxWorkerService,
} = require('../dist/training/training-telegram-outbox-worker.service.js');
const { TrainingVoiceWorkerService } = require('../dist/training/training-voice-worker.service.js');

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
  const state = new TrainingAttemptStateService(
    prisma,
    evaluator,
    { select: (candidates) => candidates.slice(0, 3) },
    projectAccess,
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

  test('two workers cannot process one answer twice', async () => {
    const item = await createProcessingAnswers(1, 'two-workers');
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
    assert.equal(completed.processingAttempts, 1);
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
    const originalQueryRaw = prisma.$queryRaw.bind(prisma);
    let gateNextQuery = true;
    const gatedPrisma = new Proxy(prisma, {
      get(target, property) {
        if (property === '$queryRaw') {
          return async (...args) => {
            if (gateNextQuery) {
              gateNextQuery = false;
              signalClaimQuery();
              await claimQueryBarrier;
            }
            return originalQueryRaw(...args);
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
    const originalQueryRaw = prisma.$queryRaw.bind(prisma);
    const gatedPrisma = new Proxy(prisma, {
      get(target, property) {
        if (property === '$queryRaw') {
          return async (...args) => {
            signalClaimQuery();
            await claimQueryBarrier;
            return originalQueryRaw(...args);
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

  test('shutdown drains active work when it finishes inside the grace bound', async (context) => {
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
    assert.equal(answer.processingStatus, 'COMPLETED');
    assert.equal(answer.processingLockedBy, null);
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
    );
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
    await prisma.file.deleteMany({ where: { key: { startsWith: 'training-stage5-part3-test/' } } });
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
}
