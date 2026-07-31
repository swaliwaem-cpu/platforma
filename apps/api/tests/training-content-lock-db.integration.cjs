require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ConflictException,
  UnprocessableEntityException,
} = require('@nestjs/common');
const {
  PrismaClient,
  TrainingProjectAudienceMode,
  TrainingProjectStatus,
  TrainingQuestionType,
  TrainingVersionStatus,
  UserStatus,
} = require('@prisma/client');

const {
  TrainingContentService,
} = require('../dist/training/training-content.service.js');
const {
  TrainingAttemptEngineService,
} = require('../dist/training/training-attempt-engine.service.js');
const {
  DeterministicFakeTrainingEvaluationProvider,
  DeterministicFakeTrainingTranscriptionProvider,
} = require('../dist/training/training-attempt.providers.js');
const {
  DeterministicQuestionSelector,
  MutableTrainingClock,
} = require('./helpers/training-attempt-fake-prisma.cjs');

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL must point to the runner-created isolated training database',
  );
}

const prismaOptions = {
  transactionOptions: {
    maxWait: 5_000,
    timeout: 20_000,
  },
};
const observerPrisma = new PrismaClient(prismaOptions);
const mutationPrisma = new PrismaClient(prismaOptions);
const publicationPrisma = new PrismaClient(prismaOptions);
const gatePrisma = new PrismaClient(prismaOptions);
const mutationService = new TrainingContentService(mutationPrisma);
const publicationService = new TrainingContentService(publicationPrisma);
const request = {
  headers: {
    'user-agent': 'training-content-lock-db-test',
  },
  ip: '127.0.0.1',
};

test.after(async () => {
  await Promise.all([
    observerPrisma.$disconnect(),
    mutationPrisma.$disconnect(),
    publicationPrisma.$disconnect(),
    gatePrisma.$disconnect(),
  ]);
});

for (const scenario of createMutationFirstScenarios()) {
  test(
    `PostgreSQL race: ${scenario.label} commits before waiting publication validation`,
    async () => {
      const fixture = await createPublishableFixture();
      const actor = createActor(fixture.publisher);
      const baselineWaiters = await countBlockedTransactions();
      const gate = await scenario.holdGate(fixture);
      let mutationResultPromise;
      let publicationResultPromise;

      try {
        mutationResultPromise = settle(
          scenario.mutate(mutationService, fixture, actor),
        );
        await waitForBlockedTransactions(baselineWaiters + 1);

        publicationResultPromise = settle(
          publicationService.publishVersion(fixture.version.id, actor, request),
        );
        await waitForBlockedTransactions(baselineWaiters + 2);

        await gate.release();
        const [mutationResult, publicationResult] = await Promise.all([
          mutationResultPromise,
          publicationResultPromise,
        ]);

        assert.equal(mutationResult.status, 'fulfilled');
        assert.equal(publicationResult.status, 'rejected');
        assert.equal(
          publicationResult.reason instanceof UnprocessableEntityException,
          true,
        );
      } finally {
        await gate.release();
        if (mutationResultPromise) {
          await mutationResultPromise;
        }
        if (publicationResultPromise) {
          await publicationResultPromise;
        }
      }

      const persistedVersion = await observerPrisma.trainingProjectVersion.findUniqueOrThrow({
        where: { id: fixture.version.id },
      });
      const persistedProject = await observerPrisma.trainingProject.findUniqueOrThrow({
        where: { id: fixture.project.id },
      });

      assert.equal(persistedVersion.status, TrainingVersionStatus.DRAFT);
      assert.equal(persistedVersion.publishedAt, null);
      assert.equal(persistedProject.activeVersionId, null);
      assert.equal(persistedProject.status, TrainingProjectStatus.DRAFT);
      const persistedEntityId = await scenario.assertPersisted(fixture);
      assert.equal(
        await observerPrisma.auditLog.count({
          where: {
            action: 'training.version.publish',
            entityId: fixture.version.id,
          },
        }),
        0,
      );
      assert.equal(
        await observerPrisma.auditLog.count({
          where: {
            action: scenario.auditAction,
            entityId: persistedEntityId,
          },
        }),
        1,
      );
    },
  );
}

