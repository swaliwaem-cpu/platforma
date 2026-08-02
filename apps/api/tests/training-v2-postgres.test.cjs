require('reflect-metadata');

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, beforeEach, test } = require('node:test');
const {
  PrismaClient,
  TrainingAttemptQuestionStatus,
  TrainingAttemptStatus,
  UserStatus,
} = require('@prisma/client');
const { ConflictException, NotFoundException } = require('@nestjs/common');

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

const databaseUrl = process.env.TRAINING_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('Training PostgreSQL scenarios require the targeted temporary database runner', () => {
    assert.equal(process.env.TRAINING_TEST_DATABASE_URL, undefined);
  });
} else {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const evaluator = new DeterministicFakeTrainingEvaluator();
  const deterministicSelector = {
    select: (candidates) => candidates.slice(0, 3),
  };
  const stateService = new TrainingAttemptStateService(
    prisma,
    evaluator,
    deterministicSelector,
  );
  const attemptService = new TrainingAttemptService(prisma, stateService);
  const projectService = new TrainingProjectService(prisma);

  before(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    await prisma.trainingAnswerSegment.deleteMany();
    await prisma.trainingAnswer.deleteMany();
    await prisma.trainingAttemptQuestion.deleteMany();
    await prisma.trainingAttempt.deleteMany();
    await prisma.trainingTelegramLinkToken.deleteMany();
    await prisma.trainingTelegramAccount.deleteMany();
    await prisma.trainingFact.deleteMany();
    await prisma.trainingCriterion.deleteMany();
    await prisma.trainingQuestion.deleteMany();
    await prisma.trainingProject.deleteMany();
    await prisma.user.deleteMany({ where: { email: { endsWith: '@training.test' } } });
    await prisma.role.deleteMany({ where: { name: { startsWith: 'training-test-' } } });
  });

  after(async () => {
    await prisma.$disconnect();
  });

  test('create, publish and concurrent double start create one active attempt', async () => {
    const user = await createUser('concurrent');
    const project = await createOpenProject({ attemptLimit: 3 });
    const [first, second] = await Promise.all([
      attemptService.startAttempt(project.id, user.id, startInput()),
      attemptService.startAttempt(project.id, user.id, startInput()),
    ]);
    const stored = await prisma.trainingAttempt.findMany({
      where: { projectId: project.id, userId: user.id },
    });

    assert.equal(first.id, second.id);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].attemptNumber, 1);
    assert.equal(stored[0].status, TrainingAttemptStatus.IN_PROGRESS);

    await answerAll(first, user.id, '[fake:fail]');
    const replay = await attemptService.startAttempt(project.id, user.id, {
      confirmed: true,
      idempotencyKey: stored[0].startIdempotencyKey,
    });
    assert.equal(replay.id, first.id);
    assert.equal(await prisma.trainingAttempt.count({ where: { userId: user.id, projectId: project.id } }), 1);
  });

  test('attempt limit and retake policy are enforced after confirmed results', async () => {
    const user = await createUser('retake');
    const noRetakeProject = await createOpenProject({
      attemptLimit: 3,
      allowRetakeAfterPass: false,
    });
    const passed = await answerAll(
      await attemptService.startAttempt(noRetakeProject.id, user.id, startInput()),
      user.id,
      '[fake:pass]',
    );

    assert.equal(passed.status, TrainingAttemptStatus.COMPLETED);
    assert.equal(passed.result.isPassed, true);
    await assert.rejects(
      () => attemptService.startAttempt(noRetakeProject.id, user.id, startInput()),
      ConflictException,
    );

    const limitedProject = await createOpenProject({ attemptLimit: 1 });
    await answerAll(
      await attemptService.startAttempt(limitedProject.id, user.id, startInput()),
      user.id,
      '[fake:fail]',
    );
    await assert.rejects(
      () => attemptService.startAttempt(limitedProject.id, user.id, startInput()),
      ConflictException,
    );
  });

  test('reload preserves the attempt and selection uses the immutable 1+10 snapshot', async () => {
    const user = await createUser('snapshot');
    const project = await createOpenProject({ title: 'Исходный проект' });
    const started = await attemptService.startAttempt(project.id, user.id, startInput());
    const reloaded = await attemptService.getEmployeeAttempt(started.id, user.id);

    assert.equal(reloaded.id, started.id);
    assert.equal(reloaded.expiresAt, started.expiresAt);

    await projectService.setAvailability(project.id, false);
    await projectService.updateDraft(project.id, draftInput({
      title: 'Изменённый проект',
      mainQuestion: 'Новый главный вопрос',
      followUpQuestions: Array.from({ length: 10 }, (_, index) => `Новый follow-up ${index + 1}`),
    }));
    const afterMain = await attemptService.submitAnswer(started.id, user.id, {
      attemptQuestionId: started.currentQuestion.id,
      text: '[fake:pass]',
    });
    const adminAttempt = await attemptService.getAdminAttempt(started.id);

    assert.equal(afterMain.currentQuestion.text, 'Исходный follow-up 1');
    assert.equal(adminAttempt.project.title, 'Исходный проект');
    assert.equal(adminAttempt.questions.length, 4);
    assert.equal(new Set(adminAttempt.questions.map((question) => question.sourceQuestionId)).size, 4);
    assert.equal(
      adminAttempt.questions.slice(1).every((question) => question.text.startsWith('Исходный')),
      true,
    );
    const completed = await answerAll(afterMain, user.id, '[fake:pass]');
    assert.equal(completed.status, TrainingAttemptStatus.COMPLETED);
    await assert.rejects(
      () => attemptService.startAttempt(project.id, user.id, startInput()),
      ConflictException,
    );
  });

  test('duplicate and foreign answers are rejected without leaking another attempt', async () => {
    const owner = await createUser('owner');
    const stranger = await createUser('stranger');
    const project = await createOpenProject();
    const started = await attemptService.startAttempt(project.id, owner.id, startInput());

    await assert.rejects(
      () => attemptService.getEmployeeAttempt(started.id, stranger.id),
      NotFoundException,
    );
    await assert.rejects(
      () =>
        attemptService.submitAnswer(started.id, stranger.id, {
          attemptQuestionId: started.currentQuestion.id,
          text: '[fake:pass]',
        }),
      NotFoundException,
    );

    await attemptService.submitAnswer(started.id, owner.id, {
      attemptQuestionId: started.currentQuestion.id,
      text: '[fake:pass]',
    });
    await assert.rejects(
      () =>
        attemptService.submitAnswer(started.id, owner.id, {
          attemptQuestionId: started.currentQuestion.id,
          text: '[fake:pass]',
        }),
      NotFoundException,
    );
    assert.equal(await prisma.trainingAnswer.count({ where: { attemptQuestionId: started.currentQuestion.id } }), 1);
  });

  test('lazy timeout scores unanswered as zero and never passes an incomplete attempt', async () => {
    const user = await createUser('timeout');
    const project = await createOpenProject({ passScore: 50 });
    const beforeMain = await attemptService.startAttempt(project.id, user.id, startInput());

    await expireAttempt(beforeMain.id);
    const timedOutEmpty = await attemptService.getEmployeeAttempt(beforeMain.id, user.id);
    assert.equal(timedOutEmpty.status, TrainingAttemptStatus.TIMED_OUT);
    assert.equal(timedOutEmpty.result.finalScore, 0);
    assert.equal(timedOutEmpty.result.isPassed, false);

    const second = await attemptService.startAttempt(project.id, user.id, startInput());
    const afterMain = await attemptService.submitAnswer(second.id, user.id, {
      attemptQuestionId: second.currentQuestion.id,
      text: '[fake:pass]',
    });
    await expireAttempt(second.id);
    const timedOutPartial = await attemptService.getEmployeeAttempt(second.id, user.id);
    const storedQuestions = await prisma.trainingAttemptQuestion.findMany({
      where: { attemptId: second.id },
    });

    assert.equal(timedOutPartial.result.finalScore, 55);
    assert.equal(timedOutPartial.result.isPassed, false);
    assert.equal(
      storedQuestions.filter((question) => question.status === TrainingAttemptQuestionStatus.SKIPPED_TIMEOUT).length,
      3,
    );
    assert.equal(afterMain.currentQuestion.sequence, 2);

    const expiredSubmit = await attemptService.startAttempt(project.id, user.id, startInput());
    await expireAttempt(expiredSubmit.id);
    await assert.rejects(
      () => attemptService.submitAnswer(expiredSubmit.id, user.id, {
        attemptQuestionId: expiredSubmit.currentQuestion.id,
        text: '[fake:pass]',
      }),
      ConflictException,
    );
    const storedExpiredSubmit = await prisma.trainingAttempt.findUniqueOrThrow({
      where: { id: expiredSubmit.id },
    });
    assert.equal(storedExpiredSubmit.status, TrainingAttemptStatus.TIMED_OUT);
    assert.equal(storedExpiredSubmit.completionReason, 'TIMEOUT');
    assert.equal(storedExpiredSubmit.finalScore, 0);
    assert.equal(storedExpiredSubmit.isPassed, false);
  });

  test('start does not overwrite an attempt completed while waiting for its row lock', async () => {
    const user = await createUser('race');
    const project = await createOpenProject({ attemptLimit: 3, allowRetakeAfterPass: true });
    const started = await attemptService.startAttempt(project.id, user.id, startInput());
    await expireAttempt(started.id);

    let releaseAttemptLock;
    let reportAttemptLock;
    const attemptLockHeld = new Promise((resolve) => { reportAttemptLock = resolve; });
    const releaseAttempt = new Promise((resolve) => { releaseAttemptLock = resolve; });
    const concurrentCompletion = prisma.$transaction(async (transaction) => {
      await transaction.$queryRawUnsafe(
        'SELECT id FROM training_attempts WHERE id = $1::uuid FOR UPDATE',
        started.id,
      );
      reportAttemptLock();
      await releaseAttempt;
      await transaction.trainingAttempt.update({
        where: { id: started.id },
        data: {
          status: TrainingAttemptStatus.COMPLETED,
          completionReason: 'COMPLETED',
          completedAt: new Date(),
          calculatedScore: 100,
          finalScore: 100,
          isPassed: true,
        },
      });
    });

    await attemptLockHeld;
    let startSettled = false;
    const concurrentStart = attemptService.startAttempt(project.id, user.id, startInput());
    void concurrentStart.then(
      () => { startSettled = true; },
      () => { startSettled = true; },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(startSettled, false);
    releaseAttemptLock();
    await concurrentCompletion;
    const nextAttempt = await concurrentStart;
    const completed = await prisma.trainingAttempt.findUniqueOrThrow({
      where: { id: started.id },
    });

    assert.equal(completed.status, TrainingAttemptStatus.COMPLETED);
    assert.equal(completed.isPassed, true);
    assert.notEqual(nextAttempt.id, started.id);
    assert.equal(nextAttempt.attemptNumber, 2);
  });

  test('separate attempts keep best confirmed result apart from pending review', async () => {
    const user = await createUser('history');
    const project = await createOpenProject({ attemptLimit: 3, allowRetakeAfterPass: true });
    const failed = await answerAll(
      await attemptService.startAttempt(project.id, user.id, startInput()),
      user.id,
      '[fake:fail]',
    );
    const passed = await answerAll(
      await attemptService.startAttempt(project.id, user.id, startInput()),
      user.id,
      '[fake:pass]',
    );
    const review = await answerAll(
      await attemptService.startAttempt(project.id, user.id, startInput()),
      user.id,
      '[fake:review]',
    );
    const projectList = await attemptService.listEmployeeProjects(user.id);
    const summary = projectList.items.find((item) => item.id === project.id);

    assert.notEqual(failed.id, passed.id);
    assert.notEqual(passed.id, review.id);
    assert.deepEqual([failed.attemptNumber, passed.attemptNumber, review.attemptNumber], [1, 2, 3]);
    assert.equal(review.status, TrainingAttemptStatus.REQUIRES_REVIEW);
    assert.equal(summary.bestConfirmedScore, 100);
    assert.equal(summary.bestConfirmedStatus, 'PASSED');
    assert.equal(summary.hasPendingReview, true);
    assert.equal(summary.status, 'PASSED');
  });

  async function createUser(label) {
    const role = await prisma.role.create({
      data: {
        name: `training-test-${label}-${randomUUID()}`,
        description: 'Training integration test role',
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

  async function createOpenProject(overrides = {}) {
    const created = await projectService.createProject({
      title: overrides.title ?? 'Исходный проект',
      description: null,
      realEstateObjectId: null,
      sortOrder: 0,
      attemptLimit: overrides.attemptLimit ?? 3,
      timeLimitSeconds: 420,
      passScore: overrides.passScore ?? 75,
      allowRetakeAfterPass: overrides.allowRetakeAfterPass ?? true,
    });
    await projectService.updateDraft(created.id, draftInput(overrides));
    await projectService.publishProject(created.id);

    return projectService.setAvailability(created.id, true);
  }

  function draftInput(overrides = {}) {
    return {
      title: overrides.title ?? 'Исходный проект',
      description: null,
      realEstateObjectId: null,
      sortOrder: 0,
      attemptLimit: overrides.attemptLimit ?? 3,
      timeLimitSeconds: 420,
      passScore: overrides.passScore ?? 75,
      allowRetakeAfterPass: overrides.allowRetakeAfterPass ?? true,
      mainQuestion: overrides.mainQuestion ?? 'Исходный главный вопрос',
      followUpQuestions:
        overrides.followUpQuestions ??
        Array.from({ length: 10 }, (_, index) => `Исходный follow-up ${index + 1}`),
      facts: Array.from({ length: 11 }, (_, index) => ({
        id: null,
        questionType: index === 0 ? 'MAIN' : 'FOLLOW_UP',
        questionPosition: index === 0 ? 1 : index,
        statement: `Утверждённый факт ${index + 1}`,
        aliases: [`Термин ${index + 1}`],
        isRequired: true,
        position: 1,
      })),
      criteria: [
        { id: null, questionType: 'MAIN', code: 'main', title: 'Main', guidance: '', maxPoints: 55, position: 1 },
        { id: null, questionType: 'FOLLOW_UP', code: 'follow_up', title: 'Follow-up', guidance: '', maxPoints: 15, position: 1 },
      ],
    };
  }

  function startInput() {
    return { confirmed: true, idempotencyKey: randomUUID() };
  }

  async function answerAll(initialAttempt, userId, text) {
    let attempt = initialAttempt;

    while (attempt.currentQuestion) {
      attempt = await attemptService.submitAnswer(attempt.id, userId, {
        attemptQuestionId: attempt.currentQuestion.id,
        text,
      });
    }

    return attempt;
  }

  async function expireAttempt(attemptId) {
    await prisma.$executeRawUnsafe(
      `UPDATE training_attempts SET started_at = CURRENT_TIMESTAMP - INTERVAL '2 minutes', expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE id = $1::uuid`,
      attemptId,
    );
  }
}
