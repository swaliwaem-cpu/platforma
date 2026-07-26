require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  PrismaClient,
  TrainingAttemptQuestionStatus,
  TrainingAttemptStatus,
  TrainingJobKind,
  TrainingJobStatus,
  TrainingProjectStatus,
  TrainingQuestionType,
  TrainingVersionStatus,
  UserStatus,
} = require('@prisma/client');

const {
  TrainingAttemptEngineService,
} = require('../dist/training/training-attempt-engine.service.js');
const {
  DeterministicFakeTrainingEvaluationProvider,
  DeterministicFakeTrainingTranscriptionProvider,
  SystemTrainingAttemptClock,
} = require('../dist/training/training-attempt.providers.js');
const {
  encodeFinishCallback,
  encodeStartCallback,
} = require('../dist/training/telegram/training-telegram.callback.js');
const {
  TrainingTelegramDialogService,
} = require('../dist/training/telegram/training-telegram-dialog.service.js');
const {
  hashTrainingLinkToken,
  TrainingTelegramLinkService,
} = require('../dist/training/telegram/training-telegram-link.service.js');
const {
  FakeTrainingTelegramTransport,
} = require('../dist/training/telegram/training-telegram.transport.js');
const {
  TrainingTelegramWebhookService,
} = require('../dist/training/telegram/training-telegram-webhook.service.js');
const {
  TrainingTelegramWorkerService,
} = require('../dist/training/telegram/training-telegram-worker.service.js');
const {
  DeterministicQuestionSelector,
} = require('./helpers/training-attempt-fake-prisma.cjs');

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL must point to the runner-created isolated training database',
  );
}

const prisma = new PrismaClient();
let telegramSequence = 100_000;

test.after(async () => {
  await prisma.$disconnect();
});

test('Telegram link token happy path stores only hash and consumes atomically', async () => {
  const fixture = await createFixture();
  const harness = createHarness();
  const issued = await harness.links.issueLinkToken(fixture.userId);
  const persisted = await prisma.trainingLinkToken.findUnique({
    where: { tokenHash: hashTrainingLinkToken(issued.token) },
  });

  assert.ok(issued.token.length <= 64);
  assert.match(issued.token, /^[A-Za-z0-9_-]+$/u);
  assert.ok(persisted);
  assert.notEqual(persisted.tokenHash, issued.token);
  assert.equal(persisted.tokenHash.length, 64);
  assert.equal(persisted.usedAt, null);

  const linked = await harness.links.consumeHashedToken(persisted.tokenHash, {
    telegramUserId: 501_001n,
    chatId: 501_001n,
    username: 'stage6_user',
    firstName: 'Stage',
    lastName: 'Six',
  });
  const consumed = await prisma.trainingLinkToken.findUnique({
    where: { id: persisted.id },
  });

  assert.equal(linked.userId, fixture.userId);
  assert.ok(consumed.usedAt);
  assert.equal(
    await prisma.trainingTelegramAccount.count({
      where: { userId: fixture.userId, revokedAt: null },
    }),
    1,
  );
});

test('expired, reused and revoked Telegram link tokens are rejected', async () => {
  const fixture = await createFixture();
  const harness = createHarness();

  const expired = await harness.links.issueLinkToken(fixture.userId);
  const oldCreatedAt = new Date(Date.now() - 60 * 60_000);
  await prisma.trainingLinkToken.update({
    where: { tokenHash: hashTrainingLinkToken(expired.token) },
    data: {
      createdAt: oldCreatedAt,
      expiresAt: new Date(Date.now() - 60_000),
    },
  });
  await assert.rejects(
    harness.links.consumeHashedToken(hashTrainingLinkToken(expired.token), {
      telegramUserId: 501_002n,
      chatId: 501_002n,
    }),
    /expired/,
  );

  const reusable = await harness.links.issueLinkToken(fixture.userId);
  const reusableHash = hashTrainingLinkToken(reusable.token);
  await harness.links.consumeHashedToken(reusableHash, {
    telegramUserId: 501_002n,
    chatId: 501_002n,
  });
  await assert.rejects(
    harness.links.consumeHashedToken(reusableHash, {
      telegramUserId: 501_002n,
      chatId: 501_002n,
    }),
    /already used/,
  );

  const revoked = await harness.links.issueLinkToken(fixture.userId);
  await harness.links.revokeLinkTokens(fixture.userId);
  await assert.rejects(
    harness.links.consumeHashedToken(hashTrainingLinkToken(revoked.token), {
      telegramUserId: 501_002n,
      chatId: 501_002n,
    }),
    /revoked/,
  );
});

