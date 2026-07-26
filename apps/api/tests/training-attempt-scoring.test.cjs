const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  CryptoTrainingQuestionSelector,
  DeterministicFakeTrainingEvaluationProvider,
  DeterministicFakeTrainingTranscriptionProvider,
} = require('../dist/training/training-attempt.providers.js');
const {
  TRAINING_INCORRECT_FACT_PENALTY,
  scoreTrainingEvaluation,
} = require('../dist/training/training-attempt.scoring.js');
const {
  TRAINING_ATTEMPT_SCORE_MAXIMUM,
} = require('../dist/training/training-attempt-engine.service.js');

const mainCriterion = {
  id: 'criterion-main',
  code: 'main-total',
  title: 'Главный ответ',
  maxPoints: 55,
};
const approvedFact = {
  id: 'fact-main',
  code: 'main.fact',
  statement: 'Утверждённый факт',
};
const rootDir = path.resolve(__dirname, '../../..');
const engineSource = readFileSync(
  path.join(
    rootDir,
    'apps/api/src/training/training-attempt-engine.service.ts',
  ),
  'utf8',
);
const providerSource = readFileSync(
  path.join(rootDir, 'apps/api/src/training/training-attempt.providers.ts'),
  'utf8',
);
const moduleSource = readFileSync(
  path.join(rootDir, 'apps/api/src/training/training.module.ts'),
  'utf8',
);
const contentServiceSource = readFileSync(
  path.join(rootDir, 'apps/api/src/training/training-content.service.ts'),
  'utf8',
);

