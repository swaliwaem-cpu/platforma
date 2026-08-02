require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const { BadRequestException } = require('@nestjs/common');
const { TrainingQuestionType } = require('@prisma/client');

const {
  calculateTrainingObjectiveMetrics,
  normalizeTrainingEvidence,
  scoreTrainingEvaluation,
  validateTrainingStructuredEvaluation,
} = require('../dist/training/training-evaluator.js');
const {
  parseTrainingProjectSnapshot,
} = require('../dist/training/training-snapshot.js');
const {
  parseUpdateTrainingProjectDraftInput,
} = require('../dist/training/training.validation.js');

const factId = '11111111-1111-4111-8111-111111111111';
const secondFactId = '22222222-2222-4222-8222-222222222222';
const criterionId = '33333333-3333-4333-8333-333333333333';
const secondCriterionId = '44444444-4444-4444-8444-444444444444';

test('Stage 3 draft validates fact aliases and duplicate criterion codes', () => {
  const draft = makeDraft();
  assert.equal(parseUpdateTrainingProjectDraftInput(draft).facts.length, 11);
  assert.throws(
    () => parseUpdateTrainingProjectDraftInput({
      ...draft,
      facts: draft.facts.map((fact, index) => index === 0
        ? { ...fact, aliases: ['ЖК', 'жк'] }
        : fact),
    }),
    BadRequestException,
  );
  assert.throws(
    () => parseUpdateTrainingProjectDraftInput({
      ...draft,
      facts: draft.facts.map((fact, index) => index === 0
        ? { ...fact, aliases: ['полный эталонный ответ из девяти отдельных слов подряд сейчас'] }
        : fact),
    }),
    BadRequestException,
  );
  assert.throws(
    () => parseUpdateTrainingProjectDraftInput({
      ...draft,
      criteria: [...draft.criteria, { ...draft.criteria[0], id: null, position: 2 }],
    }),
    BadRequestException,
  );
});

test('snapshot schema v2 freezes facts and exact 55/15 criteria while v1 remains readable', () => {
  const snapshot = makeSnapshot();
  const parsed = parseTrainingProjectSnapshot(snapshot);

  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.questions[0].facts[0].statement, 'В проекте 120 квартир.');
  assert.equal(parsed.criteria.main.reduce((sum, item) => sum + item.maxPoints, 0), 55);
  assert.equal(parsed.criteria.followUp.reduce((sum, item) => sum + item.maxPoints, 0), 15);
  assert.equal(parseTrainingProjectSnapshot({
    schemaVersion: 1,
    projectTitle: snapshot.projectTitle,
    settings: snapshot.settings,
    questions: snapshot.questions.map(({ facts: _facts, ...question }) => question),
  }).schemaVersion, 1);
  assert.throws(() => parseTrainingProjectSnapshot({
    ...snapshot,
    criteria: { ...snapshot.criteria, main: [{ ...snapshot.criteria.main[0], maxPoints: 54 }] },
  }));
});

test('strict evaluation rejects unknown/duplicate IDs and mismatched evidence', () => {
  const input = makeEvaluationInput();
  const valid = makeEvaluation();

  assert.doesNotThrow(() => validateTrainingStructuredEvaluation(valid, input));
  assert.throws(() => validateTrainingStructuredEvaluation({
    ...valid,
    fact_assessments: valid.fact_assessments.map((item, index) => index === 0
      ? { ...item, fact_id: '99999999-9999-4999-8999-999999999999' }
      : item),
  }, input), /FACT_IDS_MISMATCH/);
  assert.throws(() => validateTrainingStructuredEvaluation({
    ...valid,
    fact_assessments: [valid.fact_assessments[0], valid.fact_assessments[0]],
  }, input), /FACT_IDS_MISMATCH/);
  assert.throws(() => validateTrainingStructuredEvaluation({
    ...valid,
    criterion_assessments: valid.criterion_assessments.map((item, index) => index === 0
      ? { ...item, evidence: 'нет в транскрипте' }
      : item),
  }, input), /EVIDENCE_NOT_IN_TRANSCRIPT/);
});

test('evidence normalization is exact and deterministic', () => {
  assert.equal(normalizeTrainingEvidence('  ЖК\u00a0«Север»\nготов  '), 'ЖК «Север» готов');
  assert.throws(() => validateTrainingStructuredEvaluation({
    ...makeEvaluation(),
    fact_assessments: makeEvaluation().fact_assessments.map((item, index) => index === 0
      ? { ...item, evidence: 'жк север' }
      : item),
  }, makeEvaluationInput()), /EVIDENCE_NOT_IN_TRANSCRIPT/);
});

