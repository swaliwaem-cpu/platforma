require('reflect-metadata');

const assert = require('node:assert/strict');
const http = require('node:http');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { JwtService } = require('@nestjs/jwt');
const {
  PrismaClient,
  TrainingAnswerStatus,
  TrainingAttemptQuestionStatus,
  TrainingAttemptStatus,
  TrainingJobKind,
  TrainingJobStatus,
  TrainingPassStatus,
  TrainingProviderKind,
  TrainingProviderRunStatus,
  TrainingProjectStatus,
  TrainingQuestionType,
  TrainingReviewStatus,
  TrainingVersionStatus,
  UserStatus,
} = require('@prisma/client');

const {
  TrainingAttemptEngineService,
} = require('../dist/training/training-attempt-engine.service.js');
const {
  TrainingReviewController,
} = require('../dist/training/training-review.controller.js');
const {
  AuthModule,
} = require('../dist/auth/auth.module.js');
const {
  DeterministicFakeTrainingEvaluationProvider,
  DeterministicFakeTrainingTranscriptionProvider,
} = require('../dist/training/training-attempt.providers.js');
const {
  TrainingOpenAiHttpClient,
} = require('../dist/training/openai/training-openai.http.js');
const {
  OpenAiTrainingEvaluationProvider,
} = require('../dist/training/openai/training-openai-evaluation.provider.js');
const {
  OpenAiTrainingTranscriptionProvider,
} = require('../dist/training/openai/training-openai-transcription.provider.js');
const {
  DeterministicQuestionSelector,
  MutableTrainingClock,
} = require('./helpers/training-attempt-fake-prisma.cjs');

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL must point to the runner-created isolated training database',
  );
}

const prisma = new PrismaClient();
const fakeTranscription = new DeterministicFakeTrainingTranscriptionProvider();
const fakeEvaluation = new DeterministicFakeTrainingEvaluationProvider();

test.after(async () => {
  await prisma.$disconnect();
});

