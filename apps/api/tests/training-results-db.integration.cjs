require('reflect-metadata');

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const argon2 = require('argon2');
const {
  Prisma,
  TrainingAnswerStatus,
  TrainingAttemptQuestionStatus,
  TrainingAttemptStatus,
  TrainingFactVerdict,
  TrainingPassStatus,
  TrainingProjectStatus,
  TrainingQuestionType,
  TrainingReviewStatus,
  TrainingVersionStatus,
  UserStatus,
} = require('@prisma/client');

const { AuthModule } = require('../dist/auth/auth.module.js');
const { PrismaModule } = require('../dist/prisma/prisma.module.js');
const { PrismaService } = require('../dist/prisma/prisma.service.js');
const {
  TrainingAdminResultsController,
  TrainingEmployeeResultsController,
} = require('../dist/training/training-results.controller.js');
const {
  buildTrainingRankingPageQuery,
  TrainingRankingService,
} = require('../dist/training/training-ranking.service.js');
const {
  TrainingResultsService,
} = require('../dist/training/training-results.service.js');

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL must point to the runner-created isolated training database',
  );
}

test('real PostgreSQL and HTTP enforce stage 9 visibility, filters, ranking and CSV', async () => {
  const originalAccessSecret = process.env.JWT_ACCESS_SECRET;
  const originalRefreshSecret = process.env.JWT_REFRESH_SECRET;
  process.env.JWT_ACCESS_SECRET = 'training-results-http-access-test-secret';
  process.env.JWT_REFRESH_SECRET = 'training-results-http-refresh-test-secret';

  class TrainingResultsHttpTestModule {}
  Module({
    imports: [PrismaModule, AuthModule],
    controllers: [
      TrainingEmployeeResultsController,
      TrainingAdminResultsController,
    ],
    providers: [TrainingResultsService, TrainingRankingService],
  })(TrainingResultsHttpTestModule);

  const app = await NestFactory.create(TrainingResultsHttpTestModule, {
    logger: false,
  });
  try {
    await app.listen(0, '127.0.0.1');
    const prisma = app.get(PrismaService);
    const fixture = await createFixture(prisma);
    const address = app.getHttpServer().address();
    assert.equal(typeof address, 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    assert.equal((await fetch(`${baseUrl}/training/attempts`)).status, 401);

    const noPermissionToken = await login(
      baseUrl,
      fixture.users.noPermission,
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/training/attempts`, {
          headers: authorization(noPermissionToken),
        })
      ).status,
      403,
    );

    const employeeToken = await login(baseUrl, fixture.users.employee);
    const projectsResponse = await fetch(`${baseUrl}/training/projects`, {
      headers: authorization(employeeToken),
    });
    assert.equal(projectsResponse.status, 200);
    const projects = await projectsResponse.json();
    const employeeProject = projects.items.find(
      (item) => item.id === fixture.projectIds.first,
    );
    assert.ok(employeeProject);
    assert.equal(employeeProject.bestScore, '90');
    assert.equal(employeeProject.attemptsUsed, 3);
    assert.equal(employeeProject.attemptsLeft, 0);
    assert.equal(employeeProject.allowRetakeAfterPass, false);
    assert.equal(employeeProject.requiresTelegramConnection, true);
    assert.equal(employeeProject.telegramConnected, false);
    assert.equal(employeeProject.lastAttemptStatus, 'REQUIRES_REVIEW');
    assert.equal(employeeProject.activeAttempt, null);

    const ownAttemptsResponse = await fetch(
      `${baseUrl}/training/attempts?page=1&pageSize=2&projectId=${fixture.projectIds.first}`,
      { headers: authorization(employeeToken) },
    );
    assert.equal(ownAttemptsResponse.status, 200);
    const ownAttempts = await ownAttemptsResponse.json();
    assert.equal(ownAttempts.items.length, 2);
    assert.equal(ownAttempts.pagination.total, 3);
    assert.ok(
      ownAttempts.items.every(
        (item) => item.project.id === fixture.projectIds.first,
      ),
    );
    const futureAttempts = await fetch(
      `${baseUrl}/training/attempts?dateFrom=2099-01-01&limit=10`,
      { headers: authorization(employeeToken) },
    );
    assert.equal(futureAttempts.status, 200);
    assert.equal((await futureAttempts.json()).pagination.total, 0);
    assert.equal(
      (
        await fetch(
          `${baseUrl}/training/attempts?dateFrom=2026-07-28&dateTo=2026-07-01`,
          { headers: authorization(employeeToken) },
        )
      ).status,
      400,
    );

    const pendingDetailResponse = await fetch(
      `${baseUrl}/training/attempts/${fixture.attemptIds.pending}`,
      { headers: authorization(employeeToken) },
    );
    assert.equal(pendingDetailResponse.status, 200);
    const pendingDetailText = await pendingDetailResponse.text();
    const pendingDetail = JSON.parse(pendingDetailText);
    assert.equal(pendingDetail.attempt.finalScore, null);
    assert.equal(pendingDetail.attempt.breakdownStatus, 'PENDING_REVIEW');
    assert.equal(pendingDetail.attempt.breakdown, null);
    assert.equal('summary' in pendingDetail.attempt, false);
    for (const forbidden of [
      'combinedTranscript',
      'transcript',
      'audioUrl',
      'errorMessage',
      'providerRuns',
      'summary',
      'storage',
      'telegram',
    ]) {
      assert.equal(pendingDetailText.includes(forbidden), false, forbidden);
    }
    assertEmployeePayloadHasNoInternalScores(pendingDetail);

    const visibilityToken = await login(
      baseUrl,
      fixture.users.visibility,
    );
    for (const expected of [
      {
        id: fixture.attemptIds.visibilityNotRequired,
        finalScore: '90',
        status: 'AVAILABLE',
        hasBreakdown: true,
      },
      {
        id: fixture.attemptIds.visibilityApproved,
        finalScore: '90',
        status: 'AVAILABLE',
        hasBreakdown: true,
      },
      {
        id: fixture.attemptIds.visibilityOverridden,
        finalScore: '70',
        status: 'MANUALLY_ADJUSTED_BREAKDOWN_UNAVAILABLE',
        hasBreakdown: false,
      },
      {
        id: fixture.attemptIds.visibilityFactualPenalty,
        finalScore: '85',
        status: 'MANUALLY_ADJUSTED_BREAKDOWN_UNAVAILABLE',
        hasBreakdown: false,
      },
    ]) {
      const response = await fetch(
        `${baseUrl}/training/attempts/${expected.id}`,
        { headers: authorization(visibilityToken) },
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.attempt.finalScore, expected.finalScore);
      assert.equal(body.attempt.breakdownStatus, expected.status);
      assert.equal(
        body.attempt.breakdown !== null,
        expected.hasBreakdown,
      );
      if (expected.hasBreakdown) {
        assert.equal(body.attempt.breakdown[0].score, '90');
        assert.equal(
          body.attempt.breakdown[0].components[0].awardedPoints,
          '90',
        );
      }
      assertEmployeePayloadHasNoInternalScores(body);
    }

    const foreignDetail = await fetch(
      `${baseUrl}/training/attempts/${fixture.attemptIds.foreign}`,
      { headers: authorization(employeeToken) },
    );
    assert.equal(foreignDetail.status, 404);

    assert.equal(
      (
        await fetch(`${baseUrl}/training/admin/results`, {
          headers: authorization(employeeToken),
        })
      ).status,
      403,
    );

    for (const role of ['trainingAdmin', 'admin']) {
      const token = await login(baseUrl, fixture.users[role]);
      const listResponse = await fetch(
        `${baseUrl}/training/admin/results?user=${encodeURIComponent(
          fixture.users.employee.email,
        )}&projectId=${fixture.projectIds.first}&sort=score_desc&page=1&pageSize=2`,
        { headers: authorization(token) },
      );
      assert.equal(listResponse.status, 200, role);
      const list = await listResponse.json();
      assert.equal(list.items.length, 2);
      assert.equal(list.pagination.total, 3);
      assert.equal(list.items[0].finalScore, '99');
      assert.equal(list.items[0].aiScore, '99');
      assert.equal(list.items[0].serverScore, '99');
      assert.equal(list.items[0].projectVersion.versionNumber, 1);
      assert.equal(list.items[0].answersCompleted, 1);
      assert.equal(list.items[0].attemptsUsed, 3);
      assert.equal(list.items[0].requiresReview, true);
      assert.equal(list.items[0].summary, 'pending private summary');
      assert.equal(list.items[0].reviewStatus, 'PENDING');

      const reviewFilterResponse = await fetch(
        `${baseUrl}/training/admin/results?userId=${fixture.users.employee.id}&requiresReview=true&limit=1&sortField=finalScore&sortDirection=desc`,
        { headers: authorization(token) },
      );
      assert.equal(reviewFilterResponse.status, 200, role);
      const reviewFilter = await reviewFilterResponse.json();
      assert.equal(reviewFilter.pagination.total, 1);
      assert.equal(reviewFilter.items[0].id, fixture.attemptIds.pending);
      assert.equal(
        (
          await fetch(
            `${baseUrl}/training/admin/results?finalScoreFrom=90&finalScoreTo=10`,
            { headers: authorization(token) },
          )
        ).status,
        400,
      );

      const detailResponse = await fetch(
        `${baseUrl}/training/admin/results/${fixture.attemptIds.best}`,
        { headers: authorization(token) },
      );
      assert.equal(detailResponse.status, 200, role);
      const detailText = await detailResponse.text();
      const detail = JSON.parse(detailText);
      assert.equal(
        detail.attempt.questions[0].answer.combinedTranscript,
        'private admin transcript',
      );
      assert.equal(
        detail.attempt.questions[0].answer.audioUrl,
        null,
      );
      assert.equal(
        'transcriptionProvider' in detail.attempt.questions[0].answer,
        true,
      );
      assert.equal(
        'audioMimeType' in detail.attempt.questions[0].answer,
        true,
      );
      assert.match(detailText, /providerRuns/u);
      for (const forbidden of [
        'telegramFileId',
        'telegramChatId',
        'originalStorageKey',
        'inputMetadataJson',
        'passwordHash',
      ]) {
        assert.equal(detailText.includes(forbidden), false, forbidden);
      }

      const overriddenDetailResponse = await fetch(
        `${baseUrl}/training/admin/results/${fixture.attemptIds.visibilityOverridden}`,
        { headers: authorization(token) },
      );
      assert.equal(overriddenDetailResponse.status, 200, role);
      const overriddenDetail = await overriddenDetailResponse.json();
      assert.equal(overriddenDetail.attempt.aiScore, '90');
      assert.equal(overriddenDetail.attempt.serverScore, '90');
      assert.equal(overriddenDetail.attempt.adminScore, '70');
      assert.equal(overriddenDetail.attempt.finalScore, '70');
      assert.equal(
        overriddenDetail.attempt.questions[0].answer.evaluations[0]
          .serverScore,
        '90',
      );

      const rankingResponse = await fetch(
        `${baseUrl}/training/admin/ranking?user=${encodeURIComponent(
          fixture.users.employee.email,
        )}`,
        { headers: authorization(token) },
      );
      assert.equal(rankingResponse.status, 200, role);
      const ranking = await rankingResponse.json();
      assert.equal(ranking.items.length, 1);
      assert.equal(ranking.items[0].passedProjectsCount, 1);
      assert.equal(ranking.items[0].completedProjectsCount, 2);
      assert.equal(ranking.items[0].averageBestScore, '77.50');
      assert.equal(ranking.items[0].attemptsUsed, 4);
      const firstProject = ranking.items[0].projects.find(
        (project) => project.projectId === fixture.projectIds.first,
      );
      assert.equal(firstProject.attemptId, fixture.attemptIds.best);
      assert.equal(firstProject.attemptsUsed, 3);
      assert.equal(firstProject.scoreChangeFromFirst, '10.00');
      assert.equal(firstProject.summary, 'safe summary');
      assert.deepEqual(
        ranking.items[0].projects.map((project) => project.finalScore),
        ['90', '65'],
      );
      assert.equal(
        ranking.items[0].projects.some(
          (project) => project.finalScore === '99',
        ),
        false,
      );

      const csvResponse = await fetch(
        `${baseUrl}/training/admin/ranking/export.csv?user=${encodeURIComponent(
          fixture.users.employee.email,
        )}`,
        { headers: authorization(token) },
      );
      assert.equal(csvResponse.status, 200, role);
      assert.equal(
        csvResponse.headers.get('cache-control'),
        'private, no-store',
      );
      const csvBuffer = Buffer.from(await csvResponse.arrayBuffer());
      assert.deepEqual([...csvBuffer.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
      const csv = csvBuffer.toString('utf8');
      assert.match(csv, /'=Employee/u);
      assert.equal(csv.includes('private admin transcript'), false);
      assert.equal(csv.includes('audioUrl'), false);
    }

    await assertRankingPaginationAndExactNumeric({
      app,
      baseUrl,
      prisma,
      token: await login(baseUrl, fixture.users.admin),
      fixture,
    });
  } finally {
    await app.close();
    restoreEnvironment('JWT_ACCESS_SECRET', originalAccessSecret);
    restoreEnvironment('JWT_REFRESH_SECRET', originalRefreshSecret);
  }
});

async function createFixture(prisma) {
  const unique = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const password = 'TrainingResults!1';
  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
  });
  const permissionIds = {};
  for (const key of [
    'training:take',
    'training:own-results:read',
    'training:results:read',
  ]) {
    const permission = await prisma.permission.upsert({
      where: { key },
      update: {},
      create: { key, description: key },
    });
    permissionIds[key] = permission.id;
  }
  const definitions = {
    employee: [
      'training:take',
      'training:own-results:read',
    ],
    other: [
      'training:take',
      'training:own-results:read',
    ],
    visibility: [
      'training:take',
      'training:own-results:read',
    ],
    trainingAdmin: ['training:results:read'],
    admin: ['training:results:read'],
    noPermission: [],
  };
  const users = {};
  for (const [name, permissionKeys] of Object.entries(definitions)) {
    const role = await prisma.role.create({
      data: {
        name: `training-results-${name}-${unique}`,
        permissions: {
          create: permissionKeys.map((key) => ({
            permissionId: permissionIds[key],
          })),
        },
      },
    });
    const email = `${name.toLowerCase()}-${unique}@example.test`;
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        name: name === 'employee' ? '=Employee' : name,
        status: UserStatus.ACTIVE,
        roleId: role.id,
      },
    });
    users[name] = { id: user.id, email, password, roleId: role.id };
  }

  const first = await createProject(
    prisma,
    users.admin.id,
    unique,
    'first',
    'Проект Север',
  );
  const second = await createProject(
    prisma,
    users.admin.id,
    unique,
    'second',
    'Проект Юг',
  );
  const visibilityProject = await createProject(
    prisma,
    users.admin.id,
    unique,
    'visibility',
    'Проект Visibility',
  );
  const old = await createAttempt(prisma, {
    userId: users.employee.id,
    project: first,
    attemptNumber: 1,
    finalScore: 80,
    passStatus: TrainingPassStatus.PASSED,
    completedOffset: -50_000,
    transcript: 'older transcript',
  });
  const best = await createAttempt(prisma, {
    userId: users.employee.id,
    project: first,
    attemptNumber: 2,
    finalScore: 90,
    passStatus: TrainingPassStatus.PASSED,
    completedOffset: -40_000,
    transcript: 'private admin transcript',
    component: {
      key: 'criterion:facts',
      title: 'Факты',
      verdict: null,
      awarded: 90,
      maximum: 100,
    },
  });
  const pending = await createAttempt(prisma, {
    userId: users.employee.id,
    project: first,
    attemptNumber: 3,
    finalScore: 99,
    passStatus: TrainingPassStatus.PENDING,
    reviewStatus: TrainingReviewStatus.PENDING,
    status: TrainingAttemptStatus.REQUIRES_REVIEW,
    completedOffset: -30_000,
    transcript: 'pending transcript',
    summary: 'pending private summary',
    component: {
      key: 'fact:unsupported',
      title: 'Unsupported',
      verdict: TrainingFactVerdict.UNSUPPORTED,
      awarded: 0,
      maximum: 5,
    },
  });
  await createAttempt(prisma, {
    userId: users.employee.id,
    project: second,
    attemptNumber: 1,
    finalScore: 65,
    passStatus: TrainingPassStatus.FAILED,
    completedOffset: -20_000,
    transcript: 'second transcript',
  });
  await createAttempt(prisma, {
    userId: users.employee.id,
    project: second,
    attemptNumber: 2,
    finalScore: null,
    passStatus: TrainingPassStatus.PENDING,
    reviewStatus: TrainingReviewStatus.NOT_REQUIRED,
    status: TrainingAttemptStatus.TECHNICAL_FAILURE,
    isConsumed: false,
    completedOffset: -10_000,
    transcript: null,
  });
  const foreign = await createAttempt(prisma, {
    userId: users.other.id,
    project: first,
    attemptNumber: 1,
    finalScore: 70,
    passStatus: TrainingPassStatus.FAILED,
    completedOffset: -5_000,
    transcript: 'foreign transcript',
  });
  const visibilityNotRequired = await createAttempt(prisma, {
    userId: users.visibility.id,
    project: visibilityProject,
    attemptNumber: 1,
    finalScore: 90,
    passStatus: TrainingPassStatus.PASSED,
    completedOffset: -4_000,
    transcript: 'visibility not required',
    component: {
      key: 'criterion:facts',
      title: 'Факты',
      verdict: null,
      awarded: 90,
      maximum: 100,
    },
  });
  const visibilityApproved = await createAttempt(prisma, {
    userId: users.visibility.id,
    project: visibilityProject,
    attemptNumber: 2,
    finalScore: 90,
    passStatus: TrainingPassStatus.PASSED,
    reviewStatus: TrainingReviewStatus.APPROVED,
    completedOffset: -3_000,
    transcript: 'visibility approved',
    component: {
      key: 'criterion:facts',
      title: 'Факты',
      verdict: null,
      awarded: 90,
      maximum: 100,
    },
  });
  const visibilityOverridden = await createAttempt(prisma, {
    userId: users.visibility.id,
    project: visibilityProject,
    attemptNumber: 3,
    aiScore: 90,
    serverScore: 90,
    adminScore: 70,
    finalScore: 70,
    evaluationServerScore: 90,
    passStatus: TrainingPassStatus.FAILED,
    reviewStatus: TrainingReviewStatus.OVERRIDDEN,
    completedOffset: -2_000,
    transcript: 'visibility overridden',
    component: {
      key: 'criterion:facts',
      title: 'Факты',
      verdict: null,
      awarded: 90,
      maximum: 100,
    },
  });
  const visibilityFactualPenalty = await createAttempt(prisma, {
    userId: users.visibility.id,
    project: visibilityProject,
    attemptNumber: 4,
    aiScore: 90,
    serverScore: 90,
    finalScore: 85,
    evaluationServerScore: 90,
    passStatus: TrainingPassStatus.PASSED,
    reviewStatus: TrainingReviewStatus.APPROVED,
    completedOffset: -1_000,
    transcript: 'visibility factual penalty',
    component: {
      key: 'fact:unsupported',
      title: 'Unsupported',
      verdict: TrainingFactVerdict.UNSUPPORTED,
      awarded: 90,
      maximum: 100,
    },
  });
  const rankingFixture = await createRankingFixture(
    prisma,
    users.employee.roleId,
    passwordHash,
    users.admin.id,
    unique,
  );

  return {
    users,
    projectIds: {
      first: first.id,
      second: second.id,
      visibility: visibilityProject.id,
    },
    attemptIds: {
      old: old.id,
      best: best.id,
      pending: pending.id,
      foreign: foreign.id,
      visibilityNotRequired: visibilityNotRequired.id,
      visibilityApproved: visibilityApproved.id,
      visibilityOverridden: visibilityOverridden.id,
      visibilityFactualPenalty: visibilityFactualPenalty.id,
    },
    ranking: rankingFixture,
  };
}

async function createProject(
  prisma,
  publishedById,
  unique,
  suffix,
  title,
) {
  const project = await prisma.trainingProject.create({
    data: {
      slug: `training-results-${suffix}-${unique}`,
      title,
      status: TrainingProjectStatus.OPEN,
    },
  });
  const version = await prisma.trainingProjectVersion.create({
    data: {
      projectId: project.id,
      versionNumber: 1,
      status: TrainingVersionStatus.DRAFT,
      attemptLimit: 3,
      cooldownMinutes: 60,
    },
  });
  const question = await prisma.trainingQuestion.create({
    data: {
      projectVersionId: version.id,
      type: TrainingQuestionType.MAIN,
      text: `Вопрос ${title}`,
      position: 1,
      maxScore: 55,
    },
  });
  const criterion = await prisma.trainingEvaluationCriterion.create({
    data: {
      projectVersionId: version.id,
      questionType: TrainingQuestionType.MAIN,
      code: 'facts',
      title: 'Факты',
      maxPoints: 100,
      sortOrder: 0,
    },
  });
  await prisma.trainingProjectVersion.update({
    where: { id: version.id },
    data: {
      status: TrainingVersionStatus.PUBLISHED,
      publishedAt: new Date(),
      publishedById,
    },
  });
  await prisma.trainingProject.update({
    where: { id: project.id },
    data: { activeVersionId: version.id },
  });
  return {
    id: project.id,
    versionId: version.id,
    questionId: question.id,
    criterionId: criterion.id,
  };
}

async function createAttempt(prisma, input) {
  const completedAt = new Date(Date.now() + input.completedOffset);
  const attempt = await prisma.trainingAttempt.create({
    data: {
      userId: input.userId,
      projectId: input.project.id,
      projectVersionId: input.project.versionId,
      attemptNumber: input.attemptNumber,
      status: input.status ?? TrainingAttemptStatus.COMPLETED,
      isConsumed: input.isConsumed ?? true,
      startedAt: new Date(completedAt.getTime() - 300_000),
      expiresAt: new Date(completedAt.getTime() + 60_000),
      graceExpiresAt: new Date(completedAt.getTime() + 120_000),
      completedAt,
      settingsSnapshotJson: {},
      aiScore: input.aiScore ?? input.finalScore,
      serverScore: input.serverScore ?? input.finalScore,
      adminScore: input.adminScore ?? null,
      finalScore: input.finalScore,
      passStatus: input.passStatus,
      reviewStatus:
        input.reviewStatus ?? TrainingReviewStatus.NOT_REQUIRED,
      summary: input.summary ?? 'safe summary',
      totalDurationSeconds: 300,
    },
  });
  const attemptQuestion = await prisma.trainingAttemptQuestion.create({
    data: {
      attemptId: attempt.id,
      questionId: input.project.questionId,
      sequence: 1,
      status: TrainingAttemptQuestionStatus.SCORED,
      presentedAt: new Date(completedAt.getTime() - 250_000),
      firstSegmentAt: new Date(completedAt.getTime() - 240_000),
      finishedAt: new Date(completedAt.getTime() - 10_000),
      responseTimeSeconds: 240,
      answerDurationSeconds: 120,
    },
  });
  if (input.transcript !== null) {
    const answer = await prisma.trainingAnswer.create({
      data: {
        attemptQuestionId: attemptQuestion.id,
        status: TrainingAnswerStatus.SCORED,
        combinedTranscript: input.transcript,
        processingStartedAt: new Date(completedAt.getTime() - 8_000),
        processingFinishedAt: new Date(completedAt.getTime() - 1_000),
      },
    });
    const evaluation = await prisma.trainingAnswerEvaluation.create({
      data: {
        answerId: answer.id,
        evaluationNumber: 1,
        actualModelId: 'fake-stage-9',
        promptVersion: 'fixture-1',
        schemaVersion: 'fixture-1',
        rubricVersion: 'fixture-1',
        structuredResultJson: {},
        aiSuggestedScore: input.aiScore ?? input.finalScore ?? 0,
        serverScore:
          input.evaluationServerScore ??
          input.serverScore ??
          input.finalScore ??
          0,
        summary: 'fixture evaluation',
        requiresReview:
          input.reviewStatus === TrainingReviewStatus.PENDING,
      },
    });
    if (input.component) {
      await prisma.trainingScoreComponent.create({
        data: {
          evaluationId: evaluation.id,
          criterionId:
            input.component.verdict === null
              ? input.project.criterionId
              : null,
          componentKey: input.component.key,
          title: input.component.title,
          awardedPoints: input.component.awarded,
          maxPoints: input.component.maximum,
          factVerdict: input.component.verdict,
        },
      });
    }
    await prisma.trainingAnswer.update({
      where: { id: answer.id },
      data: { activeEvaluationId: evaluation.id },
    });
  }
  return attempt;
}

async function login(baseUrl, user) {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: user.email,
      password: user.password,
    }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).accessToken;
}

function authorization(token) {
  return { Authorization: `Bearer ${token}` };
}

function restoreEnvironment(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function createRankingFixture(
  prisma,
  trainingRoleId,
  passwordHash,
  publishedById,
  unique,
) {
  const projects = [];
  for (let index = 0; index < 10; index += 1) {
    projects.push(
      await createProject(
        prisma,
        publishedById,
        unique,
        `ranking-${index}`,
        `Рейтинг ${String(index).padStart(2, '0')}`,
      ),
    );
  }
  const users = [];
  for (let index = 0; index < 90; index += 1) {
    const user = await createRankingUser(prisma, {
      roleId: trainingRoleId,
      passwordHash,
      unique,
      suffix: `regular-${String(index).padStart(2, '0')}`,
      name: `Ranking Regular ${String(index).padStart(2, '0')}`,
    });
    users.push(user);
    const firstCompletedAt = new Date(
      `2026-07-${String(1 + (index % 20)).padStart(2, '0')}T10:00:00.000Z`,
    );
    await createBareRankingAttempt(prisma, {
      userId: user.id,
      project: projects[0],
      attemptNumber: 1,
      finalScore: 70 + (index % 10),
      passStatus:
        index % 3 === 0
          ? TrainingPassStatus.FAILED
          : TrainingPassStatus.PASSED,
      completedAt: firstCompletedAt,
    });
    await createBareRankingAttempt(prisma, {
      userId: user.id,
      project: projects[0],
      attemptNumber: 2,
      finalScore: 60 + (index % 10),
      passStatus: TrainingPassStatus.FAILED,
      completedAt: new Date(firstCompletedAt.getTime() + 3_600_000),
    });
    await createBareRankingAttempt(prisma, {
      userId: user.id,
      project: projects[1],
      attemptNumber: 1,
      finalScore: 80 + (index % 10),
      passStatus: TrainingPassStatus.PASSED,
      completedAt: new Date(firstCompletedAt.getTime() + 7_200_000),
    });
    if (index % 2 === 0) {
      await createBareRankingAttempt(prisma, {
        userId: user.id,
        project: projects[2],
        attemptNumber: 1,
        finalScore: 65 + (index % 10),
        passStatus: TrainingPassStatus.PASSED,
        completedAt: new Date(firstCompletedAt.getTime() + 10_800_000),
      });
    }
  }

  const exactUsers = [];
  for (const exact of [
    { suffix: 'exact-low', finalIncrement: '0.01' },
    { suffix: 'exact-mid', finalIncrement: '0.04' },
    { suffix: 'exact-high', finalIncrement: '0.05' },
  ]) {
    const user = await createRankingUser(prisma, {
      roleId: trainingRoleId,
      passwordHash,
      unique,
      suffix: exact.suffix,
      name: `Exact Average ${exact.suffix}`,
    });
    exactUsers.push(user);
    for (let index = 0; index < projects.length; index += 1) {
      await createBareRankingAttempt(prisma, {
        userId: user.id,
        project: projects[index],
        attemptNumber: 1,
        finalScore:
          index === projects.length - 1
            ? new Prisma.Decimal(85).add(exact.finalIncrement)
            : 85,
        passStatus: TrainingPassStatus.PASSED,
        completedAt: new Date(
          `2026-06-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`,
        ),
      });
    }
  }

  const tieUsers = [];
  for (const suffix of ['tie-a', 'tie-b']) {
    const user = await createRankingUser(prisma, {
      roleId: trainingRoleId,
      passwordHash,
      unique,
      suffix,
      name: `Stable Tie ${suffix}`,
    });
    tieUsers.push(user);
    await createBareRankingAttempt(prisma, {
      userId: user.id,
      project: projects[0],
      attemptNumber: 1,
      finalScore: 88,
      passStatus: TrainingPassStatus.PASSED,
      completedAt: new Date('2026-06-15T10:00:00.000Z'),
    });
  }

  const needleUsers = [];
  for (const suffix of ['needle-a', 'needle-b']) {
    const user = await createRankingUser(prisma, {
      roleId: trainingRoleId,
      passwordHash,
      unique,
      suffix,
      name: `Needle Ranking ${suffix}`,
    });
    needleUsers.push(user);
  }
  const reviewedUser = needleUsers[0];
  await createBareRankingAttempt(prisma, {
    userId: reviewedUser.id,
    project: projects[0],
    attemptNumber: 1,
    finalScore: 90,
    passStatus: TrainingPassStatus.PASSED,
    reviewStatus: TrainingReviewStatus.APPROVED,
    completedAt: new Date('2026-06-10T10:00:00.000Z'),
  });
  await createBareRankingAttempt(prisma, {
    userId: reviewedUser.id,
    project: projects[0],
    attemptNumber: 2,
    finalScore: 80,
    passStatus: TrainingPassStatus.PASSED,
    reviewStatus: TrainingReviewStatus.APPROVED,
    completedAt: new Date('2026-06-11T10:00:00.000Z'),
  });
  await createBareRankingAttempt(prisma, {
    userId: reviewedUser.id,
    project: projects[0],
    attemptNumber: 3,
    finalScore: 99,
    passStatus: TrainingPassStatus.PENDING,
    reviewStatus: TrainingReviewStatus.PENDING,
    status: TrainingAttemptStatus.REQUIRES_REVIEW,
    completedAt: new Date('2026-06-12T10:00:00.000Z'),
  });
  await createBareRankingAttempt(prisma, {
    userId: reviewedUser.id,
    project: projects[0],
    attemptNumber: 4,
    finalScore: 100,
    passStatus: TrainingPassStatus.PASSED,
    status: TrainingAttemptStatus.TECHNICAL_FAILURE,
    completedAt: new Date('2026-06-13T10:00:00.000Z'),
  });
  await createBareRankingAttempt(prisma, {
    userId: reviewedUser.id,
    project: projects[0],
    attemptNumber: 5,
    finalScore: 100,
    passStatus: TrainingPassStatus.PASSED,
    isConsumed: false,
    completedAt: new Date('2026-06-14T10:00:00.000Z'),
  });
  await createBareRankingAttempt(prisma, {
    userId: needleUsers[1].id,
    project: projects[0],
    attemptNumber: 1,
    finalScore: 75,
    passStatus: TrainingPassStatus.PASSED,
    completedAt: new Date('2026-06-16T10:00:00.000Z'),
  });

  const noAttemptUser = await createRankingUser(prisma, {
    roleId: trainingRoleId,
    passwordHash,
    unique,
    suffix: 'null-average',
    name: 'Null Average Ranking',
  });

  return {
    projects: projects.map((project) => project.id),
    exactUsers,
    tieUsers,
    needleUsers,
    reviewedUser,
    noAttemptUser,
    totalEligibleUsers: 3 + 90 + 3 + 2 + 2 + 1,
    unique,
  };
}

async function createRankingUser(
  prisma,
  { roleId, passwordHash, unique, suffix, name },
) {
  return prisma.user.create({
    data: {
      email: `rank-${suffix}-${unique}@example.test`,
      passwordHash,
      name,
      status: UserStatus.ACTIVE,
      roleId,
    },
  });
}

async function createBareRankingAttempt(
  prisma,
  {
    userId,
    project,
    attemptNumber,
    finalScore,
    passStatus,
    reviewStatus = TrainingReviewStatus.NOT_REQUIRED,
    status = TrainingAttemptStatus.COMPLETED,
    isConsumed = true,
    completedAt,
  },
) {
  return prisma.trainingAttempt.create({
    data: {
      userId,
      projectId: project.id,
      projectVersionId: project.versionId,
      attemptNumber,
      status,
      isConsumed,
      startedAt: new Date(completedAt.getTime() - 300_000),
      expiresAt: new Date(completedAt.getTime() + 60_000),
      graceExpiresAt: new Date(completedAt.getTime() + 120_000),
      completedAt,
      settingsSnapshotJson: {},
      aiScore: finalScore,
      serverScore: finalScore,
      finalScore,
      passStatus,
      reviewStatus,
      summary: 'ranking fixture',
      totalDurationSeconds: 300,
    },
  });
}

async function assertRankingPaginationAndExactNumeric({
  baseUrl,
  prisma,
  token,
  fixture,
}) {
  const headers = authorization(token);
  const pageLoadStartedAt = performance.now();
  const pageOne = await fetchRanking(baseUrl, headers, 'page=1&pageSize=10');
  const pageTwo = await fetchRanking(baseUrl, headers, 'page=2&pageSize=10');
  const pageLoadDurationMs = performance.now() - pageLoadStartedAt;
  assert.equal(pageOne.items.length, 10);
  assert.equal(pageTwo.items.length, 10);
  assert.equal(
    pageOne.pagination.total,
    fixture.ranking.totalEligibleUsers,
  );
  assert.equal(pageTwo.pagination.total, pageOne.pagination.total);
  assert.ok(pageOne.pagination.total >= 100);
  assert.ok(pageLoadDurationMs < 5_000);
  assert.equal(
    pageOne.items.some((first) =>
      pageTwo.items.some((second) => second.user.id === first.user.id),
    ),
    false,
  );

  const scopedUserIdFilters = [];
  let scopedQueryCount = 0;
  const scopedService = new TrainingRankingService({
    $queryRaw: (query) => {
      scopedQueryCount += 1;
      return prisma.$queryRaw(query);
    },
    trainingAttempt: {
      findMany: (args) => {
        scopedQueryCount += 1;
        scopedUserIdFilters.push(args.where.userId.in);
        return prisma.trainingAttempt.findMany(args);
      },
      groupBy: (args) => {
        scopedQueryCount += 1;
        return prisma.trainingAttempt.groupBy(args);
      },
    },
    trainingProject: {
      findMany: (args) => {
        scopedQueryCount += 1;
        return prisma.trainingProject.findMany(args);
      },
    },
  });
  const scopedPage = await scopedService.list({ page: 2, pageSize: 2 });
  assert.equal(scopedPage.items.length, 2);
  assert.equal(scopedQueryCount, 4);
  assert.deepEqual(
    [...new Set(scopedUserIdFilters.flat())].sort(),
    scopedPage.items.map((item) => item.user.id).sort(),
  );
  const queryCountBeforeExport = scopedQueryCount;
  const scopedExport = await scopedService.listForExport({});
  const scopedExportQueryCount = scopedQueryCount - queryCountBeforeExport;
  assert.equal(scopedExport.pagination.total, pageOne.pagination.total);
  assert.equal(
    scopedExportQueryCount,
    Math.ceil(pageOne.pagination.total / 100) * 4,
  );

  const needle = await fetchRanking(
    baseUrl,
    headers,
    `page=1&pageSize=1&user=${encodeURIComponent('Needle Ranking')}`,
  );
  assert.equal(needle.items.length, 1);
  assert.equal(needle.pagination.total, 2);

  const projectFiltered = await fetchRanking(
    baseUrl,
    headers,
    `page=1&pageSize=1&projectId=${fixture.ranking.projects[9]}`,
  );
  assert.equal(projectFiltered.items.length, 1);
  assert.equal(projectFiltered.pagination.total, 3);

  const reviewed = await fetchRanking(
    baseUrl,
    headers,
    `page=1&pageSize=10&user=${encodeURIComponent(
      fixture.ranking.reviewedUser.email,
    )}`,
  );
  assert.equal(reviewed.pagination.total, 1);
  assert.equal(reviewed.items[0].projects[0].finalScore, '90');
  assert.equal(reviewed.items[0].projects[0].attemptNumber, 1);
  assert.equal(reviewed.items[0].attemptsUsed, 4);
  assert.equal(
    reviewed.items[0].projects.some((project) =>
      ['99', '100'].includes(project.finalScore),
    ),
    false,
  );

  const exact = await fetchRanking(
    baseUrl,
    headers,
    `page=1&pageSize=10&user=${encodeURIComponent('Exact Average')}`,
  );
  assert.deepEqual(
    exact.items.map((item) => item.user.id),
    [
      fixture.ranking.exactUsers[2].id,
      fixture.ranking.exactUsers[1].id,
      fixture.ranking.exactUsers[0].id,
    ],
  );
  assert.deepEqual(
    exact.items.map((item) => item.averageBestScore),
    ['85.01', '85.00', '85.00'],
  );

  const ties = await fetchRanking(
    baseUrl,
    headers,
    `page=1&pageSize=10&user=${encodeURIComponent('Stable Tie')}`,
  );
  assert.deepEqual(
    ties.items.map((item) => item.user.id),
    fixture.ranking.tieUsers.map((user) => user.id).sort(),
  );

  const nullAverage = await fetchRanking(
    baseUrl,
    headers,
    `page=1&pageSize=10&user=${encodeURIComponent(
      fixture.ranking.noAttemptUser.email,
    )}`,
  );
  assert.equal(nullAverage.items[0].averageBestScore, null);
  assert.deepEqual(nullAverage.items[0].projects, []);

  const exactCsvResponse = await fetch(
    `${baseUrl}/training/admin/ranking/export.csv?user=${encodeURIComponent(
      'Exact Average',
    )}`,
    { headers },
  );
  assert.equal(exactCsvResponse.status, 200);
  const exactCsv = await exactCsvResponse.text();
  const exactEmails = exact.items.map((item) => item.user.email);
  assert.ok(exactCsv.indexOf(exactEmails[0]) < exactCsv.indexOf(exactEmails[1]));
  assert.ok(exactCsv.indexOf(exactEmails[1]) < exactCsv.indexOf(exactEmails[2]));

  const fullCsvStartedAt = performance.now();
  const fullCsvResponse = await fetch(
    `${baseUrl}/training/admin/ranking/export.csv`,
    { headers },
  );
  assert.equal(fullCsvResponse.status, 200);
  const fullCsv = await fullCsvResponse.text();
  const fullCsvDurationMs = performance.now() - fullCsvStartedAt;
  assert.ok(fullCsv.split('\r\n').length >= pageOne.pagination.total + 1);
  assert.ok(fullCsvDurationMs < 5_000);
  console.log(
    `Stage 10 ranking load: users=${pageOne.pagination.total}, pages=${pageLoadDurationMs.toFixed(
      3,
    )}ms, csv=${fullCsvDurationMs.toFixed(
      3,
    )}ms, queriesPerPage=4, csvQueries=${scopedExportQueryCount}`,
  );

  const planRows = await prisma.$queryRaw(
    Prisma.sql`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      ${buildTrainingRankingPageQuery({ page: 1, pageSize: 10 }, 0)}
    `,
  );
  const planText = JSON.stringify(planRows);
  const explain = planRows[0]['QUERY PLAN'][0];
  const planRelations = [
    ...collectPlanValues(explain.Plan, 'Relation Name'),
  ].sort();
  console.log(
    `Stage 10 ranking EXPLAIN: execution=${explain['Execution Time'].toFixed(
      3,
    )}ms, root=${explain.Plan['Node Type']}, relations=${planRelations.join(
      ',',
    )}`,
  );
  assert.match(planText, /Limit/u);
  for (const forbiddenRelation of [
    'training_answers',
    'training_answer_evaluations',
    'training_score_components',
    'training_voice_segments',
    'training_provider_runs',
  ]) {
    assert.equal(
      planText.includes(forbiddenRelation),
      false,
      forbiddenRelation,
    );
  }
}

function collectPlanValues(node, key) {
  const values = [];
  if (typeof node?.[key] === 'string') values.push(node[key]);
  for (const child of node?.Plans ?? []) {
    values.push(...collectPlanValues(child, key));
  }
  return values;
}

async function fetchRanking(baseUrl, headers, query) {
  const response = await fetch(
    `${baseUrl}/training/admin/ranking?${query}`,
    { headers },
  );
  assert.equal(response.status, 200);
  return response.json();
}

function assertEmployeePayloadHasNoInternalScores(value) {
  const forbiddenKeys = new Set([
    'serverScore',
    'aiScore',
    'adminScore',
    'override',
  ]);
  visitJson(value, (key) => {
    assert.equal(forbiddenKeys.has(key), false, key);
  });
}

function visitJson(value, visit) {
  if (Array.isArray(value)) {
    for (const item of value) visitJson(item, visit);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    visit(key);
    visitJson(item, visit);
  }
}