test('two Platforma users cannot link one Telegram ID', async () => {
  const fixture = await createFixture();
  const secondUserId = await createUser(fixture.roleId, 'second-link-user');
  const harness = createHarness();
  const first = await harness.links.issueLinkToken(fixture.userId);
  const second = await harness.links.issueLinkToken(secondUserId);

  const results = await Promise.allSettled([
    harness.links.consumeHashedToken(hashTrainingLinkToken(first.token), {
      telegramUserId: 501_003n,
      chatId: 501_003n,
    }),
    harness.links.consumeHashedToken(hashTrainingLinkToken(second.token), {
      telegramUserId: 501_003n,
      chatId: 501_003n,
    }),
  ]);

  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    await prisma.trainingTelegramAccount.count({
      where: { telegramUserId: 501_003n, revokedAt: null },
    }),
    1,
  );
});

test('one Platforma user cannot link two active Telegram accounts', async () => {
  const fixture = await createFixture();
  const harness = createHarness();
  const first = await harness.links.issueLinkToken(fixture.userId);
  await harness.links.consumeHashedToken(hashTrainingLinkToken(first.token), {
    telegramUserId: 501_004n,
    chatId: 501_004n,
  });
  const second = await harness.links.issueLinkToken(fixture.userId);

  await assert.rejects(
    harness.links.consumeHashedToken(hashTrainingLinkToken(second.token), {
      telegramUserId: 501_005n,
      chatId: 501_005n,
    }),
    /another active Telegram account/,
  );
  const account = await prisma.trainingTelegramAccount.findUnique({
    where: { userId: fixture.userId },
  });
  assert.equal(account.telegramUserId, 501_004n);
  assert.equal(account.revokedAt, null);
});

test('group update is rejected and invalid webhook secret is refused', async () => {
  const harness = createHarness();
  assert.throws(
    () => harness.webhook.verifySecret('wrong-secret'),
    /secret is invalid/,
  );
  const beforeJobs = await prisma.trainingJob.count({
    where: { kind: TrainingJobKind.PROCESS_TELEGRAM_UPDATE },
  });
  const result = await harness.webhook.acceptUpdate({
    update_id: nextSequence(),
    message: {
      message_id: 1,
      date: nowSeconds(),
      chat: { id: -500, type: 'group' },
      from: { id: 501_006, first_name: 'Group user' },
      text: '/start',
    },
  });
  const processed = await prisma.trainingProcessedUpdate.findFirst({
    orderBy: { createdAt: 'desc' },
  });

  assert.deepEqual(result, { ok: true, duplicate: false, queued: false });
  assert.equal(processed.errorCode, 'PRIVATE_CHAT_REQUIRED');
  assert.equal(
    await prisma.trainingJob.count({
      where: { kind: TrainingJobKind.PROCESS_TELEGRAM_UPDATE },
    }),
    beforeJobs,
  );
});

test('duplicate update and callback_query do not duplicate actions', async () => {
  const fixture = await createFixture();
  const telegramId = 501_007;
  const harness = createHarness();
  await linkUser(harness, fixture.userId, telegramId);
  const updateId = nextSequence();
  const callbackId = `callback-${nextSequence()}`;
  const update = callbackUpdate(
    updateId,
    10,
    telegramId,
    callbackId,
    'tr:projects',
  );

  const first = await harness.webhook.acceptUpdate(update);
  const duplicateUpdate = await harness.webhook.acceptUpdate(update);
  const duplicateCallback = await harness.webhook.acceptUpdate(
    callbackUpdate(
      nextSequence(),
      10,
      telegramId,
      callbackId,
      'tr:projects',
    ),
  );
  await drainTelegram(harness.worker);

  assert.equal(first.queued, true);
  assert.equal(duplicateUpdate.duplicate, true);
  assert.equal(duplicateCallback.duplicate, true);
  assert.equal(
    harness.transport.deliveries.filter(
      (delivery) => delivery.operation === 'ANSWER_CALLBACK',
    ).length,
    1,
  );
  assert.equal(
    harness.transport.deliveries.filter(
      (delivery) =>
        delivery.operation === 'SEND_MESSAGE' &&
        delivery.text === 'Выберите проект:',
    ).length,
    1,
  );
});

