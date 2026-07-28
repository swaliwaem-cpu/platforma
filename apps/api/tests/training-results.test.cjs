require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  Prisma,
  TrainingAttemptQuestionStatus,
  TrainingAttemptStatus,
  TrainingPassStatus,
  TrainingQuestionType,
  TrainingReviewStatus,
} = require('@prisma/client');

const { PERMISSIONS_KEY } = require('../dist/auth/permissions.decorator.js');
const {
  buildTrainingRankingCsv,
  escapeTrainingCsvCell,
  TRAINING_RANKING_CSV_BOM,
} = require('../dist/training/training-csv.js');
const {
  buildTrainingRankingNarrative,
} = require('../dist/training/training-ranking.service.js');
const {
  TrainingAdminResultsController,
  TrainingEmployeeResultsController,
} = require('../dist/training/training-results.controller.js');
const {
  TrainingResultsService,
} = require('../dist/training/training-results.service.js');

test('ranking narrative is deterministic and avoids overclaiming on one project', () => {
  const insufficient = buildTrainingRankingNarrative({
    completedProjectsCount: 1,
    passedProjectsCount: 1,
    averageBestScore: '91.00',
    projects: [],
  });
  assert.equal(
    insufficient,
    'Недостаточно завершённых аттестаций для общей расшифровки.',
  );

  const input = {
    completedProjectsCount: 2,
    passedProjectsCount: 1,
    averageBestScore: '78.50',
    projects: [
      {
        projectTitle: 'ЖК Север',
        finalScore: '92.00',
        components: [
          {
            title: 'Факты',
            awardedPoints: '20.00',
            maxPoints: '20.00',
          },
          {
            title: 'Структура',
            awardedPoints: '4.00',
            maxPoints: '10.00',
          },
        ],
        errors: ['Срок сдачи'],
        unsupportedClaims: ['Несогласованная акция'],
        scoreChangeFromFirst: '12.00',
      },
      {
        projectTitle: 'ЖК Юг',
        finalScore: '65.00',
        components: [],
        errors: [],
        unsupportedClaims: [],
        scoreChangeFromFirst: null,
      },
    ],
  };
  assert.equal(
    buildTrainingRankingNarrative(input),
    buildTrainingRankingNarrative(structuredClone(input)),
  );
  assert.match(buildTrainingRankingNarrative(input), /Сильная сторона: Факты/u);
  assert.match(
    buildTrainingRankingNarrative(input),
    /Зона внимания: Структура/u,
  );
  assert.match(
    buildTrainingRankingNarrative(input),
    /Средняя динамика от первой до лучшей попытки: \+12\.00/u,
  );
});