test('PostgreSQL race: concurrent confirmStart creates one consumed active attempt', async () => {
  const fixture = await createFixture();
  const clock = createClock();
  const service = createService(clock);
  const starts = await Promise.allSettled(
    Array.from({ length: 12 }, () =>
      service.confirmStart({
        userId: fixture.userId,
        projectId: fixture.projectId,
        confirmed: true,
      }),
    ),
  );

  assert.equal(
    starts.filter((result) => result.status === 'fulfilled').length,
    1,
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

test('PostgreSQL race: finishAnswer against timeout preserves one score and timeout skips', async () => {
  const fixture = await createFixture();
  const clock = createClock();
  const service = createService(clock);
  const attempt = await startAttempt(service, fixture);
  await appendVoice(service, clock, attempt, 20_001n, 'finish timeout');
  clock.set(attempt.expiresAt);

  await Promise.allSettled([
    service.finishAnswer({
      attemptId: attempt.id,
      attemptQuestionId: attempt.attemptQuestions[0].id,
    }),
    service.handleTimeout(attempt.id, clock.now()),
  ]);
  const completed = (await service.getAttempt(attempt.id)).attempt;

  assert.equal(completed.status, TrainingAttemptStatus.COMPLETED);
  assert.equal(Number(completed.finalScore), 55);
  assert.equal(
    await prisma.trainingAnswerEvaluation.count({
      where: {
        answer: {
          attemptQuestion: {
            attemptId: attempt.id,
          },
        },
      },
    }),
    1,
  );
  assert.equal(
    await prisma.trainingAttemptQuestion.count({
      where: {
        attemptId: attempt.id,
        status: TrainingAttemptQuestionStatus.SKIPPED_TIMEOUT,
      },
    }),
    3,
  );
});

test('PostgreSQL race: two finishAnswer commands create one evaluation', async () => {
  const fixture = await createFixture();
  const clock = createClock();
  const service = createService(clock);
  const attempt = await startAttempt(service, fixture);
  await appendVoice(service, clock, attempt, 20_101n, 'two finish');
  const command = {
    attemptId: attempt.id,
    attemptQuestionId: attempt.attemptQuestions[0].id,
  };

  const results = await Promise.allSettled([
    service.finishAnswer(command),
    service.finishAnswer(command),
  ]);

  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    2,
  );
  assert.equal(
    await prisma.trainingAnswerEvaluation.count({
      where: {
        answer: {
          attemptQuestion: {
            attemptId: attempt.id,
          },
        },
      },
    }),
    1,
  );
});

test('PostgreSQL race: duplicate voice segment creates one persisted segment', async () => {
  const fixture = await createFixture();
  const clock = createClock();
  const service = createService(clock);
  const attempt = await startAttempt(service, fixture);
  const command = {
    attemptId: attempt.id,
    kind: 'VOICE',
    updateId: 20_201n,
    fakeTranscript: 'duplicate voice',
    recordingStartedAt: clock.now(),
  };

  const results = await Promise.allSettled([
    service.appendVoiceSegment(command),
    service.appendVoiceSegment(command),
  ]);

  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    2,
  );
  assert.equal(
    await prisma.trainingVoiceSegment.count({
      where: {
        answer: {
          attemptQuestion: {
            attemptId: attempt.id,
          },
        },
      },
    }),
    1,
  );
});

test('PostgreSQL race: voice segment against finishAnswer never appends after the answer lock', async () => {
  const fixture = await createFixture();
  const clock = createClock();
  const service = createService(clock);
  const attempt = await startAttempt(service, fixture);
  await appendVoice(service, clock, attempt, 20_301n, 'first segment');

  const results = await Promise.allSettled([
    service.appendVoiceSegment({
      attemptId: attempt.id,
      kind: 'VOICE',
      updateId: 20_302n,
      fakeTranscript: 'racing segment',
      recordingStartedAt: clock.now(),
    }),
    service.finishAnswer({
      attemptId: attempt.id,
      attemptQuestionId: attempt.attemptQuestions[0].id,
    }),
  ]);
  const persistedSegments = await prisma.trainingVoiceSegment.count({
    where: {
      answer: {
        attemptQuestion: {
          attemptId: attempt.id,
        },
      },
    },
  });

  assert.equal(
    results.some((result) => result.status === 'fulfilled'),
    true,
  );
  assert.equal([1, 2].includes(persistedSegments), true);
  assert.equal(
    await prisma.trainingAnswerEvaluation.count({
      where: {
        answer: {
          attemptQuestion: {
            attemptId: attempt.id,
          },
        },
      },
    }),
    1,
  );
});

test('PostgreSQL race: two finalize workers produce one final result', async () => {
  const fixture = await createFixture();
  const clock = createClock();
  let firstService;
  let evaluations = 0;
  const stoppingEvaluationProvider = {
    evaluate: async (input) => {
      evaluations += 1;
      const result = await fakeEvaluation.evaluate(input);
      if (evaluations === 4) firstService.onModuleDestroy();
      return result;
    },
  };
  firstService = createService(clock, {
    evaluationProvider: stoppingEvaluationProvider,
  });
  let attempt = await startAttempt(firstService, fixture);
  attempt = await completeAttempt(firstService, clock, attempt, 20_400);
  assert.equal(attempt.status, TrainingAttemptStatus.FINALIZING);

  const workerOne = createService(clock);
  const workerTwo = createService(clock);
  await Promise.all([
    workerOne.finalizeAttempt(attempt.id),
    workerTwo.finalizeAttempt(attempt.id),
  ]);
  const completed = (await workerOne.getAttempt(attempt.id)).attempt;

  assert.equal(completed.status, TrainingAttemptStatus.COMPLETED);
  assert.equal(Number(completed.finalScore), 100);
  assert.equal(
    await prisma.trainingJob.count({
      where: {
        kind: TrainingJobKind.FINALIZE_ATTEMPT,
        idempotencyKey: `attempt:${attempt.id}:finalize`,
      },
    }),
    1,
  );
});

test('PostgreSQL race: two refunds create one audit and refund once', async () => {
  const fixture = await createFixture({ attemptLimit: 1 });
  const clock = createClock();
  const failingService = createService(clock, {
    evaluationProvider: {
      evaluate: async () => {
        throw new Error('postgres refund fixture failure');
      },
    },
  });
  const attempt = await startAttempt(failingService, fixture);
  await appendVoice(failingService, clock, attempt, 20_501n, 'refund');
  await assert.rejects(() =>
    failingService.finishAnswer({
      attemptId: attempt.id,
      attemptQuestionId: attempt.attemptQuestions[0].id,
    }),
  );
  const failedAnswer = await prisma.trainingAnswer.findFirstOrThrow({
    where: { attemptQuestion: { attemptId: attempt.id } },
  });
  const failedProviderRun =
    await prisma.trainingProviderRun.findFirstOrThrow({
      where: {
        answerId: failedAnswer.id,
        kind: TrainingProviderKind.EVALUATION,
      },
    });
  assert.equal(failedAnswer.status, TrainingAnswerStatus.FAILED);
  assert.equal(
    failedProviderRun.status,
    TrainingProviderRunStatus.FAILED,
  );

  const command = {
    attemptId: attempt.id,
    actorUserId: fixture.publisherId,
    reason: 'Подтверждённый системный сбой',
  };
  await Promise.all([
    createService(clock).refundTechnicalFailure(command),
    createService(clock).refundTechnicalFailure(command),
  ]);
  const refunded = await prisma.trainingAttempt.findUnique({
    where: { id: attempt.id },
  });

  assert.equal(refunded.isConsumed, false);
  assert.equal(
    await prisma.auditLog.count({
      where: {
        action: 'training.attempt.refund',
        entityId: attempt.id,
      },
    }),
    1,
  );

});

test('PostgreSQL recovery: two workers claim one READY job without duplicates', async () => {
  const fixture = await createFixture();
  const clock = createClock();
  const stoppedService = createService(clock);
  const attempt = await startAttempt(stoppedService, fixture);
  await appendVoice(stoppedService, clock, attempt, 20_601n, 'ready recovery');
  stoppedService.onModuleDestroy();
  await stoppedService.finishAnswer({
    attemptId: attempt.id,
    attemptQuestionId: attempt.attemptQuestions[0].id,
  });

  let transcriptionCalls = 0;
  let evaluationCalls = 0;
  const providers = {
    transcriptionProvider: {
      transcribe: async (input) => {
        transcriptionCalls += 1;
        return fakeTranscription.transcribe(input);
      },
    },
    evaluationProvider: {
      evaluate: async (input) => {
        evaluationCalls += 1;
        return fakeEvaluation.evaluate(input);
      },
    },
  };
  await Promise.all([
    createService(clock, providers).recoverPendingProcessing(),
    createService(clock, providers).recoverPendingProcessing(),
  ]);

  assert.equal(transcriptionCalls, 1);
  assert.equal(evaluationCalls, 1);
  assert.equal(
    await prisma.trainingAnswerEvaluation.count({
      where: {
        answer: {
          attemptQuestion: {
            attemptId: attempt.id,
          },
        },
      },
    }),
    1,
  );
  assert.equal(
    await prisma.trainingScoreComponent.count({
      where: {
        evaluation: {
          answer: {
            attemptQuestion: {
              attemptId: attempt.id,
            },
          },
        },
      },
    }),
    1,
  );
});

test('PostgreSQL runtime disable after attempt-job claim prevents providers and re-enable resumes processing', async () => {
  const fixture = await createFixture();
  const clock = createClock();
  const stoppedService = createService(clock);
  const attempt = await startAttempt(stoppedService, fixture);
  await appendVoice(
    stoppedService,
    clock,
    attempt,
    20_651n,
    'runtime disable recovery',
  );
  stoppedService.onModuleDestroy();
  await stoppedService.finishAnswer({
    attemptId: attempt.id,
    attemptQuestionId: attempt.attemptQuestions[0].id,
  });

  let enabled = true;
  let transcriptionCalls = 0;
  let evaluationCalls = 0;
  const trainingConfig = {
    isEnabled: () => enabled,
  };
  const providers = {
    transcriptionProvider: {
      async transcribe(input) {
        transcriptionCalls += 1;
        return fakeTranscription.transcribe(input);
      },
    },
    evaluationProvider: {
      async evaluate(input) {
        evaluationCalls += 1;
        return fakeEvaluation.evaluate(input);
      },
    },
  };
  const pausedPrisma = proxyPrismaTrainingJob({
    async updateMany(delegate, args) {
      const result = await delegate.updateMany(args);
      if (
        result.count === 1 &&
        args.data?.status === TrainingJobStatus.RUNNING &&
        args.data?.lockOwner
      ) {
        enabled = false;
      }
      return result;
    },
  });
  await createService(clock, {
    ...providers,
    prismaClient: pausedPrisma,
    trainingConfig,
  }).recoverPendingProcessing();

  let job = await prisma.trainingJob.findFirstOrThrow({
    where: {
      kind: TrainingJobKind.TRANSCRIBE_ANSWER,
      idempotencyKey: { startsWith: `attempt:${attempt.id}:answer:` },
    },
  });
  assert.equal(transcriptionCalls, 0);
  assert.equal(evaluationCalls, 0);
  assert.equal(job.status, TrainingJobStatus.PENDING);
  assert.equal(job.attempts, 0);
  assert.equal(job.lockOwner, null);
  assert.equal(job.lastErrorCode, 'TRAINING_DISABLED_AFTER_CLAIM');

  enabled = true;
  await createService(clock, {
    ...providers,
    trainingConfig,
  }).recoverPendingProcessing();
  job = await prisma.trainingJob.findUnique({ where: { id: job.id } });
  assert.equal(job.status, TrainingJobStatus.SUCCEEDED);
  assert.equal(job.attempts, 1);
  assert.equal(transcriptionCalls, 1);
  assert.equal(evaluationCalls, 1);
  assert.equal(
    (
      await prisma.trainingAttemptQuestion.findUnique({
        where: { id: attempt.attemptQuestions[0].id },
      })
    ).status,
    TrainingAttemptQuestionStatus.SCORED,
  );
});

test('PostgreSQL runtime disable after finalization lock prevents mutation and restart resumes it', async () => {
  const fixture = await createFixture();
  const clock = createClock();
  let preparingService;
  let evaluations = 0;
  preparingService = createService(clock, {
    evaluationProvider: {
      async evaluate(input) {
        evaluations += 1;
        const result = await fakeEvaluation.evaluate(input);
        if (evaluations === 4) preparingService.onModuleDestroy();
        return result;
      },
    },
  });
  let attempt = await startAttempt(preparingService, fixture);
  attempt = await completeAttempt(
    preparingService,
    clock,
    attempt,
    20_652,
  );
  assert.equal(attempt.status, TrainingAttemptStatus.FINALIZING);
  const finalizationJob = await prisma.trainingJob.findUniqueOrThrow({
    where: { idempotencyKey: `attempt:${attempt.id}:finalize` },
  });

  let enabled = true;
  const trainingConfig = {
    isEnabled: () => enabled,
  };
  const pausedPrisma = proxyPrismaFinalizationLockGate(
    finalizationJob.id,
    () => {
      enabled = false;
    },
  );
  await createService(clock, {
    prismaClient: pausedPrisma,
    trainingConfig,
  }).recoverPendingProcessing();

  let [persistedAttempt, persistedJob] = await Promise.all([
    prisma.trainingAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    }),
    prisma.trainingJob.findUniqueOrThrow({
      where: { id: finalizationJob.id },
    }),
  ]);
  assert.equal(persistedAttempt.status, TrainingAttemptStatus.FINALIZING);
  assert.equal(persistedAttempt.finalScore, null);
  assert.equal(persistedJob.status, TrainingJobStatus.PENDING);
  assert.equal(persistedJob.attempts, 0);
  assert.equal(persistedJob.lockOwner, null);
  assert.equal(
    persistedJob.lastErrorCode,
    'TRAINING_DISABLED_AFTER_CLAIM',
  );

  enabled = true;
  await createService(clock, {
    trainingConfig,
  }).recoverPendingProcessing();
  [persistedAttempt, persistedJob] = await Promise.all([
    prisma.trainingAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    }),
    prisma.trainingJob.findUniqueOrThrow({
      where: { id: finalizationJob.id },
    }),
  ]);
  assert.equal(persistedAttempt.status, TrainingAttemptStatus.COMPLETED);
  assert.equal(Number(persistedAttempt.finalScore), 100);
  assert.equal(persistedJob.status, TrainingJobStatus.SUCCEEDED);
  assert.equal(persistedJob.attempts, 1);
});

