require('reflect-metadata');

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { access, readFile, writeFile } = require('node:fs/promises');
const { after, before, beforeEach, test } = require('node:test');
const {
  PrismaClient,
  TrainingAnswerProcessingStatus,
  TrainingAnswerSource,
  TrainingProjectAccessMode,
  UserStatus,
} = require('@prisma/client');

const {
  TrainingAttemptStateService,
} = require('../dist/training/training-attempt-state.service.js');
const {
  TrainingAttemptService,
} = require('../dist/training/training-attempt.service.js');
const {
  DeterministicFakeTrainingEvaluator,
} = require('../dist/training/training-evaluator.js');
const {
  TrainingProjectService,
} = require('../dist/training/training-project.service.js');
const { TrainingProjectAccessService } = require('../dist/training/training-project-access.service.js');
const {
  FakeTrainingTelegramClient,
} = require('../dist/training/training-telegram-client.js');
const {
  TrainingTelegramService,
} = require('../dist/training/training-telegram.service.js');
const {
  TrainingAudioError,
  TrainingAudioService,
} = require('../dist/training/training-audio.service.js');
const {
  TrainingVoiceWorkerService,
} = require('../dist/training/training-voice-worker.service.js');

const databaseUrl = process.env.TRAINING_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('Training Stage 2 PostgreSQL scenarios require the targeted runner', () => {
    assert.equal(process.env.TRAINING_TEST_DATABASE_URL, undefined);
  });
} else {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const projectAccess = new TrainingProjectAccessService(prisma);
  const state = new TrainingAttemptStateService(
    prisma,
    new DeterministicFakeTrainingEvaluator(),
    { select: (candidates) => candidates.slice(0, 3) },
    projectAccess,
  );
  const attempts = new TrainingAttemptService(prisma, state, projectAccess);
  const projects = new TrainingProjectService(prisma);
  let client;
  let telegram;

  before(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    await clearTrainingData();
    client = new FakeTrainingTelegramClient();
    telegram = new TrainingTelegramService(prisma, state, projectAccess, client);
  });

  after(async () => {
    await clearTrainingData();
    await prisma.$disconnect();
  });

  test('concurrent token consume links one account and raw token is never persisted', async () => {
    const user = await createUser('token');
    const project = await createOpenProject('Token project');
    const link = await telegram.createProjectLink(user.id, project.id);
    const rawToken = new URL(link.url).searchParams.get('start');
    const update = startUpdate(101, rawToken);

    await Promise.all([telegram.handleUpdate(update), telegram.handleUpdate(update)]);

    const storedToken = await prisma.trainingTelegramLinkToken.findFirstOrThrow({
      where: { userId: user.id, projectId: project.id },
    });
    assert.equal(storedToken.usedAt instanceof Date, true);
    assert.equal(storedToken.tokenHash.length, 64);
    assert.equal(storedToken.tokenHash.includes(rawToken), false);
    assert.equal(await prisma.trainingTelegramAccount.count({ where: { userId: user.id } }), 1);
    assert.equal(await prisma.trainingAttempt.count({ where: { userId: user.id } }), 0);
    assert.equal(
      client.sentMessages.filter((message) => message.text.includes('Начать аттестацию')).length,
      0,
    );
    assert.equal(
      client.sentMessages.filter((message) => message.text.includes('выбран')).length,
      1,
    );
  });

  test('active Telegram account uniqueness rejects both conflict directions', async () => {
    const firstUser = await createUser('account-first');
    const secondUser = await createUser('account-second');
    const project = await createOpenProject('Account project');

    await consumeLink(firstUser.id, project.id, 201);
    await attemptLink(secondUser.id, project.id, 201);
    await attemptLink(firstUser.id, project.id, 202);

    const accounts = await prisma.trainingTelegramAccount.findMany({
      where: { revokedAt: null },
    });
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].userId, firstUser.id);
    assert.equal(accounts[0].telegramUserId, 201n);
    assert.equal(
      client.sentMessages.some((message) =>
        message.text.includes('Telegram уже связан с другим пользователем'),
      ),
      true,
    );
    assert.equal(
      client.sentMessages.some((message) =>
        message.text.includes('связан с другим Telegram-аккаунтом'),
      ),
      true,
    );
  });

  test('voice segments keep order, deduplicate and finish is idempotent', async () => {
    const user = await createUser('segments');
    const project = await createOpenProject('Segments project');
    const { token, telegramId } = await consumeLink(user.id, project.id, 301);

    await telegram.handleUpdate(callbackUpdate(telegramId, `tr:start:${token.id}`, 'start-1'));
    const attempt = await prisma.trainingAttempt.findFirstOrThrow({ where: { userId: user.id } });

    await telegram.handleUpdate(voiceUpdate(telegramId, 10, 'file-a', 'unique-a'));
    await telegram.handleUpdate(voiceUpdate(telegramId, 10, 'file-a', 'unique-a'));
    await telegram.handleUpdate(voiceUpdate(telegramId, 11, 'file-b', 'unique-b'));

    const answer = await prisma.trainingAnswer.findFirstOrThrow({
      where: { attemptQuestion: { attemptId: attempt.id } },
      include: { segments: { orderBy: { position: 'asc' } } },
    });
    assert.equal(answer.source, TrainingAnswerSource.TELEGRAM);
    assert.equal(answer.processingStatus, TrainingAnswerProcessingStatus.COLLECTING);
    assert.deepEqual(answer.segments.map((segment) => segment.position), [1, 2]);
    assert.deepEqual(
      answer.segments.map((segment) => segment.telegramFileUniqueId),
      ['unique-a', 'unique-b'],
    );

    const questionId = answer.attemptQuestionId;
    await Promise.all([
      telegram.handleUpdate(callbackUpdate(telegramId, `tr:finish:${questionId}`, 'finish-1')),
      telegram.handleUpdate(callbackUpdate(telegramId, `tr:finish:${questionId}`, 'finish-2')),
    ]);
    const processing = await prisma.trainingAnswer.findUniqueOrThrow({
      where: { id: answer.id },
    });
    assert.equal(processing.processingStatus, TrainingAnswerProcessingStatus.PROCESSING);
    assert.equal(await prisma.trainingAnswer.count({ where: { id: answer.id } }), 1);
    assert.equal(
      client.sentMessages.filter((message) => message.text === 'Ответ обрабатывается').length,
      2,
    );
  });

  test('same Telegram file is allowed in another answer while duplicates stay scoped', async () => {
    const first = await createStandaloneTelegramAnswer('same-file-first');
    const second = await createStandaloneTelegramAnswer('same-file-second');

    await prisma.trainingAnswerSegment.create({
      data: segmentData(first.answerId, 1, 1n, 'same-file'),
    });
    await prisma.trainingAnswerSegment.create({
      data: segmentData(second.answerId, 1, 1n, 'same-file'),
    });
    await assert.rejects(() =>
      prisma.trainingAnswerSegment.create({
        data: segmentData(first.answerId, 2, 2n, 'same-file'),
      }),
    );

    assert.equal(
      await prisma.trainingAnswerSegment.count({
        where: { telegramFileUniqueId: 'same-file' },
      }),
      2,
    );
  });

  test('lazy timeout rejects new voice and marks unfinished answer safely failed', async () => {
    const user = await createUser('voice-timeout');
    const project = await createOpenProject('Timeout project');
    const { token, telegramId } = await consumeLink(user.id, project.id, 401);
    await telegram.handleUpdate(callbackUpdate(telegramId, `tr:start:${token.id}`, 'start-timeout'));
    const attempt = await prisma.trainingAttempt.findFirstOrThrow({ where: { userId: user.id } });

    await telegram.handleUpdate(voiceUpdate(telegramId, 20, 'file-timeout', 'unique-timeout'));
    await prisma.$executeRawUnsafe(
      `UPDATE training_attempts SET started_at = CURRENT_TIMESTAMP - INTERVAL '2 minutes', expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE id = $1::uuid`,
      attempt.id,
    );
    await telegram.handleUpdate(voiceUpdate(telegramId, 21, 'file-late', 'unique-late'));

    const storedAttempt = await prisma.trainingAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    const storedAnswer = await prisma.trainingAnswer.findFirstOrThrow({
      where: { attemptQuestion: { attemptId: attempt.id } },
      include: { segments: true },
    });
    assert.equal(storedAttempt.status, 'TIMED_OUT');
    assert.equal(storedAnswer.processingStatus, TrainingAnswerProcessingStatus.FAILED);
    assert.equal(storedAnswer.processingErrorCode, 'ATTEMPT_TIMED_OUT');
    assert.equal(storedAnswer.score, null);
    assert.equal(storedAnswer.segments.length, 1);
  });

  test('audio processing downloads ordered segments, stores private files and cleans temp data', async () => {
    process.env.TRAINING_AUDIO_BUCKET = 'platforma-training-audio-test';
    const first = Buffer.from('OggS-first');
    const second = Buffer.from('OggS-second');
    const item = await createStandaloneTelegramAnswer('audio-order');
    await prisma.trainingAnswer.update({
      where: { id: item.answerId },
      data: {
        processingStatus: TrainingAnswerProcessingStatus.PROCESSING,
        submittedAt: new Date(),
      },
    });
    await prisma.trainingAnswerSegment.createMany({
      data: [
        segmentData(item.answerId, 1, 501n, 'audio-order-first', first.length),
        segmentData(item.answerId, 2, 502n, 'audio-order-second', second.length),
      ],
    });
    client.registerFile('file-501', { body: first, mimeType: 'audio/ogg' });
    client.registerFile('file-502', { body: second, mimeType: 'audio/ogg' });
    const storage = new InMemoryTrainingStorage();
    const runner = new SyntheticWavRunner();
    const audio = new TrainingAudioService(prisma, storage, client, runner);

    const result = await audio.prepareAnswerAudio(item.answerId);
    const repeated = await audio.prepareAnswerAudio(item.answerId);
    const files = await prisma.file.findMany({
      where: { key: { startsWith: `training-v2/answers/${item.answerId}/` } },
      orderBy: { key: 'asc' },
    });

    assert.deepEqual(runner.inputBodies.map((body) => body.toString()), [
      first.toString(),
      second.toString(),
    ]);
    assert.equal(result.fileId, repeated.fileId);
    assert.equal(files.length, 3);
    assert.equal(files.every((file) => file.url === null), true);
    assert.equal(files.every((file) => file.bucket === process.env.TRAINING_AUDIO_BUCKET), true);
    assert.equal(storage.objects.size, 3);
    await assert.rejects(() => access(runner.tempDirectory));
  });

  test('ffmpeg failure leaves answer unscored and always cleans its temp directory', async () => {
    process.env.TRAINING_AUDIO_BUCKET = 'platforma-training-audio-test';
    const item = await createStandaloneTelegramAnswer('audio-failure');
    const body = Buffer.from('OggS-failure');
    await prisma.trainingAnswer.update({
      where: { id: item.answerId },
      data: {
        processingStatus: TrainingAnswerProcessingStatus.PROCESSING,
        submittedAt: new Date(),
      },
    });
    await prisma.trainingAnswerSegment.create({
      data: segmentData(item.answerId, 1, 601n, 'audio-failure-file', body.length),
    });
    client.registerFile('file-601', { body, mimeType: 'audio/ogg' });
    const runner = new FailingFfmpegRunner();
    const audio = new TrainingAudioService(
      prisma,
      new InMemoryTrainingStorage(),
      client,
      runner,
    );

    await assert.rejects(
      () => audio.prepareAnswerAudio(item.answerId),
      (error) => error instanceof TrainingAudioError && error.code === 'FFMPEG_FAILED',
    );
    const answer = await prisma.trainingAnswer.findUniqueOrThrow({
      where: { id: item.answerId },
    });
    assert.equal(answer.processingStatus, TrainingAnswerProcessingStatus.PROCESSING);
    assert.equal(answer.score, null);
    assert.equal(answer.mergedAudioFileId, null);
    await assert.rejects(() => access(runner.tempDirectory));
  });

  test('two workers claim one answer and stale lock restart completes existing progression once', async () => {
    process.env.TRAINING_VOICE_STALE_LOCK_MS = '1000';
    const item = await createStandaloneTelegramAnswer('worker-claim');
    await prisma.trainingTelegramAccount.create({
      data: { userId: item.user.id, telegramUserId: 701n, chatId: 701n },
    });
    await prisma.trainingAnswer.update({
      where: { id: item.answerId },
      data: {
        processingStatus: TrainingAnswerProcessingStatus.PROCESSING,
        submittedAt: new Date(),
        processingAttempts: 1,
        processingLockedAt: new Date(Date.now() - 10_000),
        processingLockedBy: 'dead-process',
      },
    });
    const waitingAudio = new WaitingWorkerAudio(prisma);
    const transcripts = { calls: 0, transcribe: async () => {
      transcripts.calls += 1;
      return fakeTranscription();
    } };
    const firstWorker = createWorker(waitingAudio, transcripts);
    const secondWorker = createWorker(waitingAudio, transcripts);

    const firstRun = firstWorker.runOnce();
    await waitingAudio.waitUntilStarted();
    await new Promise((resolve) => setTimeout(resolve, 1_250));
    const secondResult = await secondWorker.runOnce();
    waitingAudio.release();
    const firstResult = await firstRun;

    assert.equal(firstResult, true);
    assert.equal(secondResult, false);
    assert.equal(transcripts.calls, 1);
    const answer = await prisma.trainingAnswer.findUniqueOrThrow({
      where: { id: item.answerId },
    });
    const questions = await prisma.trainingAttemptQuestion.findMany({
      where: { attemptId: item.attempt.id },
      orderBy: { sequence: 'asc' },
    });
    assert.equal(answer.processingAttempts, 2);
    assert.equal(answer.processingStatus, TrainingAnswerProcessingStatus.COMPLETED);
    assert.equal(answer.processingLockedBy, null);
    assert.equal(questions.length, 4);
    assert.equal(questions.filter((question) => question.sequence === 2).length, 1);
    assert.equal(await firstWorker.runOnce(), false);
    assert.equal(transcripts.calls, 1);
  });

  test('vertical fake Telegram flow completes deep link, voice 1+3 and final result once', async () => {
    const user = await createUser('worker-vertical');
    const project = await createOpenProject('Worker vertical');
    const { token, telegramId } = await consumeLink(user.id, project.id, 801);
    await telegram.handleUpdate(callbackUpdate(telegramId, `tr:start:${token.id}`, 'vertical-start'));
    await telegram.handleUpdate(plainStartUpdate(telegramId));
    const attempt = await prisma.trainingAttempt.findFirstOrThrow({
      where: { userId: user.id, projectId: project.id },
    });
    const workerAudio = new ImmediateWorkerAudio(prisma);
    const transcriber = { transcribe: async () => fakeTranscription() };
    const worker = createWorker(workerAudio, transcriber);

    for (let sequence = 1; sequence <= 4; sequence += 1) {
      const question = await prisma.trainingAttemptQuestion.findFirstOrThrow({
        where: {
          attemptId: attempt.id,
          status: 'PRESENTED',
        },
        orderBy: { sequence: 'asc' },
      });
      await telegram.handleUpdate(
        voiceUpdate(
          telegramId,
          sequence * 10 + 1,
          `vertical-file-${sequence}-a`,
          `vertical-unique-${sequence}-a`,
        ),
      );
      await telegram.handleUpdate(
        voiceUpdate(
          telegramId,
          sequence * 10 + 2,
          `vertical-file-${sequence}-b`,
          `vertical-unique-${sequence}-b`,
        ),
      );
      await telegram.handleUpdate(
        callbackUpdate(
          telegramId,
          `tr:finish:${question.id}`,
          `vertical-finish-${sequence}`,
        ),
      );
      if (sequence === 1) {
        await telegram.handleUpdate(plainStartUpdate(telegramId));
        assert.equal(client.sentMessages.at(-1)?.text, 'Ответ обрабатывается');
      }
      assert.equal(await worker.runOnce(), true);
    }

    const completed = await prisma.trainingAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
      include: { questions: { include: { answer: true } } },
    });
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.questions.length, 4);
    assert.equal(
      await prisma.trainingAnswerSegment.count({
        where: { answer: { attemptQuestion: { attemptId: attempt.id } } },
      }),
      8,
    );
    assert.equal(
      completed.questions.every(
        (question) =>
          question.status === 'ANSWERED' &&
          question.answer?.processingStatus === TrainingAnswerProcessingStatus.COMPLETED &&
          question.answer?.text === '[fake:pass]',
      ),
      true,
    );
    assert.equal(await worker.runOnce(), false);
    const history = await attempts.listEmployeeAttempts(user.id);
    assert.equal(history.items.some((item) => item.id === attempt.id), true);
    assert.equal(
      client.sentMessages.filter((message) =>
        message.text === 'Аттестация пройдена.',
      ).length,
      1,
    );
  });

  test('worker timeout after finish commits timeout result and notifies Telegram', async () => {
    const user = await createUser('worker-timeout');
    const project = await createOpenProject('Worker timeout');
    const { token, telegramId } = await consumeLink(user.id, project.id, 851);
    await telegram.handleUpdate(callbackUpdate(telegramId, `tr:start:${token.id}`, 'timeout-start'));
    const attempt = await prisma.trainingAttempt.findFirstOrThrow({
      where: { userId: user.id, projectId: project.id },
    });
    await telegram.handleUpdate(voiceUpdate(telegramId, 8511, 'timeout-file', 'timeout-unique'));
    const question = await prisma.trainingAttemptQuestion.findFirstOrThrow({
      where: { attemptId: attempt.id, status: 'PRESENTED' },
      orderBy: { sequence: 'asc' },
    });
    await telegram.handleUpdate(
      callbackUpdate(telegramId, `tr:finish:${question.id}`, 'timeout-finish'),
    );
    await prisma.$executeRawUnsafe(
      `UPDATE training_attempts SET started_at = CURRENT_TIMESTAMP - INTERVAL '2 minutes', expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE id = $1::uuid`,
      attempt.id,
    );
    const worker = createWorker(
      new ImmediateWorkerAudio(prisma),
      { transcribe: async () => fakeTranscription() },
    );

    assert.equal(await worker.runOnce(), true);

    const storedAttempt = await prisma.trainingAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    const answer = await prisma.trainingAnswer.findFirstOrThrow({
      where: { attemptQuestion: { attemptId: attempt.id } },
    });
    assert.equal(storedAttempt.status, 'TIMED_OUT');
    assert.equal(storedAttempt.isPassed, false);
    assert.equal(answer.processingStatus, TrainingAnswerProcessingStatus.FAILED);
    assert.equal(answer.processingErrorCode, 'ATTEMPT_TIMED_OUT');
    assert.equal(answer.score, null);
    assert.equal(
      client.sentMessages.filter(
        (message) => message.text === 'Время попытки истекло. Аттестация не пройдена.',
      ).length,
      1,
    );
  });

  test('worker notifies timeout that occurs while claimed audio is processing', async () => {
    const user = await createUser('worker-mid-timeout');
    const project = await createOpenProject('Worker mid timeout');
    const { token, telegramId } = await consumeLink(user.id, project.id, 852);
    await telegram.handleUpdate(callbackUpdate(telegramId, `tr:start:${token.id}`, 'mid-timeout-start'));
    const attempt = await prisma.trainingAttempt.findFirstOrThrow({
      where: { userId: user.id, projectId: project.id },
    });
    await telegram.handleUpdate(voiceUpdate(telegramId, 8521, 'mid-timeout-file', 'mid-timeout-unique'));
    const question = await prisma.trainingAttemptQuestion.findFirstOrThrow({
      where: { attemptId: attempt.id, status: 'PRESENTED' },
      orderBy: { sequence: 'asc' },
    });
    await telegram.handleUpdate(
      callbackUpdate(telegramId, `tr:finish:${question.id}`, 'mid-timeout-finish'),
    );
    const waitingAudio = new WaitingWorkerAudio(prisma);
    const worker = createWorker(
      waitingAudio,
      { transcribe: async () => fakeTranscription() },
    );
    const run = worker.runOnce();
    await waitingAudio.waitUntilStarted();
    await prisma.$executeRawUnsafe(
      `UPDATE training_attempts SET started_at = CURRENT_TIMESTAMP - INTERVAL '2 minutes', expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE id = $1::uuid`,
      attempt.id,
    );
    waitingAudio.release();

    assert.equal(await run, true);

    const storedAttempt = await prisma.trainingAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    const answer = await prisma.trainingAnswer.findFirstOrThrow({
      where: { attemptQuestion: { attemptId: attempt.id } },
    });
    assert.equal(storedAttempt.status, 'TIMED_OUT');
    assert.equal(answer.processingStatus, TrainingAnswerProcessingStatus.FAILED);
    assert.equal(answer.processingErrorCode, 'ATTEMPT_TIMED_OUT');
    assert.equal(answer.score, 55);
    assert.equal(storedAttempt.finalScore, 0);
    assert.equal(
      client.sentMessages.filter(
        (message) => message.text === 'Время попытки истекло. Аттестация не пройдена.',
      ).length,
      1,
    );
  });

  test('bounded worker failures end in FAILED without a normal low score', async () => {
    const item = await createStandaloneTelegramAnswer('worker-failure');
    await prisma.trainingAnswer.update({
      where: { id: item.answerId },
      data: {
        processingStatus: TrainingAnswerProcessingStatus.PROCESSING,
        submittedAt: new Date(),
      },
    });
    const failingAudio = {
      prepareAnswerAudio: async () => {
        throw new TrainingAudioError('TEMPORARY_AUDIO_FAILURE', true);
      },
    };
    const worker = createWorker(failingAudio, { transcribe: async () => fakeTranscription() });

    assert.equal(await worker.runOnce(), true);
    assert.equal(await worker.runOnce(), true);
    assert.equal(await worker.runOnce(), true);

    const answer = await prisma.trainingAnswer.findUniqueOrThrow({
      where: { id: item.answerId },
    });
    const attempt = await prisma.trainingAttempt.findUniqueOrThrow({
      where: { id: item.attempt.id },
    });
    assert.equal(answer.processingAttempts, 3);
    assert.equal(answer.processingStatus, TrainingAnswerProcessingStatus.FAILED);
    assert.equal(answer.processingErrorCode, 'TEMPORARY_AUDIO_FAILURE');
    assert.equal(answer.score, null);
    assert.equal(attempt.status, 'TECHNICAL_FAILED');
    assert.equal(attempt.countsTowardAttemptLimit, false);
    assert.equal(attempt.finalScore, null);
    assert.equal(await worker.runOnce(), false);
  });

  async function consumeLink(userId, projectId, telegramId) {
    await attemptLink(userId, projectId, telegramId);
    const token = await prisma.trainingTelegramLinkToken.findFirstOrThrow({
      where: { userId, projectId, usedAt: { not: null } },
      orderBy: { createdAt: 'desc' },
    });

    return { token, telegramId };
  }

  async function attemptLink(userId, projectId, telegramId) {
    const link = await telegram.createProjectLink(userId, projectId);
    const rawToken = new URL(link.url).searchParams.get('start');
    await telegram.handleUpdate(startUpdate(telegramId, rawToken));
  }

  async function createUser(label) {
    const permission = await prisma.permission.upsert({
      where: { key: 'training:participate' },
      update: {},
      create: { key: 'training:participate', description: 'Participate' },
    });
    const role = await prisma.role.create({
      data: {
        name: `training-test-${label.slice(0, 16)}-${randomUUID().slice(0, 8)}`,
        description: 'Training Stage 2 test role',
        permissions: {
          create: { permissionId: permission.id },
        },
      },
    });

    return prisma.user.create({
      data: {
        email: `${label}-${randomUUID()}@training.test`,
        passwordHash: 'test-hash',
        name: label,
        status: UserStatus.ACTIVE,
        roleId: role.id,
      },
    });
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
      followUpQuestions: Array.from({ length: 10 }, (_, index) => `${title} ${index + 1}`),
      facts: Array.from({ length: 11 }, (_, index) => ({
        id: null,
        questionType: index === 0 ? 'MAIN' : 'FOLLOW_UP',
        questionPosition: index === 0 ? 1 : index,
        statement: `${title} fact ${index + 1}`,
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

  async function createStandaloneTelegramAnswer(label) {
    const user = await createUser(label);
    const project = await createOpenProject(label);
    const attempt = await attempts.startAttempt(project.id, user.id, {
      confirmed: true,
      idempotencyKey: randomUUID(),
    });
    const answer = await prisma.trainingAnswer.create({
      data: {
        attemptQuestionId: attempt.currentQuestion.id,
        source: TrainingAnswerSource.TELEGRAM,
        processingStatus: TrainingAnswerProcessingStatus.COLLECTING,
      },
    });

    return { answerId: answer.id, attempt, user };
  }

  function startUpdate(telegramId, rawToken) {
    return {
      update_id: telegramId,
      message: {
        message_id: telegramId,
        from: { id: telegramId, username: `user_${telegramId}` },
        chat: { id: telegramId, type: 'private' },
        text: `/start ${rawToken}`,
      },
    };
  }

  function plainStartUpdate(telegramId) {
    return {
      update_id: telegramId + 9_000,
      message: {
        message_id: telegramId + 9_000,
        from: { id: telegramId, username: `user_${telegramId}` },
        chat: { id: telegramId, type: 'private' },
        text: '/start',
      },
    };
  }

  function callbackUpdate(telegramId, data, callbackId) {
    return {
      update_id: telegramId + 1,
      callback_query: {
        id: callbackId,
        from: { id: telegramId, username: `user_${telegramId}` },
        message: { chat: { id: telegramId, type: 'private' } },
        data,
      },
    };
  }

  function voiceUpdate(telegramId, messageId, fileId, fileUniqueId) {
    return {
      update_id: messageId,
      message: {
        message_id: messageId,
        from: { id: telegramId, username: `user_${telegramId}` },
        chat: { id: telegramId, type: 'private' },
        voice: {
          file_id: fileId,
          file_unique_id: fileUniqueId,
          duration: 2,
          file_size: 1024,
        },
      },
    };
  }

  function segmentData(answerId, position, messageId, fileUniqueId, sizeBytes = 100) {
    return {
      answerId,
      position,
      telegramMessageId: messageId,
      telegramFileId: `file-${messageId}`,
      telegramFileUniqueId: fileUniqueId,
      durationSeconds: 1,
      sizeBytes: BigInt(sizeBytes),
    };
  }

  function createWorker(audio, transcriber) {
    return new TrainingVoiceWorkerService(
      prisma,
      audio,
      transcriber,
      new DeterministicFakeTrainingEvaluator(),
      state,
      telegram,
    );
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
      where: { key: { startsWith: 'training-v2/answers/' } },
    });
    await prisma.user.deleteMany({ where: { email: { endsWith: '@training.test' } } });
    await prisma.role.deleteMany({ where: { name: { startsWith: 'training-test-' } } });
  }

  class InMemoryTrainingStorage {
    constructor() {
      this.objects = new Map();
    }

    getBucket() {
      return 'platforma-public';
    }

    async putObject({ bucket, key, body }) {
      this.objects.set(`${bucket}/${key}`, Buffer.from(body));
    }

    async putObjectFromFile({ bucket, key, filePath }) {
      this.objects.set(`${bucket}/${key}`, await readFile(filePath));
    }

    async getObject(key, bucket) {
      const body = this.objects.get(`${bucket}/${key}`);
      if (!body) throw new Error('Missing fake object');
      return Buffer.from(body);
    }
  }

  class SyntheticWavRunner {
    constructor() {
      this.inputBodies = [];
      this.tempDirectory = null;
    }

    async run(args) {
      const inputPaths = args.flatMap((value, index) =>
        index > 0 && args[index - 1] === '-i' ? [value] : [],
      );
      const outputPath = args.at(-1);
      this.inputBodies = await Promise.all(inputPaths.map((path) => readFile(path)));
      this.tempDirectory = outputPath.slice(0, outputPath.lastIndexOf('/'));
      const wav = Buffer.alloc(64);
      wav.write('RIFF', 0, 'ascii');
      wav.write('WAVE', 8, 'ascii');
      await writeFile(outputPath, wav);
    }
  }

  class FailingFfmpegRunner {
    async run(args) {
      const outputPath = args.at(-1);
      this.tempDirectory = outputPath.slice(0, outputPath.lastIndexOf('/'));
      throw new TrainingAudioError('FFMPEG_FAILED', false);
    }
  }

  class ImmediateWorkerAudio {
    constructor(database) {
      this.database = database;
    }

    async prepareAnswerAudio(answerId) {
      const file = await this.database.file.create({
        data: {
          storage: 'MINIO',
          bucket: 'platforma-training-audio-test',
          key: `training-v2/answers/${answerId}/merged.wav`,
          url: null,
          originalName: 'merged.wav',
          mimeType: 'audio/wav',
          sizeBytes: 64n,
        },
      });
      await this.database.trainingAnswer.update({
        where: { id: answerId },
        data: { mergedAudioFileId: file.id },
      });
      const wav = Buffer.alloc(64);
      wav.write('RIFF', 0, 'ascii');
      wav.write('WAVE', 8, 'ascii');
      return { answerId, fileId: file.id, mimeType: 'audio/wav', sizeBytes: 64, checksum: 'test', wav, vocabularyPrompt: '' };
    }
  }

  class WaitingWorkerAudio extends ImmediateWorkerAudio {
    constructor(database) {
      super(database);
      this.started = new Promise((resolve) => { this.markStarted = resolve; });
      this.waiting = new Promise((resolve) => { this.releaseWaiting = resolve; });
    }

    waitUntilStarted() {
      return this.started;
    }

    release() {
      this.releaseWaiting();
    }

    async prepareAnswerAudio(answerId) {
      this.markStarted();
      await this.waiting;
      return super.prepareAnswerAudio(answerId);
    }
  }
}

function fakeTranscription() {
  return { text: '[fake:pass]', model: 'fake', requestId: null, latencyMs: 0, attempts: 1, usage: null };
}
