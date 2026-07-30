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
  const questions = [
    {
      id: '11111111-1111-4111-8111-111111111111',
      type: 'MAIN',
      text: 'Расскажите о проекте',
      position: 1,
      isActive: true,
      maxScore: 55,
    },
    ...Array.from({ length: 10 }, (_, index) => ({
      id: `22222222-2222-4222-8222-${String(index + 1).padStart(12, '0')}`,
      type: 'FOLLOW_UP',
      text: `Дополнительный вопрос ${index + 1}`,
      position: index + 1,
      isActive: true,
      maxScore: 15,
    })),
  ];
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
    questions,
    facts: [
      {
        id: '33333333-3333-4333-8333-333333333333',
        code: 'project.fact',
        statement: 'Проект находится в Москве',
        acceptedAliasesJson: [],
        isApproved: true,
        questionLinks: questions.map((question) => ({
          questionId: question.id,
        })),
      },
    ],
    criteria: [
      {
        id: '44444444-4444-4444-8444-444444444444',
        questionType: 'MAIN',
        code: 'main.completeness',
        title: 'Полнота',
        sortOrder: 0,
        maxPoints: 55,
        anchorsJson: [
          { id: 'main-zero', points: 0, description: 'Нет ответа' },
          { id: 'main-full', points: 55, description: 'Полный ответ' },
        ],
      },
      {
        id: '55555555-5555-4555-8555-555555555555',
        questionType: 'FOLLOW_UP',
        code: 'follow.accuracy',
        title: 'Точность',
        sortOrder: 0,
        maxPoints: 15,
        anchorsJson: [
          { id: 'follow-zero', points: 0, description: 'Нет ответа' },
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

test('publication rejects content that exceeds runtime fact and criterion limits', () => {
  const factHeavyVersion = validVersion();
  const mainQuestionId = factHeavyVersion.questions[0].id;
  factHeavyVersion.facts.push(
    ...Array.from({ length: 500 }, (_, index) => ({
      id: `fact-${index + 2}`,
      code: `project.fact.${index + 2}`,
      statement: `Утверждённый факт ${index + 2}`,
      acceptedAliasesJson: [],
      isApproved: true,
      questionLinks: [{ questionId: mainQuestionId }],
    })),
  );

  const factErrors = collectTrainingPublicationErrors(factHeavyVersion);
  assert.equal(
    factErrors.includes(
      'Main question linked approved facts count must not exceed 500',
    ),
    true,
  );

  const criterionHeavyVersion = validVersion();
  criterionHeavyVersion.criteria = [
    ...Array.from({ length: 101 }, (_, index) => {
      const maxPoints = index === 100 ? 5 : 0.5;
      return {
        id: `main-criterion-${index + 1}`,
        questionType: 'MAIN',
        code: `main.${index + 1}`,
        title: `Главный критерий ${index + 1}`,
        sortOrder: index,
        maxPoints,
        anchorsJson: [
          { id: 'zero', points: 0, description: 'Нет ответа' },
          { id: 'full', points: maxPoints, description: 'Полный ответ' },
        ],
      };
    }),
    validVersion().criteria[1],
  ];

  const criterionErrors = collectTrainingPublicationErrors(
    criterionHeavyVersion,
  );
  assert.equal(
    criterionErrors.includes('Main criteria count must not exceed 100'),
    true,
  );
});

test('publication requires bounded anchors with zero and full score endpoints', () => {
  const tooManyAnchors = validVersion();
  tooManyAnchors.criteria[0].anchorsJson = [
    { id: 'zero', points: 0, description: 'Нет ответа' },
    { id: 'full', points: 55, description: 'Полный ответ' },
    ...Array.from({ length: 99 }, (_, index) => ({
      id: `middle-${index + 1}`,
      points: 1,
      description: `Промежуточный уровень ${index + 1}`,
    })),
  ];
  assert.equal(
    collectTrainingPublicationErrors(tooManyAnchors).includes(
      'Main criterion anchors count must not exceed 100',
    ),
    true,
  );

  const noZero = validVersion();
  noZero.criteria[0].anchorsJson = [
    { id: 'full', points: 55, description: 'Полный ответ' },
  ];
  assert.equal(
    collectTrainingPublicationErrors(noZero).includes(
      'Main criteria require a zero-point anchor',
    ),
    true,
  );

  const noFull = validVersion();
  noFull.criteria[0].anchorsJson = [
    { id: 'zero', points: 0, description: 'Нет ответа' },
    { id: 'partial', points: 20, description: 'Частичный ответ' },
  ];
  assert.equal(
    collectTrainingPublicationErrors(noFull).includes(
      'Main criteria require a full-score anchor',
    ),
    true,
  );
});

test('publication requires approved fact coverage for every active question', () => {
  const version = validVersion();
  version.facts[0].questionLinks = [
    { questionId: version.questions[0].id },
  ];

  const errors = collectTrainingPublicationErrors(version);

  assert.equal(
    errors.includes(
      'Follow-up question 1 must have at least one linked approved fact',
    ),
    true,
  );
  assert.equal(
    errors.includes(
      'Follow-up question 10 must have at least one linked approved fact',
    ),
    true,
  );
});

test('publication rejects duplicate fact statements or aliases within a question', () => {
  const version = validVersion();
  version.facts[0].statement = 'Срок сдачи — 2027.';
  version.facts.push({
    id: '66666666-6666-4666-8666-666666666666',
    code: 'project.deadline.alias',
    statement: 'Проект будет завершён в установленный срок',
    acceptedAliasesJson: ['  СРОК СДАЧИ 2027  '],
    isApproved: true,
    questionLinks: [{ questionId: version.questions[0].id }],
  });

  assert.equal(
    collectTrainingPublicationErrors(version).includes(
      'Main question linked approved facts must not contain duplicate statements or aliases',
    ),
    true,
  );
});

test('publication preflights aggregate prompt and mandatory output capacity', () => {
  const promptHeavyVersion = validVersion();
  promptHeavyVersion.criteria = [
    ...[18.33, 18.33, 18.34].map((maxPoints, criterionIndex) => ({
      id: `prompt-main-${criterionIndex + 1}`,
      questionType: 'MAIN',
      code: `main.prompt.${criterionIndex + 1}`,
      title: `Главный критерий ${criterionIndex + 1}`,
      sortOrder: criterionIndex,
      maxPoints,
      anchorsJson: [
        { id: 'zero', points: 0, description: 'я'.repeat(2_000) },
        { id: 'full', points: maxPoints, description: 'я'.repeat(2_000) },
        ...Array.from({ length: 98 }, (_, anchorIndex) => ({
          id: `middle-${anchorIndex + 1}`,
          points: 0,
          description: 'я'.repeat(2_000),
        })),
      ],
    })),
    validVersion().criteria[1],
  ];
  assert.equal(
    collectTrainingPublicationErrors(promptHeavyVersion).includes(
      'Main question evaluation input exceeds the safe prompt budget',
    ),
    true,
  );

  const outputHeavyVersion = validVersion();
  const mainQuestionId = outputHeavyVersion.questions[0].id;
  outputHeavyVersion.facts.push(
    ...Array.from({ length: 79 }, (_, index) => ({
      id: `77777777-7777-4777-8777-${String(index + 2).padStart(12, '0')}`,
      code: `output.fact.${index + 2}`,
      statement: `Короткий факт ${index + 2}`,
      acceptedAliasesJson: [],
      isApproved: true,
      questionLinks: [{ questionId: mainQuestionId }],
    })),
  );
  assert.equal(
    collectTrainingPublicationErrors(outputHeavyVersion).includes(
      'Main question evaluation output exceeds the safe output capacity',
    ),
    true,
  );
});
