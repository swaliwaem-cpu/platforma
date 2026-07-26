require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  PrismaClient,
  TrainingAttemptStatus,
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
} = require('../dist/training/training-attempt.providers.js');
const {
  DeterministicQuestionSelector,
  MutableTrainingClock,
} = require('./helpers/training-attempt-fake-prisma.cjs');

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL must point to an isolated migrated database for the training attempt integration test',
  );
}

test('PostgreSQL integration serializes concurrent start, persists full 1 + 3 flow and blocks the fourth consumed attempt', async () => {
  const prisma = new PrismaClient();
  const clock = new MutableTrainingClock(
    new Date('2026-07-25T10:00:00.000Z'),
  );
  const service = new TrainingAttemptEngineService(
    prisma,
    clock,
    new DeterministicQuestionSelector(),
    new DeterministicFakeTrainingTranscriptionProvider(),
    new DeterministicFakeTrainingEvaluationProvider(),
  );

  try {
    const fixture = await createFixture(prisma);
    const starts = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        service.confirmStart({
          userId: fixture.userId,
          projectId: fixture.projectId,
          confirmed: true,
        }),
      ),
    );
    const fulfilled = starts.filter((result) => result.status === 'fulfilled');

    assert.equal(fulfilled.length, 1);
    assert.equal(
      starts.filter((result) => result.status === 'rejected').length,
      11,
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

    let current = fulfilled[0].value.attempt;
    current = await completeAttempt(service, clock, current, 100);
    assert.equal(current.status, TrainingAttemptStatus.COMPLETED);
    assert.equal(Number(current.serverScore), 100);
    assert.equal(Number(current.finalScore), 100);

    for (let index = 0; index < 2; index += 1) {
      clock.advanceSeconds(3_601);
      current = (
        await service.confirmStart({
          userId: fixture.userId,
          projectId: fixture.projectId,
          confirmed: true,
        })
      ).attempt;
      current = await completeAttempt(service, clock, current, 1_000 + index * 100);
      assert.equal(current.status, TrainingAttemptStatus.COMPLETED);
    }

    clock.advanceSeconds(3_601);
    await assert.rejects(
      () =>
        service.confirmStart({
          userId: fixture.userId,
          projectId: fixture.projectId,
          confirmed: true,
        }),
      /attempt limit is exhausted/u,
    );
    assert.equal(
      await prisma.trainingAttempt.count({
        where: {
          userId: fixture.userId,
          projectId: fixture.projectId,
          isConsumed: true,
        },
      }),
      3,
    );
  } finally {
    await prisma.$disconnect();
  }
});

async function createFixture(prisma) {
  const role = await prisma.role.create({
    data: {
      name: `training-stage5-${Date.now()}`,
      description: 'Stage 5 isolated integration role',
    },
  });
  const user = await prisma.user.create({
    data: {
      email: `training-stage5-${Date.now()}@example.test`,
      passwordHash: 'not-used-in-domain-test',
      name: 'Stage 5 User',
      status: UserStatus.ACTIVE,
      roleId: role.id,
    },
  });
  const project = await prisma.trainingProject.create({
    data: {
      slug: `training-stage5-${Date.now()}`,
      title: 'Stage 5 integration project',
      status: TrainingProjectStatus.DRAFT,
    },
  });
  const version = await prisma.trainingProjectVersion.create({
    data: {
      projectId: project.id,
      versionNumber: 1,
      status: TrainingVersionStatus.DRAFT,
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
  const fact = await prisma.trainingFact.create({
    data: {
      projectVersionId: version.id,
      code: 'main.fact',
      topicCode: 'main',
      statement: 'Утверждённый факт',
      isApproved: true,
    },
  });
  await prisma.trainingQuestionFactLink.create({
    data: {
      questionId: main.id,
      factId: fact.id,
      isRequired: true,
    },
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
      publishedById: user.id,
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
    projectId: project.id,
    userId: user.id,
  };
}

async function completeAttempt(service, clock, attempt, seed) {
  for (let questionIndex = 0; questionIndex < 4; questionIndex += 1) {
    const current = (await service.getAttempt(attempt.id)).attempt;
    const targetQuestion = current.attemptQuestions.find((question) =>
      ['PRESENTED', 'COLLECTING'].includes(question.status),
    );
    assert.ok(targetQuestion);
    await service.appendVoiceSegment({
      attemptId: attempt.id,
      kind: 'VOICE',
      updateId: BigInt(seed + questionIndex),
      fakeTranscript: `Ответ ${questionIndex + 1}`,
      recordingStartedAt: clock.now(),
      durationSeconds: 5,
    });
    await service.finishAnswer({
      attemptId: attempt.id,
      attemptQuestionId: targetQuestion.id,
    });
  }
  return (await service.getAttempt(attempt.id)).attempt;
}
