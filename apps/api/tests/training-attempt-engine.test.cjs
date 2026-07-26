require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ConflictException,
} = require('@nestjs/common');
const {
  TrainingAttemptQuestionStatus,
  TrainingAttemptStatus,
  TrainingPassStatus,
  TrainingReviewStatus,
} = require('@prisma/client');

const {
  TrainingAttemptEngineService,
} = require('../dist/training/training-attempt-engine.service.js');
const {
  DeterministicFakeTrainingEvaluationProvider,
  DeterministicFakeTrainingTranscriptionProvider,
} = require('../dist/training/training-attempt.providers.js');
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
  const service = new TrainingAttemptEngineService(
    prisma,
    clock,
    options.selector ?? new DeterministicQuestionSelector(),
    options.transcriptionProvider ??
      new DeterministicFakeTrainingTranscriptionProvider(),
    options.evaluationProvider ??
      new DeterministicFakeTrainingEvaluationProvider(),
  );

  return { clock, prisma, service };
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
  assert.equal(completed.aiScore, 100);
  assert.equal(completed.serverScore, 100);
  assert.equal(completed.finalScore, 100);
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
  assert.equal(result.attempt.serverScore, 55);
  assert.equal(result.attempt.finalScore, 55);
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
  assert.equal(completed.attempt.serverScore, 0);
  assert.equal(completed.attempt.finalScore, 0);
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
  assert.equal(reviewed.serverScore, 95);
  assert.equal(reviewed.finalScore, 95);
  const incorrectComponents =
    reviewed.attemptQuestions[0].answer.evaluations[0].scoreComponents.filter(
      (component) => component.factVerdict === 'INCORRECT',
    );
  assert.equal(incorrectComponents.length, 1);
  assert.equal(incorrectComponents[0].penaltyPoints, 5);

  harness.clock.advanceSeconds(3_601);
  const pendingReview = await completeAttempt(
    harness,
    9_100,
    '[[unsupported:факт сверх утверждённого материала]]',
  );
  assert.equal(pendingReview.serverScore, 100);
  assert.equal(pendingReview.finalScore, null);
  assert.equal(
    pendingReview.status,
    TrainingAttemptStatus.REQUIRES_REVIEW,
  );
  assert.equal(pendingReview.reviewStatus, TrainingReviewStatus.PENDING);
  assert.equal(pendingReview.passStatus, TrainingPassStatus.PENDING);

  const best = await harness.service.getBestReviewedScore(USER_ID, PROJECT_ID);
  assert.equal(best.bestReviewedScore, 95);
  assert.equal(best.attemptId, reviewed.id);
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

  const refunded = await harness.service.refundTechnicalFailure({
    attemptId: attempt.id,
    actorUserId: ADMIN_ID,
    reason: 'Подтверждённый системный сбой',
  });
  assert.equal(refunded.attempt.isConsumed, false);
  assert.equal(harness.prisma.auditLogs.length, 1);

  const replacement = await startAttempt(harness.service);
  assert.equal(replacement.attemptNumber, 2);
  assert.equal(replacement.isConsumed, true);
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