test('text and message.audio create no answer or voice segment', async () => {
  const fixture = await createFixture();
  const telegramId = 501_008;
  const harness = createHarness();
  await linkUser(harness, fixture.userId, telegramId);
  const attempt = await startAttempt(harness.engine, fixture);

  await acceptAndDrain(
    harness,
    privateTextUpdate(nextSequence(), 20, telegramId, 'обычный текст'),
  );
  await acceptAndDrain(harness, {
    update_id: nextSequence(),
    message: {
      message_id: 21,
      date: nowSeconds(),
      chat: { id: telegramId, type: 'private' },
      from: { id: telegramId, first_name: 'User' },
      audio: { file_id: 'audio-not-voice' },
    },
  });

  assert.equal(
    await prisma.trainingAnswer.count({
      where: { attemptQuestion: { attemptId: attempt.id } },
    }),
    0,
  );
  assert.equal(
    await prisma.trainingVoiceSegment.count({
      where: { answer: { attemptQuestion: { attemptId: attempt.id } } },
    }),
    0,
  );
});

test('employee attempt endpoints are ownership-bound and expose no private processing data', async () => {
  const fixture = await createFixture();
  const harness = createHarness();
  const attempt = await startAttempt(harness.engine, fixture);
  const list = await harness.dialog.listEmployeeAttempts(fixture.userId);
  const own = await harness.dialog.getEmployeeAttempt(
    fixture.userId,
    attempt.id,
  );
  const otherUserId = await createUser(fixture.roleId, 'attempt-idor-user');

  assert.equal(list.items.length, 1);
  assert.equal(own.attempt.id, attempt.id);
  assert.equal(
    /transcript|error|audio|storage|unsupported/iu.test(JSON.stringify(own)),
    false,
  );
  await assert.rejects(
    harness.dialog.getEmployeeAttempt(otherUserId, attempt.id),
    /Training attempt not found/,
  );
});

test('several voice messages form one answer and duplicate message creates no segment', async () => {
  const fixture = await createFixture();
  const telegramId = 501_009;
  const harness = createHarness();
  await linkUser(harness, fixture.userId, telegramId);
  const attempt = await startAttempt(harness.engine, fixture);

  await acceptAndDrain(
    harness,
    voiceUpdate(nextSequence(), 30, telegramId, 'voice-part-1'),
  );
  await acceptAndDrain(
    harness,
    voiceUpdate(nextSequence(), 31, telegramId, 'voice-part-2'),
  );
  await acceptAndDrain(
    harness,
    voiceUpdate(nextSequence(), 31, telegramId, 'voice-part-2'),
  );

  assert.equal(
    await prisma.trainingAnswer.count({
      where: { attemptQuestion: { attemptId: attempt.id } },
    }),
    1,
  );
  assert.equal(
    await prisma.trainingVoiceSegment.count({
      where: { answer: { attemptQuestion: { attemptId: attempt.id } } },
    }),
    2,
  );
  const messages = harness.transport.deliveries.filter(
    (delivery) => delivery.operation === 'SEND_MESSAGE',
  );
  assert.ok(messages.some((message) => message.text.startsWith('Часть 1 принята')));
  assert.ok(messages.some((message) => message.text.startsWith('Часть 2 принята')));
});