test('PostgreSQL restart: READY, TRANSCRIBING, EVALUATING and FINALIZING all resume', async (t) => {
  await t.test('READY', async () => {
    const fixture = await createFixture();
    const clock = createClock();
    const firstService = createService(clock);
    const attempt = await startAttempt(firstService, fixture);
    await appendVoice(firstService, clock, attempt, 20_701n, 'restart ready');
    firstService.onModuleDestroy();
    await firstService.finishAnswer({
      attemptId: attempt.id,
      attemptQuestionId: attempt.attemptQuestions[0].id,
    });

    const recoveredService = createService(clock);
    await recoveredService.recoverPendingProcessing();
    assert.equal(
      (
        await prisma.trainingAttemptQuestion.findUnique({
          where: { id: attempt.attemptQuestions[0].id },
        })
      ).status,
      TrainingAttemptQuestionStatus.SCORED,
    );
  });

  await t.test('TRANSCRIBING becomes ambiguous and needs explicit reprocessing', async () => {
    const fixture = await createFixture();
    const clock = createClock();
    const deferred = createDeferred();
    const firstService = createService(clock, {
      transcriptionProvider: {
        transcribe: async () => deferred.promise,
      },
    });
    const attempt = await startAttempt(firstService, fixture);
    await appendVoice(
      firstService,
      clock,
      attempt,
      20_702n,
      'restart transcribing',
    );
    void firstService
      .finishAnswer({
        attemptId: attempt.id,
        attemptQuestionId: attempt.attemptQuestions[0].id,
      })
      .catch(() => {});
    await waitForAnswerStatus(attempt.id, TrainingAnswerStatus.TRANSCRIBING);
    await waitForProviderRunStatus(
      attempt.id,
      TrainingProviderKind.TRANSCRIPTION,
      TrainingProviderRunStatus.REQUESTING,
    );
    firstService.onModuleDestroy();
    clock.advanceSeconds(31);

    let recoveredProviderCalls = 0;
    const recoveredService = createService(clock, {
      transcriptionProvider: {
        transcribe: async (input) => {
          recoveredProviderCalls += 1;
          return fakeTranscription.transcribe(input);
        },
      },
    });
    await recoveredService.recoverPendingProcessing();
    assert.equal(
      (await recoveredService.getAttempt(attempt.id)).attempt.status,
      TrainingAttemptStatus.TECHNICAL_FAILURE,
    );
    assert.equal(await countEvaluations(attempt.id), 0);
    assert.equal(recoveredProviderCalls, 0);
    const answer = await prisma.trainingAnswer.findFirstOrThrow({
      where: { attemptQuestion: { attemptId: attempt.id } },
    });
    assert.equal(answer.status, TrainingAnswerStatus.FAILED);
    const primaryRun = await prisma.trainingProviderRun.findFirstOrThrow({
      where: {
        answerId: answer.id,
        kind: TrainingProviderKind.TRANSCRIPTION,
      },
    });
    assert.equal(primaryRun.runType, 'PRIMARY');
    assert.equal(primaryRun.status, TrainingProviderRunStatus.AMBIGUOUS);
    await recoveredService.reprocessTranscription({
      answerId: answer.id,
      reviewerId: fixture.publisherId,
      comment: 'Explicit retry after ambiguous transcription',
    });
    await recoveredService.recoverPendingProcessing();
    assert.equal(await countEvaluations(attempt.id), 1);
    assert.equal(recoveredProviderCalls, 1);
    const transcriptionRuns = await prisma.trainingProviderRun.findMany({
      where: {
        answerId: answer.id,
        kind: TrainingProviderKind.TRANSCRIPTION,
      },
      orderBy: { createdAt: 'asc' },
    });
    assert.equal(transcriptionRuns.length, 2);
    assert.equal(transcriptionRuns[0].id, primaryRun.id);
    assert.equal(transcriptionRuns[0].status, TrainingProviderRunStatus.AMBIGUOUS);
    assert.equal(transcriptionRuns[1].runType, 'REPROCESS');
    assert.equal(transcriptionRuns[1].status, TrainingProviderRunStatus.SUCCEEDED);
    assert.notEqual(transcriptionRuns[1].idempotencyKey, primaryRun.idempotencyKey);
    const activeTranscription = await prisma.trainingAnswer.findUniqueOrThrow({
      where: { id: answer.id },
      select: {
        activeTranscription: {
          select: { providerRunId: true },
        },
      },
    });
    assert.equal(
      activeTranscription.activeTranscription.providerRunId,
      transcriptionRuns[1].id,
    );
  });

  await t.test('EVALUATING becomes ambiguous and needs explicit reprocessing', async () => {
    const fixture = await createFixture();
    const clock = createClock();
    const deferred = createDeferred();
    const firstService = createService(clock, {
      evaluationProvider: {
        evaluate: async () => deferred.promise,
      },
    });
    const attempt = await startAttempt(firstService, fixture);
    await appendVoice(
      firstService,
      clock,
      attempt,
      20_703n,
      'restart evaluating',
    );
    void firstService
      .finishAnswer({
        attemptId: attempt.id,
        attemptQuestionId: attempt.attemptQuestions[0].id,
      })
      .catch(() => {});
    await waitForAnswerStatus(attempt.id, TrainingAnswerStatus.EVALUATING);
    await waitForProviderRunStatus(
      attempt.id,
      TrainingProviderKind.EVALUATION,
      TrainingProviderRunStatus.REQUESTING,
    );
    firstService.onModuleDestroy();
    clock.advanceSeconds(31);

    let recoveredProviderCalls = 0;
    const recoveredService = createService(clock, {
      evaluationProvider: {
        evaluate: async (input) => {
          recoveredProviderCalls += 1;
          return fakeEvaluation.evaluate(input);
        },
      },
    });
    await recoveredService.recoverPendingProcessing();
    assert.equal(
      (await recoveredService.getAttempt(attempt.id)).attempt.status,
      TrainingAttemptStatus.TECHNICAL_FAILURE,
    );
    assert.equal(await countEvaluations(attempt.id), 0);
    assert.equal(recoveredProviderCalls, 0);
    const answer = await prisma.trainingAnswer.findFirstOrThrow({
      where: { attemptQuestion: { attemptId: attempt.id } },
    });
    assert.equal(answer.status, TrainingAnswerStatus.FAILED);
    const primaryRun = await prisma.trainingProviderRun.findFirstOrThrow({
      where: {
        answerId: answer.id,
        kind: TrainingProviderKind.EVALUATION,
      },
    });
    assert.equal(primaryRun.runType, 'PRIMARY');
    assert.equal(primaryRun.status, TrainingProviderRunStatus.AMBIGUOUS);
    await recoveredService.reprocessEvaluation({
      answerId: answer.id,
      reviewerId: fixture.publisherId,
      comment: 'Explicit retry after ambiguous evaluation',
    });
    await recoveredService.recoverPendingProcessing();
    assert.equal(await countEvaluations(attempt.id), 1);
    assert.equal(recoveredProviderCalls, 1);
    const evaluationRuns = await prisma.trainingProviderRun.findMany({
      where: {
        answerId: answer.id,
        kind: TrainingProviderKind.EVALUATION,
      },
      orderBy: { createdAt: 'asc' },
    });
    assert.equal(evaluationRuns.length, 2);
    assert.equal(evaluationRuns[0].id, primaryRun.id);
    assert.equal(evaluationRuns[0].status, TrainingProviderRunStatus.AMBIGUOUS);
    assert.equal(evaluationRuns[1].runType, 'REPROCESS');
    assert.equal(evaluationRuns[1].status, TrainingProviderRunStatus.SUCCEEDED);
    assert.notEqual(evaluationRuns[1].idempotencyKey, primaryRun.idempotencyKey);
    const activeEvaluation = await prisma.trainingAnswer.findUniqueOrThrow({
      where: { id: answer.id },
      select: {
        activeEvaluation: {
          select: { providerRunId: true },
        },
      },
    });
    assert.equal(
      activeEvaluation.activeEvaluation.providerRunId,
      evaluationRuns[1].id,
    );
  });

  await t.test('FINALIZING', async () => {
    const fixture = await createFixture();
    const clock = createClock();
    let firstService;
    let evaluationCalls = 0;
    firstService = createService(clock, {
      evaluationProvider: {
        evaluate: async (input) => {
          evaluationCalls += 1;
          const result = await fakeEvaluation.evaluate(input);
          if (evaluationCalls === 4) firstService.onModuleDestroy();
          return result;
        },
      },
    });
    let attempt = await startAttempt(firstService, fixture);
    attempt = await completeAttempt(firstService, clock, attempt, 20_710);
    assert.equal(attempt.status, TrainingAttemptStatus.FINALIZING);

    const recoveredService = createService(clock);
    await recoveredService.recoverPendingProcessing();
    assert.equal(
      (await recoveredService.getAttempt(attempt.id)).attempt.status,
      TrainingAttemptStatus.COMPLETED,
    );
  });
});

