require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ConflictException,
  UnprocessableEntityException,
} = require('@nestjs/common');
const {
  PrismaClient,
  TrainingProjectStatus,
  TrainingQuestionType,
  TrainingVersionStatus,
  UserStatus,
} = require('@prisma/client');

const {
  TrainingContentService,
} = require('../dist/training/training-content.service.js');

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
      mutationService.createQuestion(
        fixture.version.id,
        {
          type: TrainingQuestionType.FOLLOW_UP,
          text: 'Поздний вопрос после начала публикации',
          position: 10,
          isActive: true,
          maxScore: 15,
          topicCodes: ['race'],
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
    await observerPrisma.trainingQuestion.count({
      where: {
        projectVersionId: fixture.version.id,
        text: 'Поздний вопрос после начала публикации',
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
      'training.question.create',
      fixture.version.id,
    ),
    0,
  );
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
  await observerPrisma.trainingQuestionFactLink.create({
    data: {
      questionId: mainQuestion.id,
      factId: fact.id,
      isRequired: true,
    },
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
    publisher,
    project,
    version,
    mainQuestion,
    followUpQuestions,
  };
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
