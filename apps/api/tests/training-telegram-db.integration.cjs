require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  Prisma,
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
  TrainingTelegramTransportError,
} = require('../dist/training/telegram/training-telegram.transport.js');
const {
  TrainingTelegramWebhookService,
} = require('../dist/training/telegram/training-telegram-webhook.service.js');
const {
  TrainingTelegramWorkerService,
} = require('../dist/training/telegram/training-telegram-worker.service.js');
const { UsersService } = require('../dist/users/users.service.js');
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
  assert.equal(
    await prisma.auditLog.count({
      where: {
        action: 'training.telegram.link',
        entityId: linked.account.id,
      },
    }),
    1,
  );
  const welcomeJob = await prisma.trainingJob.findUnique({
    where: {
      idempotencyKey: `telegram:link:${persisted.id}:welcome`,
    },
  });
  assert.equal(welcomeJob.status, TrainingJobStatus.PENDING);
  assert.equal(welcomeJob.payloadJson.eventType, 'ACCOUNT_LINKED');
});

test('concurrent consumption of one link token creates one account, audit and outbox event', async () => {
  const fixture = await createFixture();
  const harness = createHarness();
  const issued = await harness.links.issueLinkToken(fixture.userId);
  const tokenHash = hashTrainingLinkToken(issued.token);
  const persisted = await prisma.trainingLinkToken.findUnique({
    where: { tokenHash },
  });
  const identity = {
    telegramUserId: 501_101n,
    chatId: 501_101n,
  };

  const results = await Promise.allSettled([
    harness.links.consumeHashedToken(tokenHash, identity),
    harness.links.consumeHashedToken(tokenHash, identity),
  ]);

  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    await prisma.trainingTelegramAccount.count({
      where: { userId: fixture.userId },
    }),
    1,
  );
  assert.equal(
    await prisma.auditLog.count({
      where: { action: 'training.telegram.link', actorUserId: fixture.userId },
    }),
    1,
  );
  assert.equal(
    await prisma.trainingJob.count({
      where: {
        idempotencyKey: `telegram:link:${persisted.id}:welcome`,
      },
    }),
    1,
  );
});

test('manual unlink is idempotent and audited once', async () => {
  const fixture = await createFixture();
  const harness = createHarness();
  const account = await linkUser(harness, fixture.userId, 501_102);

  await harness.links.revokeAccount(fixture.userId);
  await harness.links.revokeAccount(fixture.userId);

  const persisted = await prisma.trainingTelegramAccount.findUnique({
    where: { userId: fixture.userId },
  });
  assert.ok(persisted.revokedAt);
  assert.equal(
    await prisma.auditLog.count({
      where: {
        action: 'training.telegram.unlink',
        entityId: account.account.id,
      },
    }),
    1,
  );
});