test('PostgreSQL restart automatically resumes a persisted PENDING provider run', async () => {
  const fixture = await createFixture();
  const clock = createClock();
  const deferred = createDeferred();
  const firstService = createService(clock, {
    transcriptionProvider: {
      transcribe: async () => deferred.promise,
    },
  });
  const attempt = await startAttempt(firstService, fixture);
  await appendVoice(firstService, clock, attempt, 20_801n, 'pending provider');
  void firstService
    .finishAnswer({
      attemptId: attempt.id,
      attemptQuestionId: attempt.attemptQuestions[0].id,
    })
    .catch(() => {});
  const providerRun = await waitForProviderRunStatus(
    attempt.id,
    TrainingProviderKind.TRANSCRIPTION,
    TrainingProviderRunStatus.REQUESTING,
  );
  await prisma.trainingProviderRun.update({
    where: { id: providerRun.id },
    data: {
      status: TrainingProviderRunStatus.PENDING,
      startedAt: null,
    },
  });
  firstService.onModuleDestroy();
  clock.advanceSeconds(31);

  let recoveredCalls = 0;
  const recoveredService = createService(clock, {
    transcriptionProvider: {
      transcribe: async (input) => {
        recoveredCalls += 1;
        return fakeTranscription.transcribe(input);
      },
    },
  });
  await recoveredService.recoverPendingProcessing();

  assert.equal(recoveredCalls, 1);
  assert.equal(
    (
      await prisma.trainingProviderRun.findUniqueOrThrow({
        where: { id: providerRun.id },
      })
    ).status,
    TrainingProviderRunStatus.SUCCEEDED,
  );
  assert.equal(await countEvaluations(attempt.id), 1);
});

test('PostgreSQL restart reuses a persisted SUCCEEDED provider result before state transition', async () => {
  const fixture = await createFixture();
  const clock = createClock();
  const deferred = createDeferred();
  const firstService = createService(clock, {
    transcriptionProvider: {
      transcribe: async () => deferred.promise,
    },
  });
  const attempt = await startAttempt(firstService, fixture);
  await appendVoice(firstService, clock, attempt, 20_802n, 'provider result');
  void firstService
    .finishAnswer({
      attemptId: attempt.id,
      attemptQuestionId: attempt.attemptQuestions[0].id,
    })
    .catch(() => {});
  const providerRun = await waitForProviderRunStatus(
    attempt.id,
    TrainingProviderKind.TRANSCRIPTION,
    TrainingProviderRunStatus.REQUESTING,
  );
  const answer = await prisma.trainingAnswer.findFirstOrThrow({
    where: { attemptQuestion: { attemptId: attempt.id } },
  });
  await prisma.$transaction([
    prisma.trainingAnswerTranscription.create({
      data: {
        answerId: answer.id,
        providerRunId: providerRun.id,
        transcriptionNumber: 1,
        transcript: 'persisted PostgreSQL provider result',
        language: 'ru',
        wordCount: 4,
      },
    }),
    prisma.trainingProviderRun.update({
      where: { id: providerRun.id },
      data: {
        status: TrainingProviderRunStatus.SUCCEEDED,
        actualModelId: 'fake-transcription-v1',
        requestId: `persisted:${answer.id}`,
        responseStatus: 'completed',
        completedAt: clock.now(),
      },
    }),
  ]);
  firstService.onModuleDestroy();
  clock.advanceSeconds(31);

  let repeatedCalls = 0;
  const recoveredService = createService(clock, {
    transcriptionProvider: {
      transcribe: async () => {
        repeatedCalls += 1;
        throw new Error('Persisted provider result must not be repeated');
      },
    },
  });
  await recoveredService.recoverPendingProcessing();

  assert.equal(repeatedCalls, 0);
  assert.equal(
    (
      await prisma.trainingProviderRun.findUniqueOrThrow({
        where: { id: providerRun.id },
      })
    ).status,
    TrainingProviderRunStatus.SUCCEEDED,
  );
  assert.equal(
    await prisma.trainingAnswerTranscription.count({
      where: { providerRunId: providerRun.id },
    }),
    1,
  );
  assert.equal(
    (
      await prisma.trainingAnswer.findUniqueOrThrow({
        where: { id: answer.id },
      })
    ).combinedTranscript,
    'persisted PostgreSQL provider result',
  );
  assert.equal(await countEvaluations(attempt.id), 1);
});

test('PostgreSQL timeout during provider request preserves ambiguity and explicit recovery', async (t) => {
  for (const state of [
    TrainingAnswerStatus.TRANSCRIBING,
    TrainingAnswerStatus.EVALUATING,
  ]) {
    await t.test(state, async () => {
      const fixture = await createFixture();
      const clock = createClock();
      const deferred = createDeferred();
      const firstService = createService(clock, {
        ...(state === TrainingAnswerStatus.TRANSCRIBING
          ? {
              transcriptionProvider: {
                transcribe: async () => deferred.promise,
              },
            }
          : {
              evaluationProvider: {
                evaluate: async () => deferred.promise,
              },
            }),
      });
      const attempt = await startAttempt(firstService, fixture);
      await appendVoice(
        firstService,
        clock,
        attempt,
        state === TrainingAnswerStatus.TRANSCRIBING ? 20_901n : 20_902n,
        `timeout ${state}`,
      );
      void firstService
        .finishAnswer({
          attemptId: attempt.id,
          attemptQuestionId: attempt.attemptQuestions[0].id,
        })
        .catch(() => {});
      await waitForAnswerStatus(attempt.id, state);
      await waitForProviderRunStatus(
        attempt.id,
        state === TrainingAnswerStatus.TRANSCRIBING
          ? TrainingProviderKind.TRANSCRIPTION
          : TrainingProviderKind.EVALUATION,
        TrainingProviderRunStatus.REQUESTING,
      );
      clock.set(attempt.expiresAt);
      await firstService.handleTimeout(attempt.id, clock.now());
      firstService.onModuleDestroy();
      clock.advanceSeconds(31);

      const recoveredService = createService(clock);
      await recoveredService.recoverPendingProcessing();
      const completed = (await recoveredService.getAttempt(attempt.id)).attempt;
      const timeoutJob = await prisma.trainingJob.findUnique({
        where: {
          idempotencyKey: `attempt:${attempt.id}:timer:expire`,
        },
      });

      assert.equal(
        completed.status,
        TrainingAttemptStatus.TECHNICAL_FAILURE,
      );
      assert.equal(timeoutJob.status, TrainingJobStatus.SUCCEEDED);
      assert.equal(timeoutJob.payloadJson.phase, 'APPLIED');
      const answer = await prisma.trainingAnswer.findFirstOrThrow({
        where: { attemptQuestion: { attemptId: attempt.id } },
      });
      const ambiguousRun =
        await prisma.trainingProviderRun.findFirstOrThrow({
          where: {
            answerId: answer.id,
            kind:
              state === TrainingAnswerStatus.TRANSCRIBING
                ? 'TRANSCRIPTION'
                : 'EVALUATION',
          },
          orderBy: { createdAt: 'desc' },
        });
      assert.equal(ambiguousRun.status, 'AMBIGUOUS');

      if (state === TrainingAnswerStatus.TRANSCRIBING) {
        await recoveredService.reprocessTranscription({
          answerId: answer.id,
          reviewerId: fixture.publisherId,
          comment: 'Explicit timeout transcription recovery',
        });
      } else {
        await recoveredService.reprocessEvaluation({
          answerId: answer.id,
          reviewerId: fixture.publisherId,
          comment: 'Explicit timeout evaluation recovery',
        });
      }
      await recoveredService.recoverPendingProcessing();
      const reprocessed = (
        await recoveredService.getAttempt(attempt.id)
      ).attempt;
      assert.equal(reprocessed.status, TrainingAttemptStatus.COMPLETED);
      assert.equal(Number(reprocessed.finalScore), 55);
    });
  }
});