test('CSV neutralizes formulas, quotes Unicode and omits sensitive fields', () => {
  assert.equal(escapeTrainingCsvCell('  =2+2'), "'  =2+2");
  assert.equal(escapeTrainingCsvCell('+SUM(A1:A2)'), "'+SUM(A1:A2)");
  assert.equal(escapeTrainingCsvCell('-1+2'), "'-1+2");
  assert.equal(escapeTrainingCsvCell('@cmd'), "'@cmd");
  assert.equal(escapeTrainingCsvCell('\tformula'), "'\tformula");
  assert.equal(escapeTrainingCsvCell('  \tformula'), "'  \tformula");
  assert.equal(escapeTrainingCsvCell('строка, \"цитата\"'), '"строка, ""цитата"""');
  assert.equal(escapeTrainingCsvCell('первая\nвторая'), '"первая\nвторая"');

  const csv = buildTrainingRankingCsv({
    items: [
      {
        position: 1,
        user: {
          id: 'user-safe',
          name: '=ОПАСНО',
          email: 'user@example.test',
        },
        passedProjectsCount: 1,
        completedProjectsCount: 1,
        averageBestScore: '88.50',
        attemptsUsed: 2,
        lastCompletedAt: '2026-07-27T10:00:00.000Z',
        totalDurationSeconds: 300,
        averageDurationSeconds: 300,
        narrative: 'Стабильный текст, без AI.',
        projects: [
          {
            attemptId: 'attempt-safe',
            attemptNumber: 2,
            projectId: 'project-safe',
            projectTitle: 'ЖК «Река»',
            finalScore: '88.50',
            passStatus: 'PASSED',
            completedAt: '2026-07-27T10:00:00.000Z',
            attemptsUsed: 2,
            summary: 'Безопасная сводка',
            scoreChangeFromFirst: '4.00',
            components: [],
            errors: ['ошибка'],
            unsupportedClaims: [],
          },
        ],
      },
    ],
    pagination: {
      page: 1,
      pageSize: 1,
      total: 1,
      totalPages: 1,
    },
    projects: [{ id: 'project-safe', title: 'ЖК «Река»' }],
  });

  assert.ok(csv.startsWith(TRAINING_RANKING_CSV_BOM));
  assert.match(csv, /'=ОПАСНО/u);
  for (const forbidden of [
    'transcript',
    'audioUrl',
    'storageKey',
    'telegramUserId',
    'chatId',
    'providerUsageJson',
  ]) {
    assert.equal(csv.includes(forbidden), false, forbidden);
  }
});

test('results controllers enforce employee ownership and administrative read scopes', () => {
  assert.deepEqual(
    Reflect.getMetadata(
      PERMISSIONS_KEY,
      TrainingEmployeeResultsController.prototype.listAttempts,
    ),
    ['training:own-results:read'],
  );
  assert.deepEqual(
    Reflect.getMetadata(PERMISSIONS_KEY, TrainingAdminResultsController),
    ['training:results:read'],
  );
});

test('employee detail exposes a breakdown only when it reconciles with final score', async () => {
  for (const scenario of [
    {
      name: 'not required',
      reviewStatus: TrainingReviewStatus.NOT_REQUIRED,
      finalScore: 90,
      serverScore: 90,
      expectedStatus: 'AVAILABLE',
      expectedBreakdown: true,
    },
    {
      name: 'approved unchanged',
      reviewStatus: TrainingReviewStatus.APPROVED,
      finalScore: 90,
      serverScore: 90,
      expectedStatus: 'AVAILABLE',
      expectedBreakdown: true,
    },
    {
      name: 'overridden',
      reviewStatus: TrainingReviewStatus.OVERRIDDEN,
      finalScore: 70,
      serverScore: 90,
      expectedStatus: 'MANUALLY_ADJUSTED_BREAKDOWN_UNAVAILABLE',
      expectedBreakdown: false,
    },
    {
      name: 'approved with factual penalty',
      reviewStatus: TrainingReviewStatus.APPROVED,
      finalScore: 70,
      serverScore: 90,
      expectedStatus: 'MANUALLY_ADJUSTED_BREAKDOWN_UNAVAILABLE',
      expectedBreakdown: false,
    },
    {
      name: 'pending review',
      reviewStatus: TrainingReviewStatus.PENDING,
      finalScore: 90,
      serverScore: 90,
      status: TrainingAttemptStatus.REQUIRES_REVIEW,
      passStatus: TrainingPassStatus.PENDING,
      expectedStatus: 'PENDING_REVIEW',
      expectedBreakdown: false,
    },
  ]) {
    const attempt = employeeAttemptFixture(scenario);
    let findFirstCall = 0;
    const service = new TrainingResultsService({
      trainingAttempt: {
        async findFirst() {
          findFirstCall += 1;
          return findFirstCall === 1
            ? attempt
            : { finalScore: attempt.finalScore };
        },
        async count() {
          return 1;
        },
      },
    });

    const response = await service.getEmployeeAttempt(
      'employee-1',
      `attempt-${scenario.name}`,
    );
    assert.equal(
      response.attempt.breakdownStatus,
      scenario.expectedStatus,
      scenario.name,
    );
    assert.equal(
      response.attempt.breakdown !== null,
      scenario.expectedBreakdown,
      scenario.name,
    );
    if (scenario.expectedBreakdown) {
      assert.equal(response.attempt.breakdown[0].score, '90');
      assert.equal(
        response.attempt.breakdown[0].components[0].awardedPoints,
        '90',
      );
    }
    const serialized = JSON.stringify(response);
    for (const forbidden of [
      'serverScore',
      'aiScore',
      'adminScore',
      'summary',
      'combinedTranscript',
      'audioUrl',
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  }
});

function employeeAttemptFixture({
  reviewStatus,
  finalScore,
  serverScore,
  status = TrainingAttemptStatus.COMPLETED,
  passStatus = TrainingPassStatus.PASSED,
}) {
  const now = new Date('2026-07-28T10:00:00.000Z');
  return {
    id: 'attempt-employee',
    attemptNumber: 1,
    status,
    isConsumed: true,
    startedAt: now,
    expiresAt: new Date(now.getTime() + 300_000),
    completedAt: now,
    totalDurationSeconds: 120,
    finalScore: new Prisma.Decimal(finalScore),
    serverScore: new Prisma.Decimal(serverScore),
    passStatus,
    reviewStatus,
    project: {
      id: 'project-1',
      title: 'Проект',
      slug: 'project',
      activeVersion: { attemptLimit: 3 },
    },
    projectVersion: { attemptLimit: 3 },
    attemptQuestions: [
      {
        id: 'attempt-question-1',
        sequence: 1,
        status: TrainingAttemptQuestionStatus.SCORED,
        responseTimeSeconds: 100,
        answerDurationSeconds: 90,
        question: {
          type: TrainingQuestionType.MAIN,
          text: 'Вопрос',
        },
        answer: {
          activeEvaluation: {
            serverScore: new Prisma.Decimal(90),
            scoreComponents: [
              {
                componentKey: 'criterion:facts',
                title: 'Факты',
                awardedPoints: new Prisma.Decimal(90),
                maxPoints: new Prisma.Decimal(100),
              },
            ],
          },
        },
      },
    ],
  };
}