test('simultaneous relink and revoke preserve one account and no reusable token', async () => {
  const fixture = await createFixture();
  const harness = createHarness();
  await linkUser(harness, fixture.userId, 501_112);
  const issued = await harness.links.issueLinkToken(fixture.userId);
  const tokenHash = hashTrainingLinkToken(issued.token);

  const results = await Promise.allSettled([
    harness.links.consumeHashedToken(tokenHash, {
      telegramUserId: 501_112n,
      chatId: 501_112n,
    }),
    harness.links.revokeAccount(fixture.userId),
  ]);

  assert.ok(
    results.some((result) => result.status === 'fulfilled'),
  );
  assert.equal(
    await prisma.trainingTelegramAccount.count({
      where: { userId: fixture.userId },
    }),
    1,
  );
  assert.equal(
    await prisma.trainingLinkToken.count({
      where: {
        userId: fixture.userId,
        usedAt: null,
        revokedAt: null,
      },
    }),
    0,
  );
  const racedToken = await prisma.trainingLinkToken.findUnique({
    where: { tokenHash },
  });
  assert.ok(racedToken.usedAt || racedToken.revokedAt);
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

test('blocking and deactivating a user atomically revoke Telegram access without automatic restore', async () => {
  const fixture = await createFixture();
  const harness = createHarness();
  await linkUser(harness, fixture.userId, 501_103);
  const pendingToken = await harness.links.issueLinkToken(fixture.userId);
  const actor = await prisma.user.findUnique({
    where: { id: fixture.publisherId },
    include: { role: true },
  });
  const users = new UsersService(prisma);

  await users.update(
    fixture.userId,
    { status: UserStatus.BLOCKED },
    actor,
    auditRequest(),
  );

  const [blockedUser, revokedAccount, revokedToken] = await Promise.all([
    prisma.user.findUnique({ where: { id: fixture.userId } }),
    prisma.trainingTelegramAccount.findUnique({
      where: { userId: fixture.userId },
    }),
    prisma.trainingLinkToken.findUnique({
      where: { tokenHash: hashTrainingLinkToken(pendingToken.token) },
    }),
  ]);
  assert.equal(blockedUser.status, UserStatus.BLOCKED);
  assert.ok(revokedAccount.revokedAt);
  assert.ok(revokedToken.revokedAt);
  assert.equal(
    await prisma.auditLog.count({
      where: {
        action: 'training.telegram.auto_revoke',
        entityId: revokedAccount.id,
      },
    }),
    1,
  );

  await users.activate(fixture.userId, actor, auditRequest());
  await linkUser(harness, fixture.userId, 501_103);
  await users.deactivate(fixture.userId, actor, auditRequest());
  const deactivated = await prisma.user.findUnique({
    where: { id: fixture.userId },
  });
  assert.equal(deactivated.status, UserStatus.DEACTIVATED);
  assert.equal(
    await prisma.auditLog.count({
      where: {
        action: 'training.telegram.auto_revoke',
        entityId: revokedAccount.id,
      },
    }),
    2,
  );
  await users.activate(fixture.userId, actor, auditRequest());
  const afterActivation = await prisma.trainingTelegramAccount.findUnique({
    where: { userId: fixture.userId },
  });
  assert.ok(afterActivation.revokedAt);
  await acceptAndDrain(
    harness,
    privateTextUpdate(nextSequence(), 90, 501_103, 'Правила'),
  );
  assert.ok(
    harness.transport.deliveries.some(
      (delivery) =>
        delivery.operation === 'SEND_MESSAGE' &&
        delivery.text.includes('Подключите Telegram'),
    ),
  );
});

test('user status and Telegram revocation roll back together when audit persistence fails', async () => {
  const fixture = await createFixture();
  const harness = createHarness();
  await linkUser(harness, fixture.userId, 501_104);
  const users = new UsersService(prisma);

  await assert.rejects(
    users.update(
      fixture.userId,
      { status: UserStatus.BLOCKED },
      { id: '00000000-0000-4000-8000-000000000099' },
      auditRequest(),
    ),
  );

  const [user, account] = await Promise.all([
    prisma.user.findUnique({ where: { id: fixture.userId } }),
    prisma.trainingTelegramAccount.findUnique({
      where: { userId: fixture.userId },
    }),
  ]);
  assert.equal(user.status, UserStatus.ACTIVE);
  assert.equal(account.revokedAt, null);
});

test('every update rejects a soft-deleted user and revokes a stale active account', async () => {
  const fixture = await createFixture();
  const telegramId = 501_105;
  const harness = createHarness();
  const linked = await linkUser(harness, fixture.userId, telegramId);
  await prisma.user.update({
    where: { id: fixture.userId },
    data: { deletedAt: new Date() },
  });

  await acceptAndDrain(
    harness,
    privateTextUpdate(nextSequence(), 91, telegramId, 'Правила'),
  );

  const account = await prisma.trainingTelegramAccount.findUnique({
    where: { userId: fixture.userId },
  });
  assert.ok(account.revokedAt);
  assert.equal(
    await prisma.auditLog.count({
      where: {
        action: 'training.telegram.auto_revoke',
        entityId: account.id,
      },
    }),
    1,
  );
  assert.ok(
    harness.transport.deliveries.some(
      (delivery) =>
        delivery.operation === 'SEND_MESSAGE' &&
        delivery.text.includes('Доступ к обучению закрыт'),
    ),
  );
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

test('concurrent file_unique_id deduplication is scoped to one answer and keeps segment order valid', async () => {
  const fixture = await createFixture();
  const harness = createHarness();
  const attempt = await startAttempt(harness.engine, fixture);
  const sharedFileUniqueId = `shared-current-answer-${nextSequence()}`;

  await Promise.all([
    appendVoice(harness.engine, attempt.id, {
      updateId: nextSequence(),
      messageId: nextSequence(),
      fileUniqueId: sharedFileUniqueId,
      transcript: 'duplicate voice first delivery',
    }),
    appendVoice(harness.engine, attempt.id, {
      updateId: nextSequence(),
      messageId: nextSequence(),
      fileUniqueId: sharedFileUniqueId,
      transcript: 'duplicate voice forwarded delivery',
    }),
  ]);
  await Promise.all(
    ['parallel-a', 'parallel-b', 'parallel-c'].map((suffix, index) =>
      appendVoice(harness.engine, attempt.id, {
        updateId: nextSequence(),
        messageId: nextSequence(),
        fileUniqueId: `${sharedFileUniqueId}-${suffix}`,
        transcript: suffix,
      }),
    ),
  );

  const segments = await prisma.trainingVoiceSegment.findMany({
    where: {
      answer: { attemptQuestion: { attemptId: attempt.id, sequence: 1 } },
    },
    orderBy: { segmentIndex: 'asc' },
  });
  assert.equal(
    segments.filter(
      (segment) => segment.fileUniqueId === sharedFileUniqueId,
    ).length,
    1,
  );
  assert.deepEqual(
    segments.map((segment) => segment.segmentIndex),
    [1, 2, 3, 4],
  );
});

test('the same file_unique_id remains valid for another question and a new attempt', async () => {
  const fixture = await createFixture({ cooldownMinutes: 60 });
  const harness = createHarness();
  const sharedFileUniqueId = `shared-across-answers-${nextSequence()}`;
  const firstAttempt = await startAttempt(harness.engine, fixture);

  for (let index = 0; index < 4; index += 1) {
    const current = (await harness.engine.getAttempt(firstAttempt.id)).attempt;
    const question = current.attemptQuestions.find(
      (item) =>
        item.status === TrainingAttemptQuestionStatus.PRESENTED ||
        item.status === TrainingAttemptQuestionStatus.COLLECTING,
    );
    await appendVoice(harness.engine, firstAttempt.id, {
      updateId: nextSequence(),
      messageId: nextSequence(),
      fileUniqueId: index < 2 ? sharedFileUniqueId : `${sharedFileUniqueId}-${index}`,
      transcript: `answer ${index + 1}`,
    });
    await harness.engine.finishAnswer({
      attemptId: firstAttempt.id,
      attemptQuestionId: question.id,
    });
  }

  await prisma.trainingAttempt.update({
    where: { id: firstAttempt.id },
    data: {
      startedAt: new Date(Date.now() - 62 * 60_000),
      completedAt: new Date(Date.now() - 61 * 60_000),
    },
  });
  const secondAttempt = await startAttempt(harness.engine, fixture);
  await appendVoice(harness.engine, secondAttempt.id, {
    updateId: nextSequence(),
    messageId: nextSequence(),
    fileUniqueId: sharedFileUniqueId,
    transcript: 'new attempt answer',
  });

  const segments = await prisma.trainingVoiceSegment.findMany({
    where: { fileUniqueId: sharedFileUniqueId },
    select: {
      answerId: true,
      answer: {
        select: {
          attemptQuestion: {
            select: { attemptId: true, sequence: true },
          },
        },
      },
    },
  });
  assert.equal(segments.length, 3);
  assert.equal(new Set(segments.map((segment) => segment.answerId)).size, 3);
  assert.equal(
    new Set(
      segments.map(
        (segment) =>
          `${segment.answer.attemptQuestion.attemptId}:${segment.answer.attemptQuestion.sequence}`,
      ),
    ).size,
    3,
  );
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
  assert.equal(
    await prisma.trainingJob.count({
      where: {
        idempotencyKey: `telegram:attempt:${attempt.id}:answer-accepted:${firstQuestionId}`,
      },
    }),
    1,
  );
  assert.equal(
    await prisma.trainingJob.count({
      where: {
        idempotencyKey: `telegram:attempt:${attempt.id}:question:${nextQuestion.id}`,
      },
    }),
    1,
  );
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

test('link and attempt state roll back when their transactional outbox write fails', async () => {
  const linkFixture = await createFixture();
  const normalHarness = createHarness();
  const issued = await normalHarness.links.issueLinkToken(linkFixture.userId);
  const tokenHash = hashTrainingLinkToken(issued.token);
  const failingPrisma = prismaWithFailingTelegramOutbox(prisma);
  const failingLinks = new TrainingTelegramLinkService(
    failingPrisma,
    TEST_CONFIG,
  );

  await assert.rejects(
    failingLinks.consumeHashedToken(tokenHash, {
      telegramUserId: 501_106n,
      chatId: 501_106n,
    }),
    /forced Telegram outbox failure/,
  );
  const rolledBackToken = await prisma.trainingLinkToken.findUnique({
    where: { tokenHash },
  });
  assert.equal(rolledBackToken.usedAt, null);
  assert.equal(
    await prisma.trainingTelegramAccount.count({
      where: { userId: linkFixture.userId },
    }),
    0,
  );
  assert.equal(
    await prisma.auditLog.count({
      where: {
        action: 'training.telegram.link',
        actorUserId: linkFixture.userId,
      },
    }),
    0,
  );

  const attemptFixture = await createFixture();
  await linkUser(normalHarness, attemptFixture.userId, 501_107);
  const failingEngine = createEngine(failingPrisma);
  const timerJobsBefore = await prisma.trainingJob.count({
    where: {
      kind: {
        in: [
          TrainingJobKind.SEND_TIMER_WARNING,
          TrainingJobKind.EXPIRE_ATTEMPT,
        ],
      },
    },
  });
  await assert.rejects(
    failingEngine.confirmStart({
      userId: attemptFixture.userId,
      projectId: attemptFixture.projectId,
      confirmed: true,
    }),
    /forced Telegram outbox failure/,
  );
  assert.equal(
    await prisma.trainingAttempt.count({
      where: {
        userId: attemptFixture.userId,
        projectId: attemptFixture.projectId,
      },
    }),
    0,
  );
  assert.equal(
    await prisma.trainingJob.count({
      where: {
        kind: {
          in: [
            TrainingJobKind.SEND_TIMER_WARNING,
            TrainingJobKind.EXPIRE_ATTEMPT,
          ],
        },
      },
    }),
    timerJobsBefore,
  );
});

test('answer locking rolls back if its outbox event cannot be persisted', async () => {
  const fixture = await createFixture();
  const harness = createHarness();
  await linkUser(harness, fixture.userId, 501_108);
  const attempt = await startAttempt(harness.engine, fixture);
  const question = attempt.attemptQuestions[0];
  await appendVoice(harness.engine, attempt.id, {
    updateId: nextSequence(),
    messageId: nextSequence(),
    fileUniqueId: `finish-rollback-${nextSequence()}`,
    transcript: 'answer before forced rollback',
  });

  const failingEngine = createEngine(
    prismaWithFailingTelegramOutbox(prisma),
  );
  await assert.rejects(
    failingEngine.finishAnswer({
      attemptId: attempt.id,
      attemptQuestionId: question.id,
    }),
    /forced Telegram outbox failure/,
  );

  const persisted = await prisma.trainingAttemptQuestion.findUnique({
    where: { id: question.id },
    include: { answer: true },
  });
  assert.equal(
    persisted.status,
    TrainingAttemptQuestionStatus.COLLECTING,
  );
  assert.equal(persisted.answer.status, 'COLLECTING');
  assert.equal(
    await prisma.trainingJob.count({
      where: {
        idempotencyKey: `telegram:attempt:${attempt.id}:answer:${question.id}:accepted`,
      },
    }),
    0,
  );
});

test('a worker restart delivers an outbox event committed before the crash window', async () => {
  const fixture = await createFixture();
  const firstHarness = createHarness();
  await linkUser(firstHarness, fixture.userId, 501_109);
  await drainTelegram(firstHarness.worker);
  const attempt = await startAttempt(firstHarness.engine, fixture);
  const question = attempt.attemptQuestions[0];
  const key = `telegram:attempt:${attempt.id}:question:${question.id}`;
  const beforeRestart = await prisma.trainingJob.findUnique({
    where: { idempotencyKey: key },
  });
  assert.equal(beforeRestart.status, TrainingJobStatus.PENDING);

  const restartedHarness = createHarness();
  await drainTelegram(restartedHarness.worker);
  await drainTelegram(restartedHarness.worker);

  assert.equal(
    restartedHarness.transport.deliveries.filter(
      (delivery) =>
        delivery.operation === 'SEND_MESSAGE' &&
        delivery.text.includes('Главный вопрос'),
    ).length,
    1,
  );
  const delivered = await prisma.trainingJob.findUnique({
    where: { idempotencyKey: key },
  });
  assert.equal(delivered.status, TrainingJobStatus.SUCCEEDED);
  assert.equal(delivered.attempts, 1);
});

test('finalization commits the terminal state and result outbox before worker restart', async () => {
  const fixture = await createFixture();
  const firstHarness = createHarness();
  await linkUser(firstHarness, fixture.userId, 501_113);
  await drainTelegram(firstHarness.worker);
  const attempt = await startAttempt(firstHarness.engine, fixture);
  await completeAttempt(firstHarness.engine, attempt, 720_000);
  const key = `telegram:attempt-result:${attempt.id}`;
  const [terminalAttempt, committedOutbox] = await Promise.all([
    prisma.trainingAttempt.findUnique({ where: { id: attempt.id } }),
    prisma.trainingJob.findUnique({ where: { idempotencyKey: key } }),
  ]);
  assert.equal(terminalAttempt.status, TrainingAttemptStatus.COMPLETED);
  assert.equal(committedOutbox.status, TrainingJobStatus.PENDING);

  await wait(120);
  const restartedHarness = createHarness();
  await drainTelegram(restartedHarness.worker);
  const resultDeliveries = restartedHarness.transport.deliveries.filter(
    (delivery) =>
      delivery.operation === 'SEND_MESSAGE' &&
      delivery.text.startsWith('Результат:'),
  );
  assert.equal(resultDeliveries.length, 1);
  const delivered = await prisma.trainingJob.findUnique({
    where: { idempotencyKey: key },
  });
  assert.equal(delivered.status, TrainingJobStatus.SUCCEEDED);
  assert.equal(delivered.attempts, 1);
});

test('technical failure creates and delivers one safe outbox message', async () => {
  const fixture = await createFixture();
  const harness = createHarness();
  await linkUser(harness, fixture.userId, 501_110);
  await drainTelegram(harness.worker);
  const failingEngine = createEngine(prisma, {
    transcribe: async () => {
      throw new Error('provider secret detail must not reach Telegram');
    },
  });
  const attempt = await startAttempt(failingEngine, fixture);
  const question = attempt.attemptQuestions[0];
  await appendVoice(failingEngine, attempt.id, {
    updateId: nextSequence(),
    messageId: nextSequence(),
    fileUniqueId: `technical-${nextSequence()}`,
    transcript: 'provider should fail',
  });
  await assert.rejects(
    failingEngine.finishAnswer({
      attemptId: attempt.id,
      attemptQuestionId: question.id,
    }),
    /provider secret detail must not reach Telegram/,
  );
  await drainTelegram(harness.worker, true);

  const failedAttempt = await prisma.trainingAttempt.findUnique({
    where: { id: attempt.id },
  });
  assert.equal(
    failedAttempt.status,
    TrainingAttemptStatus.TECHNICAL_FAILURE,
  );
  const deliveries = harness.transport.deliveries.filter(
    (delivery) =>
      delivery.operation === 'SEND_MESSAGE' &&
      delivery.text.includes('техническая ошибка'),
  );
  assert.equal(deliveries.length, 1);
  assert.equal(
    deliveries[0].text.includes('provider secret detail'),
    false,
  );
});

test('two Telegram workers claim one delivery job only once', async () => {
  const marker = `two-workers-${nextSequence()}`;
  const key = `telegram:test:${marker}`;
  await createTelegramDeliveryJob(key, marker);
  const transport = new FakeTrainingTelegramTransport();
  const dialog = createHarness().dialog;
  const first = new TrainingTelegramWorkerService(
    prisma,
    TEST_CONFIG,
    dialog,
    transport,
  );
  const second = new TrainingTelegramWorkerService(
    prisma,
    TEST_CONFIG,
    dialog,
    transport,
  );

  await Promise.all([first.drainNow(), second.drainNow()]);

  const job = await prisma.trainingJob.findUnique({
    where: { idempotencyKey: key },
  });
  assert.equal(job.status, TrainingJobStatus.SUCCEEDED);
  assert.equal(job.attempts, 1);
  assert.equal(
    transport.deliveries.filter(
      (delivery) =>
        delivery.operation === 'SEND_MESSAGE' && delivery.text === marker,
    ).length,
    1,
  );
});

test('Telegram worker applies bounded retries and permanently rejects non-retryable 4xx', async () => {
  const retryMarker = `retryable-${nextSequence()}`;
  const retryKey = `telegram:test:${retryMarker}`;
  const permanentMarker = `permanent-${nextSequence()}`;
  const permanentKey = `telegram:test:${permanentMarker}`;
  await createTelegramDeliveryJob(retryKey, retryMarker, { maxAttempts: 2 });
  await createTelegramDeliveryJob(permanentKey, permanentMarker, {
    maxAttempts: 5,
  });
  const fallback = new FakeTrainingTelegramTransport();
  const transport = {
    async sendMessage(input) {
      if (input.text === retryMarker) {
        throw new TrainingTelegramTransportError(
          'RATE_LIMITED',
          true,
          1_000,
        );
      }
      if (input.text === permanentMarker) {
        throw new TrainingTelegramTransportError(
          'PERMANENT_CLIENT_ERROR',
          false,
        );
      }
      return fallback.sendMessage(input);
    },
    answerCallbackQuery: (input) => fallback.answerCallbackQuery(input),
  };
  const worker = new TrainingTelegramWorkerService(
    prisma,
    TEST_CONFIG,
    createHarness().dialog,
    transport,
  );

  await worker.drainNow();
  const [retrying, permanent] = await Promise.all([
    prisma.trainingJob.findUnique({ where: { idempotencyKey: retryKey } }),
    prisma.trainingJob.findUnique({ where: { idempotencyKey: permanentKey } }),
  ]);
  assert.equal(retrying.status, TrainingJobStatus.PENDING);
  assert.equal(retrying.attempts, 1);
  assert.equal(retrying.lastErrorCode, 'RATE_LIMITED');
  assert.ok(retrying.runAt.getTime() >= Date.now() + 700);
  assert.equal(permanent.status, TrainingJobStatus.DEAD);
  assert.equal(permanent.attempts, 1);
  assert.equal(permanent.lastErrorCode, 'PERMANENT_CLIENT_ERROR');

  await prisma.trainingJob.update({
    where: { idempotencyKey: retryKey },
    data: { runAt: new Date('2000-01-01T00:00:00.000Z') },
  });
  await worker.drainNow();
  const exhausted = await prisma.trainingJob.findUnique({
    where: { idempotencyKey: retryKey },
  });
  assert.equal(exhausted.status, TrainingJobStatus.DEAD);
  assert.equal(exhausted.attempts, 2);
  assert.equal(exhausted.lastErrorCode, 'RATE_LIMITED');
});

test('Telegram worker heartbeats prevent takeover and stale exhausted jobs become DEAD', async () => {
  const heartbeatMarker = `heartbeat-${nextSequence()}`;
  const heartbeatKey = `telegram:test:${heartbeatMarker}`;
  await createTelegramDeliveryJob(heartbeatKey, heartbeatMarker);
  const staleDeadMarker = `stale-dead-${nextSequence()}`;
  const staleDeadKey = `telegram:test:${staleDeadMarker}`;
  await createTelegramDeliveryJob(staleDeadKey, staleDeadMarker, {
    status: TrainingJobStatus.RUNNING,
    attempts: 2,
    maxAttempts: 2,
    lockOwner: 'crashed-worker',
    lockedAt: new Date('2000-01-01T00:00:00.000Z'),
    heartbeatAt: new Date('2000-01-01T00:00:00.000Z'),
  });
  const staleRetryMarker = `stale-retry-${nextSequence()}`;
  const staleRetryKey = `telegram:test:${staleRetryMarker}`;
  await createTelegramDeliveryJob(staleRetryKey, staleRetryMarker, {
    status: TrainingJobStatus.RUNNING,
    attempts: 1,
    maxAttempts: 3,
    lockOwner: 'crashed-worker',
    lockedAt: new Date('2000-01-01T00:00:00.000Z'),
    heartbeatAt: new Date('2000-01-01T00:00:00.000Z'),
  });
  const gate = deferred();
  const fallback = new FakeTrainingTelegramTransport();
  const slowTransport = {
    async sendMessage(input) {
      if (input.text === heartbeatMarker) await gate.promise;
      return fallback.sendMessage(input);
    },
    answerCallbackQuery: (input) => fallback.answerCallbackQuery(input),
  };
  const config = {
    ...TEST_CONFIG,
    workerLeaseMs: 80,
    workerHeartbeatMs: 10,
  };
  const dialog = createHarness().dialog;
  const first = new TrainingTelegramWorkerService(
    prisma,
    config,
    dialog,
    slowTransport,
  );
  const second = new TrainingTelegramWorkerService(
    prisma,
    config,
    dialog,
    slowTransport,
  );

  const firstDrain = first.drainNow();
  await waitForJobStatus(heartbeatKey, TrainingJobStatus.RUNNING);
  await wait(140);
  await second.drainNow();
  const duringSend = await prisma.trainingJob.findUnique({
    where: { idempotencyKey: heartbeatKey },
  });
  const staleDead = await prisma.trainingJob.findUnique({
    where: { idempotencyKey: staleDeadKey },
  });
  const staleRecovered = await prisma.trainingJob.findUnique({
    where: { idempotencyKey: staleRetryKey },
  });
  assert.equal(duringSend.status, TrainingJobStatus.RUNNING);
  assert.equal(duringSend.attempts, 1);
  assert.equal(staleDead.status, TrainingJobStatus.DEAD);
  assert.equal(staleDead.lastErrorCode, 'STALE_TELEGRAM_JOB_DEAD');
  assert.equal(staleRecovered.status, TrainingJobStatus.SUCCEEDED);
  assert.equal(staleRecovered.attempts, 2);

  gate.resolve();
  await firstDrain;
  const completed = await prisma.trainingJob.findUnique({
    where: { idempotencyKey: heartbeatKey },
  });
  assert.equal(completed.status, TrainingJobStatus.SUCCEEDED);
  assert.equal(completed.attempts, 1);
});

test('bounded shutdown releases ownership and a restarted worker resumes the job', async () => {
  const marker = `shutdown-${nextSequence()}`;
  const key = `telegram:test:${marker}`;
  await createTelegramDeliveryJob(key, marker, { maxAttempts: 3 });
  const gate = deferred();
  const blockedTransport = {
    async sendMessage(input) {
      if (input.text === marker) await gate.promise;
    },
    async answerCallbackQuery() {},
  };
  const config = {
    ...TEST_CONFIG,
    workerLeaseMs: 100,
    workerHeartbeatMs: 10,
    workerDrainTimeoutMs: 30,
  };
  const dialog = createHarness().dialog;
  const stoppingWorker = new TrainingTelegramWorkerService(
    prisma,
    config,
    dialog,
    blockedTransport,
  );

  const drain = stoppingWorker.drainNow();
  await waitForJobStatus(key, TrainingJobStatus.RUNNING);
  await stoppingWorker.onModuleDestroy();
  let job = await prisma.trainingJob.findUnique({
    where: { idempotencyKey: key },
  });
  assert.equal(job.status, TrainingJobStatus.PENDING);
  assert.equal(job.lastErrorCode, 'TELEGRAM_SHUTDOWN_RELEASE');

  gate.resolve();
  await drain;
  job = await prisma.trainingJob.findUnique({
    where: { idempotencyKey: key },
  });
  assert.equal(job.status, TrainingJobStatus.PENDING);

  const restartedTransport = new FakeTrainingTelegramTransport();
  const restartedWorker = new TrainingTelegramWorkerService(
    prisma,
    config,
    dialog,
    restartedTransport,
  );
  await restartedWorker.drainNow();
  job = await prisma.trainingJob.findUnique({
    where: { idempotencyKey: key },
  });
  assert.equal(job.status, TrainingJobStatus.SUCCEEDED);
  assert.equal(job.attempts, 2);
  assert.equal(
    restartedTransport.deliveries.filter(
      (delivery) =>
        delivery.operation === 'SEND_MESSAGE' && delivery.text === marker,
    ).length,
    1,
  );
});

test('graceful shutdown waits for an active Telegram job within the drain timeout', async () => {
  const marker = `graceful-shutdown-${nextSequence()}`;
  const key = `telegram:test:${marker}`;
  await createTelegramDeliveryJob(key, marker);
  const gate = deferred();
  const transport = {
    async sendMessage(input) {
      if (input.text === marker) await gate.promise;
    },
    async answerCallbackQuery() {},
  };
  const worker = new TrainingTelegramWorkerService(
    prisma,
    {
      ...TEST_CONFIG,
      workerDrainTimeoutMs: 500,
    },
    createHarness().dialog,
    transport,
  );

  const drain = worker.drainNow();
  await waitForJobStatus(key, TrainingJobStatus.RUNNING);
  let shutdownFinished = false;
  const shutdown = worker.onModuleDestroy().then(() => {
    shutdownFinished = true;
  });
  await wait(30);
  assert.equal(shutdownFinished, false);
  gate.resolve();
  await Promise.all([drain, shutdown]);

  const job = await prisma.trainingJob.findUnique({
    where: { idempotencyKey: key },
  });
  assert.equal(job.status, TrainingJobStatus.SUCCEEDED);
  assert.equal(job.attempts, 1);
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

test('timeout finalization persists and delivers one result outbox event', async () => {
  const fixture = await createFixture();
  const telegramId = 501_114;
  const harness = createHarness();
  await linkUser(harness, fixture.userId, telegramId);
  await drainTelegram(harness.worker);
  const attempt = await startAttempt(harness.engine, fixture);
  const now = new Date();
  await prisma.trainingAttempt.update({
    where: { id: attempt.id },
    data: {
      startedAt: new Date(now.getTime() - 10_000),
      expiresAt: new Date(now.getTime() - 2_000),
      graceExpiresAt: new Date(now.getTime() - 1_000),
    },
  });

  await harness.engine.handleTimeout(attempt.id, now);
  await wait(120);
  await drainTelegram(harness.worker);

  const persisted = await prisma.trainingAttempt.findUnique({
    where: { id: attempt.id },
  });
  assert.equal(persisted.status, TrainingAttemptStatus.COMPLETED);
  const resultJobs = await prisma.trainingJob.findMany({
    where: {
      idempotencyKey: `telegram:attempt-result:${attempt.id}`,
    },
  });
  assert.equal(resultJobs.length, 1);
  assert.equal(resultJobs[0].status, TrainingJobStatus.SUCCEEDED);
  assert.equal(
    harness.transport.deliveries.filter(
      (delivery) =>
        delivery.operation === 'SEND_MESSAGE' &&
        delivery.text.startsWith('Результат:'),
    ).length,
    1,
  );
});

test('terminal transition wins the advisory pre-send warning gate without a late message', async () => {
  const fixture = await createFixture();
  const telegramId = 501_111;
  const harness = createHarness();
  await linkUser(harness, fixture.userId, telegramId);
  const attempt = await startAttempt(harness.engine, fixture);
  await drainTelegram(harness.worker);
  harness.transport.clear();
  const warning = await prisma.trainingJob.findFirst({
    where: {
      kind: TrainingJobKind.SEND_TIMER_WARNING,
      idempotencyKey: {
        startsWith: `attempt:${attempt.id}:timer:warning:`,
      },
    },
    orderBy: { runAt: 'asc' },
  });
  await prisma.trainingJob.update({
    where: { id: warning.id },
    data: {
      status: TrainingJobStatus.PENDING,
      runAt: new Date('1998-01-01T00:00:00.000Z'),
      finishedAt: null,
    },
  });
  const lockAcquired = deferred();
  const terminalTransition = prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      'SELECT 1 AS "locked" FROM (SELECT pg_advisory_xact_lock(hashtextextended($1, 0))) AS "lock_state"',
      `training-attempt-id:${attempt.id}`,
    );
    lockAcquired.resolve();
    await wait(80);
    const completedAt = new Date();
    await tx.trainingAttempt.update({
      where: { id: attempt.id },
      data: {
        status: TrainingAttemptStatus.COMPLETED,
        completedAt,
      },
    });
    await tx.trainingJob.updateMany({
      where: {
        id: warning.id,
        status: {
          in: [
            TrainingJobStatus.PENDING,
            TrainingJobStatus.RUNNING,
          ],
        },
      },
      data: {
        status: TrainingJobStatus.SUCCEEDED,
        finishedAt: completedAt,
        lockOwner: null,
        lockedAt: null,
        heartbeatAt: null,
        errorDetailsJson: { terminalNoop: true },
      },
    });
  });
  await lockAcquired.promise;
  const workerDrain = harness.worker.drainNow();
  await Promise.all([terminalTransition, workerDrain]);

  assert.equal(
    harness.transport.deliveries.some(
      (delivery) =>
        delivery.operation === 'SEND_MESSAGE' &&
        delivery.text.includes('осталось'),
    ),
    false,
  );
  const closedWarning = await prisma.trainingJob.findUnique({
    where: { id: warning.id },
  });
  assert.equal(closedWarning.status, TrainingJobStatus.SUCCEEDED);
  assert.equal(closedWarning.errorDetailsJson.terminalNoop, true);
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
  const resultJob = await prisma.trainingJob.findUnique({
    where: {
      idempotencyKey: `telegram:attempt-result:${attempt.id}`,
    },
  });
  assert.equal(resultJob.status, TrainingJobStatus.SUCCEEDED);
  assert.equal(resultJob.attempts, 1);
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
  await prisma.trainingJob.updateMany({
    where: {
      kind: TrainingJobKind.SEND_TIMER_WARNING,
      idempotencyKey: {
        startsWith: `attempt:${attempt.id}:timer:warning:`,
      },
    },
    data: {
      status: TrainingJobStatus.PENDING,
      runAt: new Date('1997-01-01T00:00:00.000Z'),
      finishedAt: null,
    },
  });
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
  assert.equal(
    harness.transport.deliveries.some(
      (delivery) =>
        delivery.operation === 'SEND_MESSAGE' &&
        delivery.text.startsWith('До завершения аттестации'),
    ),
    false,
  );
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
  transportMode: 'fake',
  botToken: '',
  botUsername: 'platforma_training_bot',
  webhookSecret: 'stage6-webhook-secret',
  webhookUrl: 'http://localhost:3000/training/telegram/webhook',
  linkTokenTtlMinutes: 15,
  workerPollMs: 250,
  workerLeaseMs: 1_000,
  workerHeartbeatMs: 100,
  workerDrainTimeoutMs: 500,
  publicTrainingUrl: 'http://localhost:5173/training',
  usesFakeTransport: true,
};

function createHarness() {
  const engine = createEngine(prisma);
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

function createEngine(
  prismaClient,
  transcriptionProvider = new DeterministicFakeTrainingTranscriptionProvider(),
) {
  return new TrainingAttemptEngineService(
    prismaClient,
    new SystemTrainingAttemptClock(),
    new DeterministicQuestionSelector(),
    transcriptionProvider,
    new DeterministicFakeTrainingEvaluationProvider(),
  );
}

function prismaWithFailingTelegramOutbox(basePrisma) {
  return new Proxy(basePrisma, {
    get(target, property) {
      if (property === '$transaction') {
        return (callback, options) =>
          target.$transaction(
            (tx) => callback(transactionWithFailingTelegramOutbox(tx)),
            options,
          );
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function transactionWithFailingTelegramOutbox(tx) {
  return new Proxy(tx, {
    get(target, property) {
      if (property === 'trainingJob') {
        return new Proxy(target.trainingJob, {
          get(jobTarget, jobProperty) {
            if (jobProperty === 'createMany') {
              return async (args) => {
                const rows = Array.isArray(args.data) ? args.data : [args.data];
                if (
                  rows.some(
                    (row) =>
                      row.kind === TrainingJobKind.SEND_TELEGRAM_MESSAGE &&
                      row.payloadJson?.operation === 'DOMAIN_EVENT',
                  )
                ) {
                  throw new Error('forced Telegram outbox failure');
                }
                return jobTarget.createMany(args);
              };
            }
            const value = jobTarget[jobProperty];
            return typeof value === 'function'
              ? value.bind(jobTarget)
              : value;
          },
        });
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
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
      cooldownMinutes: options.cooldownMinutes ?? 60,
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

function appendVoice(
  engine,
  attemptId,
  { updateId, messageId, fileUniqueId, transcript },
) {
  return engine.appendVoiceSegment({
    attemptId,
    kind: 'VOICE',
    updateId: BigInt(updateId),
    fakeTranscript: transcript,
    recordingStartedAt: new Date(),
    telegramMessageId: BigInt(messageId),
    telegramChatId: 900_001n,
    telegramFileId: `file-${fileUniqueId}`,
    fileUniqueId,
    durationSeconds: 5,
  });
}

function createTelegramDeliveryJob(idempotencyKey, text, overrides = {}) {
  return prisma.trainingJob.create({
    data: {
      kind: TrainingJobKind.SEND_TELEGRAM_MESSAGE,
      status: overrides.status ?? TrainingJobStatus.PENDING,
      payloadJson: {
        operation: 'SEND_MESSAGE',
        chatId: '999001',
        text,
      },
      idempotencyKey,
      runAt: new Date('1999-01-01T00:00:00.000Z'),
      attempts: overrides.attempts ?? 0,
      maxAttempts: overrides.maxAttempts ?? 5,
      lockOwner: overrides.lockOwner,
      lockedAt: overrides.lockedAt,
      heartbeatAt: overrides.heartbeatAt,
    },
  });
}

async function waitForJobStatus(idempotencyKey, status) {
  for (let index = 0; index < 100; index += 1) {
    const job = await prisma.trainingJob.findUnique({
      where: { idempotencyKey },
      select: { status: true },
    });
    if (job?.status === status) return;
    await wait(5);
  }
  throw new Error(`Training job ${idempotencyKey} did not reach ${status}`);
}

function deferred() {
  let resolve;
  const promise = new Promise((currentResolve) => {
    resolve = currentResolve;
  });
  return { promise, resolve };
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

function auditRequest() {
  return {
    headers: {},
    socket: {},
  };
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
