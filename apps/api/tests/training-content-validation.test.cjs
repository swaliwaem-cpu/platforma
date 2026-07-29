const test = require('node:test');
const assert = require('node:assert/strict');
const { UnprocessableEntityException } = require('@nestjs/common');

const {
  assertTrainingAvailability,
  assertTrainingVersionPublishable,
  collectTrainingPublicationErrors,
  getTrainingVersionReadiness,
  normalizeTrainingUniqueKey,
} = require('../dist/training/training-content.validation.js');

function validVersion(overrides = {}) {
  return {
    passScore: 75,
    attemptLimit: 3,
    cooldownMinutes: 60,
    totalTimeLimitSeconds: 420,
    finishGraceSeconds: 90,
    warningSecondsJson: [60, 20],
    mainMaxScore: 55,
    followUpMaxScore: 15,
    project: {
      status: 'CLOSED',
      availableFrom: null,
      deadlineAt: null,
    },
    questions: [
      {
        type: 'MAIN',
        text: 'Расскажите о проекте',
        position: 1,
        isActive: true,
        maxScore: 55,
      },
      ...Array.from({ length: 10 }, (_, index) => ({
        type: 'FOLLOW_UP',
        text: `Дополнительный вопрос ${index + 1}`,
        position: index + 1,
        isActive: true,
        maxScore: 15,
      })),
    ],
    facts: [{ code: 'project.fact', isApproved: true }],
    criteria: [
      {
        questionType: 'MAIN',
        code: 'main.completeness',
        sortOrder: 0,
        maxPoints: 55,
        anchorsJson: [
          { id: 'main-full', points: 55, description: 'Полный ответ' },
        ],
      },
      {
        questionType: 'FOLLOW_UP',
        code: 'follow.accuracy',
        sortOrder: 0,
        maxPoints: 15,
        anchorsJson: [
          { id: 'follow-full', points: 15, description: 'Полный ответ' },
        ],
      },
    ],
    ...overrides,
  };
}

test('publication validation accepts the exact 1 plus 10 and 55 plus 15 content shape', () => {
  const version = validVersion();

  assert.deepEqual(collectTrainingPublicationErrors(version), []);
  assert.doesNotThrow(() => assertTrainingVersionPublishable(version));
});

test('publication validation reports aggregate content errors before any write', () => {
  const version = validVersion();
  version.questions.pop();
  version.questions[1].text = version.questions[0].text.toLocaleUpperCase('ru-RU');
  version.facts.push({ code: 'PROJECT.FACT', isApproved: false });
  version.criteria[0].maxPoints = 54;
  version.criteria[1].maxPoints = 14;
  version.warningSecondsJson = [20, 60];

  const errors = collectTrainingPublicationErrors(version);

  assert.equal(errors.some((error) => error.includes('exactly 10 active follow-up')), true);
  assert.equal(errors.includes('Active question texts must be unique'), true);
  assert.equal(errors.includes('Fact codes must be unique'), true);
  assert.equal(errors.includes('Every fact must be approved before publication'), true);
  assert.equal(errors.includes('Main criteria maximum must equal 55'), true);
  assert.equal(errors.includes('Follow-up criteria maximum must equal 15'), true);
  assert.equal(
    errors.includes('Timer warnings must be ordered from largest to smallest'),
    true,
  );
  assert.throws(() => assertTrainingVersionPublishable(version), UnprocessableEntityException);
});

test('publication validation enforces project settings and score caps', () => {
  const version = validVersion({
    passScore: 101,
    attemptLimit: 0,
    cooldownMinutes: 30,
    totalTimeLimitSeconds: 299,
    finishGraceSeconds: -1,
    warningSecondsJson: [300],
    mainMaxScore: 54,
    followUpMaxScore: 14,
    project: {
      status: 'ARCHIVED',
      availableFrom: new Date('2026-08-01T00:00:00.000Z'),
      deadlineAt: new Date('2026-08-09T00:00:00.000Z'),
    },
  });

  const errors = collectTrainingPublicationErrors(version);

  assert.equal(errors.includes('Archived project cannot be published'), true);
  assert.equal(errors.includes('Availability window must be between 1 and 7 days'), true);
  assert.equal(errors.includes('Pass score must be an integer between 0 and 100'), true);
  assert.equal(errors.includes('Attempt limit must be a positive integer'), true);
  assert.equal(errors.includes('Cooldown must be between 60 and 1440 minutes'), true);
  assert.equal(errors.includes('Attempt timer must be between 300 and 420 seconds'), true);
  assert.equal(errors.includes('Finish grace must be a non-negative integer'), true);
  assert.equal(errors.includes('Main answer maximum must equal 55'), true);
  assert.equal(errors.includes('Follow-up answer maximum must equal 15'), true);
});