test('PostgreSQL race: publication commits before a waiting create and the create is rejected', async () => {
  const fixture = await createPublishableFixture();
  const actor = createActor(fixture.publisher);
  assert.equal(
    (
      await publicationService.getVersionReadiness(fixture.version.id)
    ).readiness.readyToPublish,
    true,
  );
  const baselineWaiters = await countBlockedTransactions();
  const gate = await holdVersionRowGate(fixture.version.id);
  let publicationResultPromise;
  let mutationResultPromise;

  try {
    publicationResultPromise = settle(
      publicationService.publishVersion(fixture.version.id, actor, request),
    );
    await waitForBlockedTransactions(baselineWaiters + 1);

    mutationResultPromise = settle(
      mutationService.createFact(
        fixture.version.id,
        {
          code: 'race.late-fact',
          topicCode: 'race',
          statement: 'Поздний факт после начала публикации',
          acceptedAliases: [],
          importance: 1,
          isApproved: true,
          questionIds: [],
        },
        actor,
        request,
      ),
    );
    await waitForBlockedTransactions(baselineWaiters + 2);

    await gate.release();
    const publicationResult = await publicationResultPromise;
    assert.equal(publicationResult.status, 'fulfilled');

    const mutationResult = await mutationResultPromise;
    assert.equal(mutationResult.status, 'rejected');
    assert.equal(mutationResult.reason instanceof ConflictException, true);
    assert.equal(
      mutationResult.reason.message,
      'Published training version is immutable; create a new draft',
    );
  } finally {
    await gate.release();
    if (publicationResultPromise) {
      await publicationResultPromise;
    }
    if (mutationResultPromise) {
      await mutationResultPromise;
    }
  }

  const persistedVersion = await observerPrisma.trainingProjectVersion.findUniqueOrThrow({
    where: { id: fixture.version.id },
  });
  const persistedProject = await observerPrisma.trainingProject.findUniqueOrThrow({
    where: { id: fixture.project.id },
  });

  assert.equal(persistedVersion.status, TrainingVersionStatus.PUBLISHED);
  assert.equal(persistedVersion.publishedAt instanceof Date, true);
  assert.equal(persistedProject.activeVersionId, fixture.version.id);
  assert.equal(persistedProject.status, TrainingProjectStatus.CLOSED);
  assert.equal(
    await observerPrisma.trainingFact.count({
      where: {
        projectVersionId: fixture.version.id,
        code: 'race.late-fact',
      },
    }),
    0,
  );
  assert.equal(
    await observerPrisma.auditLog.count({
      where: {
        action: 'training.version.publish',
        entityId: fixture.version.id,
      },
    }),
    1,
  );
  assert.equal(
    await countAuditForVersion(
      'training.fact.create',
      fixture.version.id,
    ),
    0,
  );
});

test('PostgreSQL race: two concurrent publishes create one current published version', async () => {
  const fixture = await createPublishableFixture();
  const actor = createActor(fixture.publisher);
  const results = await Promise.all([
    settle(publicationService.publishVersion(fixture.version.id, actor, request)),
    settle(mutationService.publishVersion(fixture.version.id, actor, request)),
  ]);

  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    results.filter(
      (result) =>
        result.status === 'rejected' &&
        result.reason instanceof ConflictException &&
        result.reason.message ===
          'Published training version is immutable; create a new draft',
    ).length,
    1,
  );
  const [project, publishedVersions, publishAudits] = await Promise.all([
    observerPrisma.trainingProject.findUniqueOrThrow({
      where: { id: fixture.project.id },
      select: { activeVersionId: true },
    }),
    observerPrisma.trainingProjectVersion.findMany({
      where: {
        projectId: fixture.project.id,
        status: TrainingVersionStatus.PUBLISHED,
      },
      select: { id: true },
    }),
    observerPrisma.auditLog.count({
      where: {
        action: 'training.version.publish',
        entityId: fixture.version.id,
      },
    }),
  ]);
  assert.equal(project.activeVersionId, fixture.version.id);
  assert.deepEqual(publishedVersions, [{ id: fixture.version.id }]);
  assert.equal(publishAudits, 1);
});

