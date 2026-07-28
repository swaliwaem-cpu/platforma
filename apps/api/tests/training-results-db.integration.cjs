require('reflect-metadata');

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const argon2 = require('argon2');
const {
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
    assert.equal('summary' in pendingDetail.attempt, false);
    assert.ok(
      pendingDetail.attempt.questions.every(
        (question) =>
          question.score === null && question.components.length === 0,
      ),
    );
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
    'training:projects:read',
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
      'training:projects:read',
      'training:take',
      'training:own-results:read',
    ],
    other: [
      'training:projects:read',
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
    users[name] = { id: user.id, email, password };
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
      awarded: 18,
      maximum: 20,
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

  return {
    users,
    projectIds: { first: first.id, second: second.id },
    attemptIds: {
      old: old.id,
      best: best.id,
      pending: pending.id,
      foreign: foreign.id,
    },
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
  return { id: project.id, versionId: version.id, questionId: question.id };
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
      aiScore: input.finalScore,
      serverScore: input.finalScore,
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
        aiSuggestedScore: input.finalScore ?? 0,
        serverScore: input.finalScore ?? 0,
        summary: 'fixture evaluation',
        requiresReview:
          input.reviewStatus === TrainingReviewStatus.PENDING,
      },
    });
    if (input.component) {
      await prisma.trainingScoreComponent.create({
        data: {
          evaluationId: evaluation.id,
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