test('availability accepts no schedule or a complete 1 to 7 day window', () => {
  assert.doesNotThrow(() => assertTrainingAvailability(null, null));
  assert.doesNotThrow(() =>
    assertTrainingAvailability(
      new Date('2026-08-01T00:00:00.000Z'),
      new Date('2026-08-02T00:00:00.000Z'),
    ),
  );
  assert.throws(
    () => assertTrainingAvailability(new Date('2026-08-01T00:00:00.000Z'), null),
    UnprocessableEntityException,
  );
  assert.throws(
    () =>
      assertTrainingAvailability(
        new Date('2026-08-01T00:00:00.000Z'),
        new Date('2026-08-08T00:00:00.001Z'),
      ),
    UnprocessableEntityException,
  );
});

test('duplicate-key normalization is trimmed and case insensitive', () => {
  assert.equal(normalizeTrainingUniqueKey('  ФАКТ.Code  '), 'факт.code');
});

test('readiness uses the publication validator and exposes the wizard contract', () => {
  const readiness = getTrainingVersionReadiness(validVersion());

  assert.deepEqual(readiness, {
    readyToPublish: true,
    facts: {
      approved: 1,
      total: 1,
      pendingSuggestions: 0,
      ready: true,
    },
    questions: {
      active: 11,
      required: 11,
      mainReady: true,
      followUpsReady: true,
      positionsReady: true,
      ready: true,
    },
    criteria: {
      mainPoints: 55,
      mainRequired: 55,
      followUpPoints: 15,
      followUpRequired: 15,
      ready: true,
    },
    issues: [],
  });
});

test('pending fact suggestions are reported by readiness and block publication', () => {
  const version = validVersion({ pendingFactSuggestionCount: 2 });
  const readiness = getTrainingVersionReadiness(version);

  assert.equal(readiness.readyToPublish, false);
  assert.equal(readiness.facts.pendingSuggestions, 2);
  assert.equal(readiness.facts.ready, false);
  assert.deepEqual(readiness.issues[0], {
    code: 'facts.pending_suggestions',
    step: 'suggestions',
    message: 'Pending fact suggestions must be reviewed or dismissed before publication',
  });
  assert.throws(
    () => assertTrainingVersionPublishable(version),
    UnprocessableEntityException,
  );
});

test('active fact suggestion generation blocks readiness and publication', () => {
  const version = validVersion({
    activeFactSuggestionRunCount: 1,
    activeFactSuggestionProviderCount: 2,
    activeFactSuggestionJobCount: 2,
  });
  const readiness = getTrainingVersionReadiness(version);

  assert.equal(readiness.readyToPublish, false);
  assert.equal(readiness.facts.ready, false);
  assert.deepEqual(readiness.issues[0], {
    code: 'facts.suggestion_generation_active',
    step: 'suggestions',
    message: 'Fact suggestion generation must finish before publication',
  });
  assert.throws(
    () => assertTrainingVersionPublishable(version),
    UnprocessableEntityException,
  );
});

test('in-flight source extraction is reported on the sources step and blocks publication', () => {
  const version = validVersion({
    sourceDocuments: [{ extractionStatus: 'PENDING' }],
    officialUrlSources: [
      { extractionStatus: 'PROCESSING' },
      { extractionStatus: 'FAILED' },
    ],
  });
  const readiness = getTrainingVersionReadiness(version);

  assert.equal(readiness.readyToPublish, false);
  assert.deepEqual(readiness.issues, [
    {
      code: 'sources.processing',
      step: 'sources',
      message: 'Source extraction must finish before publication',
    },
  ]);
  assert.throws(
    () => assertTrainingVersionPublishable(version),
    UnprocessableEntityException,
  );
  assert.deepEqual(
    collectTrainingPublicationErrors(
      validVersion({
        sourceDocuments: [{ extractionStatus: 'READY' }],
        officialUrlSources: [{ extractionStatus: 'FAILED' }],
      }),
    ),
    [],
  );
});