test('stage 5 wiring uses short serializable PostgreSQL locks and fake-only providers', () => {
  assert.match(engineSource, /pg_advisory_xact_lock/u);
  assert.match(
    engineSource,
    /Prisma\.TransactionIsolationLevel\.Serializable/u,
  );
  assert.match(engineSource, /crypto-random-without-replacement/u);
  assert.match(engineSource, /TrainingProjectStatus\.OPEN/u);
  assert.match(engineSource, /assertProjectAvailable/u);
  assert.match(
    contentServiceSource,
    /orderBy:\s*\[\{ sortOrder: 'asc' \}, \{ title: 'asc' \}\]/u,
  );
  assert.doesNotMatch(engineSource, /gapScore|weakness|adaptive/iu);
  assert.doesNotMatch(providerSource, /\bfetch\s*\(|https?:\/\//u);
  assert.match(
    moduleSource,
    /useClass:\s*DeterministicFakeTrainingTranscriptionProvider/u,
  );
  assert.match(
    moduleSource,
    /useClass:\s*DeterministicFakeTrainingEvaluationProvider/u,
  );
});

test('secure question selector returns three different items without mutating the 10-item pool', () => {
  const selector = new CryptoTrainingQuestionSelector();
  const candidates = Array.from({ length: 10 }, (_, index) => ({
    id: `question-${index + 1}`,
  }));
  const originalOrder = candidates.map((item) => item.id);

  for (let iteration = 0; iteration < 100; iteration += 1) {
    const selection = selector.select(candidates, 3);
    assert.equal(selection.length, 3);
    assert.equal(
      new Set(selection.map((item) => item.candidate.id)).size,
      3,
    );
    assert.equal(
      selection.every(
        (item) => candidates[item.randomIndex].id === item.candidate.id,
      ),
      true,
    );
  }

  assert.deepEqual(
    candidates.map((item) => item.id),
    originalOrder,
  );
});

test('fake transcription combines multiple voice segments in their domain order', async () => {
  const provider = new DeterministicFakeTrainingTranscriptionProvider();
  const result = await provider.transcribe({
    answerId: 'answer-1',
    segments: [
      { id: 'segment-2', segmentIndex: 2, fakeTranscript: 'вторая часть' },
      { id: 'segment-1', segmentIndex: 1, fakeTranscript: 'первая часть' },
    ],
  });

  assert.equal(result.transcript, 'первая часть\nвторая часть');
  assert.equal(result.provider, 'fake');
  assert.equal(result.model, 'fake-transcription-v1');
});

test('fake evaluation is deterministic and supports criterion, incorrect and unsupported markers', async () => {
  const provider = new DeterministicFakeTrainingEvaluationProvider();
  const result = await provider.evaluate({
    answerId: 'answer-1',
    questionId: 'question-1',
    questionText: 'Вопрос',
    questionMaxScore: 55,
    transcript:
      '[[criterion:main-total=41]] [[incorrect:main.fact]] [[unsupported:новый факт]]',
    criteria: [mainCriterion],
    facts: [approvedFact],
  });

  assert.equal(result.aiSuggestedScore, 41);
  assert.deepEqual(result.criterionScores[0], {
    criterionId: mainCriterion.id,
    awardedPoints: 41,
    evidence: 'fake:main-total',
  });
  assert.equal(
    result.factFindings.some((finding) => finding.verdict === 'INCORRECT'),
    true,
  );
  assert.equal(
    result.factFindings.some((finding) => finding.verdict === 'UNSUPPORTED'),
    true,
  );
});

test('backend scoring applies one minus-five penalty per distinct incorrect fact', () => {
  const score = scoreTrainingEvaluation({
    questionMaxScore: 55,
    criteria: [mainCriterion],
    facts: [approvedFact],
    evaluation: {
      actualModelId: 'fake',
      reasoningEffort: null,
      aiSuggestedScore: 55,
      criterionScores: [
        {
          criterionId: mainCriterion.id,
          awardedPoints: 55,
        },
      ],
      factFindings: [
        {
          factId: approvedFact.id,
          verdict: 'INCORRECT',
          evidence: 'первое упоминание',
        },
        {
          factId: approvedFact.id,
          verdict: 'INCORRECT',
          evidence: 'повтор той же ошибки',
        },
      ],
      summary: 'fake',
      requestId: 'request-1',
      latencyMs: 0,
    },
  });

  assert.equal(TRAINING_INCORRECT_FACT_PENALTY, 5);
  assert.equal(score.aiSuggestedScore, 55);
  assert.equal(score.serverScore, 50);
  assert.equal(
    score.components.filter((component) => component.factVerdict === 'INCORRECT')
      .length,
    1,
  );
});

test('unsupported claim has no automatic penalty but requires review', () => {
  const score = scoreTrainingEvaluation({
    questionMaxScore: 55,
    criteria: [mainCriterion],
    facts: [approvedFact],
    evaluation: {
      actualModelId: 'fake',
      reasoningEffort: null,
      aiSuggestedScore: 55,
      criterionScores: [
        {
          criterionId: mainCriterion.id,
          awardedPoints: 55,
        },
      ],
      factFindings: [
        {
          verdict: 'UNSUPPORTED',
          claim: 'Факт сверх материала',
        },
      ],
      summary: 'fake',
      requestId: 'request-2',
      latencyMs: 0,
    },
  });

  assert.equal(score.serverScore, 55);
  assert.equal(score.requiresReview, true);
  assert.equal(
    score.components.find((component) => component.factVerdict === 'UNSUPPORTED')
      .penaltyPoints,
    0,
  );
});

test('backend clamps answer points and fixes the attempt maximum at 55 + 15 + 15 + 15', () => {
  const score = scoreTrainingEvaluation({
    questionMaxScore: 15,
    criteria: [
      {
        id: 'criterion-follow',
        code: 'follow-total',
        title: 'Дополнительный ответ',
        maxPoints: 15,
      },
    ],
    facts: [],
    evaluation: {
      actualModelId: 'fake',
      reasoningEffort: null,
      aiSuggestedScore: 1_000,
      criterionScores: [
        {
          criterionId: 'criterion-follow',
          awardedPoints: 1_000,
        },
      ],
      factFindings: [],
      summary: 'fake',
      requestId: 'request-3',
      latencyMs: 0,
    },
  });

  assert.equal(score.aiSuggestedScore, 15);
  assert.equal(score.serverScore, 15);
  assert.equal(TRAINING_ATTEMPT_SCORE_MAXIMUM, 100);
  assert.equal(55 + 15 + 15 + 15, TRAINING_ATTEMPT_SCORE_MAXIMUM);
});

test('backend rejects unknown criterion and fact identifiers from a provider', () => {
  assert.throws(
    () =>
      scoreTrainingEvaluation({
        questionMaxScore: 55,
        criteria: [mainCriterion],
        facts: [approvedFact],
        evaluation: {
          actualModelId: 'fake',
          reasoningEffort: null,
          aiSuggestedScore: 0,
          criterionScores: [
            {
              criterionId: 'unknown',
              awardedPoints: 1,
            },
          ],
          factFindings: [],
          summary: 'fake',
          requestId: 'request-4',
          latencyMs: 0,
        },
      }),
    /unknown criterion/u,
  );

  assert.throws(
    () =>
      scoreTrainingEvaluation({
        questionMaxScore: 55,
        criteria: [mainCriterion],
        facts: [approvedFact],
        evaluation: {
          actualModelId: 'fake',
          reasoningEffort: null,
          aiSuggestedScore: 55,
          criterionScores: [
            {
              criterionId: mainCriterion.id,
              awardedPoints: 55,
            },
          ],
          factFindings: [
            {
              factId: 'unknown',
              verdict: 'INCORRECT',
            },
          ],
          summary: 'fake',
          requestId: 'request-5',
          latencyMs: 0,
        },
      }),
    /unknown fact/u,
  );
});