test('PostgreSQL canonical rounding matches persisted components and pass threshold', async () => {
  const fixture = await createFixture({ passScore: 75 });
  const clock = createClock();
  const service = createService(clock);
  let attempt = await startAttempt(service, fixture);
  attempt = await completeAttempt(
    service,
    clock,
    attempt,
    21_000,
    '[[criterion:main-total=29.995]]',
  );
  const mainEvaluation = await prisma.trainingAnswerEvaluation.findFirst({
    where: {
      answer: {
        attemptQuestion: {
          attemptId: attempt.id,
          sequence: 1,
        },
      },
    },
    include: {
      scoreComponents: true,
    },
  });

  assert.equal(mainEvaluation.scoreComponents[0].awardedPoints.toFixed(2), '30.00');
  assert.equal(mainEvaluation.serverScore.toFixed(2), '30.00');
  assert.equal(attempt.finalScore.toFixed(2), '75.00');
  assert.equal(attempt.passStatus, TrainingPassStatus.PASSED);
});

test('PostgreSQL provider runs preserve original outputs and activate explicit reprocessing history', async () => {
  const fixture = await createFixture();
  const clock = createClock();
  const service = createService(clock);
  let attempt = await startAttempt(service, fixture);
  attempt = await completeAttempt(service, clock, attempt, 21_100);
  const mainAnswer = await prisma.trainingAnswer.findFirstOrThrow({
    where: {
      attemptQuestion: {
        attemptId: attempt.id,
        sequence: 1,
      },
    },
    include: {
      evaluations: { orderBy: { evaluationNumber: 'asc' } },
      transcriptions: true,
    },
  });
  const originalEvaluationId = mainAnswer.evaluations[0].id;
  assert.equal(mainAnswer.transcriptions.length, 1);
  assert.equal(mainAnswer.evaluations.length, 1);

  await service.reprocessEvaluation({
    answerId: mainAnswer.id,
    reviewerId: fixture.publisherId,
    comment: 'Re-evaluate after reviewer request',
  });
  await service.recoverPendingProcessing();

  const reprocessed = await prisma.trainingAnswer.findUniqueOrThrow({
    where: { id: mainAnswer.id },
    include: {
      evaluations: { orderBy: { evaluationNumber: 'asc' } },
      transcriptions: true,
      providerRuns: { orderBy: { createdAt: 'asc' } },
    },
  });
  assert.equal(reprocessed.transcriptions.length, 1);
  assert.equal(reprocessed.evaluations.length, 2);
  assert.equal(reprocessed.evaluations[0].id, originalEvaluationId);
  assert.equal(
    reprocessed.activeEvaluationId,
    reprocessed.evaluations[1].id,
  );
  assert.equal(
    reprocessed.providerRuns.filter((run) => run.status === 'SUCCEEDED')
      .length,
    3,
  );
  assert.equal(reprocessed.providerRuns.at(-1).runType, 'REPROCESS');
  assert.equal(
    await prisma.auditLog.count({
      where: {
        entityId: mainAnswer.id,
        action: 'training.answer.reprocess_evaluation',
      },
    }),
    1,
  );
});

test('PostgreSQL same-answer constraints reject cross-owned active results and provider history', async () => {
  const fixture = await createFixture();
  const clock = createClock();
  const service = createService(clock);
  let attempt = await startAttempt(service, fixture);
  attempt = await completeAttempt(service, clock, attempt, 21_400);
  const answers = await prisma.trainingAnswer.findMany({
    where: {
      attemptQuestion: {
        attemptId: attempt.id,
      },
    },
    orderBy: {
      attemptQuestion: {
        sequence: 'asc',
      },
    },
    include: {
      transcriptions: true,
      evaluations: true,
    },
  });
  const own = answers[0];
  const other = answers[1];
  const historyCounts = {
    transcriptions: await prisma.trainingAnswerTranscription.count({
      where: { answer: { attemptQuestion: { attemptId: attempt.id } } },
    }),
    evaluations: await prisma.trainingAnswerEvaluation.count({
      where: { answer: { attemptQuestion: { attemptId: attempt.id } } },
    }),
  };

  await prisma.trainingAnswer.update({
    where: { id: own.id },
    data: {
      activeTranscriptionId: own.activeTranscriptionId,
      activeEvaluationId: own.activeEvaluationId,
    },
  });

  await prisma.trainingAnswer.update({
    where: { id: other.id },
    data: {
      activeTranscriptionId: null,
      activeEvaluationId: null,
    },
  });
  await assert.rejects(
    () =>
      prisma.trainingAnswer.update({
        where: { id: own.id },
        data: {
          activeTranscriptionId: other.activeTranscriptionId,
        },
      }),
    isForeignKeyFailure,
  );
  await assert.rejects(
    () =>
      prisma.trainingAnswer.update({
        where: { id: own.id },
        data: {
          activeEvaluationId: other.activeEvaluationId,
        },
      }),
    isForeignKeyFailure,
  );
  await prisma.trainingAnswer.update({
    where: { id: other.id },
    data: {
      activeTranscriptionId: other.activeTranscriptionId,
      activeEvaluationId: other.activeEvaluationId,
    },
  });

  const crossTranscriptionRun = await createUnreferencedProviderRun(
    other.id,
    'TRANSCRIPTION',
    'same-answer-transcription',
  );
  await assert.rejects(
    () =>
      prisma.trainingAnswerTranscription.update({
        where: { id: own.transcriptions[0].id },
        data: { providerRunId: crossTranscriptionRun.id },
      }),
    isForeignKeyFailure,
  );
  await prisma.trainingProviderRun.delete({
    where: { id: crossTranscriptionRun.id },
  });

  const crossEvaluationRun = await createUnreferencedProviderRun(
    other.id,
    'EVALUATION',
    'same-answer-evaluation',
  );
  await assert.rejects(
    () =>
      prisma.trainingAnswerEvaluation.update({
        where: { id: own.evaluations[0].id },
        data: { providerRunId: crossEvaluationRun.id },
      }),
    isForeignKeyFailure,
  );
  await prisma.trainingProviderRun.delete({
    where: { id: crossEvaluationRun.id },
  });

  assert.deepEqual(
    {
      transcriptions: await prisma.trainingAnswerTranscription.count({
        where: { answer: { attemptQuestion: { attemptId: attempt.id } } },
      }),
      evaluations: await prisma.trainingAnswerEvaluation.count({
        where: { answer: { attemptQuestion: { attemptId: attempt.id } } },
      }),
    },
    historyCounts,
  );
  const constraints = await prisma.$queryRaw`
    SELECT "conname"
    FROM "pg_constraint"
    WHERE "conname" IN (
      'training_answers_active_transcription_answer_fkey',
      'training_answers_active_evaluation_answer_fkey',
      'training_answer_transcriptions_provider_run_answer_fkey',
      'training_answer_evaluations_provider_run_answer_fkey'
    )
  `;
  assert.deepEqual(
    constraints.map((row) => row.conname).sort(),
    [
      'training_answer_evaluations_provider_run_answer_fkey',
      'training_answer_transcriptions_provider_run_answer_fkey',
      'training_answers_active_evaluation_answer_fkey',
      'training_answers_active_transcription_answer_fkey',
    ],
  );
});