test('finish callback is idempotent and an old-question callback cannot finish the new question', async () => {
  const fixture = await createFixture();
  const telegramId = 501_010;
  const harness = createHarness();
  await linkUser(harness, fixture.userId, telegramId);
  const attempt = await startAttempt(harness.engine, fixture);
  const firstQuestionId = attempt.attemptQuestions[0].id;
  await acceptAndDrain(
    harness,
    voiceUpdate(nextSequence(), 40, telegramId, 'first-answer'),
  );
  const finishData = encodeFinishCallback(firstQuestionId);
  const callbackId = `finish-${nextSequence()}`;

  await acceptAndDrain(
    harness,
    callbackUpdate(
      nextSequence(),
      41,
      telegramId,
      callbackId,
      finishData,
    ),
  );
  await acceptAndDrain(
    harness,
    callbackUpdate(
      nextSequence(),
      41,
      telegramId,
      callbackId,
      finishData,
    ),
  );
  const afterFinish = (await harness.engine.getAttempt(attempt.id)).attempt;
  const nextQuestion = afterFinish.attemptQuestions.find(
    (question) =>
      question.status === TrainingAttemptQuestionStatus.PRESENTED,
  );
  assert.ok(nextQuestion);

  await acceptAndDrain(
    harness,
    callbackUpdate(
      nextSequence(),
      41,
      telegramId,
      `old-finish-${nextSequence()}`,
      finishData,
    ),
  );
  const persistedNext = await prisma.trainingAttemptQuestion.findUnique({
    where: { id: nextQuestion.id },
    include: { answer: true },
  });

  assert.equal(
    await prisma.trainingAnswerEvaluation.count({
      where: { answer: { attemptQuestion: { attemptId: attempt.id } } },
    }),
    1,
  );
  assert.equal(persistedNext.status, TrainingAttemptQuestionStatus.PRESENTED);
  assert.equal(persistedNext.answer, null);
});

test('second Start click and webhook retry after quick ACK create no duplicate attempt', async () => {
  const fixture = await createFixture();
  const telegramId = 501_011;
  const harness = createHarness();
  await linkUser(harness, fixture.userId, telegramId);
  const startData = encodeStartCallback(fixture.projectId);
  const firstUpdate = callbackUpdate(
    nextSequence(),
    50,
    telegramId,
    `start-${nextSequence()}`,
    startData,
  );

  const ack = await harness.webhook.acceptUpdate(firstUpdate);
  const retry = await harness.webhook.acceptUpdate(firstUpdate);
  assert.equal(ack.queued, true);
  assert.equal(retry.duplicate, true);
  assert.equal(
    await prisma.trainingAttempt.count({
      where: { userId: fixture.userId, projectId: fixture.projectId },
    }),
    0,
  );
  await drainTelegram(harness.worker);
  await acceptAndDrain(
    harness,
    callbackUpdate(
      nextSequence(),
      50,
      telegramId,
      `start-second-${nextSequence()}`,
      startData,
    ),
  );

  assert.equal(
    await prisma.trainingAttempt.count({
      where: {
        userId: fixture.userId,
        projectId: fixture.projectId,
        isConsumed: true,
      },
    }),
    1,
  );
});

test('timeout warning is not sent after terminal state', async () => {
  const fixture = await createFixture();
  const telegramId = 501_012;
  const harness = createHarness();
  await linkUser(harness, fixture.userId, telegramId);
  const attempt = await startAttempt(harness.engine, fixture);
  const completedAt = new Date();
  await prisma.trainingAttempt.update({
    where: { id: attempt.id },
    data: {
      status: TrainingAttemptStatus.COMPLETED,
      completedAt,
    },
  });
  await prisma.trainingJob.updateMany({
    where: {
      kind: TrainingJobKind.SEND_TIMER_WARNING,
      payloadJson: { path: ['attemptId'], equals: attempt.id },
    },
    data: {
      status: TrainingJobStatus.PENDING,
      runAt: completedAt,
      finishedAt: null,
    },
  });

  await drainTelegram(harness.worker);
  assert.equal(
    harness.transport.deliveries.some(
      (delivery) =>
        delivery.operation === 'SEND_MESSAGE' &&
        delivery.text.includes('осталось'),
    ),
    false,
  );
});

test('normal finalization sends only score, pass status, attempts left and Platforma button', async () => {
  const fixture = await createFixture();
  const telegramId = 501_013;
  const harness = createHarness();
  await linkUser(harness, fixture.userId, telegramId);
  const attempt = await startAttempt(harness.engine, fixture);
  await completeAttempt(harness.engine, attempt, 600_000);
  await drainTelegram(harness.worker, true);

  const result = harness.transport.deliveries.find(
    (delivery) =>
      delivery.operation === 'SEND_MESSAGE' &&
      delivery.text.startsWith('Результат:'),
  );
  assert.ok(result);
  assert.match(result.text, /Результат: 100\/100/);
  assert.match(result.text, /Аттестация пройдена/);
  assert.match(result.text, /Осталось попыток: 2/);
  assert.equal(result.text.includes('transcript'), false);
  assert.deepEqual(result.replyMarkup.inline_keyboard[0][0], {
    text: 'Открыть платформу',
    url: TEST_CONFIG.publicTrainingUrl,
  });
});

