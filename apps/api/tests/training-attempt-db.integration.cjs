require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  PrismaClient,
  TrainingAnswerStatus,
  TrainingAttemptQuestionStatus,
  TrainingAttemptStatus,
  TrainingJobKind,
  TrainingJobStatus,
  TrainingPassStatus,
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

  await t.test('TRANSCRIBING', async () => {
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
    firstService.onModuleDestroy();
    clock.advanceSeconds(31);

    await createService(clock).recoverPendingProcessing();
    assert.equal(
      await countEvaluations(attempt.id),
      1,
    );
  });

  await t.test('EVALUATING', async () => {
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
    firstService.onModuleDestroy();
    clock.advanceSeconds(31);

    await createService(clock).recoverPendingProcessing();
    assert.equal(await countEvaluations(attempt.id), 1);
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

test('PostgreSQL restart reuses a persisted provider result before state transition', async () => {
  const fixture = await createFixture();
  const clock = createClock();
  const deferred = createDeferred();
  const firstService = createService(clock, {
    transcriptionProvider: {
      transcribe: async (input) => {
        await prisma.trainingAnswer.update({
          where: { id: input.answerId },
          data: {
            combinedTranscript: 'persisted PostgreSQL provider result',
            normalizedLanguage: 'ru',
            transcriptionProvider: 'fake',
            transcriptionModel: 'fake-transcription-v1',
            transcriptionRequestId: `persisted:${input.answerId}`,
          },
        });
        return deferred.promise;
      },
    },
  });
  const attempt = await startAttempt(firstService, fixture);
  await appendVoice(firstService, clock, attempt, 20_801n, 'provider result');
  void firstService
    .finishAnswer({
      attemptId: attempt.id,
      attemptQuestionId: attempt.attemptQuestions[0].id,
    })
    .catch(() => {});
  await waitForPersistedTranscript(attempt.id);
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
  assert.equal(await countEvaluations(attempt.id), 1);
});

test('PostgreSQL timeout during TRANSCRIBING and EVALUATING persists intent and finalizes', async (t) => {
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

      assert.equal(completed.status, TrainingAttemptStatus.COMPLETED);
      assert.equal(Number(completed.finalScore), 55);
      assert.equal(timeoutJob.status, TrainingJobStatus.SUCCEEDED);
      assert.equal(timeoutJob.payloadJson.phase, 'APPLIED');
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
    prisma,
    clock,
    options.selector ?? new DeterministicQuestionSelector(),
    options.transcriptionProvider ?? fakeTranscription,
    options.evaluationProvider ?? fakeEvaluation,
  );
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

async function waitForAnswerStatus(attemptId, status) {
  for (let index = 0; index < 200; index += 1) {
    const answer = await prisma.trainingAnswer.findFirst({
      where: {
        status,
        attemptQuestion: {
          attemptId,
        },
      },
    });
    if (answer) return answer;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`Answer did not enter ${status}`);
}

async function waitForPersistedTranscript(attemptId) {
  for (let index = 0; index < 200; index += 1) {
    const answer = await prisma.trainingAnswer.findFirst({
      where: {
        attemptQuestion: {
          attemptId,
        },
        combinedTranscript: 'persisted PostgreSQL provider result',
      },
    });
    if (answer) return answer;
    await new Promise((resolve) => setImmediate(resolve));
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
