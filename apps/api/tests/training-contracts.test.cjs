const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const prisma = require('@prisma/client');
const {
  TRAINING_ACTIVE_ATTEMPT_STATUSES,
  TRAINING_ATTEMPT_QUESTION_COUNT,
  TRAINING_FOLLOW_UP_MAX_SCORE,
  TRAINING_FOLLOW_UP_POOL_SIZE,
  TRAINING_IMMUTABLE_VERSION_STATUSES,
  TRAINING_MAIN_MAX_SCORE,
  TRAINING_MAIN_QUESTION_COUNT,
  TRAINING_SELECTED_FOLLOW_UP_COUNT,
  TRAINING_TOTAL_MAX_SCORE,
} = require('../dist/training/training.domain.js');
const {
  trainingAttemptRepositoryInclude,
  trainingJobClaimSelect,
  trainingProjectRepositoryInclude,
} = require('../dist/training/training.repository.types.js');

const rootDir = path.resolve(__dirname, '../../..');
const sharedTrainingSource = fs.readFileSync(
  path.join(rootDir, 'packages/shared/src/training.ts'),
  'utf8',
);
const repositoryTypesSource = fs.readFileSync(
  path.join(rootDir, 'apps/api/src/training/training.repository.types.ts'),
  'utf8',
);

const expectedAttemptStatuses = [
  'STARTED',
  'AWAITING_MAIN',
  'PROCESSING_MAIN',
  'AWAITING_FOLLOW_UP',
  'PROCESSING_FOLLOW_UP',
  'FINALIZING',
  'COMPLETED',
  'REQUIRES_REVIEW',
  'EXPIRED',
  'TECHNICAL_FAILURE',
];

const expectedJobKinds = [
  'TELEGRAM_DOWNLOAD_SEGMENT',
  'ASSEMBLE_ANSWER_AUDIO',
  'TRANSCRIBE_ANSWER',
  'ANALYZE_ACOUSTICS',
  'EVALUATE_ANSWER',
  'FINALIZE_ATTEMPT',
  'SEND_TELEGRAM_MESSAGE',
  'SEND_TIMER_WARNING',
  'EXPIRE_ATTEMPT',
  'EXTRACT_SOURCE_DOCUMENT',
];

test('generated Prisma enums match shared training contracts', () => {
  assert.deepEqual(Object.values(prisma.TrainingAttemptStatus), expectedAttemptStatuses);
  assert.deepEqual(Object.values(prisma.TrainingJobKind), expectedJobKinds);
  assert.deepEqual(Object.values(prisma.TrainingProjectStatus), [
    'DRAFT',
    'OPEN',
    'CLOSED',
    'ARCHIVED',
  ]);
  assert.deepEqual(Object.values(prisma.TrainingVersionStatus), [
    'DRAFT',
    'PUBLISHED',
    'SUPERSEDED',
  ]);
  assert.deepEqual(Object.values(prisma.TrainingQuestionType), ['MAIN', 'FOLLOW_UP']);
  assert.deepEqual(Object.values(prisma.TrainingReviewStatus), [
    'NOT_REQUIRED',
    'PENDING',
    'APPROVED',
    'OVERRIDDEN',
  ]);

  for (const literal of [...expectedAttemptStatuses, ...expectedJobKinds]) {
    assert.match(sharedTrainingSource, new RegExp(`'${literal}'`));
  }
});

test('domain constants encode one main plus three selected follow-ups from ten', () => {
  assert.equal(TRAINING_MAIN_QUESTION_COUNT, 1);
  assert.equal(TRAINING_FOLLOW_UP_POOL_SIZE, 10);
  assert.equal(TRAINING_SELECTED_FOLLOW_UP_COUNT, 3);
  assert.equal(TRAINING_ATTEMPT_QUESTION_COUNT, 4);
  assert.equal(TRAINING_MAIN_MAX_SCORE, 55);
  assert.equal(TRAINING_FOLLOW_UP_MAX_SCORE, 15);
  assert.equal(TRAINING_TOTAL_MAX_SCORE, 100);
  assert.deepEqual(TRAINING_ACTIVE_ATTEMPT_STATUSES, expectedAttemptStatuses.slice(0, 6));
  assert.deepEqual(TRAINING_IMMUTABLE_VERSION_STATUSES, ['PUBLISHED', 'SUPERSEDED']);
});

test('shared snapshot contracts pin attempts to a version and exactly three follow-ups', () => {
  assert.match(
    sharedTrainingSource,
    /export type TrainingAttemptSettingsSnapshot = \{[\s\S]*versionId: string;[\s\S]*versionNumber: number;[\s\S]*passScore: number;[\s\S]*totalTimeLimitSeconds: number;[\s\S]*finishGraceSeconds: number;[\s\S]*warningSeconds: number\[\];[\s\S]*mainMaxScore: 55;[\s\S]*followUpMaxScore: 15;/,
  );
  assert.match(
    sharedTrainingSource,
    /export type TrainingQuestionSelection = \{[\s\S]*mainQuestionId: string;[\s\S]*followUpQuestionIds: readonly \[string, string, string\];/,
  );
  assert.match(
    sharedTrainingSource,
    /export type TrainingScoreSnapshot = \{[\s\S]*aiScore: string \| null;[\s\S]*serverScore: string \| null;[\s\S]*adminScore: string \| null;[\s\S]*finalScore: string \| null;/,
  );
});

test('repository contracts expose stable project, attempt and job records', () => {
  assert.deepEqual(trainingProjectRepositoryInclude.realEstateObject.select, {
    id: true,
    title: true,
    slug: true,
    status: true,
  });
  assert.equal(trainingProjectRepositoryInclude.activeVersion.include.questions !== undefined, true);
  assert.equal(trainingProjectRepositoryInclude.activeVersion.include.facts !== undefined, true);
  assert.equal(trainingProjectRepositoryInclude.activeVersion.include.criteria !== undefined, true);
  assert.equal(trainingAttemptRepositoryInclude.attemptQuestions.include.answer !== undefined, true);
  assert.equal(
    trainingAttemptRepositoryInclude.attemptQuestions.include.answer.include.voiceSegments !==
      undefined,
    true,
  );
  assert.deepEqual(trainingJobClaimSelect, {
    id: true,
    kind: true,
    status: true,
    payloadJson: true,
    idempotencyKey: true,
    runAt: true,
    attempts: true,
    maxAttempts: true,
    lockOwner: true,
    lockedAt: true,
    heartbeatAt: true,
  });
  assert.match(repositoryTypesSource, /export type TrainingTransactionClient = Prisma\.TransactionClient;/);
});
