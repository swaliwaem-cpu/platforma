const assert = require('node:assert/strict');
const test = require('node:test');
const { Prisma } = require('@prisma/client');

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
  canonicalTrainingScore,
  clampTrainingScore,
  trainingScoreMeetsThreshold,
} = require('../dist/training/training-score-decimal.js');
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
  acceptedAliases: [],
};
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
    transcript: 'Менеджер сказал: Факт сверх материала.',
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

  assert.equal(TRAINING_INCORRECT_FACT_PENALTY.toFixed(2), '5.00');
  assert.equal(score.aiSuggestedScore.toFixed(2), '55.00');
  assert.equal(score.serverScore.toFixed(2), '50.00');
  assert.equal(
    score.components.filter((component) => component.factVerdict === 'INCORRECT')
      .length,
    1,
  );
});

test('unsupported claim has no automatic penalty but requires review', () => {
  const score = scoreTrainingEvaluation({
    questionMaxScore: 55,
    transcript: 'Менеджер сказал: Факт сверх материала.',
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
          evidenceSource: 'TRANSCRIPT',
          evidence: 'Факт сверх материала',
        },
      ],
      summary: 'fake',
      requestId: 'request-2',
      latencyMs: 0,
    },
  });

  assert.equal(score.serverScore.toFixed(2), '55.00');
  assert.equal(score.requiresReview, true);
  assert.equal(
    score.components.find((component) => component.factVerdict === 'UNSUPPORTED')
      .penaltyPoints.toFixed(2),
    '0.00',
  );
});

test('irrelevant answer is fail-closed to zero points and mandatory review', () => {
  const score = scoreTrainingEvaluation({
    questionMaxScore: 55,
    criteria: [mainCriterion],
    facts: [],
    evaluation: {
      actualModelId: 'fixture',
      reasoningEffort: null,
      answerRelevance: 'IRRELEVANT',
      requiresManualReview: false,
      reviewReasons: [],
      criterionScores: [
        {
          criterionId: mainCriterion.id,
          awardedPoints: 55,
        },
      ],
      factFindings: [],
      summary: 'Ответ нерелевантен.',
      requestId: 'request-irrelevant',
      latencyMs: 0,
    },
  });

  assert.equal(score.aiSuggestedScore.toFixed(2), '0.00');
  assert.equal(score.serverScore.toFixed(2), '0.00');
  assert.equal(score.components[0].awardedPoints.toFixed(2), '0.00');
  assert.equal(score.requiresReview, true);
  assert.deepEqual(score.reviewReasons, ['ANSWER_IRRELEVANT']);
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

  assert.equal(score.aiSuggestedScore.toFixed(2), '15.00');
  assert.equal(score.serverScore.toFixed(2), '15.00');
  assert.equal(TRAINING_ATTEMPT_SCORE_MAXIMUM, 100);
  assert.equal(55 + 15 + 15 + 15, TRAINING_ATTEMPT_SCORE_MAXIMUM);
});

test('canonical score policy is two decimals with ROUND_HALF_UP', () => {
  assert.equal(canonicalTrainingScore('10.004').toFixed(2), '10.00');
  assert.equal(canonicalTrainingScore('10.005').toFixed(2), '10.01');
  assert.equal(
    Prisma.Decimal.ROUND_HALF_UP,
    canonicalTrainingScore('1.005').constructor.ROUND_HALF_UP,
  );
});

test('pass threshold compares canonical decimals instead of binary floats', () => {
  assert.equal(trainingScoreMeetsThreshold('74.994', 75), false);
  assert.equal(trainingScoreMeetsThreshold('74.995', 75), true);
});

test('minus five penalty is applied after component normalization', () => {
  const score = scoreTrainingEvaluation({
    questionMaxScore: 55,
    criteria: [mainCriterion],
    facts: [approvedFact],
    evaluation: {
      actualModelId: 'fake',
      reasoningEffort: null,
      aiSuggestedScore: 10.005,
      criterionScores: [
        {
          criterionId: mainCriterion.id,
          awardedPoints: 10.005,
        },
      ],
      factFindings: [
        {
          factId: approvedFact.id,
          verdict: 'INCORRECT',
        },
      ],
      summary: 'fake',
      requestId: 'request-rounding-penalty',
      latencyMs: 0,
    },
  });

  assert.equal(score.components[0].awardedPoints.toFixed(2), '10.01');
  assert.equal(score.serverScore.toFixed(2), '5.01');
});

test('final score clamp stays within canonical zero and one hundred', () => {
  assert.equal(clampTrainingScore('100.009', 0, 100).toFixed(2), '100.00');
  assert.equal(clampTrainingScore('-0.009', 0, 100).toFixed(2), '0.00');
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