test('backend scoring applies one distinct minus five penalty, clamps and sends unsupported to review', () => {
  const input = makeEvaluationInput();
  const evaluation = validateTrainingStructuredEvaluation(makeEvaluation(), input);
  const scored = scoreTrainingEvaluation(evaluation, input);

  assert.equal(scored.safeBreakdown.criteriaPoints, 55);
  assert.equal(scored.safeBreakdown.incorrectFactCount, 1);
  assert.equal(scored.safeBreakdown.penaltyPoints, 5);
  assert.equal(scored.score, 50);
  assert.equal(scored.requiresReview, false);

  const withUnsupported = validateTrainingStructuredEvaluation({
    ...makeEvaluation(),
    unsupported_claims: [{ claim: 'Есть бассейн', evidence: 'Есть бассейн' }],
    requires_review: false,
  }, input);
  assert.equal(scoreTrainingEvaluation(withUnsupported, input).requiresReview, true);
  assert.throws(() => validateTrainingStructuredEvaluation({
    ...makeEvaluation(),
    unsupported_claims: [{ claim: '120 квартир', evidence: '120 квартир' }],
  }, input), /UNSUPPORTED_CLAIM_IS_APPROVED/);
});

test('objective speech metrics use only documented deterministic measurements', () => {
  assert.deepEqual(calculateTrainingObjectiveMetrics({
    transcript: 'Ну, в общем дом готов, как бы полностью.',
    audioDurationSeconds: 30,
    segmentCount: 2,
  }), {
    audioDurationSeconds: 30,
    segmentCount: 2,
    wordCount: 8,
    wordsPerMinute: 16,
    fillerWordsCount: 3,
    fillerWordsFound: ['ну', 'как бы', 'в общем'],
  });
});

function makeDraft() {
  return {
    title: 'Stage 3',
    description: null,
    realEstateObjectId: null,
    sortOrder: 0,
    attemptLimit: 3,
    timeLimitMinutes: 7,
    passScore: 75,
    allowRetakeAfterPass: false,
    mainQuestion: 'Главный вопрос',
    followUpQuestions: Array.from({ length: 10 }, (_, index) => `Вопрос ${index + 1}`),
    facts: Array.from({ length: 11 }, (_, index) => ({
      id: null,
      questionType: index === 0 ? 'MAIN' : 'FOLLOW_UP',
      questionPosition: index === 0 ? 1 : index,
      statement: `Факт ${index + 1}`,
      aliases: [`Термин ${index + 1}`],
      isRequired: true,
      position: 1,
    })),
    criteria: [
      { id: null, questionType: 'MAIN', code: 'main', title: 'Main', guidance: '', maxPoints: 55, position: 1 },
      { id: null, questionType: 'FOLLOW_UP', code: 'follow_up', title: 'Follow-up', guidance: '', maxPoints: 15, position: 1 },
    ],
  };
}

function makeSnapshot() {
  return {
    schemaVersion: 2,
    projectTitle: 'Stage 3',
    relatedObjectTitle: 'ЖК Север',
    settings: { attemptLimit: 3, timeLimitSeconds: 420, passScore: 75, allowRetakeAfterPass: false },
    scoringVersion: 'training-v2-scoring-v1',
    evaluationSchemaVersion: 'training-v2-evaluation-v1',
    criteria: {
      main: [{ id: criterionId, code: 'main', title: 'Main', guidance: '', maxPoints: 55, position: 1 }],
      followUp: [{ id: secondCriterionId, code: 'follow_up', title: 'Follow', guidance: '', maxPoints: 15, position: 1 }],
    },
    questions: Array.from({ length: 11 }, (_, index) => ({
      sourceQuestionId: `question-${index}`,
      type: index === 0 ? TrainingQuestionType.MAIN : TrainingQuestionType.FOLLOW_UP,
      text: `Вопрос ${index}`,
      position: index === 0 ? 1 : index,
      facts: [{
        id: index === 0 ? factId : `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        statement: index === 0 ? 'В проекте 120 квартир.' : `Факт ${index}`,
        aliases: index === 0 ? ['120 квартир'] : [`Термин ${index}`],
        required: true,
        position: 1,
      }],
    })),
  };
}

function makeEvaluationInput() {
  return {
    questionText: 'Расскажите о проекте',
    questionType: 'MAIN',
    transcript: 'В проекте 120 квартир. Срок сдачи перенесён. Есть бассейн.',
    facts: [
      { id: factId, statement: 'В проекте 120 квартир.', aliases: ['120 квартир'], required: true, position: 1 },
      { id: secondFactId, statement: 'Срок сдачи не переносился.', aliases: ['срок без переноса'], required: true, position: 2 },
    ],
    criteria: [{ id: criterionId, code: 'main', title: 'Main', guidance: '', maxPoints: 55, position: 1 }],
    objectiveMetrics: { audioDurationSeconds: 30, segmentCount: 1, wordCount: 9, wordsPerMinute: 18, fillerWordsCount: 0, fillerWordsFound: [] },
    maxScore: 55,
  };
}

function makeEvaluation() {
  return {
    schema_version: 'training-v2-evaluation-v1',
    fact_assessments: [
      { fact_id: factId, verdict: 'CORRECT', evidence: 'В проекте 120 квартир.', explanation: 'Совпадает.' },
      { fact_id: secondFactId, verdict: 'INCORRECT', evidence: 'Срок сдачи перенесён.', explanation: 'Противоречит факту.' },
    ],
    criterion_assessments: [{ criterion_id: criterionId, awarded_points: 55, evidence: 'В проекте 120 квартир.', explanation: 'Полный ответ.' }],
    unsupported_claims: [],
    summary: 'Ответ оценён.',
    requires_review: false,
  };
}