test('PostgreSQL publication supersedes the old version and attempts stay pinned', async () => {
  const fixture = await createPublishableFixture();
  const actor = createActor(fixture.publisher);
  await publicationService.publishVersion(fixture.version.id, actor, request);
  await observerPrisma.trainingProject.update({
    where: { id: fixture.project.id },
    data: {
      audienceMode: TrainingProjectAudienceMode.ALL_ELIGIBLE,
      status: TrainingProjectStatus.OPEN,
    },
  });
  const [firstEmployee, secondEmployee] = await Promise.all([
    createEmployee(fixture.role.id, 'before-publication'),
    createEmployee(fixture.role.id, 'after-publication'),
  ]);
  const attemptEngine = createAttemptEngine();
  const firstAttempt = (
    await attemptEngine.confirmStart({
      userId: firstEmployee.id,
      projectId: fixture.project.id,
      confirmed: true,
    })
  ).attempt;
  assert.equal(firstAttempt.projectVersionId, fixture.version.id);

  const draft = await publicationService.createDraftVersion(
    fixture.project.id,
    actor,
    request,
  );
  await publicationService.publishVersion(draft.version.id, actor, request);

  const [oldVersion, newVersion, project, persistedFirstAttempt] =
    await Promise.all([
      observerPrisma.trainingProjectVersion.findUniqueOrThrow({
        where: { id: fixture.version.id },
        select: { status: true },
      }),
      observerPrisma.trainingProjectVersion.findUniqueOrThrow({
        where: { id: draft.version.id },
        select: { status: true },
      }),
      observerPrisma.trainingProject.findUniqueOrThrow({
        where: { id: fixture.project.id },
        select: { activeVersionId: true, status: true },
      }),
      observerPrisma.trainingAttempt.findUniqueOrThrow({
        where: { id: firstAttempt.id },
        select: { projectVersionId: true },
      }),
    ]);
  assert.equal(oldVersion.status, TrainingVersionStatus.SUPERSEDED);
  assert.equal(newVersion.status, TrainingVersionStatus.PUBLISHED);
  assert.equal(project.activeVersionId, draft.version.id);
  assert.equal(project.status, TrainingProjectStatus.OPEN);
  assert.equal(persistedFirstAttempt.projectVersionId, fixture.version.id);

  const secondAttempt = (
    await attemptEngine.confirmStart({
      userId: secondEmployee.id,
      projectId: fixture.project.id,
      confirmed: true,
    })
  ).attempt;
  assert.equal(secondAttempt.projectVersionId, draft.version.id);

  const newMainQuestion = await observerPrisma.trainingQuestion.findFirstOrThrow({
    where: {
      projectVersionId: draft.version.id,
      type: TrainingQuestionType.MAIN,
    },
  });
  for (const [versionId, questionId] of [
    [fixture.version.id, fixture.mainQuestion.id],
    [draft.version.id, newMainQuestion.id],
  ]) {
    await assert.rejects(
      mutationService.updateQuestion(
        versionId,
        questionId,
        { text: 'Недопустимое изменение опубликованной версии' },
        actor,
        request,
      ),
      (error) =>
        error instanceof ConflictException &&
        error.message ===
          'Published training version is immutable; create a new draft',
    );
  }
});

function createMutationFirstScenarios() {
  return [
    {
      label: 'patch question',
      auditAction: 'training.question.update',
      holdGate: (fixture) => holdQuestionRowGate(fixture.mainQuestion.id),
      mutate: (service, fixture, actor) =>
        service.updateQuestion(
          fixture.version.id,
          fixture.mainQuestion.id,
          { isActive: false },
          actor,
          request,
        ),
      assertPersisted: async (fixture) => {
        const updated = await observerPrisma.trainingQuestion.findUniqueOrThrow({
          where: { id: fixture.mainQuestion.id },
        });
        assert.equal(updated.isActive, false);
        return fixture.mainQuestion.id;
      },
    },
    {
      label: 'delete question',
      auditAction: 'training.question.delete',
      holdGate: (fixture) =>
        holdQuestionRowGate(fixture.followUpQuestions[0].id),
      mutate: (service, fixture, actor) =>
        service.deleteQuestion(
          fixture.version.id,
          fixture.followUpQuestions[0].id,
          actor,
          request,
        ),
      assertPersisted: async (fixture) => {
        const deleted = await observerPrisma.trainingQuestion.findUnique({
          where: { id: fixture.followUpQuestions[0].id },
        });
        assert.equal(deleted, null);
        return fixture.followUpQuestions[0].id;
      },
    },
  ];
}

async function holdQuestionRowGate(questionId) {
  return holdTransactionGate(async (tx, ready, release) => {
    await tx.$queryRaw`
      SELECT "id"
      FROM "training_questions"
      WHERE "id" = ${questionId}::uuid
      FOR UPDATE
    `;
    ready();
    await release;
  });
}

async function holdVersionRowGate(versionId) {
  return holdTransactionGate(async (tx, ready, release) => {
    await tx.$queryRaw`
      SELECT "id"
      FROM "training_project_versions"
      WHERE "id" = ${versionId}::uuid
      FOR SHARE
    `;
    ready();
    await release;
  });
}

async function holdTransactionGate(callback, expectedRollback) {
  const readyState = deferred();
  const releaseState = deferred();
  let released = false;
  const completion = gatePrisma
    .$transaction(
      (tx) => callback(tx, readyState.resolve, releaseState.promise),
      prismaOptions.transactionOptions,
    )
    .catch((error) => {
      readyState.reject(error);
      if (error !== expectedRollback) {
        throw error;
      }
    });

  await readyState.promise;

  return {
    release: async () => {
      if (!released) {
        released = true;
        releaseState.resolve();
      }
      await completion;
    },
  };
}