test('REQUIRES_REVIEW is shown without preliminary score or pass/fail', async () => {
  const fixture = await createFixture();
  const telegramId = 501_014;
  const harness = createHarness();
  await linkUser(harness, fixture.userId, telegramId);
  const attempt = await startAttempt(harness.engine, fixture);
  await completeAttempt(
    harness.engine,
    attempt,
    610_000,
    '[[unsupported:нужна проверка]]',
  );
  await drainTelegram(harness.worker, true);

  const result = harness.transport.deliveries.find(
    (delivery) =>
      delivery.operation === 'SEND_MESSAGE' &&
      delivery.text.includes('Результат отправлен на проверку'),
  );
  assert.ok(result);
  assert.equal(result.text.includes('/100'), false);
  assert.equal(result.text.includes('пройдена'), false);
  assert.equal(result.text.includes('не пройдена'), false);
  assert.match(result.text, /Осталось попыток: 2/);
});

test('timeout accepts only one voice started before expiry and rejects later voice', async () => {
  const fixture = await createFixture();
  const telegramId = 501_015;
  const harness = createHarness();
  await linkUser(harness, fixture.userId, telegramId);
  const attempt = await startAttempt(harness.engine, fixture);
  const now = new Date();
  await prisma.trainingAttempt.update({
    where: { id: attempt.id },
    data: {
      startedAt: new Date(now.getTime() - 10_000),
      expiresAt: new Date(now.getTime() - 1_000),
      graceExpiresAt: new Date(now.getTime() + 60_000),
    },
  });
  await acceptAndDrain(
    harness,
    voiceUpdate(
      nextSequence(),
      70,
      telegramId,
      'grace-voice',
      5,
      nowSeconds(),
    ),
  );
  await acceptAndDrain(
    harness,
    voiceUpdate(
      nextSequence(),
      71,
      telegramId,
      'late-voice',
      0,
      nowSeconds() + 1,
    ),
  );

  assert.equal(
    await prisma.trainingVoiceSegment.count({
      where: { answer: { attemptQuestion: { attemptId: attempt.id } } },
    }),
    1,
  );
  assert.ok(
    harness.transport.deliveries.some(
      (delivery) =>
        delivery.operation === 'SEND_MESSAGE' &&
        delivery.text.includes('Время ответа истекло'),
    ),
  );
});

const TEST_CONFIG = {
  botToken: '',
  botUsername: 'platforma_training_bot',
  webhookSecret: 'stage6-webhook-secret',
  webhookUrl: 'http://localhost:3000/training/telegram/webhook',
  linkTokenTtlMinutes: 15,
  workerPollMs: 250,
  publicTrainingUrl: 'http://localhost:5173/training',
  usesFakeTransport: true,
};

function createHarness() {
  const clock = new SystemTrainingAttemptClock();
  const engine = new TrainingAttemptEngineService(
    prisma,
    clock,
    new DeterministicQuestionSelector(),
    new DeterministicFakeTrainingTranscriptionProvider(),
    new DeterministicFakeTrainingEvaluationProvider(),
  );
  const links = new TrainingTelegramLinkService(prisma, TEST_CONFIG);
  const dialog = new TrainingTelegramDialogService(
    prisma,
    TEST_CONFIG,
    links,
    engine,
  );
  const transport = new FakeTrainingTelegramTransport();
  const webhook = new TrainingTelegramWebhookService(prisma, TEST_CONFIG);
  const worker = new TrainingTelegramWorkerService(
    prisma,
    TEST_CONFIG,
    dialog,
    transport,
  );
  return { engine, links, dialog, transport, webhook, worker };
}

