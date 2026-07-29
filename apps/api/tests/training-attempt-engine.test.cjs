require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ConflictException,
} = require('@nestjs/common');
const {
  Prisma,
  TrainingAttemptQuestionStatus,
  TrainingAttemptStatus,
  TrainingJobKind,
  TrainingJobStatus,
  TrainingPassStatus,
  TrainingProjectAudienceMode,
  TrainingReviewStatus,
} = require('@prisma/client');

const {
  TrainingAttemptEngineService,
} = require('../dist/training/training-attempt-engine.service.js');
const {
  DeterministicFakeTrainingEvaluationProvider,
  DeterministicFakeTrainingTranscriptionProvider,
  TRAINING_EVALUATION_PROVIDER,
  TRAINING_TRANSCRIPTION_PROVIDER,
} = require('../dist/training/training-attempt.providers.js');
const {
  TrainingModule,
} = require('../dist/training/training.module.js');
const {
  ADMIN_ID,
  DeterministicQuestionSelector,
  FakeTrainingAttemptPrisma,
  MutableTrainingClock,
  PROJECT_ID,
  USER_ID,
} = require('./helpers/training-attempt-fake-prisma.cjs');

function createHarness(options = {}) {
  const clock =
    options.clock ??
    new MutableTrainingClock(new Date('2026-07-25T10:00:00.000Z'));
  const prisma = new FakeTrainingAttemptPrisma({
    now: clock.now(),
    ...options,
  });
  const service = createService({
    prisma,
    clock,
    ...options,
  });

  return { clock, prisma, service };
}

