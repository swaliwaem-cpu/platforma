require('reflect-metadata');

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const { Prisma, PrismaClient } = require('@prisma/client');

const { TrainingProjectAccessService } = require('../dist/training/training-project-access.service.js');
const { TrainingRankingService } = require('../dist/training/training-ranking.service.js');
const { parseTrainingAdminRankingQuery } = require('../dist/training/training.validation.js');

const databaseUrl = process.env.TRAINING_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('Training Stage 5 Part 2 PostgreSQL scenarios require the targeted temporary database runner', () => {
    assert.equal(process.env.TRAINING_TEST_DATABASE_URL, undefined);
  });
} else {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  let ranking;
  let users;
  let projects;
  let queryCount = 0;
  let olderBestAttemptId;
  let newerBestAttemptId;

  before(async () => {
    await prisma.$connect();
    const permission = await prisma.permission.upsert({
      where: { key: 'training:participate' },
      update: {},
      create: { key: 'training:participate', description: 'Stage 5 Part 2 fixture' },
    });
    const role = await prisma.role.create({ data: { name: `ranking-${randomUUID()}` } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    users = await Promise.all(Array.from({ length: 105 }, (_, index) => prisma.user.create({
      data: {
        email: `ranking-${index}-${randomUUID()}@example.test`,
        passwordHash: 'not-used',
        name: index === 100 ? '=HYPERLINK("https://invalid")' : `Employee ${String(index).padStart(3, '0')}`,
        status: 'ACTIVE',
        roleId: role.id,
      },
    })));
    projects = await Promise.all(Array.from({ length: 10 }, (_, index) => prisma.trainingProject.create({
      data: {
        title: `Ranking project ${index}`,
        status: 'PUBLISHED',
        accessMode: index < 5 ? 'ALL_PARTICIPANTS' : 'ASSIGNED_USERS',
        isOpen: true,
        allowRetakeAfterPass: true,
      },
    })));
    await prisma.trainingProjectAssignment.createMany({
      data: users.slice(0, 53).flatMap((user) => projects.slice(5).map((project) => ({
        userId: user.id,
        projectId: project.id,
      }))),
    });

    const base = new Date('2026-08-01T10:00:00.000Z');
    const attempts = users.map((user, index) => ({
      userId: user.id,
      projectId: projects[0].id,
      attemptNumber: 1,
      startIdempotencyKey: randomUUID(),
      status: 'COMPLETED',
      completionReason: 'COMPLETED',
      startedAt: new Date(base.getTime() + index * 1_000),
      expiresAt: new Date(base.getTime() + index * 1_000 + 420_000),
      completedAt: new Date(base.getTime() + index * 1_000 + 60_000),
      finalScore: index % 101,
      calculatedScore: index % 101,
      isPassed: index % 101 >= 75,
      reviewStatus: 'NOT_REQUIRED',
      countsTowardAttemptLimit: true,
      projectSnapshotJson: { schemaVersion: 1, projectTitle: `Historical ${index}` },
      fakeEvaluationVersion: 'stage5-part2-fixture',
    }));
    await prisma.trainingAttempt.createMany({ data: attempts });
    await prisma.trainingAttempt.createMany({
      data: users.flatMap((user, userIndex) => projects.slice(1).map((project) => ({
        ...attempts[userIndex],
        projectId: project.id,
        attemptNumber: 9,
        startIdempotencyKey: randomUUID(),
        status: 'TECHNICAL_FAILED',
        completionReason: 'TECHNICAL_FAILURE',
        calculatedScore: null,
        finalScore: null,
        isPassed: false,
        countsTowardAttemptLimit: false,
      }))),
    });

    olderBestAttemptId = randomUUID();
    newerBestAttemptId = randomUUID();
    await prisma.trainingAttempt.createMany({ data: [
      { ...attempts[0], id: olderBestAttemptId, attemptNumber: 2, startIdempotencyKey: randomUUID(), startedAt: new Date(base.getTime() + 500_000), expiresAt: new Date(base.getTime() + 920_000), completedAt: new Date(base.getTime() + 560_000), finalScore: 80, calculatedScore: 80, isPassed: true },
      { ...attempts[0], id: newerBestAttemptId, attemptNumber: 3, startIdempotencyKey: randomUUID(), startedAt: new Date(base.getTime() + 600_000), expiresAt: new Date(base.getTime() + 1_020_000), completedAt: new Date(base.getTime() + 660_000), finalScore: 80, calculatedScore: 80, isPassed: true },
      { ...attempts[0], attemptNumber: 4, startIdempotencyKey: randomUUID(), status: 'REQUIRES_REVIEW', finalScore: null, calculatedScore: 50, isPassed: null, reviewStatus: 'PENDING' },
      { ...attempts[0], attemptNumber: 5, startIdempotencyKey: randomUUID(), status: 'TECHNICAL_FAILED', completionReason: 'TECHNICAL_FAILURE', finalScore: null, calculatedScore: null, isPassed: false, countsTowardAttemptLimit: false },
      { ...attempts[0], projectId: projects[5].id, attemptNumber: 1, startIdempotencyKey: randomUUID(), finalScore: 95, calculatedScore: 95, isPassed: true },
      { ...attempts[1], projectId: projects[1].id, attemptNumber: 1, startIdempotencyKey: randomUUID(), status: 'TIMED_OUT', completionReason: 'TIMEOUT', finalScore: 30, calculatedScore: 30, isPassed: false },
      { ...attempts[2], projectId: projects[1].id, attemptNumber: 1, startIdempotencyKey: randomUUID(), finalScore: 99, calculatedScore: 55, isPassed: true, reviewStatus: 'RESOLVED', reviewDecision: 'OVERRIDDEN', reviewedById: users[0].id, reviewedAt: new Date('2026-08-02T01:00:00.000Z'), reviewComment: 'Synthetic override', reviewFinalScore: 99 },
      { ...attempts[0], attemptNumber: 6, startIdempotencyKey: randomUUID(), startedAt: new Date(base.getTime() + 700_000), expiresAt: new Date(base.getTime() + 1_120_000), completedAt: new Date(base.getTime() + 760_000), finalScore: 70, calculatedScore: 70, isPassed: false },
    ] });
    await prisma.trainingProjectAssignment.update({
      where: { projectId_userId: { projectId: projects[5].id, userId: users[0].id } },
      data: { revokedAt: new Date('2026-08-02T00:00:00.000Z') },
    });

    const measuredPrisma = {
      $queryRaw: (...args) => { queryCount += 1; return prisma.$queryRaw(...args); },
    };
    ranking = new TrainingRankingService(
      measuredPrisma,
      { finalizeExpiredAttempts: async () => ({ count: 0 }) },
      new TrainingProjectAccessService(prisma),
    );
  });

  after(async () => prisma.$disconnect());

  test('Stage 5 Part 2 ranks 105 users with stable SQL pagination and current coverage', async () => {
    queryCount = 0;
    const firstPage = await ranking.listRanking(parseTrainingAdminRankingQuery({ page: '1', limit: '20' }));
    assert.equal(firstPage.total, 105);
    assert.equal(firstPage.items.length, 20);
    assert.equal(firstPage.totalPages, 6);
    assert.equal(new Set(firstPage.items.map((item) => item.user.id)).size, 20);
    assert.equal(queryCount, 2, 'one core SQL query plus one page-details SQL query');
    assert.deepEqual(firstPage.items.slice(0, 2).map((item) => item.averageBestScore), ['87.50', '50.50']);

    queryCount = 0;
    const secondPage = await ranking.listRanking(parseTrainingAdminRankingQuery({ page: '2', limit: '20' }));
    assert.equal(secondPage.items.length, 20);
    assert.equal(queryCount, 2);
    assert.equal(firstPage.items.some((item) => secondPage.items.some((other) => other.user.id === item.user.id)), false);

    const firstUser = firstPage.items.find((item) => item.user.id === users[0].id);
    assert.ok(firstUser);
    assert.equal(firstUser.completedProjectsCount, 2);
    assert.equal(firstUser.passedProjectsCount, 2);
    assert.equal(firstUser.averageBestScore, '87.50');
    assert.equal(firstUser.attemptsUsed, 6);
    assert.equal(firstUser.currentEligibleProjectsCount, 9);
    assert.equal(firstUser.currentCompletedEligibleProjectsCount, 1);
    assert.equal(firstUser.currentCoveragePercent, '11.11');
    assert.equal(firstUser.bestResults.some((result) => result.projectId === projects[5].id && !result.currentlyEligible), true);
    assert.equal(firstUser.bestResults.find((result) => result.projectId === projects[0].id).attemptId, newerBestAttemptId);
    assert.notEqual(firstUser.bestResults.find((result) => result.projectId === projects[0].id).attemptId, olderBestAttemptId);

    await prisma.trainingProjectAssignment.update({
      where: { projectId_userId: { projectId: projects[5].id, userId: users[0].id } },
      data: { revokedAt: null },
    });
    const beforeRevoke = await ranking.listRanking(parseTrainingAdminRankingQuery({ page: '1', limit: '20', search: 'Employee 000' }));
    assert.equal(beforeRevoke.items[0].averageBestScore, '87.50');
    assert.equal(beforeRevoke.items[0].currentEligibleProjectsCount, 10);
    assert.equal(beforeRevoke.items[0].currentCompletedEligibleProjectsCount, 2);
    assert.equal(beforeRevoke.items[0].currentCoveragePercent, '20.00');
    await prisma.trainingProjectAssignment.update({
      where: { projectId_userId: { projectId: projects[5].id, userId: users[0].id } },
      data: { revokedAt: new Date('2026-08-02T02:00:00.000Z') },
    });
    const afterRevoke = await ranking.listRanking(parseTrainingAdminRankingQuery({ page: '1', limit: '20', search: 'Employee 000' }));
    assert.equal(afterRevoke.items[0].averageBestScore, '87.50');
    assert.equal(afterRevoke.items[0].currentEligibleProjectsCount, 9);
    assert.equal(afterRevoke.items[0].currentCompletedEligibleProjectsCount, 1);

    const timeoutUser = await ranking.listRanking(parseTrainingAdminRankingQuery({ page: '1', limit: '20', search: 'Employee 001' }));
    assert.equal(timeoutUser.total, 1);
    assert.equal(timeoutUser.items[0].completedProjectsCount, 2);
    assert.equal(timeoutUser.items[0].passedProjectsCount, 0);
    const overriddenUser = await ranking.listRanking(parseTrainingAdminRankingQuery({ page: '1', limit: '20', search: 'Employee 002', project: 'Ranking project 1' }));
    assert.equal(overriddenUser.total, 1);
    assert.equal(overriddenUser.items[0].averageBestScore, '99.00');
    assert.equal(overriddenUser.items[0].bestResults[0].finalScore, 99);

    const beyondLastPage = await ranking.listRanking(parseTrainingAdminRankingQuery({ page: '99', limit: '20' }));
    assert.deepEqual(beyondLastPage.items, []);
    assert.equal(beyondLastPage.total, 105);
    assert.equal(beyondLastPage.totalPages, 6);
  });

  test('Stage 5 Part 2 applies assignment-aware filters and exports formula-safe BOM CSV', async () => {
    const assigned = await ranking.listRanking(parseTrainingAdminRankingQuery({
      page: '1', limit: '100', project: projects[5].id, accessMode: 'ASSIGNED_USERS', currentlyAssigned: 'true', currentlyEligible: 'true',
    }));
    assert.equal(assigned.total, 52);
    assert.equal(assigned.items.every((item) => item.currentAccess.activeAssignmentsCount > 0), true);
    const notAssigned = await ranking.listRanking(parseTrainingAdminRankingQuery({ page: '1', limit: '100', project: projects[5].id, currentlyAssigned: 'false', currentlyEligible: 'false' }));
    assert.equal(notAssigned.total, 1);
    assert.equal(notAssigned.items[0].user.id, users[0].id);

    queryCount = 0;
    const csv = await ranking.exportCsv(parseTrainingAdminRankingQuery({ page: '1', limit: '20' }));
    assert.equal(csv.codePointAt(0), 0xfeff);
    assert.match(csv, /"'=HYPERLINK\(""https:\/\/invalid""\)"/u);
    assert.doesNotMatch(csv, /passwordHash|refreshToken|evaluationJson|projectSnapshotJson/iu);
    assert.equal(csv.trimEnd().split('\r\n').length, 106);
    assert.equal(queryCount, 4, 'two bounded SQL queries per 100-row CSV batch');
  });

  test('Stage 5 Part 2 core query has measured PostgreSQL EXPLAIN evidence', async () => {
    let capturedQuery;
    const captureService = new TrainingRankingService(
      { $queryRaw: async (query) => { capturedQuery = query; return []; } },
      { finalizeExpiredAttempts: async () => ({ count: 0 }) },
      new TrainingProjectAccessService(prisma),
    );
    await captureService.listRanking(parseTrainingAdminRankingQuery({ page: '1', limit: '20' }));
    assert.ok(capturedQuery);
    const planRows = await prisma.$queryRaw(
      Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${capturedQuery}`,
    );
    const plan = planRows[0]['QUERY PLAN'][0];
    assert.equal(plan.Plan['Actual Rows'], 20);
    assert.ok(plan['Execution Time'] < 2_000, `execution took ${plan['Execution Time']} ms`);
    assert.ok(plan.Plan['Shared Hit Blocks'] >= 0);
    process.stdout.write(`ranking explain execution_ms=${plan['Execution Time']} planning_ms=${plan['Planning Time']} rows=${plan.Plan['Actual Rows']}\n`);
  });
}