test('PostgreSQL full 1 plus 3 flow runs real adapters against a local HTTP stub without duplicate provider runs', async () => {
  const fixture = await createFixture();
  const clock = createClock();
  const wav = createPcmWav();
  const checksum = createHash('sha256').update(wav).digest('hex');
  let transcriptionCalls = 0;
  let evaluationCalls = 0;
  const stub = await startOpenAiStub(async (request, response) => {
    if (request.url === '/v1/audio/transcriptions') {
      transcriptionCalls += 1;
      await readRequestBody(request);
      response.writeHead(200, {
        'content-type': 'application/json',
        'x-request-id': `stub-transcription-${transcriptionCalls}`,
      });
      response.end(
        JSON.stringify({
          text: `Тестовый ответ ${transcriptionCalls}`,
          language: 'ru',
          model: 'gpt-4o-mini-transcribe-2025-12-15',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
      return;
    }
    if (request.url === '/v1/responses') {
      evaluationCalls += 1;
      const requestBody = JSON.parse((await readRequestBody(request)).toString());
      const input = JSON.parse(requestBody.input);
      const output = {
        schema_version: 'openai-evaluation-v1',
        answer_relevance: 'RELEVANT',
        criteria: input.criteria.map((criterion) => ({
          criterion_id: criterion.id,
          anchor_id: criterion.anchors[0].id,
          evidence_source: 'TRANSCRIPT',
          evidence: input.transcript,
          metric_id: null,
          explanation: 'Транскрипт обработан локальным stub.',
        })),
        facts: input.approved_facts.map((fact) => ({
          fact_id: fact.id,
          verdict: 'MISSING',
          claim: null,
          evidence_source: 'NONE',
          evidence: null,
          metric_id: null,
          explanation: 'Факт не заявлен.',
          confidence: 0.99,
        })),
        summary: 'Ответ обработан локальным HTTP stub.',
        requires_manual_review: false,
        review_reasons: [],
      };
      response.writeHead(200, {
        'content-type': 'application/json',
        'x-request-id': `stub-evaluation-${evaluationCalls}`,
      });
      response.end(
        JSON.stringify({
          id: `resp-${evaluationCalls}`,
          model: 'gpt-5.6-terra',
          status: 'completed',
          usage: { input_tokens: 10, output_tokens: 10 },
          output: [
            {
              type: 'message',
              content: [
                { type: 'output_text', text: JSON.stringify(output) },
              ],
            },
          ],
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });

  try {
    const openAiConfig = createOpenAiStubConfig();
    const client = new TrainingOpenAiHttpClient(openAiConfig, {
      baseUrl: stub.baseUrl,
      sleep: async () => undefined,
    });
    const service = createService(clock, {
      openAiConfig,
      transcriptionProvider: new OpenAiTrainingTranscriptionProvider(
        prisma,
        { readStoredFile: async () => wav },
        openAiConfig,
        client,
      ),
      evaluationProvider: new OpenAiTrainingEvaluationProvider(
        openAiConfig,
        client,
      ),
    });
    let attempt = await startAttempt(service, fixture);

    for (let questionIndex = 0; questionIndex < 4; questionIndex += 1) {
      const current = (await service.getAttempt(attempt.id)).attempt;
      const targetQuestion = current.attemptQuestions.find((question) =>
        [
          TrainingAttemptQuestionStatus.PRESENTED,
          TrainingAttemptQuestionStatus.COLLECTING,
        ].includes(question.status),
      );
      assert.ok(targetQuestion);
      await appendVoice(
        service,
        clock,
        attempt,
        BigInt(21_150 + questionIndex),
        `local stub ${questionIndex}`,
      );
      const file = await prisma.file.create({
        data: {
          bucket: 'training-openai-stub',
          key: `training-audio/openai-stub-${attempt.id}-${questionIndex}.wav`,
          url: null,
          originalName: 'answer.wav',
          mimeType: 'audio/wav',
          sizeBytes: BigInt(wav.length),
          checksum,
        },
      });
      await prisma.trainingAnswer.update({
        where: { attemptQuestionId: targetQuestion.id },
        data: {
          mergedAudioFileId: file.id,
          mergedAudioDurationMilliseconds: 1,
          audioPreparedAt: clock.now(),
        },
      });
      await service.finishAnswer({
        attemptId: attempt.id,
        attemptQuestionId: targetQuestion.id,
      });
    }

    attempt = (await service.getAttempt(attempt.id)).attempt;
    assert.equal(attempt.status, TrainingAttemptStatus.COMPLETED);
    assert.equal(Number(attempt.finalScore), 100);
    assert.equal(transcriptionCalls, 4);
    assert.equal(evaluationCalls, 4);
    assert.equal(
      await prisma.trainingAnswerTranscription.count({
        where: { answer: { attemptQuestion: { attemptId: attempt.id } } },
      }),
      4,
    );
    assert.equal(
      await prisma.trainingAnswerEvaluation.count({
        where: { answer: { attemptQuestion: { attemptId: attempt.id } } },
      }),
      4,
    );
    assert.equal(
      await prisma.trainingProviderRun.count({
        where: {
          answer: { attemptQuestion: { attemptId: attempt.id } },
          status: 'SUCCEEDED',
        },
      }),
      8,
    );
    const idempotencyKeys = await prisma.trainingProviderRun.findMany({
      where: { answer: { attemptQuestion: { attemptId: attempt.id } } },
      select: { idempotencyKey: true },
    });
    assert.equal(
      new Set(idempotencyKeys.map((run) => run.idempotencyKey)).size,
      8,
    );
  } finally {
    await stub.close();
  }
});

test('PostgreSQL review applies minus five only after reviewer marks an unsupported claim incorrect', async () => {
  const fixture = await createFixture();
  const clock = createClock();
  const service = createService(clock);
  let attempt = await startAttempt(service, fixture);
  attempt = await completeAttempt(
    service,
    clock,
    attempt,
    21_200,
    '[[unsupported:новое утверждение]] [[unsupported:новое утверждение]]',
  );
  assert.equal(attempt.status, TrainingAttemptStatus.REQUIRES_REVIEW);
  assert.equal(Number(attempt.serverScore), 100);

  const unsupported = await prisma.trainingScoreComponent.findFirstOrThrow({
    where: {
      evaluation: {
        answer: {
          attemptQuestion: {
            attemptId: attempt.id,
          },
        },
      },
      factVerdict: 'UNSUPPORTED',
    },
  });
  const reviewed = (
    await service.reviewAttempt({
      attemptId: attempt.id,
      reviewerId: fixture.publisherId,
      idempotencyKey: 'db-review-approved-0001',
      decision: 'APPROVED',
      comment: 'Claim is factually incorrect',
      unsupportedClaimsDecisions: [
        {
          componentKey: unsupported.componentKey,
          decision: 'INCORRECT',
        },
      ],
    })
  ).attempt;

  assert.equal(Number(reviewed.serverScore), 100);
  assert.equal(Number(reviewed.finalScore), 95);
  assert.equal(reviewed.reviewStatus, TrainingReviewStatus.APPROVED);
  assert.equal(reviewed.reviews.length, 1);
  assert.equal(
    reviewed.reviews[0].unsupportedClaimsDecisionsJson[0].decision,
    'INCORRECT',
  );
  assert.equal(
    await prisma.auditLog.count({
      where: {
        entityId: attempt.id,
        action: 'training.attempt.review',
      },
    }),
    1,
  );

  const replayed = (
    await service.reviewAttempt({
      attemptId: attempt.id,
      reviewerId: fixture.publisherId,
      idempotencyKey: 'db-review-approved-0001',
      decision: 'APPROVED',
      comment: 'Claim is factually incorrect',
      unsupportedClaimsDecisions: [
        {
          componentKey: unsupported.componentKey,
          decision: 'INCORRECT',
        },
      ],
    })
  ).attempt;
  assert.equal(Number(replayed.finalScore), 95);
  assert.equal(
    await prisma.trainingResultReview.count({
      where: { attemptId: attempt.id },
    }),
    1,
  );
  assert.equal(
    await prisma.auditLog.count({
      where: {
        entityId: attempt.id,
        action: 'training.attempt.review',
      },
    }),
    1,
  );
  await assert.rejects(
    () =>
      service.reviewAttempt({
        attemptId: attempt.id,
        reviewerId: fixture.publisherId,
        idempotencyKey: 'db-review-approved-0001',
        decision: 'APPROVED',
        comment: 'Different canonical payload',
        unsupportedClaimsDecisions: [
          {
            componentKey: unsupported.componentKey,
            decision: 'INCORRECT',
          },
        ],
      }),
    (error) => error.getStatus?.() === 409,
  );

  const concurrentCommand = {
    attemptId: attempt.id,
    reviewerId: fixture.publisherId,
    idempotencyKey: 'db-review-concurrent-0002',
    decision: 'APPROVED',
    comment: 'Concurrent identical review',
    unsupportedClaimsDecisions: [
      {
        componentKey: unsupported.componentKey,
        decision: 'INCORRECT',
      },
    ],
  };
  const concurrent = await Promise.all(
    Array.from({ length: 8 }, () =>
      createService(clock).reviewAttempt(concurrentCommand),
    ),
  );
  assert.equal(
    concurrent.every(
      (result) => Number(result.attempt.finalScore) === 95,
    ),
    true,
  );
  assert.equal(
    await prisma.trainingResultReview.count({
      where: { attemptId: attempt.id },
    }),
    2,
  );
  assert.equal(
    await prisma.auditLog.count({
      where: {
        entityId: attempt.id,
        action: 'training.attempt.review',
      },
    }),
    2,
  );
});

test('real Nest review HTTP endpoint enforces auth, permission, idempotency and override reason', async (t) => {
  const fixture = await createFixture();
  const clock = createClock();
  const service = createService(clock);
  let attempt = await startAttempt(service, fixture);
  attempt = await completeAttempt(
    service,
    clock,
    attempt,
    21_250,
    '[[unsupported:HTTP review claim]]',
  );
  const unsupported = await prisma.trainingScoreComponent.findFirstOrThrow({
    where: {
      evaluation: {
        answer: {
          attemptQuestion: { attemptId: attempt.id },
        },
      },
      factVerdict: 'UNSUPPORTED',
    },
  });
  const users = await createReviewHttpUsers(fixture.publisherId);
  class ReviewHttpTestModule {}
  Module({
    imports: [AuthModule],
    controllers: [TrainingReviewController],
    providers: [
      {
        provide: TrainingAttemptEngineService,
        useValue: service,
      },
    ],
  })(ReviewHttpTestModule);
  const app = await NestFactory.create(ReviewHttpTestModule, {
    logger: false,
  });
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const baseUrl = await app.getUrl();
  const jwt = new JwtService();
  const secret =
    process.env.JWT_ACCESS_SECRET ?? 'change-me-access-secret';
  const tokens = Object.fromEntries(
    Object.entries(users).map(([role, userId]) => [
      role,
      jwt.sign(
        { sub: userId, type: 'access' },
        { secret, expiresIn: '5m' },
      ),
    ]),
  );
  const path = `/training/admin/results/${attempt.id}/review`;
  const approvedBody = {
    decision: 'APPROVED',
    comment: 'HTTP review approved',
    unsupportedClaimsDecisions: [
      {
        componentKey: unsupported.componentKey,
        decision: 'INCORRECT',
      },
    ],
  };

  assert.equal(
    (await postReview(baseUrl, path, null, approvedBody, 'http-unauthorized-1')).status,
    401,
  );
  assert.equal(
    (
      await postReview(
        baseUrl,
        path,
        tokens.employee,
        approvedBody,
        'http-forbidden-0001',
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await postReview(
        baseUrl,
        '/training/admin/results/99999999-9999-4999-8999-999999999999/review',
        tokens.admin,
        approvedBody,
        'http-not-found-0001',
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await postReview(
        baseUrl,
        path,
        tokens.trainingAdmin,
        approvedBody,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await postReview(
        baseUrl,
        path,
        tokens.trainingAdmin,
        {
          ...approvedBody,
          decision: 'OVERRIDDEN',
          adminScore: 80,
          comment: '',
        },
        'http-override-no-reason',
      )
    ).status,
    400,
  );

  const first = await postReview(
    baseUrl,
    path,
    tokens.trainingAdmin,
    approvedBody,
    'http-training-admin-0001',
  );
  assert.equal(
    first.status,
    201,
    `Unexpected review response: ${await first.text()}`,
  );
  const replay = await postReview(
    baseUrl,
    path,
    tokens.trainingAdmin,
    approvedBody,
    'http-training-admin-0001',
  );
  assert.equal(replay.status, 201);
  assert.equal(
    await prisma.trainingResultReview.count({
      where: {
        attemptId: attempt.id,
        reviewerId: users.trainingAdmin,
      },
    }),
    1,
  );
  assert.equal(
    await prisma.auditLog.count({
      where: {
        entityId: attempt.id,
        actorUserId: users.trainingAdmin,
        action: 'training.attempt.review',
      },
    }),
    1,
  );
  assert.equal(
    (
      await postReview(
        baseUrl,
        path,
        tokens.trainingAdmin,
        { ...approvedBody, comment: 'Different payload' },
        'http-training-admin-0001',
      )
    ).status,
    409,
  );

  const adminSuccess = await postReview(
    baseUrl,
    path,
    tokens.admin,
    {
      ...approvedBody,
      comment: 'Admin approved independently',
    },
    'http-admin-success-0001',
  );
  assert.equal(adminSuccess.status, 201);
  assert.equal(
    await prisma.trainingResultReview.count({
      where: { attemptId: attempt.id },
    }),
    2,
  );
});

async function createFixture(options = {}) {
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const role = await prisma.role.create({
    data: {
      name: `training-stage5-${unique}`,
      description: 'Stage 5 isolated integration role',
    },
  });
  const publisher = await prisma.user.create({
    data: {
      email: `training-stage5-publisher-${unique}@example.test`,
      passwordHash: 'not-used-in-domain-test',
      name: 'Stage 5 Publisher',
      status: UserStatus.ACTIVE,
      roleId: role.id,
    },
  });
  const user = await prisma.user.create({
    data: {
      email: `training-stage5-user-${unique}@example.test`,
      passwordHash: 'not-used-in-domain-test',
      name: 'Stage 5 User',
      status: UserStatus.ACTIVE,
      roleId: role.id,
    },
  });
  const project = await prisma.trainingProject.create({
    data: {
      slug: `training-stage5-${unique}`,
      title: 'Stage 5 integration project',
      status: TrainingProjectStatus.DRAFT,
    },
  });
  const version = await prisma.trainingProjectVersion.create({
    data: {
      projectId: project.id,
      versionNumber: 1,
      status: TrainingVersionStatus.DRAFT,
      passScore: options.passScore ?? 75,
      attemptLimit: options.attemptLimit ?? 3,
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
        anchorsJson: [
          { id: 'main-full', points: 55, description: 'Полный ответ' },
        ],
        sortOrder: 1,
      },
      {
        projectVersionId: version.id,
        questionType: TrainingQuestionType.FOLLOW_UP,
        code: 'follow-total',
        title: 'Дополнительный ответ',
        maxPoints: 15,
        anchorsJson: [
          { id: 'follow-full', points: 15, description: 'Полный ответ' },
        ],
        sortOrder: 1,
      },
    ],
  });
  await prisma.trainingProjectVersion.update({
    where: { id: version.id },
    data: {
      status: TrainingVersionStatus.PUBLISHED,
      publishedAt: new Date(),
      publishedById: publisher.id,
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
    publisherId: publisher.id,
    userId: user.id,
  };
}

function createClock() {
  return new MutableTrainingClock(new Date('2026-07-25T10:00:00.000Z'));
}

function createService(clock, options = {}) {
  return new TrainingAttemptEngineService(
    options.prismaClient ?? prisma,
    clock,
    options.selector ?? new DeterministicQuestionSelector(),
    options.transcriptionProvider ?? fakeTranscription,
    options.evaluationProvider ?? fakeEvaluation,
    options.audioConfig,
    options.openAiConfig,
    options.jobProcessorEnabled,
    options.trainingConfig,
  );
}

function proxyPrismaTrainingJob(overrides) {
  const trainingJob = new Proxy(prisma.trainingJob, {
    get(delegate, property) {
      if (property in overrides) {
        return (...args) => overrides[property](delegate, ...args);
      }
      const value = Reflect.get(delegate, property, delegate);
      return typeof value === 'function' ? value.bind(delegate) : value;
    },
  });
  return new Proxy(prisma, {
    get(client, property) {
      if (property === 'trainingJob') return trainingJob;
      const value = Reflect.get(client, property, client);
      return typeof value === 'function' ? value.bind(client) : value;
    },
  });
}

function proxyPrismaFinalizationLockGate(finalizationJobId, onLock) {
  let armed = false;
  const trainingJob = new Proxy(prisma.trainingJob, {
    get(delegate, property) {
      if (property === 'updateMany') {
        return async (args) => {
          const result = await delegate.updateMany(args);
          if (
            result.count === 1 &&
            args.where?.id === finalizationJobId &&
            args.data?.status === TrainingJobStatus.RUNNING &&
            args.data?.lockOwner
          ) {
            armed = true;
          }
          return result;
        };
      }
      const value = Reflect.get(delegate, property, delegate);
      return typeof value === 'function' ? value.bind(delegate) : value;
    },
  });
  const wrapTransaction = (tx) =>
    new Proxy(tx, {
      get(delegate, property) {
        if (property === '$queryRaw') {
          return async (...args) => {
            const result = await delegate.$queryRaw(...args);
            if (armed) {
              armed = false;
              onLock();
            }
            return result;
          };
        }
        const value = Reflect.get(delegate, property, delegate);
        return typeof value === 'function' ? value.bind(delegate) : value;
      },
    });
  return new Proxy(prisma, {
    get(client, property) {
      if (property === 'trainingJob') return trainingJob;
      if (property === '$transaction') {
        return (operation, options) =>
          client.$transaction(
            (tx) => operation(wrapTransaction(tx)),
            options,
          );
      }
      const value = Reflect.get(client, property, client);
      return typeof value === 'function' ? value.bind(client) : value;
    },
  });
}

async function startAttempt(service, fixture) {
  return (
    await service.confirmStart({
      userId: fixture.userId,
      projectId: fixture.projectId,
      confirmed: true,
    })
  ).attempt;
}

async function appendVoice(service, clock, attempt, updateId, fakeTranscript) {
  return service.appendVoiceSegment({
    attemptId: attempt.id,
    kind: 'VOICE',
    updateId,
    fakeTranscript,
    recordingStartedAt: clock.now(),
    durationSeconds: 5,
  });
}

async function completeAttempt(
  service,
  clock,
  attempt,
  seed,
  mainTranscript = 'Главный ответ',
) {
  for (let questionIndex = 0; questionIndex < 4; questionIndex += 1) {
    const current = (await service.getAttempt(attempt.id)).attempt;
    const targetQuestion = current.attemptQuestions.find((question) =>
      [
        TrainingAttemptQuestionStatus.PRESENTED,
        TrainingAttemptQuestionStatus.COLLECTING,
      ].includes(question.status),
    );
    assert.ok(targetQuestion);
    await appendVoice(
      service,
      clock,
      attempt,
      BigInt(seed + questionIndex),
      questionIndex === 0 ? mainTranscript : `Ответ ${questionIndex + 1}`,
    );
    await service.finishAnswer({
      attemptId: attempt.id,
      attemptQuestionId: targetQuestion.id,
    });
  }
  return (await service.getAttempt(attempt.id)).attempt;
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createOpenAiStubConfig() {
  return {
    providerMode: 'real',
    apiKey: 'stub-credential-not-an-openai-key',
    transcriptionModel: 'gpt-4o-mini-transcribe-2025-12-15',
    transcriptionReviewModel: 'gpt-4o-transcribe',
    evaluationModel: 'gpt-5.6-terra',
    evaluationReasoning: 'medium',
    reviewModel: 'gpt-5.6-terra',
    reviewReasoning: 'high',
    transcriptionTimeoutMs: 1_000,
    evaluationTimeoutMs: 1_000,
    transcriptionMaxRetries: 1,
    evaluationMaxRetries: 1,
    transcriptionMaxBytes: 24 * 1024 * 1024,
    maxResponseBytes: 1024 * 1024,
    evaluationMaxOutputTokens: 4096,
    smokeEnabled: false,
  };
}

function createUnreferencedProviderRun(answerId, kind, label) {
  const nonce = `${label}-${Date.now()}-${Math.random()}`;
  return prisma.trainingProviderRun.create({
    data: {
      answerId,
      kind,
      runType: 'REPROCESS',
      status: 'PENDING',
      idempotencyKey: nonce,
      requestedModelId: 'same-answer-constraint-fixture',
      inputHash: createHash('sha256').update(nonce).digest('hex'),
    },
  });
}

async function createReviewHttpUsers(trainingAdminUserId) {
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const permission = await prisma.permission.upsert({
    where: { key: 'training:results:review' },
    update: {},
    create: {
      key: 'training:results:review',
      description: 'Review training results',
    },
  });
  const trainingAdmin = await prisma.user.findUniqueOrThrow({
    where: { id: trainingAdminUserId },
    select: { roleId: true },
  });
  await prisma.rolePermission.upsert({
    where: {
      roleId_permissionId: {
        roleId: trainingAdmin.roleId,
        permissionId: permission.id,
      },
    },
    update: {},
    create: {
      roleId: trainingAdmin.roleId,
      permissionId: permission.id,
    },
  });
  const adminRole = await prisma.role.create({
    data: {
      name: `admin-http-${unique}`.slice(0, 64),
      permissions: {
        create: {
          permissionId: permission.id,
        },
      },
    },
  });
  const employeeRole = await prisma.role.create({
    data: {
      name: `employee-http-${unique}`.slice(0, 64),
    },
  });
  const [admin, employee] = await Promise.all([
    prisma.user.create({
      data: {
        email: `admin-http-${unique}@example.test`,
        passwordHash: 'not-used-by-jwt-guard',
        name: 'HTTP Admin',
        status: UserStatus.ACTIVE,
        roleId: adminRole.id,
      },
    }),
    prisma.user.create({
      data: {
        email: `employee-http-${unique}@example.test`,
        passwordHash: 'not-used-by-jwt-guard',
        name: 'HTTP Employee',
        status: UserStatus.ACTIVE,
        roleId: employeeRole.id,
      },
    }),
  ]);
  return {
    trainingAdmin: trainingAdminUserId,
    admin: admin.id,
    employee: employee.id,
  };
}

function postReview(baseUrl, path, token, body, idempotencyKey) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey
        ? { 'idempotency-key': idempotencyKey }
        : {}),
    },
    body: JSON.stringify(body),
  });
}

function isForeignKeyFailure(error) {
  return error?.code === 'P2003';
}

function createPcmWav() {
  const dataSize = 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16_000, 24);
  buffer.writeUInt32LE(32_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

async function startOpenAiStub(handler) {
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function waitForAnswerStatus(attemptId, status) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const answer = await prisma.trainingAnswer.findFirst({
      where: {
        status,
        attemptQuestion: {
          attemptId,
        },
      },
    });
    if (answer) return answer;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Answer did not enter ${status}`);
}

async function waitForProviderRunStatus(attemptId, kind, status) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const providerRun = await prisma.trainingProviderRun.findFirst({
      where: {
        kind,
        status,
        answer: {
          attemptQuestion: {
            attemptId,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (providerRun) return providerRun;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Provider run ${kind} did not enter ${status}`);
}

async function waitForPersistedTranscript(attemptId) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const answer = await prisma.trainingAnswer.findFirst({
      where: {
        attemptQuestion: {
          attemptId,
        },
        combinedTranscript: 'persisted PostgreSQL provider result',
      },
    });
    if (answer) return answer;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Provider result was not persisted before restart');
}

function countEvaluations(attemptId) {
  return prisma.trainingAnswerEvaluation.count({
    where: {
      answer: {
        attemptQuestion: {
          attemptId,
        },
      },
    },
  });
}