async function createFixture(options = {}) {
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const role = await prisma.role.create({
    data: {
      name: `training-stage6-${unique}`,
      description: 'Stage 6 isolated integration role',
    },
  });
  const publisherId = await createUser(role.id, `publisher-${unique}`);
  const userId = await createUser(role.id, `user-${unique}`);
  const project = await prisma.trainingProject.create({
    data: {
      slug: `training-stage6-${unique}`,
      title: `Stage 6 project ${unique}`,
      description: 'Telegram integration project',
      status: TrainingProjectStatus.DRAFT,
      sortOrder: options.sortOrder ?? 0,
    },
  });
  const version = await prisma.trainingProjectVersion.create({
    data: {
      projectId: project.id,
      versionNumber: 1,
      status: TrainingVersionStatus.DRAFT,
      passScore: 75,
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
      publishedById: publisherId,
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
    roleId: role.id,
    publisherId,
    userId,
    projectId: project.id,
  };
}

async function createUser(roleId, label) {
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const user = await prisma.user.create({
    data: {
      email: `training-stage6-${label}-${unique}@example.test`,
      passwordHash: 'not-used-in-domain-test',
      name: `Stage 6 ${label}`,
      status: UserStatus.ACTIVE,
      roleId,
    },
  });
  return user.id;
}

async function linkUser(harness, userId, telegramId) {
  const issued = await harness.links.issueLinkToken(userId);
  return harness.links.consumeHashedToken(hashTrainingLinkToken(issued.token), {
    telegramUserId: BigInt(telegramId),
    chatId: BigInt(telegramId),
    firstName: 'Telegram User',
  });
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

async function completeAttempt(
  engine,
  attempt,
  seed,
  mainTranscript = 'главный ответ',
) {
  for (let index = 0; index < 4; index += 1) {
    const current = (await engine.getAttempt(attempt.id)).attempt;
    const question = current.attemptQuestions.find(
      (item) =>
        item.status === TrainingAttemptQuestionStatus.PRESENTED ||
        item.status === TrainingAttemptQuestionStatus.COLLECTING,
    );
    assert.ok(question);
    const transcript =
      index === 0 ? mainTranscript : `дополнительный ответ ${index}`;
    await engine.appendVoiceSegment({
      attemptId: attempt.id,
      kind: 'VOICE',
      updateId: BigInt(seed + index),
      fakeTranscript: transcript,
      recordingStartedAt: new Date(),
      telegramMessageId: BigInt(seed + index),
      telegramChatId: BigInt(seed),
      telegramFileId: `file-${seed + index}`,
      fileUniqueId: transcript,
      durationSeconds: 5,
    });
    await engine.finishAnswer({
      attemptId: attempt.id,
      attemptQuestionId: question.id,
    });
  }
  return (await engine.getAttempt(attempt.id)).attempt;
}

async function acceptAndDrain(harness, update) {
  await harness.webhook.acceptUpdate(update);
  await drainTelegram(harness.worker);
}

async function drainTelegram(worker, includeDelayed = false) {
  for (let index = 0; index < 5; index += 1) {
    await worker.drainNow();
    await wait(5);
  }
  if (includeDelayed) {
    await wait(120);
    for (let index = 0; index < 5; index += 1) {
      await worker.drainNow();
      await wait(5);
    }
  }
}

function privateTextUpdate(updateId, messageId, telegramId, text) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: nowSeconds(),
      chat: { id: telegramId, type: 'private' },
      from: { id: telegramId, first_name: 'User' },
      text,
    },
  };
}

function voiceUpdate(
  updateId,
  messageId,
  telegramId,
  fileUniqueId,
  duration = 5,
  date = nowSeconds(),
) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date,
      chat: { id: telegramId, type: 'private' },
      from: { id: telegramId, first_name: 'User' },
      voice: {
        file_id: `file-${fileUniqueId}`,
        file_unique_id: fileUniqueId,
        duration,
        file_size: 1_024,
      },
    },
  };
}

function callbackUpdate(
  updateId,
  messageId,
  telegramId,
  callbackQueryId,
  callbackData,
) {
  return {
    update_id: updateId,
    callback_query: {
      id: callbackQueryId,
      from: { id: telegramId, first_name: 'User' },
      data: callbackData,
      message: {
        message_id: messageId,
        date: nowSeconds(),
        chat: { id: telegramId, type: 'private' },
      },
    },
  };
}

function nextSequence() {
  telegramSequence += 1;
  return telegramSequence;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1_000);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