function createService({
  prisma,
  clock,
  selector,
  transcriptionProvider,
  evaluationProvider,
}) {
  return new TrainingAttemptEngineService(
    prisma,
    clock,
    selector ?? new DeterministicQuestionSelector(),
    transcriptionProvider ??
      new DeterministicFakeTrainingTranscriptionProvider(),
    evaluationProvider ??
      new DeterministicFakeTrainingEvaluationProvider(),
  );
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

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

async function startAttempt(service) {
  const response = await service.confirmStart({
    userId: USER_ID,
    projectId: PROJECT_ID,
    confirmed: true,
  });
  return response.attempt;
}

async function answerCurrent({
  service,
  clock,
  attemptId,
  updateIds,
  transcripts,
}) {
  const before = (await service.getAttempt(attemptId)).attempt;
  const targetQuestion = before.attemptQuestions.find((question) =>
    [
      TrainingAttemptQuestionStatus.PRESENTED,
      TrainingAttemptQuestionStatus.COLLECTING,
    ].includes(question.status),
  );
  assert.ok(targetQuestion, 'Current training question must exist');

  for (let index = 0; index < transcripts.length; index += 1) {
    await service.appendVoiceSegment({
      attemptId,
      kind: 'VOICE',
      updateId: BigInt(updateIds[index]),
      fakeTranscript: transcripts[index],
      recordingStartedAt: clock.now(),
      durationSeconds: 10,
    });
  }
  return service.finishAnswer({
    attemptId,
    attemptQuestionId: targetQuestion.id,
  });
}

async function completeAttempt(harness, seed, mainTranscript = 'полный главный ответ') {
  const attempt = await startAttempt(harness.service);
  await answerCurrent({
    ...harness,
    attemptId: attempt.id,
    updateIds: [seed, seed + 1],
    transcripts: [mainTranscript, 'вторая часть главного ответа'],
  });
  for (let index = 0; index < 3; index += 1) {
    await answerCurrent({
      ...harness,
      attemptId: attempt.id,
      updateIds: [seed + 10 + index],
      transcripts: [`дополнительный ответ ${index + 1}`],
    });
  }
  return (await harness.service.getAttempt(attempt.id)).attempt;
}

test('stage 8 runtime wiring selects providers by mode while fake tests make no network calls', async () => {
  const providers = Reflect.getMetadata('providers', TrainingModule);
  const transcriptionBinding = providers.find(
    (provider) => provider?.provide === TRAINING_TRANSCRIPTION_PROVIDER,
  );
  const evaluationBinding = providers.find(
    (provider) => provider?.provide === TRAINING_EVALUATION_PROVIDER,
  );
  assert.equal(transcriptionBinding.useFactory.name, 'createTrainingTranscriptionProvider');
  assert.equal(evaluationBinding.useFactory.name, 'createTrainingEvaluationProvider');

  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error('Fake provider must not call fetch');
  };
  try {
    const harness = createHarness();
    await startAttempt(harness.service);
    assert.equal(
      harness.prisma.transactionOptions.some(
        (options) =>
          options.isolationLevel ===
          Prisma.TransactionIsolationLevel.Serializable,
      ),
      true,
    );
    assert.equal(harness.prisma.rawQueries.length > 0, true);
    await new DeterministicFakeTrainingTranscriptionProvider().transcribe({
      answerId: 'runtime-answer',
      segments: [
        {
          id: 'runtime-segment',
          segmentIndex: 1,
          fakeTranscript: 'runtime',
        },
      ],
    });
    await new DeterministicFakeTrainingEvaluationProvider().evaluate({
      answerId: 'runtime-answer',
      questionId: 'runtime-question',
      questionText: 'runtime',
      questionMaxScore: 1,
      transcript: 'runtime',
      criteria: [],
      facts: [],
    });
    assert.equal(fetchCalls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('full fake integration flow immediately consumes one attempt and completes 1 + 3 sequentially with score 100', async () => {
  const harness = createHarness({
    warningSeconds: [90, 30],
  });
  const started = await startAttempt(harness.service);

  assert.equal(started.isConsumed, true);
  assert.equal(started.attemptNumber, 1);
  assert.equal(started.status, TrainingAttemptStatus.AWAITING_MAIN);
  assert.equal(started.attemptQuestions.length, 4);
  assert.equal(
    new Set(started.attemptQuestions.map((question) => question.questionId)).size,
    4,
  );
  assert.equal(
    started.attemptQuestions[0].status,
    TrainingAttemptQuestionStatus.PRESENTED,
  );
  assert.deepEqual(
    started.attemptQuestions.slice(1).map((question) => question.status),
    [
      TrainingAttemptQuestionStatus.PENDING,
      TrainingAttemptQuestionStatus.PENDING,
      TrainingAttemptQuestionStatus.PENDING,
    ],
  );
  assert.equal(harness.prisma.jobs.size, 3);
  assert.equal(
    [...harness.prisma.jobs.values()].some(
      (job) => job.payloadJson.warningSeconds === 90,
    ),
    true,
  );

  const completed = await completeAttemptFromStarted(harness, started, 1_000);

  assert.equal(completed.status, TrainingAttemptStatus.COMPLETED);
  assert.equal(completed.aiScore.toFixed(2), '100.00');
  assert.equal(completed.serverScore.toFixed(2), '100.00');
  assert.equal(completed.finalScore.toFixed(2), '100.00');
  assert.equal(completed.passStatus, TrainingPassStatus.PASSED);
  assert.equal(completed.reviewStatus, TrainingReviewStatus.NOT_REQUIRED);
  assert.deepEqual(
    completed.attemptQuestions.map((question) => question.status),
    Array(4).fill(TrainingAttemptQuestionStatus.SCORED),
  );
  assert.equal(
    completed.attemptQuestions[0].answer.voiceSegments.length,
    2,
  );
  assert.equal(
    completed.attemptQuestions[0].answer.combinedTranscript,
    'первая часть главного ответа\nвторая часть главного ответа',
  );
});

test('concurrent starts are serialized and backend creates only one consumed active attempt', async () => {
  const harness = createHarness();
  const commands = Array.from({ length: 8 }, () =>
    harness.service.confirmStart({
      userId: USER_ID,
      projectId: PROJECT_ID,
      confirmed: true,
    }),
  );
  const results = await Promise.allSettled(commands);

  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === 'rejected').length,
    7,
  );
  assert.equal(harness.prisma.attempts.size, 1);
  assert.equal([...harness.prisma.attempts.values()][0].isConsumed, true);
});

test('default limit blocks the fourth consumed attempt and repeated questions across attempts remain allowed', async () => {
  const harness = createHarness({
    allowRetakeAfterPass: true,
  });
  const selectedQuestions = [];

  for (let attemptIndex = 0; attemptIndex < 3; attemptIndex += 1) {
    const completed = await completeAttempt(harness, 2_000 + attemptIndex * 100);
    selectedQuestions.push(
      completed.attemptQuestions.slice(1).map((question) => question.questionId),
    );
    harness.clock.advanceSeconds(3_601);
  }

  assert.deepEqual(selectedQuestions[1], selectedQuestions[0]);
  assert.deepEqual(selectedQuestions[2], selectedQuestions[0]);
  await assert.rejects(
    () => startAttempt(harness.service),
    /attempt limit is exhausted/u,
  );
  assert.equal(harness.prisma.attempts.size, 3);
});

test('custom attempt limit, cooldown and retake-after-pass are enforced from the pinned active settings', async () => {
  const customLimit = createHarness({
    attemptLimit: 1,
    allowRetakeAfterPass: true,
  });
  await completeAttempt(customLimit, 3_000);
  customLimit.clock.advanceSeconds(3_601);
  await assert.rejects(
    () => startAttempt(customLimit.service),
    /attempt limit is exhausted/u,
  );

  const cooldown = createHarness({
    attemptLimit: 2,
    allowRetakeAfterPass: true,
  });
  await completeAttempt(cooldown, 4_000);
  await assert.rejects(
    () => startAttempt(cooldown.service),
    /cooldown is active/u,
  );
  cooldown.clock.advanceSeconds(3_601);
  const second = await startAttempt(cooldown.service);
  assert.equal(second.attemptNumber, 2);

  const retakeDisabled = createHarness({
    attemptLimit: 3,
    allowRetakeAfterPass: false,
  });
  await completeAttempt(retakeDisabled, 5_000);
  retakeDisabled.clock.advanceSeconds(3_601);
  await assert.rejects(
    () => startAttempt(retakeDisabled.service),
    /Retake after passing is disabled/u,
  );
});

test('project global status and availability window are backend start boundaries', async () => {
  const closed = createHarness({ projectStatus: 'CLOSED' });
  await assert.rejects(
    () => startAttempt(closed.service),
    /project is not open/u,
  );

  const future = createHarness({
    availableFrom: new Date('2026-07-26T10:00:00.000Z'),
    deadlineAt: new Date('2026-07-27T10:00:00.000Z'),
  });
  await assert.rejects(
    () => startAttempt(future.service),
    /window has not started/u,
  );

  const expired = createHarness({
    availableFrom: new Date('2026-07-23T10:00:00.000Z'),
    deadlineAt: new Date('2026-07-24T10:00:00.000Z'),
  });
  await assert.rejects(
    () => startAttempt(expired.service),
    /deadline has expired/u,
  );
});

test('assigned-only project hides an unassigned direct start', async () => {
  const harness = createHarness();
  harness.prisma.project.audienceMode =
    TrainingProjectAudienceMode.ASSIGNED_ONLY;
  harness.prisma.project.assignments = [];

  await assert.rejects(
    () => startAttempt(harness.service),
    /Training project not found/u,
  );
  assert.equal(harness.prisma.attempts.size, 0);
});

test('assigned-only project pins the active assignment on a new attempt', async () => {
  const harness = createHarness();
  const assignmentId = '70000000-0000-4000-8000-000000000001';
  harness.prisma.project.audienceMode =
    TrainingProjectAudienceMode.ASSIGNED_ONLY;
  harness.prisma.project.assignments = [{ id: assignmentId }];

  const attempt = await startAttempt(harness.service);

  assert.equal(attempt.assignmentId, assignmentId);
  assert.deepEqual(
    harness.prisma.rawQueries.slice(0, 2).map((query) => query.values[0]),
    [
      `training-audience:${PROJECT_ID}`,
      `training-attempt:${USER_ID}:${PROJECT_ID}`,
    ],
  );
});

test('non-voice inputs are rejected and duplicate voice update creates no second segment', async () => {
  const harness = createHarness();
  const attempt = await startAttempt(harness.service);

  for (const kind of ['TEXT', 'AUDIO', 'DOCUMENT', 'VIDEO_NOTE']) {
    await assert.rejects(
      () =>
        harness.service.appendVoiceSegment({
          attemptId: attempt.id,
          kind,
          updateId: BigInt(6_000 + kind.length),
          fakeTranscript: 'not voice',
          recordingStartedAt: harness.clock.now(),
        }),
      /Only voice segments/u,
    );
  }

  const command = {
    attemptId: attempt.id,
    kind: 'VOICE',
    updateId: 6_100n,
    fakeTranscript: 'одна часть',
    recordingStartedAt: harness.clock.now(),
  };
  await harness.service.appendVoiceSegment(command);
  await harness.service.appendVoiceSegment(command);

  assert.equal(harness.prisma.segments.size, 1);
  assert.equal(
    (await harness.service.getAttempt(attempt.id)).attempt.attemptQuestions[0]
      .answer.voiceSegments.length,
    1,
  );
});

test('finish command, timeout command and finalization are idempotent under duplicates', async () => {
  const harness = createHarness();
  const attempt = await startAttempt(harness.service);
  await harness.service.appendVoiceSegment({
    attemptId: attempt.id,
    kind: 'VOICE',
    updateId: 7_000n,
    fakeTranscript: 'главный ответ',
    recordingStartedAt: harness.clock.now(),
  });
  const targetQuestionId = (
    await harness.service.getAttempt(attempt.id)
  ).attempt.attemptQuestions[0].id;

  await Promise.all([
    harness.service.finishAnswer({
      attemptId: attempt.id,
      attemptQuestionId: targetQuestionId,
    }),
    harness.service.finishAnswer({
      attemptId: attempt.id,
      attemptQuestionId: targetQuestionId,
    }),
    harness.service.finishAnswer({
      attemptId: attempt.id,
      attemptQuestionId: targetQuestionId,
    }),
  ]);
  assert.equal(harness.prisma.evaluations.size, 1);
  await harness.service.finishAnswer({
    attemptId: attempt.id,
    attemptQuestionId: targetQuestionId,
  });
  assert.equal(harness.prisma.evaluations.size, 1);

  const state = (await harness.service.getAttempt(attempt.id)).attempt;
  harness.clock.set(state.expiresAt);
  await Promise.all([
    harness.service.handleTimeout(attempt.id, harness.clock.now()),
    harness.service.handleTimeout(attempt.id, harness.clock.now()),
  ]);
  harness.clock.set(state.graceExpiresAt);
  await Promise.all([
    harness.service.handleTimeout(attempt.id, harness.clock.now()),
    harness.service.handleTimeout(attempt.id, harness.clock.now()),
  ]);
  const finalized = await Promise.all([
    harness.service.finalizeAttempt(attempt.id),
    harness.service.finalizeAttempt(attempt.id),
    harness.service.finalizeAttempt(attempt.id),
  ]);

  assert.equal(
    finalized.every(
      (result) => result.attempt.status === TrainingAttemptStatus.COMPLETED,
    ),
    true,
  );
  assert.equal(harness.prisma.evaluations.size, 1);
});

test('service recreation resumes a persisted READY answer', async () => {
  const harness = createHarness();
  const attempt = await startAttempt(harness.service);
  await harness.service.appendVoiceSegment({
    attemptId: attempt.id,
    kind: 'VOICE',
    updateId: 7_100n,
    fakeTranscript: 'ready restart',
    recordingStartedAt: harness.clock.now(),
  });
  harness.service.onModuleDestroy();
  await harness.service.finishAnswer({
    attemptId: attempt.id,
    attemptQuestionId: attempt.attemptQuestions[0].id,
  });
  assert.equal(
    [...harness.prisma.answers.values()][0].status,
    'READY',
  );

  const recoveredService = createService(harness);
  await recoveredService.recoverPendingProcessing();
  const recovered = (await recoveredService.getAttempt(attempt.id)).attempt;

  assert.equal(
    recovered.attemptQuestions[0].status,
    TrainingAttemptQuestionStatus.SCORED,
  );
  assert.equal(
    recovered.attemptQuestions[1].status,
    TrainingAttemptQuestionStatus.PRESENTED,
  );
});

test('service recreation reclaims a stale TRANSCRIBING job and creates no duplicate evaluation', async () => {
  const deferred = createDeferred();
  const harness = createHarness({
    transcriptionProvider: {
      transcribe: async () => deferred.promise,
    },
  });
  const attempt = await startAttempt(harness.service);
  await harness.service.appendVoiceSegment({
    attemptId: attempt.id,
    kind: 'VOICE',
    updateId: 7_200n,
    fakeTranscript: 'transcribing restart',
    recordingStartedAt: harness.clock.now(),
  });
  void harness.service
    .finishAnswer({
      attemptId: attempt.id,
      attemptQuestionId: attempt.attemptQuestions[0].id,
    })
    .catch(() => {});
  await waitFor(
    () => [...harness.prisma.answers.values()][0].status === 'TRANSCRIBING',
    'Answer did not enter TRANSCRIBING',
  );

  harness.service.onModuleDestroy();
  harness.clock.advanceSeconds(31);
  let recoveredTranscriptions = 0;
  const recoveredService = createService({
    ...harness,
    transcriptionProvider: {
      transcribe: async (input) => {
        recoveredTranscriptions += 1;
        return new DeterministicFakeTrainingTranscriptionProvider().transcribe(
          input,
        );
      },
    },
  });
  await recoveredService.recoverPendingProcessing();

  assert.equal(recoveredTranscriptions, 1);
  assert.equal(harness.prisma.evaluations.size, 1);
  assert.equal(
    (await recoveredService.getAttempt(attempt.id)).attempt.attemptQuestions[0]
      .status,
    TrainingAttemptQuestionStatus.SCORED,
  );
});

test('service recreation reclaims a stale EVALUATING job', async () => {
  const deferred = createDeferred();
  const harness = createHarness({
    evaluationProvider: {
      evaluate: async () => deferred.promise,
    },
  });
  const attempt = await startAttempt(harness.service);
  await harness.service.appendVoiceSegment({
    attemptId: attempt.id,
    kind: 'VOICE',
    updateId: 7_300n,
    fakeTranscript: 'evaluating restart',
    recordingStartedAt: harness.clock.now(),
  });
  void harness.service
    .finishAnswer({
      attemptId: attempt.id,
      attemptQuestionId: attempt.attemptQuestions[0].id,
    })
    .catch(() => {});
  await waitFor(
    () => [...harness.prisma.answers.values()][0].status === 'EVALUATING',
    'Answer did not enter EVALUATING',
  );

  harness.service.onModuleDestroy();
  harness.clock.advanceSeconds(31);
  let recoveredEvaluations = 0;
  const recoveredService = createService({
    ...harness,
    evaluationProvider: {
      evaluate: async (input) => {
        recoveredEvaluations += 1;
        return new DeterministicFakeTrainingEvaluationProvider().evaluate(input);
      },
    },
  });
  await recoveredService.recoverPendingProcessing();

  assert.equal(recoveredEvaluations, 1);
  assert.equal(harness.prisma.evaluations.size, 1);
});

test('service recreation resumes FINALIZING through one persisted finalization job', async () => {
  let service;
  let evaluationCalls = 0;
  const fakeEvaluation = new DeterministicFakeTrainingEvaluationProvider();
  const harness = createHarness({
    evaluationProvider: {
      evaluate: async (input) => {
        evaluationCalls += 1;
        const result = await fakeEvaluation.evaluate(input);
        if (evaluationCalls === 4) {
          service.onModuleDestroy();
        }
        return result;
      },
    },
  });
  service = harness.service;
  const attempt = await completeAttempt(harness, 7_400);

  assert.equal(attempt.status, TrainingAttemptStatus.FINALIZING);
  const finalizeJob = harness.prisma.jobs.get(
    `attempt:${attempt.id}:finalize`,
  );
  assert.equal(finalizeJob.status, TrainingJobStatus.PENDING);

  const recoveredService = createService(harness);
  await recoveredService.recoverPendingProcessing();
  const completed = (await recoveredService.getAttempt(attempt.id)).attempt;

  assert.equal(completed.status, TrainingAttemptStatus.COMPLETED);
  assert.equal(completed.finalScore.toFixed(2), '100.00');
  assert.equal(
    [...harness.prisma.jobs.values()].filter(
      (job) => job.kind === TrainingJobKind.FINALIZE_ATTEMPT,
    ).length,
    1,
  );
});

test('persisted transcription result is reused after restart before the answer state transition', async () => {
  const deferred = createDeferred();
  let harness;
  harness = createHarness({
    transcriptionProvider: {
      transcribe: async (input) => {
        const answer = harness.prisma.answers.get(input.answerId);
        Object.assign(answer, {
          combinedTranscript: 'persisted provider result',
          normalizedLanguage: 'ru',
          transcriptionProvider: 'fake',
          transcriptionModel: 'fake-transcription-v1',
          transcriptionRequestId: `saved:${input.answerId}`,
        });
        return deferred.promise;
      },
    },
  });
  const attempt = await startAttempt(harness.service);
  await harness.service.appendVoiceSegment({
    attemptId: attempt.id,
    kind: 'VOICE',
    updateId: 7_500n,
    fakeTranscript: 'original segment',
    recordingStartedAt: harness.clock.now(),
  });
  void harness.service
    .finishAnswer({
      attemptId: attempt.id,
      attemptQuestionId: attempt.attemptQuestions[0].id,
    })
    .catch(() => {});
  await waitFor(
    () =>
      [...harness.prisma.answers.values()][0].combinedTranscript ===
      'persisted provider result',
    'Provider result was not persisted by the crash fixture',
  );

  harness.service.onModuleDestroy();
  harness.clock.advanceSeconds(31);
  let repeatedProviderCalls = 0;
  const recoveredService = createService({
    ...harness,
    transcriptionProvider: {
      transcribe: async () => {
        repeatedProviderCalls += 1;
        throw new Error('Persisted provider result must be reused');
      },
    },
  });
  await recoveredService.recoverPendingProcessing();

  assert.equal(repeatedProviderCalls, 0);
  assert.equal(
    [...harness.prisma.answers.values()][0].combinedTranscript,
    'persisted provider result',
  );
  assert.equal(harness.prisma.evaluations.size, 1);
});

test('two recovery workers claim one persisted answer only once', async () => {
  const harness = createHarness();
  const attempt = await startAttempt(harness.service);
  await harness.service.appendVoiceSegment({
    attemptId: attempt.id,
    kind: 'VOICE',
    updateId: 7_600n,
    fakeTranscript: 'two workers',
    recordingStartedAt: harness.clock.now(),
  });
  harness.service.onModuleDestroy();
  await harness.service.finishAnswer({
    attemptId: attempt.id,
    attemptQuestionId: attempt.attemptQuestions[0].id,
  });

  let transcriptionCalls = 0;
  let evaluationCalls = 0;
  const transcriptionProvider = {
    transcribe: async (input) => {
      transcriptionCalls += 1;
      return new DeterministicFakeTrainingTranscriptionProvider().transcribe(
        input,
      );
    },
  };
  const evaluationProvider = {
    evaluate: async (input) => {
      evaluationCalls += 1;
      return new DeterministicFakeTrainingEvaluationProvider().evaluate(input);
    },
  };
  const workerOne = createService({
    ...harness,
    transcriptionProvider,
    evaluationProvider,
  });
  const workerTwo = createService({
    ...harness,
    transcriptionProvider,
    evaluationProvider,
  });

  await Promise.all([
    workerOne.recoverPendingProcessing(),
    workerTwo.recoverPendingProcessing(),
  ]);

  assert.equal(transcriptionCalls, 1);
  assert.equal(evaluationCalls, 1);
  assert.equal(harness.prisma.evaluations.size, 1);
  assert.equal(harness.prisma.scoreComponents.length, 1);
});

test('repeated persisted job execution does not duplicate transcript, evaluation or answer score', async () => {
  const harness = createHarness();
  const attempt = await startAttempt(harness.service);
  await answerCurrent({
    ...harness,
    attemptId: attempt.id,
    updateIds: [7_700],
    transcripts: ['repeat jobs'],
  });
  const answer = [...harness.prisma.answers.values()][0];
  const evaluationCount = harness.prisma.evaluations.size;
  const componentCount = harness.prisma.scoreComponents.length;

  for (const suffix of ['transcribe', 'evaluate']) {
    const job = harness.prisma.jobs.get(
      `attempt:${attempt.id}:answer:${answer.id}:${suffix}`,
    );
    Object.assign(job, {
      status: TrainingJobStatus.PENDING,
      runAt: harness.clock.now(),
      lockOwner: null,
      lockedAt: null,
      heartbeatAt: null,
      finishedAt: null,
    });
  }
  await harness.service.recoverPendingProcessing();

  assert.equal(harness.prisma.evaluations.size, evaluationCount);
  assert.equal(harness.prisma.scoreComponents.length, componentCount);
  assert.equal(
    (await harness.service.getAttempt(attempt.id)).attempt.attemptQuestions[1]
      .status,
    TrainingAttemptQuestionStatus.PRESENTED,
  );
});

test('timer grace accepts one voice started before expiry, auto-closes it and scores unanswered questions as zero', async () => {
  const harness = createHarness();
  const attempt = await startAttempt(harness.service);
  const recordingStartedAt = new Date(attempt.expiresAt.getTime() - 5_000);
  harness.clock.set(new Date(attempt.expiresAt.getTime() + 10_000));

  const result = await harness.service.appendVoiceSegment({
    attemptId: attempt.id,
    kind: 'VOICE',
    updateId: 8_000n,
    fakeTranscript: 'последняя уже начатая часть',
    recordingStartedAt,
    receivedAt: harness.clock.now(),
  });

  assert.equal(result.attempt.status, TrainingAttemptStatus.COMPLETED);
  assert.equal(result.attempt.serverScore.toFixed(2), '55.00');
  assert.equal(result.attempt.finalScore.toFixed(2), '55.00');
  assert.equal(result.attempt.passStatus, TrainingPassStatus.FAILED);
  assert.equal(
    result.attempt.attemptQuestions[0].status,
    TrainingAttemptQuestionStatus.SCORED,
  );
  assert.deepEqual(
    result.attempt.attemptQuestions
      .slice(1)
      .map((question) => question.status),
    Array(3).fill(TrainingAttemptQuestionStatus.SKIPPED_TIMEOUT),
  );
  await assert.rejects(
    () =>
      harness.service.appendVoiceSegment({
        attemptId: attempt.id,
        kind: 'VOICE',
        updateId: 8_001n,
        fakeTranscript: 'лишняя часть',
        recordingStartedAt,
        receivedAt: harness.clock.now(),
      }),
    /already finalized/u,
  );
});

test('a new voice recording started at or after timeout is rejected', async () => {
  const harness = createHarness();
  const attempt = await startAttempt(harness.service);
  harness.clock.set(new Date(attempt.expiresAt.getTime() + 1_000));

  await assert.rejects(
    () =>
      harness.service.appendVoiceSegment({
        attemptId: attempt.id,
        kind: 'VOICE',
        updateId: 8_100n,
        fakeTranscript: 'late recording',
        recordingStartedAt: attempt.expiresAt,
        receivedAt: harness.clock.now(),
      }),
    /started before timeout/u,
  );
  assert.equal(harness.prisma.segments.size, 0);
});

test('timeout intent persists during TRANSCRIBING and recovery finishes only the started answer', async () => {
  const deferred = createDeferred();
  const harness = createHarness({
    transcriptionProvider: {
      transcribe: async () => deferred.promise,
    },
  });
  const attempt = await startAttempt(harness.service);
  await harness.service.appendVoiceSegment({
    attemptId: attempt.id,
    kind: 'VOICE',
    updateId: 8_200n,
    fakeTranscript: 'timeout transcribing',
    recordingStartedAt: harness.clock.now(),
  });
  void harness.service
    .finishAnswer({
      attemptId: attempt.id,
      attemptQuestionId: attempt.attemptQuestions[0].id,
    })
    .catch(() => {});
  await waitFor(
    () => [...harness.prisma.answers.values()][0].status === 'TRANSCRIBING',
    'Answer did not enter TRANSCRIBING',
  );

  harness.clock.set(attempt.expiresAt);
  await harness.service.handleTimeout(attempt.id, harness.clock.now());
  const timeoutJob = harness.prisma.jobs.get(
    `attempt:${attempt.id}:timer:expire`,
  );
  assert.equal(timeoutJob.payloadJson.phase, 'APPLIED');
  assert.equal(timeoutJob.status, TrainingJobStatus.SUCCEEDED);

  harness.service.onModuleDestroy();
  harness.clock.advanceSeconds(31);
  const recoveredService = createService(harness);
  await recoveredService.recoverPendingProcessing();
  const completed = (await recoveredService.getAttempt(attempt.id)).attempt;

  assert.equal(completed.status, TrainingAttemptStatus.COMPLETED);
  assert.equal(completed.finalScore.toFixed(2), '55.00');
  assert.deepEqual(
    completed.attemptQuestions.slice(1).map((question) => question.status),
    Array(3).fill(TrainingAttemptQuestionStatus.SKIPPED_TIMEOUT),
  );
});

test('timeout intent persists during EVALUATING and recovery does not open another question', async () => {
  const deferred = createDeferred();
  const harness = createHarness({
    evaluationProvider: {
      evaluate: async () => deferred.promise,
    },
  });
  const attempt = await startAttempt(harness.service);
  await harness.service.appendVoiceSegment({
    attemptId: attempt.id,
    kind: 'VOICE',
    updateId: 8_300n,
    fakeTranscript: 'timeout evaluating',
    recordingStartedAt: harness.clock.now(),
  });
  void harness.service
    .finishAnswer({
      attemptId: attempt.id,
      attemptQuestionId: attempt.attemptQuestions[0].id,
    })
    .catch(() => {});
  await waitFor(
    () => [...harness.prisma.answers.values()][0].status === 'EVALUATING',
    'Answer did not enter EVALUATING',
  );

  harness.clock.set(attempt.expiresAt);
  await harness.service.handleTimeout(attempt.id, harness.clock.now());
  harness.service.onModuleDestroy();
  harness.clock.advanceSeconds(31);
  const recoveredService = createService(harness);
  await recoveredService.recoverPendingProcessing();
  const completed = (await recoveredService.getAttempt(attempt.id)).attempt;

  assert.equal(completed.status, TrainingAttemptStatus.COMPLETED);
  assert.equal(completed.finalScore.toFixed(2), '55.00');
  assert.equal(
    completed.attemptQuestions.some(
      (question) =>
        question.sequence > 1 &&
        question.status === TrainingAttemptQuestionStatus.PRESENTED,
    ),
    false,
  );
});

test('abandoned attempt is consumed, waits through grace, then finalizes with four skipped questions and zero', async () => {
  const harness = createHarness();
  const attempt = await startAttempt(harness.service);

  harness.clock.set(attempt.expiresAt);
  const atExpiry = await harness.service.handleTimeout(
    attempt.id,
    harness.clock.now(),
  );
  assert.equal(atExpiry.attempt.status, TrainingAttemptStatus.FINALIZING);
  assert.equal(atExpiry.attempt.isConsumed, true);

  harness.clock.set(attempt.graceExpiresAt);
  const completed = await harness.service.handleTimeout(
    attempt.id,
    harness.clock.now(),
  );
  assert.equal(completed.attempt.status, TrainingAttemptStatus.COMPLETED);
  assert.equal(completed.attempt.serverScore.toFixed(2), '0.00');
  assert.equal(completed.attempt.finalScore.toFixed(2), '0.00');
  assert.deepEqual(
    completed.attempt.attemptQuestions.map((question) => question.status),
    Array(4).fill(TrainingAttemptQuestionStatus.SKIPPED_TIMEOUT),
  );
});

test('distinct incorrect fact is penalized once and unsupported claim keeps server score but requires review', async () => {
  const harness = createHarness({
    allowRetakeAfterPass: true,
  });
  const reviewed = await completeAttempt(
    harness,
    9_000,
    '[[incorrect:main.fact]] [[incorrect:main.fact]]',
  );
  assert.equal(reviewed.serverScore.toFixed(2), '95.00');
  assert.equal(reviewed.finalScore.toFixed(2), '95.00');
  const incorrectComponents =
    reviewed.attemptQuestions[0].answer.evaluations[0].scoreComponents.filter(
      (component) => component.factVerdict === 'INCORRECT',
    );
  assert.equal(incorrectComponents.length, 1);
  assert.equal(incorrectComponents[0].penaltyPoints.toFixed(2), '5.00');

  harness.clock.advanceSeconds(3_601);
  const pendingReview = await completeAttempt(
    harness,
    9_100,
    '[[unsupported:факт сверх утверждённого материала]]',
  );
  assert.equal(pendingReview.serverScore.toFixed(2), '100.00');
  assert.equal(pendingReview.finalScore, null);
  assert.equal(
    pendingReview.status,
    TrainingAttemptStatus.REQUIRES_REVIEW,
  );
  assert.equal(pendingReview.reviewStatus, TrainingReviewStatus.PENDING);
  assert.equal(pendingReview.passStatus, TrainingPassStatus.PENDING);

  const best = await harness.service.getBestReviewedScore(USER_ID, PROJECT_ID);
  assert.equal(best.bestReviewedScore.toFixed(2), '95.00');
  assert.equal(best.attemptId, reviewed.id);
});

test('custom pass score and canonical threshold boundaries are enforced', async () => {
  const below = createHarness({ passScore: 75 });
  const failed = await completeAttempt(
    below,
    9_200,
    '[[criterion:main-total=29.994]]',
  );
  assert.equal(failed.finalScore.toFixed(2), '74.99');
  assert.equal(failed.passStatus, TrainingPassStatus.FAILED);

  const roundedUp = createHarness({ passScore: 75 });
  const passed = await completeAttempt(
    roundedUp,
    9_300,
    '[[criterion:main-total=29.995]]',
  );
  assert.equal(passed.finalScore.toFixed(2), '75.00');
  assert.equal(passed.passStatus, TrainingPassStatus.PASSED);

  const custom = createHarness({ passScore: 90 });
  const customFailed = await completeAttempt(
    custom,
    9_400,
    '[[criterion:main-total=44.994]]',
  );
  assert.equal(customFailed.finalScore.toFixed(2), '89.99');
  assert.equal(customFailed.passStatus, TrainingPassStatus.FAILED);
});

test('APPROVED and OVERRIDDEN reviews share canonical scoring and best-result rules', async () => {
  const harness = createHarness({
    allowRetakeAfterPass: true,
  });
  const notRequired = await completeAttempt(
    harness,
    9_500,
    '[[criterion:main-total=35]]',
  );
  assert.equal(notRequired.finalScore.toFixed(2), '80.00');
  assert.equal(notRequired.reviewStatus, TrainingReviewStatus.NOT_REQUIRED);

  harness.clock.advanceSeconds(3_601);
  const overriddenPending = await completeAttempt(
    harness,
    9_600,
    '[[criterion:main-total=25]] [[unsupported:override me]]',
  );
  assert.equal(overriddenPending.finalScore, null);
  let best = await harness.service.getBestReviewedScore(USER_ID, PROJECT_ID);
  assert.equal(best.bestReviewedScore.toFixed(2), '80.00');

  const overridden = (
    await harness.service.reviewAttempt({
      attemptId: overriddenPending.id,
      reviewerId: ADMIN_ID,
      idempotencyKey: 'review-override-9500',
      decision: 'OVERRIDDEN',
      adminScore: '89.995',
      comment: 'Проверено администратором',
    })
  ).attempt;
  assert.equal(overridden.adminScore.toFixed(2), '90.00');
  assert.equal(overridden.finalScore.toFixed(2), '90.00');
  assert.equal(overridden.reviewStatus, TrainingReviewStatus.OVERRIDDEN);
  assert.equal(overridden.passStatus, TrainingPassStatus.PASSED);
  assert.equal(overridden.aiScore.toFixed(2), '70.00');
  assert.equal(overridden.serverScore.toFixed(2), '70.00');

  best = await harness.service.getBestReviewedScore(USER_ID, PROJECT_ID);
  assert.equal(best.bestReviewedScore.toFixed(2), '90.00');
  assert.equal(best.attemptId, overridden.id);

  harness.clock.advanceSeconds(3_601);
  const approvedPending = await completeAttempt(
    harness,
    9_700,
    '[[unsupported:approve me]]',
  );
  best = await harness.service.getBestReviewedScore(USER_ID, PROJECT_ID);
  assert.equal(best.attemptId, overridden.id);

  const approved = (
    await harness.service.reviewAttempt({
      attemptId: approvedPending.id,
      reviewerId: ADMIN_ID,
      idempotencyKey: 'review-approved-9700',
      decision: 'APPROVED',
      comment: 'Факт подтверждён',
    })
  ).attempt;
  assert.equal(approved.adminScore, null);
  assert.equal(approved.finalScore.toFixed(2), '100.00');
  assert.equal(approved.reviewStatus, TrainingReviewStatus.APPROVED);
  assert.equal(harness.prisma.reviews.length, 2);

  const auditCount = harness.prisma.auditLogs.filter(
    (entry) =>
      entry.action === 'training.attempt.review' &&
      entry.entityId === approvedPending.id,
  ).length;
  const replayed = (
    await harness.service.reviewAttempt({
      attemptId: approvedPending.id,
      reviewerId: ADMIN_ID,
      idempotencyKey: 'review-approved-9700',
      decision: 'APPROVED',
      comment: 'Факт подтверждён',
    })
  ).attempt;
  assert.equal(replayed.id, approved.id);
  assert.equal(harness.prisma.reviews.length, 2);
  assert.equal(
    harness.prisma.auditLogs.filter(
      (entry) =>
        entry.action === 'training.attempt.review' &&
        entry.entityId === approvedPending.id,
    ).length,
    auditCount,
  );
  await assert.rejects(
    () =>
      harness.service.reviewAttempt({
        attemptId: approvedPending.id,
        reviewerId: ADMIN_ID,
        idempotencyKey: 'review-approved-9700',
        decision: 'APPROVED',
        comment: 'Другой payload',
      }),
    ConflictException,
  );
});

test('a FOLLOW_UP cannot be finished before it is presented', async () => {
  const harness = createHarness();
  const attempt = await startAttempt(harness.service);

  await assert.rejects(
    () =>
      harness.service.finishAnswer({
        attemptId: attempt.id,
        attemptQuestionId: attempt.attemptQuestions[1].id,
      }),
    /no longer current/u,
  );
  assert.equal(
    (await harness.service.getAttempt(attempt.id)).attempt.attemptQuestions[1]
      .status,
    TrainingAttemptQuestionStatus.PENDING,
  );
});

test('fake provider failure is refundable and does not consume the configured single attempt', async () => {
  const harness = createHarness({
    attemptLimit: 1,
    allowRetakeAfterPass: true,
    evaluationProvider: {
      evaluate: async () => {
        throw new Error('deterministic fake failure');
      },
    },
  });
  const attempt = await startAttempt(harness.service);
  await harness.service.appendVoiceSegment({
    attemptId: attempt.id,
    kind: 'VOICE',
    updateId: 10_000n,
    fakeTranscript: 'ответ',
    recordingStartedAt: harness.clock.now(),
  });
  await assert.rejects(
    () =>
      harness.service.finishAnswer({
        attemptId: attempt.id,
        attemptQuestionId: attempt.attemptQuestions[0].id,
      }),
    /deterministic fake failure/u,
  );
  const failed = (await harness.service.getAttempt(attempt.id)).attempt;
  assert.equal(failed.status, TrainingAttemptStatus.TECHNICAL_FAILURE);
  assert.equal(failed.isConsumed, true);
  assert.equal(
    [...harness.prisma.jobs.values()].some(
      (job) =>
        [TrainingJobStatus.PENDING, TrainingJobStatus.RUNNING].includes(
          job.status,
        ) && job.idempotencyKey.includes(':timer:'),
    ),
    false,
  );

  const staleWarning = [...harness.prisma.jobs.values()].find(
    (job) => job.kind === TrainingJobKind.SEND_TIMER_WARNING,
  );
  Object.assign(staleWarning, {
    status: TrainingJobStatus.PENDING,
    finishedAt: null,
  });

  const refunded = await harness.service.refundTechnicalFailure({
    attemptId: attempt.id,
    actorUserId: ADMIN_ID,
    reason: 'Подтверждённый системный сбой',
  });
  assert.equal(refunded.attempt.isConsumed, false);
  assert.equal(harness.prisma.auditLogs.length, 1);
  assert.equal(staleWarning.status, TrainingJobStatus.SUCCEEDED);

  await harness.service.refundTechnicalFailure({
    attemptId: attempt.id,
    actorUserId: ADMIN_ID,
    reason: 'Повторный refund',
  });
  assert.equal(harness.prisma.auditLogs.length, 1);

  const replacement = await startAttempt(harness.service);
  assert.equal(replacement.attemptNumber, 2);
  assert.equal(replacement.isConsumed, true);
});

test('a stale timer job after terminal completion is an idempotent no-op', async () => {
  const harness = createHarness();
  const completed = await completeAttempt(harness, 10_100);
  const originalFinalScore = completed.finalScore.toFixed(2);
  const expireJob = harness.prisma.jobs.get(
    `attempt:${completed.id}:timer:expire`,
  );
  Object.assign(expireJob, {
    status: TrainingJobStatus.PENDING,
    runAt: completed.expiresAt,
    finishedAt: null,
  });

  harness.clock.set(completed.graceExpiresAt);
  const result = await harness.service.handleTimeout(
    completed.id,
    harness.clock.now(),
  );

  assert.equal(result.attempt.status, TrainingAttemptStatus.COMPLETED);
  assert.equal(result.attempt.finalScore.toFixed(2), originalFinalScore);
  assert.equal(expireJob.status, TrainingJobStatus.SUCCEEDED);
});

test('explicit start confirmation is mandatory', async () => {
  const harness = createHarness();
  await assert.rejects(
    () =>
      harness.service.confirmStart({
        userId: USER_ID,
        projectId: PROJECT_ID,
        confirmed: false,
      }),
    /explicitly confirmed/u,
  );
  assert.equal(harness.prisma.attempts.size, 0);
});

async function completeAttemptFromStarted(harness, attempt, seed) {
  await answerCurrent({
    ...harness,
    attemptId: attempt.id,
    updateIds: [seed, seed + 1],
    transcripts: [
      'первая часть главного ответа',
      'вторая часть главного ответа',
    ],
  });
  for (let index = 0; index < 3; index += 1) {
    await answerCurrent({
      ...harness,
      attemptId: attempt.id,
      updateIds: [seed + 10 + index],
      transcripts: [`дополнительный ответ ${index + 1}`],
    });
  }
  return (await harness.service.getAttempt(attempt.id)).attempt;
}
