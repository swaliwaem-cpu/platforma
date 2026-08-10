require('reflect-metadata');

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const {
  PrismaClient,
  TrainingAttemptStatus,
  TrainingProjectAccessMode,
  UserStatus,
} = require('@prisma/client');
const { ForbiddenException } = require('@nestjs/common');

const { TrainingAttemptStateService } = require('../dist/training/training-attempt-state.service.js');
const { TrainingAttemptService } = require('../dist/training/training-attempt.service.js');
const { DeterministicFakeTrainingEvaluator } = require('../dist/training/training-evaluator.js');
const { TrainingProjectAccessService } = require('../dist/training/training-project-access.service.js');
const { TrainingProjectService } = require('../dist/training/training-project.service.js');
const { TrainingReviewService } = require('../dist/training/training-review.service.js');
const { FakeTrainingTelegramClient } = require('../dist/training/training-telegram-client.js');
const {
  TrainingTelegramOutboxWorkerService,
} = require('../dist/training/training-telegram-outbox-worker.service.js');
const { TrainingTelegramService } = require('../dist/training/training-telegram.service.js');
const { TrainingVoiceWorkerService } = require('../dist/training/training-voice-worker.service.js');

const databaseUrl = process.env.TRAINING_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('Training Stage 4.5 PostgreSQL scenarios require the targeted temporary database runner', () => {
    assert.equal(process.env.TRAINING_TEST_DATABASE_URL, undefined);
  });
} else {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const access = new TrainingProjectAccessService(prisma);
  const state = new TrainingAttemptStateService(
    prisma,
    new DeterministicFakeTrainingEvaluator(),
    { select: (candidates) => candidates.slice(0, 3) },
    access,
  );
  const attempts = new TrainingAttemptService(prisma, state, access);
  const projects = new TrainingProjectService(prisma);
  const telegramClient = new FakeTrainingTelegramClient();
  const telegram = new TrainingTelegramService(
    prisma,
    state,
    access,
    telegramClient,
  );
  const telegramOutbox = new TrainingTelegramOutboxWorkerService(prisma, telegram);
  const reviews = new TrainingReviewService(prisma, telegramOutbox);
  let admin;
  let participants;

  before(async () => {
    await prisma.$connect();
    admin = await createUser('admin', UserStatus.ACTIVE, ['training:participate']);
    participants = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        createUser(`participant-${index + 1}`, UserStatus.ACTIVE, ['training:participate']),
      ),
    );
  });

  after(async () => prisma.$disconnect());

  test('Stage 4.5 default, bulk idempotency, reactivation and mode changes preserve assignments', async () => {
    const project = await createOpenProject('Data project');
    assert.equal(project.accessMode, TrainingProjectAccessMode.ASSIGNED_USERS);

    const assigned = await access.bulkAssignments(project.id, admin.id, {
      action: 'ASSIGN',
      userIds: participants.map((user) => user.id),
    });
    assert.equal(assigned.assigned, 10);
    assert.equal(assigned.activeAssignments, 10);

    const replay = await access.bulkAssignments(project.id, admin.id, {
      action: 'ASSIGN',
      userIds: participants.map((user) => user.id),
    });
    assert.equal(replay.assigned, 0);
    assert.equal(replay.unchanged, 10);

    const revoked = await access.bulkAssignments(project.id, admin.id, {
      action: 'REVOKE',
      userIds: [participants[0].id],
    });
    assert.equal(revoked.revoked, 1);
    assert.equal((await access.bulkAssignments(project.id, admin.id, {
      action: 'REVOKE',
      userIds: [participants[0].id],
    })).unchanged, 1);
    assert.equal((await access.bulkAssignments(project.id, admin.id, {
      action: 'ASSIGN',
      userIds: [participants[0].id],
    })).assigned, 1);

    await access.setAccessMode(project.id, admin.id, TrainingProjectAccessMode.ALL_PARTICIPANTS);
    await access.setAccessMode(project.id, admin.id, TrainingProjectAccessMode.ASSIGNED_USERS);
    assert.equal(
      await prisma.trainingProjectAssignment.count({ where: { projectId: project.id, revokedAt: null } }),
      10,
    );
    assert.equal(
      await prisma.trainingProjectAssignment.count({ where: { projectId: project.id, userId: participants[0].id } }),
      1,
    );
  });

  test('one user is assigned to ten projects and employee visibility stays database-filtered', async () => {
    const projectIds = [];
    for (let index = 0; index < 10; index += 1) {
      const project = await prisma.trainingProject.create({
        data: {
          title: `Matrix project ${index + 1}`,
          allowRetakeAfterPass: true,
          status: 'PUBLISHED',
          isOpen: true,
          accessMode: TrainingProjectAccessMode.ASSIGNED_USERS,
        },
      });
      projectIds.push(project.id);
      await access.bulkAssignments(project.id, admin.id, {
        action: 'ASSIGN',
        userIds: [participants[0].id],
      });
    }

    assert.equal(
      await prisma.trainingProjectAssignment.count({
        where: { userId: participants[0].id, projectId: { in: projectIds }, revokedAt: null },
      }),
      10,
    );
    const visible = await prisma.trainingProject.count({
      where: { id: { in: projectIds }, ...access.employeeProjectWhere(participants[0].id) },
    });
    assert.equal(visible, 10);
  });

  test('ten users start one project concurrently without cross-user answers', async () => {
    const project = await createOpenProject('Concurrent project');
    await access.bulkAssignments(project.id, admin.id, {
      action: 'ASSIGN',
      userIds: participants.map((user) => user.id),
    });

    const started = await Promise.all(
      participants.map((user) =>
        attempts.startAttempt(project.id, user.id, startInput()),
      ),
    );
    assert.equal(new Set(started.map((attempt) => attempt.id)).size, 10);
    assert.equal(
      await prisma.trainingAttempt.count({
        where: { projectId: project.id, status: TrainingAttemptStatus.IN_PROGRESS },
      }),
      10,
    );

    const doubleStart = await Promise.all([
      attempts.startAttempt(project.id, participants[0].id, startInput()),
      attempts.startAttempt(project.id, participants[0].id, startInput()),
    ]);
    assert.equal(doubleStart[0].id, doubleStart[1].id);

    for (let index = 1; index <= 3; index += 1) {
      const result = await state.addTelegramVoiceSegment(
        started[index].id,
        participants[index].id,
        {
          telegramMessageId: BigInt(10_000 + index),
          telegramFileId: `file-${index}`,
          telegramFileUniqueId: `unique-${index}`,
          durationSeconds: 3,
          sizeBytes: 128n,
        },
      );
      assert.equal(result.status, 'ADDED');
    }
    const segments = await prisma.trainingAnswerSegment.findMany({
      where: { telegramMessageId: { in: [10001n, 10002n, 10003n] } },
      include: { answer: { include: { attemptQuestion: { include: { attempt: true } } } } },
    });
    assert.deepEqual(
      new Set(segments.map((segment) => segment.answer.attemptQuestion.attempt.userId)),
      new Set(participants.slice(1, 4).map((user) => user.id)),
    );
  });

  test('revoke preserves an active attempt and history but blocks a later attempt', async () => {
    const user = await createUser('revoke-active', UserStatus.ACTIVE, ['training:participate']);
    const project = await createOpenProject('Revoke project');
    await access.bulkAssignments(project.id, admin.id, { action: 'ASSIGN', userIds: [user.id] });
    let attempt = await attempts.startAttempt(project.id, user.id, startInput());

    await access.bulkAssignments(project.id, admin.id, { action: 'REVOKE', userIds: [user.id] });
    const listed = await attempts.listEmployeeProjects(user.id);
    const listedProject = listed.items.find((item) => item.id === project.id);
    assert.equal(listedProject.activeAttempt.id, attempt.id);
    assert.equal(listedProject.newAttemptAccessRevoked, true);
    assert.equal((await attempts.startAttempt(project.id, user.id, startInput())).id, attempt.id);

    while (attempt.currentQuestion) {
      attempt = await attempts.submitAnswer(attempt.id, user.id, {
        attemptQuestionId: attempt.currentQuestion.id,
        text: '[fake:fail]',
      });
    }
    assert.equal(attempt.status, TrainingAttemptStatus.COMPLETED);
    await assert.rejects(
      attempts.startAttempt(project.id, user.id, startInput()),
      ForbiddenException,
    );
    assert.equal(
      (await attempts.listEmployeeProjects(user.id)).items.some((item) => item.id === project.id),
      false,
    );
    assert.equal((await attempts.listEmployeeAttempts(user.id)).items.length, 1);
  });

  test('a Telegram token created before revoke cannot select or start the project', async () => {
    const user = await createUser('token-revoke', UserStatus.ACTIVE, ['training:participate']);
    const project = await createOpenProject('Token revoke project');
    await access.bulkAssignments(project.id, admin.id, { action: 'ASSIGN', userIds: [user.id] });
    const link = await telegram.createProjectLink(user.id, project.id);
    const rawToken = new URL(link.url).searchParams.get('start');

    await access.bulkAssignments(project.id, admin.id, { action: 'REVOKE', userIds: [user.id] });
    await telegram.handleUpdate({
      update_id: 99001,
      message: {
        message_id: 99001,
        from: { id: 99001, username: 'token_revoke' },
        chat: { id: 99001, type: 'private' },
        text: `/start ${rawToken}`,
      },
    });
    const storedToken = await prisma.trainingTelegramLinkToken.findFirstOrThrow({
      where: { userId: user.id, projectId: project.id },
    });
    assert.equal(storedToken.usedAt, null);
    assert.equal(
      await prisma.trainingAttempt.count({ where: { userId: user.id, projectId: project.id } }),
      0,
    );
  });

  test('an assigned active attempt recovers through the linked Telegram account after revoke', async () => {
    const user = await createUser('telegram-recovery', UserStatus.ACTIVE, ['training:participate']);
    const project = await createOpenProject('Telegram recovery project');
    await access.bulkAssignments(project.id, admin.id, { action: 'ASSIGN', userIds: [user.id] });
    const telegramId = 99_101;
    const link = await telegram.createProjectLink(user.id, project.id);
    const rawToken = new URL(link.url).searchParams.get('start');
    await telegram.handleUpdate(startUpdate(telegramId, rawToken));
    const token = await prisma.trainingTelegramLinkToken.findFirstOrThrow({
      where: { userId: user.id, projectId: project.id, usedAt: { not: null } },
    });
    await telegram.handleUpdate(callbackUpdate(telegramId, `tr:start:${token.id}`, 'recovery-start'));
    const attempt = await prisma.trainingAttempt.findFirstOrThrow({
      where: { userId: user.id, projectId: project.id },
      include: { questions: true },
    });

    await access.bulkAssignments(project.id, admin.id, { action: 'REVOKE', userIds: [user.id] });
    await assert.rejects(telegram.createProjectLink(user.id, project.id), ForbiddenException);

    const beforeRecovery = telegramClient.sentMessages.length;
    await telegram.handleUpdate(plainStartUpdate(telegramId));
    assert.ok(telegramClient.sentMessages.length > beforeRecovery);
    assert.equal(
      telegramClient.sentMessages.some((message) =>
        message.text.includes(attempt.questions.find((question) => question.sequence === 1).questionTextSnapshot),
      ),
      true,
    );

    await telegram.handleUpdate(callbackUpdate(telegramId, `tr:start:${token.id}`, 'recovery-replay'));
    assert.equal(
      await prisma.trainingAttempt.count({ where: { userId: user.id, projectId: project.id } }),
      1,
    );

    await prisma.user.update({ where: { id: user.id }, data: { status: UserStatus.BLOCKED } });
    await telegram.handleUpdate(callbackUpdate(telegramId, `tr:start:${token.id}`, 'recovery-blocked'));
    assert.equal(
      telegramClient.sentMessages.at(-1).text,
      'Действие недоступно. Отправьте /start, чтобы восстановить текущее состояние.',
    );
  });

  test('one bot keeps three linked Telegram voice attempts and results isolated', async () => {
    const users = participants.slice(4, 7);
    const telegramIds = [99_201, 99_202, 99_203];
    const project = await createOpenProject('Three Telegram accounts');
    const extraProjects = await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        prisma.trainingProject.create({
          data: {
            title: `Connected matrix project ${index + 2}`,
            status: 'PUBLISHED',
            isOpen: true,
            allowRetakeAfterPass: true,
            accessMode: TrainingProjectAccessMode.ASSIGNED_USERS,
          },
        }),
      ),
    );
    const connectedProjectIds = [project.id, ...extraProjects.map((item) => item.id)];
    const assignmentsByUser = [
      connectedProjectIds.slice(0, 5),
      [connectedProjectIds[0], ...connectedProjectIds.slice(3, 7)],
      [connectedProjectIds[0], ...connectedProjectIds.slice(6, 10)],
    ];
    for (const projectId of connectedProjectIds) {
      const assignedUserIds = users
        .filter((_, userIndex) => assignmentsByUser[userIndex].includes(projectId))
        .map((user) => user.id);
      await access.bulkAssignments(projectId, admin.id, {
        action: 'ASSIGN',
        userIds: assignedUserIds,
      });
    }
    for (const [userIndex, user] of users.entries()) {
      const visible = await attempts.listEmployeeProjects(user.id);
      assert.deepEqual(
        new Set(
          visible.items
            .filter((item) => connectedProjectIds.includes(item.id))
            .map((item) => item.id),
        ),
        new Set(assignmentsByUser[userIndex]),
      );
    }
    const links = await Promise.all(
      users.map((user) => telegram.createProjectLink(user.id, project.id)),
    );
    await Promise.all(
      links.map((link, index) =>
        telegram.handleUpdate(
          startUpdate(telegramIds[index], new URL(link.url).searchParams.get('start')),
        ),
      ),
    );
    const tokens = await prisma.trainingTelegramLinkToken.findMany({
      where: { projectId: project.id, userId: { in: users.map((user) => user.id) } },
    });
    assert.equal(tokens.length, 3);
    assert.equal(
      await prisma.trainingTelegramAccount.count({
        where: { userId: { in: users.map((user) => user.id) }, revokedAt: null },
      }),
      3,
    );

    await Promise.all(
      users.map((user, index) => {
        const token = tokens.find((candidate) => candidate.userId === user.id);
        return telegram.handleUpdate(
          callbackUpdate(telegramIds[index], `tr:start:${token.id}`, `three-start-${index}`),
        );
      }),
    );
    const started = await prisma.trainingAttempt.findMany({
      where: { projectId: project.id, userId: { in: users.map((user) => user.id) } },
    });
    assert.equal(new Set(started.map((attempt) => attempt.id)).size, 3);
    const attemptsInUserOrder = users.map((user) =>
      started.find((attempt) => attempt.userId === user.id),
    );
    const worker = new TrainingVoiceWorkerService(
      prisma,
      new ImmediateWorkerAudio(prisma),
      { transcribe: async () => fakeTranscription() },
      new DeterministicFakeTrainingEvaluator(),
      state,
      telegramOutbox,
    );

    for (let sequence = 1; sequence <= 4; sequence += 1) {
      const questions = await Promise.all(
        attemptsInUserOrder.map((attempt) =>
          prisma.trainingAttemptQuestion.findFirstOrThrow({
            where: { attemptId: attempt.id, status: 'PRESENTED' },
          }),
        ),
      );
      await Promise.all(
        telegramIds.map((telegramId, index) =>
          telegram.handleUpdate(
            voiceUpdate(
              telegramId,
              200_000 + sequence * 10 + index,
              `three-file-${sequence}-${index}`,
              `three-unique-${sequence}-${index}`,
            ),
          ),
        ),
      );
      await Promise.all(
        telegramIds.map((telegramId, index) =>
          telegram.handleUpdate(
            callbackUpdate(
              telegramId,
              `tr:finish:${questions[index].id}`,
              `three-finish-${sequence}-${index}`,
            ),
          ),
        ),
      );
      assert.equal(await worker.runOnce(), true);
      assert.equal(await worker.runOnce(), true);
      assert.equal(await worker.runOnce(), true);
      if (sequence === 1) {
        await access.bulkAssignments(project.id, admin.id, {
          action: 'REVOKE',
          userIds: [users[0].id],
        });
        const activeRecovery = await attempts.listEmployeeProjects(users[0].id);
        assert.equal(
          activeRecovery.items.find((item) => item.id === project.id).newAttemptAccessRevoked,
          true,
        );
      }
    }

    const completed = await prisma.trainingAttempt.findMany({
      where: { id: { in: started.map((attempt) => attempt.id) } },
      include: { questions: { include: { answer: { include: { segments: true } } } } },
    });
    assert.equal(completed.every((attempt) => attempt.status === TrainingAttemptStatus.COMPLETED), true);
    assert.equal(completed.every((attempt) => attempt.isPassed === true), true);
    assert.equal(completed.every((attempt) => attempt.questions.length === 4), true);
    assert.equal(
      completed.every((attempt) =>
        attempt.questions.every((question) => question.answer?.segments.length === 1),
      ),
      true,
    );
    for (const user of users) {
      const history = await attempts.listEmployeeAttempts(user.id);
      const ownProjectAttempts = history.items.filter((item) => item.projectId === project.id);
      assert.equal(ownProjectAttempts.length, 1);
      assert.equal(
        started.some(
          (attempt) => attempt.userId === user.id && attempt.id === ownProjectAttempts[0].id,
        ),
        true,
      );
    }
    assert.equal(
      telegramClient.sentMessages.filter(
        (message) => message.text === 'Аттестация по проекту Three Telegram accounts пройдена',
      ).length >= 3,
      true,
    );
    await assert.rejects(
      attempts.startAttempt(project.id, users[0].id, startInput()),
      ForbiddenException,
    );
    await access.assertNewAttemptAccess(project.id, users[1].id);
  });

  test('Telegram result notifications use snapshot title, remaining attempts and cooldown', async () => {
    const user = await createUser('result-message', UserStatus.ACTIVE, ['training:participate']);
    const project = await createOpenProject('Result message project');
    const telegramId = 99_401n;
    await access.bulkAssignments(project.id, admin.id, { action: 'ASSIGN', userIds: [user.id] });
    await prisma.trainingTelegramAccount.create({
      data: {
        userId: user.id,
        telegramUserId: telegramId,
        chatId: telegramId,
        username: 'result_message',
      },
    });

    const passed = await answerAll(
      await attempts.startAttempt(project.id, user.id, startInput()),
      user.id,
      '[fake:pass]',
    );
    await telegram.notifyAttemptState(passed.id);
    assert.equal(
      telegramClient.sentMessages.at(-1).text,
      'Аттестация по проекту Result message project пройдена',
    );

    const failed = await answerAll(
      await attempts.startAttempt(project.id, user.id, startInput()),
      user.id,
      '[fake:fail]',
    );
    await telegram.notifyAttemptState(failed.id);
    assert.equal(
      telegramClient.sentMessages.at(-1).text,
      'Аттестация по проекту Result message project не пройдена, осталось попыток 1. Повторное прохождение доступно через 60 минут',
    );
    await assert.rejects(
      attempts.startAttempt(project.id, user.id, startInput()),
    );

    await prisma.trainingAttempt.update({
      where: { id: failed.id },
      data: { completedAt: new Date(Date.now() - 61 * 60 * 1000) },
    });
    await prisma.trainingAttempt.update({
      where: { id: passed.id },
      data: { completedAt: new Date(Date.now() - 62 * 60 * 1000) },
    });
    const finalFailure = await answerAll(
      await attempts.startAttempt(project.id, user.id, startInput()),
      user.id,
      '[fake:fail]',
    );
    await telegram.notifyAttemptState(finalFailure.id);
    assert.equal(
      telegramClient.sentMessages.at(-1).text,
      'Аттестация по проекту Result message project не пройдена, осталось попыток 0',
    );
  });

  test('manual pass and fail send one final Telegram result after review', async () => {
    const user = await createUser('manual-result', UserStatus.ACTIVE, ['training:participate']);
    const project = await createOpenProject('Manual result project');
    const telegramId = 99_402n;
    await access.bulkAssignments(project.id, admin.id, { action: 'ASSIGN', userIds: [user.id] });
    await prisma.trainingTelegramAccount.create({
      data: {
        userId: user.id,
        telegramUserId: telegramId,
        chatId: telegramId,
        username: 'manual_result',
      },
    });

    const passPending = await answerAll(
      await attempts.startAttempt(project.id, user.id, startInput()),
      user.id,
      '[fake:review]',
    );
    const passInput = {
      decision: 'OVERRIDE',
      finalScore: 90,
      comment: 'Ручная успешная оценка',
    };
    await reviews.reviewAttempt(passPending.id, admin.id, passInput);
    const passMessage = 'Аттестация по проекту Manual result project пройдена';
    await waitForTelegramMessage(passMessage);
    assert.equal(
      telegramClient.sentMessages.filter((message) => message.text === passMessage).length,
      1,
    );

    await reviews.reviewAttempt(passPending.id, admin.id, passInput);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(
      telegramClient.sentMessages.filter((message) => message.text === passMessage).length,
      1,
    );
    assert.equal(
      await prisma.trainingTelegramOutbox.count({
        where: { attemptId: passPending.id, eventType: 'ATTEMPT_STATE' },
      }),
      1,
    );
    const messagesBeforeStaleWorker = telegramClient.sentMessages.length;
    await telegram.notifyAttemptState(
      passPending.id,
      TrainingAttemptStatus.REQUIRES_REVIEW,
    );
    assert.equal(telegramClient.sentMessages.length, messagesBeforeStaleWorker);

    const failPending = await answerAll(
      await attempts.startAttempt(project.id, user.id, startInput()),
      user.id,
      '[fake:review]',
    );
    await reviews.reviewAttempt(failPending.id, admin.id, {
      decision: 'OVERRIDE',
      finalScore: 42,
      comment: 'Ручная неуспешная оценка',
    });
    await waitForTelegramMessage(
      'Аттестация по проекту Manual result project не пройдена, осталось попыток 1. Повторное прохождение доступно через 60 минут',
    );
  });

  test('concurrent revoke and start has one consistent commit order', async () => {
    for (let index = 0; index < 5; index += 1) {
      const user = await createUser(`race-${index}`, UserStatus.ACTIVE, ['training:participate']);
      const project = await createOpenProject(`Race project ${index}`);
      await access.bulkAssignments(project.id, admin.id, {
        action: 'ASSIGN',
        userIds: [user.id],
      });

      const [startResult, revokeResult] = await Promise.allSettled([
        attempts.startAttempt(project.id, user.id, startInput()),
        access.bulkAssignments(project.id, admin.id, {
          action: 'REVOKE',
          userIds: [user.id],
        }),
      ]);
      assert.equal(revokeResult.status, 'fulfilled');
      const storedAttempts = await prisma.trainingAttempt.findMany({
        where: { projectId: project.id, userId: user.id },
      });
      if (startResult.status === 'fulfilled') {
        assert.equal(storedAttempts.length, 1);
        assert.equal(storedAttempts[0].status, TrainingAttemptStatus.IN_PROGRESS);
        assert.equal(
          (await attempts.startAttempt(project.id, user.id, startInput())).id,
          storedAttempts[0].id,
        );
      } else {
        assert.ok(startResult.reason instanceof ForbiddenException);
        assert.equal(storedAttempts.length, 0);
      }
    }
  });

  test('permission and current user state remain mandatory independently of assignments', async () => {
    const project = await createOpenProject('Permission project');
    const noPermission = await createUser('no-permission', UserStatus.ACTIVE, []);
    const inactive = await createUser('inactive', UserStatus.BLOCKED, ['training:participate']);
    const deleted = await createUser('deleted', UserStatus.ACTIVE, ['training:participate']);
    await prisma.user.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });
    await access.bulkAssignments(project.id, admin.id, {
      action: 'ASSIGN',
      userIds: [noPermission.id, inactive.id].filter((id) => id === noPermission.id),
    });
    await assert.rejects(
      attempts.startAttempt(project.id, noPermission.id, startInput()),
      ForbiddenException,
    );
    await assert.rejects(access.assertParticipant(inactive.id), ForbiddenException);
    await assert.rejects(access.assertParticipant(deleted.id), ForbiddenException);
  });

  async function createOpenProject(title) {
    const created = await projects.createProject({
      title,
      description: null,
      realEstateObjectId: null,
      sortOrder: 0,
      attemptLimit: 3,
      timeLimitSeconds: 420,
      passScore: 75,
      allowRetakeAfterPass: true,
      accessMode: TrainingProjectAccessMode.ASSIGNED_USERS,
    });
    await projects.updateDraft(created.id, {
      title,
      description: null,
      realEstateObjectId: null,
      sortOrder: 0,
      attemptLimit: 3,
      timeLimitSeconds: 420,
      passScore: 75,
      allowRetakeAfterPass: true,
      accessMode: TrainingProjectAccessMode.ASSIGNED_USERS,
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
    await projects.publishProject(created.id);
    return projects.setAvailability(created.id, true);
  }

  async function createUser(label, status, permissions) {
    const role = await prisma.role.create({
      data: {
        name: `training-stage45-${label}-${randomUUID().slice(0, 8)}`,
        description: 'Stage 4.5 temporary test role',
      },
    });
    for (const key of permissions) {
      const permission = await prisma.permission.upsert({
        where: { key },
        update: {},
        create: { key, description: key },
      });
      await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    }
    return prisma.user.create({
      data: {
        email: `${label}-${randomUUID()}@training-stage45.test`,
        passwordHash: 'test-hash',
        name: label,
        status,
        roleId: role.id,
      },
    });
  }

  function startInput() {
    return { confirmed: true, idempotencyKey: randomUUID() };
  }

  async function answerAll(initial, userId, text) {
    let attempt = initial;
    while (attempt.currentQuestion) {
      attempt = await attempts.submitAnswer(attempt.id, userId, {
        attemptQuestionId: attempt.currentQuestion.id,
        text,
      });
    }
    return attempt;
  }

  async function waitForTelegramMessage(text) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (telegramClient.sentMessages.some((message) => message.text === text)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`Telegram message was not sent: ${text}`);
  }

  function startUpdate(telegramId, rawToken) {
    return {
      update_id: telegramId,
      message: {
        message_id: telegramId,
        from: { id: telegramId, username: `stage45_${telegramId}` },
        chat: { id: telegramId, type: 'private' },
        text: `/start ${rawToken}`,
      },
    };
  }

  function plainStartUpdate(telegramId) {
    return {
      update_id: telegramId + 1_000_000,
      message: {
        message_id: telegramId + 1_000_000,
        from: { id: telegramId, username: `stage45_${telegramId}` },
        chat: { id: telegramId, type: 'private' },
        text: '/start',
      },
    };
  }

  function callbackUpdate(telegramId, data, callbackId) {
    return {
      update_id: telegramId + 2_000_000,
      callback_query: {
        id: callbackId,
        from: { id: telegramId, username: `stage45_${telegramId}` },
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
        from: { id: telegramId, username: `stage45_${telegramId}` },
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

  class ImmediateWorkerAudio {
    constructor(database) {
      this.database = database;
    }

    async prepareAnswerAudio(answerId) {
      const file = await this.database.file.create({
        data: {
          storage: 'MINIO',
          bucket: 'platforma-training-audio-test',
          key: `training-v2/stage45/${answerId}/merged.wav`,
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
      return {
        answerId,
        fileId: file.id,
        mimeType: 'audio/wav',
        sizeBytes: 64,
        checksum: 'stage45',
        wav,
        vocabularyPrompt: '',
      };
    }
  }
}

function fakeTranscription() {
  return {
    text: '[fake:pass]',
    model: 'fake',
    requestId: null,
    latencyMs: 0,
    attempts: 1,
    usage: null,
  };
}
