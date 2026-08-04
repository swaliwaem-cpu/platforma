require('reflect-metadata');

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const { PrismaClient, TrainingProjectAccessMode, UserStatus } = require('@prisma/client');

const { TrainingAttemptStateService } = require('../dist/training/training-attempt-state.service.js');
const { TrainingAttemptService } = require('../dist/training/training-attempt.service.js');
const { DeterministicFakeTrainingEvaluator } = require('../dist/training/training-evaluator.js');
const { TrainingProjectAccessService } = require('../dist/training/training-project-access.service.js');
const { TrainingProjectService } = require('../dist/training/training-project.service.js');
const { TrainingResultsService } = require('../dist/training/training-results.service.js');
const { TrainingReviewService } = require('../dist/training/training-review.service.js');
const { parseTrainingAdminResultsQuery } = require('../dist/training/training.validation.js');

const databaseUrl = process.env.TRAINING_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('Training Stage 5 Part 1 PostgreSQL scenarios require the targeted temporary database runner', () => {
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
  const results = new TrainingResultsService(prisma, state);
  const reviews = new TrainingReviewService(prisma, {
    dispatchAttemptStateNotification: () => undefined,
  });
  let admin;
  let employee;

  before(async () => {
    await prisma.$connect();
    admin = await createUser('admin', ['training:participate', 'training:results:read']);
    employee = await createUser('employee', ['training:participate']);
  });

  after(async () => prisma.$disconnect());

  test('Stage 5 Part 1 reconciles employee history and paginated admin results from PostgreSQL', async () => {
    const project = await createOpenProject('Stage 5 results');
    await access.bulkAssignments(project.id, admin.id, { action: 'ASSIGN', userIds: [employee.id] });
    let attempt = await attempts.startAttempt(project.id, employee.id, {
      confirmed: true,
      idempotencyKey: randomUUID(),
    });

    while (attempt.currentQuestion) {
      attempt = await attempts.submitAnswer(attempt.id, employee.id, {
        attemptQuestionId: attempt.currentQuestion.id,
        text: '[fake:pass]',
      });
    }

    const passedAttemptId = attempt.id;
    let failedAttempt = await attempts.startAttempt(project.id, employee.id, {
      confirmed: true,
      idempotencyKey: randomUUID(),
    });
    while (failedAttempt.currentQuestion) {
      failedAttempt = await attempts.submitAnswer(failedAttempt.id, employee.id, {
        attemptQuestionId: failedAttempt.currentQuestion.id,
        text: '[fake:fail]',
      });
    }

    let employeeHistory = await attempts.listEmployeeAttempts(employee.id);
    const passedHistory = employeeHistory.items.find((item) => item.id === passedAttemptId);
    assert.equal(employeeHistory.items.length, 2);
    assert.equal(passedHistory.projectTitle, 'Stage 5 results');
    assert.equal(passedHistory.finalScore, 100);
    assert.equal(passedHistory.isPassed, true);
    assert.equal(passedHistory.safeBreakdown.length, 4);
    assert.ok(passedHistory.durationSeconds >= 0);
    const projectSummary = (await attempts.listEmployeeProjects(employee.id)).items
      .find((item) => item.id === project.id);
    assert.equal(projectSummary.bestConfirmedScore, 100);
    assert.equal(projectSummary.lastConfirmedScore, 0);

    await assert.rejects(
      attempts.startAttempt(project.id, employee.id, {
        confirmed: true,
        idempotencyKey: randomUUID(),
      }),
    );
    await prisma.trainingAttempt.update({
      where: { id: failedAttempt.id },
      data: { completedAt: new Date(Date.now() - 61 * 60 * 1000) },
    });
    await prisma.trainingAttempt.update({
      where: { id: passedAttemptId },
      data: { completedAt: new Date(Date.now() - 62 * 60 * 1000) },
    });

    await prisma.trainingProject.update({ where: { id: project.id }, data: { title: 'Live title changed' } });
    employeeHistory = await attempts.listEmployeeAttempts(employee.id);
    assert.equal(
      employeeHistory.items.find((item) => item.id === passedAttemptId).projectTitle,
      'Stage 5 results',
    );

    const activeAttempt = await attempts.startAttempt(project.id, employee.id, {
      confirmed: true,
      idempotencyKey: randomUUID(),
    });
    await access.bulkAssignments(project.id, admin.id, { action: 'REVOKE', userIds: [employee.id] });
    const revokedProjects = await attempts.listEmployeeProjects(employee.id);
    assert.equal(
      revokedProjects.items.find((item) => item.id === project.id).activeAttempt.id,
      activeAttempt.id,
    );
    const timeoutStartedAt = new Date(new Date(failedAttempt.startedAt).getTime() + 60 * 1000);
    await prisma.trainingAttempt.update({
      where: { id: activeAttempt.id },
      data: {
        status: 'TIMED_OUT',
        completionReason: 'TIMEOUT',
        startedAt: timeoutStartedAt,
        expiresAt: new Date(timeoutStartedAt.getTime() + 7 * 60 * 1000),
        completedAt: new Date(timeoutStartedAt.getTime() + 60 * 60 * 1000),
        calculatedScore: 10,
        finalScore: 10,
        isPassed: false,
      },
    });
    const timeoutHistory = (await attempts.listEmployeeAttempts(employee.id)).items
      .find((item) => item.id === activeAttempt.id);
    assert.equal(timeoutHistory.durationSeconds, 420);
    await access.bulkAssignments(project.id, admin.id, { action: 'ASSIGN', userIds: [employee.id] });
    const projectAfterTimeout = (await attempts.listEmployeeProjects(employee.id)).items
      .find((item) => item.id === project.id);
    assert.equal(projectAfterTimeout.bestConfirmedScore, 100);
    assert.equal(projectAfterTimeout.lastConfirmedScore, 10);
    await access.bulkAssignments(project.id, admin.id, { action: 'REVOKE', userIds: [employee.id] });

    const employeeJson = JSON.stringify(await attempts.listEmployeeAttempts(employee.id));
    assert.doesNotMatch(employeeJson, /evaluationJson|objectiveMetrics|mergedAudio|requestId/iu);
    const query = parseTrainingAdminResultsQuery({
      page: '1',
      limit: '1',
      userId: employee.id,
      projectId: project.id,
      assignmentStatus: 'REVOKED',
      passed: 'true',
      scoreMin: '90',
      source: 'TEXT',
      sort: 'SCORE_DESC',
    });
    const response = await results.listAdminResults(query);

    assert.equal(response.total, 1);
    assert.equal(response.items.length, 1);
    assert.equal(response.items[0].id, passedAttemptId);
    assert.equal(response.items[0].currentAccess.assignmentStatus, 'REVOKED');
    assert.equal(response.items[0].currentAccess.hasCurrentAccess, false);
    assert.deepEqual(response.items[0].answerSources, ['TEXT']);
    assert.equal(response.items[0].answerCount, 4);
    assert.doesNotMatch(JSON.stringify(response), /answerText|transcript|evaluation|audio|bucket|key/iu);
  });

  test('Stage 5 Part 1 keeps unresolved review and technical failure out of employee final results', async () => {
    const project = await createOpenProject('Stage 5 unresolved');
    await access.bulkAssignments(project.id, admin.id, { action: 'ASSIGN', userIds: [employee.id] });
    let reviewAttempt = await attempts.startAttempt(project.id, employee.id, {
      confirmed: true,
      idempotencyKey: randomUUID(),
    });

    while (reviewAttempt.currentQuestion) {
      reviewAttempt = await attempts.submitAnswer(reviewAttempt.id, employee.id, {
        attemptQuestionId: reviewAttempt.currentQuestion.id,
        text: '[fake:review]',
      });
    }

    const reviewHistory = (await attempts.listEmployeeAttempts(employee.id)).items
      .find((item) => item.id === reviewAttempt.id);
    assert.equal(reviewHistory.status, 'REQUIRES_REVIEW');
    assert.equal(reviewHistory.finalScore, null);
    assert.equal(reviewHistory.isPassed, null);
    assert.equal(reviewHistory.message, 'Результат проверяется.');

    const reviewed = await reviews.reviewAttempt(reviewAttempt.id, admin.id, {
      decision: 'OVERRIDE',
      finalScore: 70,
      comment: 'Проверено вручную',
    });
    assert.equal(reviewed.finalScore, 70);
    assert.equal(reviewed.isPassed, false);
    const overriddenHistory = (await attempts.listEmployeeAttempts(employee.id)).items
      .find((item) => item.id === reviewAttempt.id);
    assert.equal(overriddenHistory.finalScore, 70);
    assert.equal(overriddenHistory.safeBreakdown.length, 0);
    assert.equal(overriddenHistory.message, 'Итог скорректирован после проверки.');

    await assert.rejects(
      attempts.startAttempt(project.id, employee.id, {
        confirmed: true,
        idempotencyKey: randomUUID(),
      }),
    );
    await prisma.trainingAttempt.update({
      where: { id: reviewAttempt.id },
      data: { reviewedAt: new Date(Date.now() - 61 * 60 * 1000) },
    });

    let technicalAttempt = await attempts.startAttempt(project.id, employee.id, {
      confirmed: true,
      idempotencyKey: randomUUID(),
    });
    while (technicalAttempt.currentQuestion) {
      technicalAttempt = await attempts.submitAnswer(technicalAttempt.id, employee.id, {
        attemptQuestionId: technicalAttempt.currentQuestion.id,
        text: '[fake:review]',
      });
    }

    await prisma.trainingAttempt.update({
      where: { id: technicalAttempt.id },
      data: {
        status: 'TECHNICAL_FAILED',
        completionReason: 'TECHNICAL_FAILURE',
        reviewStatus: 'NOT_REQUIRED',
        finalScore: null,
        isPassed: null,
        calculatedScore: null,
        countsTowardAttemptLimit: false,
      },
    });
    const technical = (await attempts.listEmployeeAttempts(employee.id)).items
      .find((item) => item.id === technicalAttempt.id);
    assert.equal(technical.finalScore, null);
    assert.equal(technical.isPassed, null);
    assert.equal(technical.attemptRefunded, true);
    assert.match(technical.message, /техническая ошибка/iu);
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
    await projects.publishProject(created.id);
    return projects.setAvailability(created.id, true);
  }

  async function createUser(label, permissions) {
    const role = await prisma.role.create({
      data: { name: `stage5-${label}-${randomUUID().slice(0, 8)}`, description: 'Stage 5 temporary role' },
    });
    await prisma.permission.createMany({
      data: permissions.map((key) => ({ key, description: key })),
      skipDuplicates: true,
    });
    for (const key of permissions) {
      const permission = await prisma.permission.findUniqueOrThrow({ where: { key } });
      await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    }
    return prisma.user.create({
      data: {
        email: `${label}-${randomUUID()}@training-stage5.test`,
        passwordHash: 'test-hash',
        name: label,
        status: UserStatus.ACTIVE,
        roleId: role.id,
      },
    });
  }
}