async function countBlockedTransactions() {
  const rows = await observerPrisma.$queryRaw`
    SELECT COUNT(DISTINCT locks."pid")::integer AS "count"
    FROM "pg_locks" AS locks
    INNER JOIN "pg_stat_activity" AS activity
      ON activity."pid" = locks."pid"
    WHERE activity."datname" = current_database()
      AND locks."granted" = false
  `;
  return rows[0]?.count ?? 0;
}

async function countAuditForVersion(action, versionId) {
  const rows = await observerPrisma.$queryRaw`
    SELECT COUNT(*)::integer AS "count"
    FROM "audit_logs"
    WHERE "action" = ${action}
      AND "metadata" ->> 'projectVersionId' = ${versionId}
  `;
  return rows[0]?.count ?? 0;
}

async function waitForBlockedTransactions(minimum) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await countBlockedTransactions()) >= minimum) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${minimum} blocked PostgreSQL transactions`);
}

async function createPublishableFixture() {
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const role = await observerPrisma.role.create({
    data: {
      name: `training-content-lock-${unique}`,
      description: 'Training content lock integration role',
    },
  });
  const publisher = await observerPrisma.user.create({
    data: {
      email: `training-content-lock-${unique}@example.test`,
      passwordHash: 'not-used-in-domain-test',
      name: 'Training content publisher',
      status: UserStatus.ACTIVE,
      roleId: role.id,
    },
  });
  const project = await observerPrisma.trainingProject.create({
    data: {
      slug: `training-content-lock-${unique}`,
      title: `Training content lock ${unique}`,
      status: TrainingProjectStatus.DRAFT,
    },
  });
  const version = await observerPrisma.trainingProjectVersion.create({
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
      allowRetakeAfterPass: false,
      mainMaxScore: 55,
      followUpMaxScore: 15,
    },
  });
  const mainQuestion = await observerPrisma.trainingQuestion.create({
    data: {
      projectVersionId: version.id,
      type: TrainingQuestionType.MAIN,
      text: 'Главный вопрос',
      position: 1,
      isActive: true,
      maxScore: 55,
      topicCodesJson: ['project'],
    },
  });
  const followUpQuestions = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      observerPrisma.trainingQuestion.create({
        data: {
          projectVersionId: version.id,
          type: TrainingQuestionType.FOLLOW_UP,
          text: `Дополнительный вопрос ${index + 1}`,
          position: index + 1,
          isActive: true,
          maxScore: 15,
          topicCodesJson: ['project'],
        },
      }),
    ),
  );
  const fact = await observerPrisma.trainingFact.create({
    data: {
      projectVersionId: version.id,
      code: 'project.fact',
      topicCode: 'project',
      statement: 'Подтверждённый факт для проверки публикации',
      acceptedAliasesJson: [],
      importance: 1,
      isApproved: true,
    },
  });
  await observerPrisma.trainingQuestionFactLink.createMany({
    data: [mainQuestion, ...followUpQuestions].map((question) => ({
      questionId: question.id,
      factId: fact.id,
      isRequired: true,
    })),
  });
  await observerPrisma.trainingEvaluationCriterion.createMany({
    data: [
      {
        projectVersionId: version.id,
        questionType: TrainingQuestionType.MAIN,
        code: 'main-total',
        title: 'Главный ответ',
        maxPoints: 55,
        anchorsJson: [
          { id: 'main-zero', points: 0, description: 'Ответ отсутствует' },
          { id: 'main-full', points: 55, description: 'Полный ответ' },
        ],
        sortOrder: 0,
      },
      {
        projectVersionId: version.id,
        questionType: TrainingQuestionType.FOLLOW_UP,
        code: 'follow-total',
        title: 'Дополнительный ответ',
        maxPoints: 15,
        anchorsJson: [
          { id: 'follow-zero', points: 0, description: 'Ответ отсутствует' },
          {
            id: 'follow-full',
            points: 15,
            description: 'Полный ответ',
          },
        ],
        sortOrder: 0,
      },
    ],
  });

  return {
    role,
    publisher,
    project,
    version,
    mainQuestion,
    followUpQuestions,
  };
}

function createEmployee(roleId, label) {
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return observerPrisma.user.create({
    data: {
      email: `training-content-lock-${label}-${unique}@example.test`,
      passwordHash: 'not-used-in-domain-test',
      name: `Training employee ${label}`,
      status: UserStatus.ACTIVE,
      roleId,
    },
  });
}

function createAttemptEngine() {
  return new TrainingAttemptEngineService(
    observerPrisma,
    new MutableTrainingClock(new Date('2026-08-01T00:00:00.000Z')),
    new DeterministicQuestionSelector(),
    new DeterministicFakeTrainingTranscriptionProvider(),
    new DeterministicFakeTrainingEvaluationProvider(),
  );
}

function createActor(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    permissions: ['training:projects:manage'],
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function settle(promise) {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }),
  );
}
