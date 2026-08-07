require('reflect-metadata');

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, beforeEach, describe, test } = require('node:test');
const {
  Prisma,
  PrismaClient,
  TrainingTelegramOutboxEventType,
  TrainingTelegramOutboxStatus,
  UserStatus,
} = require('@prisma/client');

const {
  FakeTrainingTelegramClient,
  TrainingTelegramClientError,
} = require('../dist/training/training-telegram-client.js');
const {
  enqueueTrainingTelegramOutbox,
} = require('../dist/training/training-telegram-outbox.js');
const {
  TrainingTelegramOutboxWorkerService,
} = require('../dist/training/training-telegram-outbox-worker.service.js');
const {
  TrainingTelegramService,
} = require('../dist/training/training-telegram.service.js');

const databaseUrl = process.env.TRAINING_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('Training Telegram outbox PostgreSQL scenarios require the targeted runner', () => {
    assert.equal(process.env.TRAINING_TEST_DATABASE_URL, undefined);
  });
} else {
  describe('Training Telegram delivery outbox PostgreSQL', { concurrency: false }, () => {
  process.env.TRAINING_MODULE_ENABLED = 'true';
  process.env.TRAINING_TELEGRAM_OUTBOX_STALE_LOCK_MS = '5000';
  process.env.TRAINING_TELEGRAM_OUTBOX_RETRY_BASE_MS = '100';

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  before(async () => prisma.$connect());
  beforeEach(clearTrainingData);
  after(async () => {
    await clearTrainingData();
    await prisma.$disconnect();
  });

  test('committed intent survives a failed delivery and a restarted worker sends it once', async () => {
    const scenario = await createScenario('restart');
    const client = new FlakyClient(true);
    const telegram = createTelegram(client);

    assert.equal(client.sentMessages.length, 0);
    assert.equal(
      await prisma.trainingTelegramOutbox.count({
        where: { attemptId: scenario.attemptId, status: TrainingTelegramOutboxStatus.PENDING },
      }),
      1,
    );

    const firstWorker = new TrainingTelegramOutboxWorkerService(prisma, telegram);
    assert.equal(await firstWorker.runOnce(), true);
    const scheduled = await prisma.trainingTelegramOutbox.findFirstOrThrow({
      where: { attemptId: scenario.attemptId },
    });
    assert.equal(scheduled.status, TrainingTelegramOutboxStatus.PENDING);
    assert.equal(scheduled.attempts, 1);
    assert.equal(scheduled.lastErrorCode, 'SENDMESSAGE_NETWORK');
    assert.equal(client.sentMessages.length, 0);

    await prisma.trainingTelegramOutbox.update({
      where: { id: scheduled.id },
      data: { availableAt: new Date(Date.now() - 1_000) },
    });
    process.env.TRAINING_TELEGRAM_OUTBOX_WORKER_ENABLED = 'true';
    process.env.TRAINING_TELEGRAM_OUTBOX_POLL_INTERVAL_MS = '250';
    const restartedWorker = new TrainingTelegramOutboxWorkerService(prisma, telegram);
    try {
      await restartedWorker.onModuleInit();
      await waitFor(async () =>
        (await prisma.trainingTelegramOutbox.findUniqueOrThrow({ where: { id: scheduled.id } }))
          .status === TrainingTelegramOutboxStatus.SENT,
      );
    } finally {
      await restartedWorker.onModuleDestroy();
      delete process.env.TRAINING_TELEGRAM_OUTBOX_WORKER_ENABLED;
      delete process.env.TRAINING_TELEGRAM_OUTBOX_POLL_INTERVAL_MS;
    }

    const sent = await prisma.trainingTelegramOutbox.findUniqueOrThrow({
      where: { id: scheduled.id },
    });
    assert.equal(sent.status, TrainingTelegramOutboxStatus.SENT);
    assert.equal(sent.attempts, 2);
    assert.equal(sent.lockedAt, null);
    assert.equal(sent.lockedBy, null);
    assert.equal(client.sentMessages.length, 1);
    assert.match(client.sentMessages[0].text, /^Вопрос 2 из 4/u);
  });

  test('deduplication and SKIP LOCKED prevent two workers from sending one event in parallel', async () => {
    const scenario = await createScenario('concurrency');
    await prisma.$transaction((transaction) => enqueueTrainingTelegramOutbox(transaction, {
      eventType: TrainingTelegramOutboxEventType.ANSWER_PROCESSED,
      attemptId: scenario.attemptId,
      answerId: scenario.answerId,
    }));
    assert.equal(
      await prisma.trainingTelegramOutbox.count({ where: { attemptId: scenario.attemptId } }),
      1,
    );

    const client = new BarrierClient();
    const telegram = createTelegram(client);
    const firstWorker = new TrainingTelegramOutboxWorkerService(prisma, telegram);
    const secondWorker = new TrainingTelegramOutboxWorkerService(prisma, telegram);
    const firstRun = firstWorker.runOnce();
    await assertDeliveryStarted(client, firstRun);

    assert.equal(await secondWorker.runOnce(), false);
    assert.equal(client.calls, 1);
    assert.equal(client.peakActive, 1);
    client.release();
    assert.equal(await firstRun, true);
    assert.equal(client.sentMessages.length, 1);
  });

  test('a stale claim is recovered and completed with a fresh fencing token', async () => {
    const scenario = await createScenario('stale');
    const notification = await prisma.trainingTelegramOutbox.findFirstOrThrow({
      where: { attemptId: scenario.attemptId },
    });
    await prisma.trainingTelegramOutbox.update({
      where: { id: notification.id },
      data: {
        status: TrainingTelegramOutboxStatus.PROCESSING,
        attempts: 1,
        lockedAt: new Date(Date.now() - 10_000),
        lockedBy: 'dead-worker-token',
      },
    });

    const client = new FakeTrainingTelegramClient();
    const worker = new TrainingTelegramOutboxWorkerService(prisma, createTelegram(client));
    assert.equal(await worker.runOnce(), true);

    const recovered = await prisma.trainingTelegramOutbox.findUniqueOrThrow({
      where: { id: notification.id },
    });
    assert.equal(recovered.status, TrainingTelegramOutboxStatus.SENT);
    assert.equal(recovered.attempts, 2);
    assert.equal(recovered.lockedBy, null);
    assert.equal(client.sentMessages.length, 1);
  });

  test('a worker that loses its fencing token cannot finalize the replacement claim', async () => {
    const scenario = await createScenario('fencing');
    const client = new BarrierClient();
    const worker = new TrainingTelegramOutboxWorkerService(prisma, createTelegram(client));
    const running = worker.runOnce();
    await assertDeliveryStarted(client, running);
    const claimed = await prisma.trainingTelegramOutbox.findFirstOrThrow({
      where: { attemptId: scenario.attemptId },
    });

    await prisma.trainingTelegramOutbox.update({
      where: { id: claimed.id },
      data: { lockedBy: 'replacement-token' },
    });
    client.release();
    assert.equal(await running, true);

    const fenced = await prisma.trainingTelegramOutbox.findUniqueOrThrow({
      where: { id: claimed.id },
    });
    assert.equal(fenced.status, TrainingTelegramOutboxStatus.PROCESSING);
    assert.equal(fenced.lockedBy, 'replacement-token');
  });

  test('non-retryable failure remains available for manual retry', async () => {
    const scenario = await createScenario('manual-retry');
    const client = new SwitchableClient();
    const worker = new TrainingTelegramOutboxWorkerService(prisma, createTelegram(client));

    assert.equal(await worker.runOnce(), true);
    const failed = await prisma.trainingTelegramOutbox.findFirstOrThrow({
      where: { attemptId: scenario.attemptId },
    });
    assert.equal(failed.status, TrainingTelegramOutboxStatus.FAILED);
    assert.equal(failed.lastErrorCode, 'BOT_API_400');

    client.shouldFail = false;
    assert.equal(await worker.retryFailed(failed.id), true);
    await waitFor(async () =>
      (await prisma.trainingTelegramOutbox.findUniqueOrThrow({ where: { id: failed.id } }))
        .status === TrainingTelegramOutboxStatus.SENT,
    );
    const sent = await prisma.trainingTelegramOutbox.findUniqueOrThrow({
      where: { id: failed.id },
    });
    assert.equal(sent.status, TrainingTelegramOutboxStatus.SENT);
    assert.equal(sent.attempts, 1);
    assert.equal(client.sentMessages.length, 1);
  });

  test('/start restores current state even when the outbox delivery is permanently failed', async () => {
    const scenario = await createScenario('start-recovery');
    const client = new SwitchableClient();
    const telegram = createTelegram(client);
    const worker = new TrainingTelegramOutboxWorkerService(prisma, telegram);

    assert.equal(await worker.runOnce(), true);
    assert.equal(
      await prisma.trainingTelegramOutbox.count({
        where: { attemptId: scenario.attemptId, status: TrainingTelegramOutboxStatus.FAILED },
      }),
      1,
    );

    client.shouldFail = false;
    await telegram.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: Number(scenario.telegramId), username: 'outbox_recovery' },
        chat: { id: Number(scenario.telegramId), type: 'private' },
        text: '/start',
      },
    });

    assert.equal(client.sentMessages.length, 1);
    assert.match(client.sentMessages[0].text, /^Вопрос 2 из 4/u);
    assert.equal(
      await prisma.trainingTelegramOutbox.count({
        where: { attemptId: scenario.attemptId, status: TrainingTelegramOutboxStatus.FAILED },
      }),
      1,
    );
  });

  function createTelegram(client) {
    return new TrainingTelegramService(
      prisma,
      {
        finalizeAttemptIfExpired: async () => false,
        finalizeExpiredForUser: async () => undefined,
      },
      { assertParticipant: async () => undefined },
      client,
    );
  }

  async function assertDeliveryStarted(client, run) {
    const result = await Promise.race([
      client.waitUntilStarted().then(() => 'STARTED'),
      run.then(() => 'COMPLETED'),
    ]);
    if (result === 'COMPLETED') {
      const rows = await prisma.trainingTelegramOutbox.findMany();
      assert.fail(`Outbox delivery completed before send: ${JSON.stringify(rows)}`);
    }
  }

  async function waitFor(predicate, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for outbox state');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function createScenario(label) {
    const role = await prisma.role.create({
      data: { name: `training-outbox-${label.slice(0, 16)}-${randomUUID().slice(0, 8)}` },
    });
    const user = await prisma.user.create({
      data: {
        email: `${label}-${randomUUID()}@training-outbox.test`,
        passwordHash: 'test-hash',
        name: label,
        status: UserStatus.ACTIVE,
        roleId: role.id,
      },
    });
    const project = await prisma.trainingProject.create({
      data: {
        title: `Outbox ${label}`,
        description: null,
        sortOrder: 0,
        attemptLimit: 3,
        timeLimitSeconds: 420,
        passScore: 75,
        allowRetakeAfterPass: true,
      },
    });
    const audioFile = await prisma.file.create({
      data: {
        storage: 'MINIO',
        bucket: 'training-outbox-test',
        key: `${label}-${randomUUID()}.wav`,
        url: null,
        originalName: 'answer.wav',
        mimeType: 'audio/wav',
        sizeBytes: 44n,
        checksum: randomUUID(),
      },
    });
    const telegramId = BigInt(8_000_000 + Math.floor(Math.random() * 1_000_000));

    const scenario = await prisma.$transaction(async (transaction) => {
      const attempt = await transaction.trainingAttempt.create({
        data: {
          userId: user.id,
          projectId: project.id,
          attemptNumber: 1,
          startIdempotencyKey: randomUUID(),
          expiresAt: new Date(Date.now() + 5 * 60_000),
          projectSnapshotJson: { schemaVersion: 1, projectTitle: project.title },
          fakeEvaluationVersion: 'outbox-test-v1',
        },
      });
      const answeredQuestion = await transaction.trainingAttemptQuestion.create({
        data: {
          attemptId: attempt.id,
          sequence: 1,
          type: 'MAIN',
          questionTextSnapshot: 'Первый вопрос',
          maxScore: 55,
          status: 'ANSWERED',
          answeredAt: new Date(),
        },
      });
      await transaction.trainingAttemptQuestion.create({
        data: {
          attemptId: attempt.id,
          sequence: 2,
          type: 'FOLLOW_UP',
          questionTextSnapshot: 'Второй вопрос',
          maxScore: 15,
          status: 'PRESENTED',
        },
      });
      const answer = await transaction.trainingAnswer.create({
        data: {
          attemptQuestionId: answeredQuestion.id,
          source: 'TELEGRAM',
          processingStatus: 'COMPLETED',
          text: 'Безопасный тестовый ответ',
          score: 55,
          fakeOutcome: 'SCORED',
          safeBreakdownJson: {},
          mergedAudioFileId: audioFile.id,
          submittedAt: new Date(),
          transcriptionStatus: 'COMPLETED',
          evaluationStatus: 'COMPLETED',
        },
      });
      await transaction.trainingTelegramAccount.create({
        data: {
          userId: user.id,
          telegramUserId: telegramId,
          chatId: telegramId,
          username: 'outbox_test',
        },
      });
      await enqueueTrainingTelegramOutbox(transaction, {
        eventType: TrainingTelegramOutboxEventType.ANSWER_PROCESSED,
        attemptId: attempt.id,
        answerId: answer.id,
      });

      return { attemptId: attempt.id, answerId: answer.id, telegramId };
    });
    await waitFor(async () => {
      const [row] = await prisma.$queryRaw(Prisma.sql`
        SELECT "available_at" <= CURRENT_TIMESTAMP AS "ready"
        FROM "training_telegram_outbox"
        WHERE "attempt_id" = CAST(${scenario.attemptId} AS uuid)
      `);
      return row?.ready === true;
    });
    return scenario;
  }

  async function clearTrainingData() {
    await prisma.trainingTelegramOutbox.deleteMany();
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
    await prisma.file.deleteMany({ where: { bucket: 'training-outbox-test' } });
    await prisma.user.deleteMany({ where: { email: { endsWith: '@training-outbox.test' } } });
    await prisma.role.deleteMany({ where: { name: { startsWith: 'training-outbox-' } } });
  }

  class FlakyClient extends FakeTrainingTelegramClient {
    constructor(shouldFail) {
      super();
      this.shouldFail = shouldFail;
    }

    async sendMessage(input) {
      if (this.shouldFail) {
        this.shouldFail = false;
        throw new TrainingTelegramClientError('SENDMESSAGE_NETWORK', true);
      }
      return super.sendMessage(input);
    }
  }

  class SwitchableClient extends FakeTrainingTelegramClient {
    constructor() {
      super();
      this.shouldFail = true;
    }

    async sendMessage(input) {
      if (this.shouldFail) {
        throw new TrainingTelegramClientError('BOT_API_400', false);
      }
      return super.sendMessage(input);
    }
  }

  class BarrierClient extends FakeTrainingTelegramClient {
    constructor() {
      super();
      this.calls = 0;
      this.active = 0;
      this.peakActive = 0;
      this.started = new Promise((resolve) => { this.signalStarted = resolve; });
      this.barrier = new Promise((resolve) => { this.releaseBarrier = resolve; });
    }

    async sendMessage(input) {
      this.calls += 1;
      this.active += 1;
      this.peakActive = Math.max(this.peakActive, this.active);
      this.signalStarted();
      await this.barrier;
      await super.sendMessage(input);
      this.active -= 1;
    }

    waitUntilStarted() {
      return this.started;
    }

    release() {
      this.releaseBarrier();
    }
  }
  });
}
