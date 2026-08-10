require('reflect-metadata');

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  TrainingAttemptQuestionStatus,
  TrainingAttemptStatus,
  TrainingProjectStatus,
  TrainingQuestionType,
} = require('@prisma/client');
const { BadRequestException } = require('@nestjs/common');

const {
  clampTrainingTotalScore,
  evaluateLegacyTrainingText,
} = require('../dist/training/training-evaluator.js');
const {
  TrainingFollowUpSelector,
} = require('../dist/training/training-follow-up-selector.js');
const { TrainingAttemptService } = require('../dist/training/training-attempt.service.js');
const { TrainingProjectService } = require('../dist/training/training-project.service.js');
const {
  parseTrainingProjectSnapshot,
} = require('../dist/training/training-snapshot.js');
const {
  parseTrainingTimeLimitMinutes,
} = require('../dist/training/training.validation.js');

test('publication validation requires exactly one main and ten follow-ups', () => {
  const service = new TrainingProjectService({});
  const validProject = {
    title: 'Продажи ЖК',
    attemptLimit: 3,
    timeLimitSeconds: 420,
    passScore: 75,
    questions: [
      { type: TrainingQuestionType.MAIN, isActive: true, text: 'Главный вопрос', facts: [{ isActive: true }] },
      ...Array.from({ length: 10 }, (_, index) => ({
        type: TrainingQuestionType.FOLLOW_UP,
        isActive: true,
        text: `Дополнительный вопрос ${index + 1}`,
        facts: [{ isActive: true }],
      })),
    ],
    criteria: [
      { questionType: TrainingQuestionType.MAIN, maxPoints: 55, isActive: true },
      { questionType: TrainingQuestionType.FOLLOW_UP, maxPoints: 15, isActive: true },
    ],
  };

  assert.doesNotThrow(() => service.validatePublication(validProject));
  assert.throws(
    () => service.validatePublication({ ...validProject, questions: validProject.questions.slice(0, 10) }),
    BadRequestException,
  );
});

test('timer parsing stores positive whole UI minutes as seconds with 420 default', () => {
  assert.equal(parseTrainingTimeLimitMinutes(undefined), 420);
  assert.equal(parseTrainingTimeLimitMinutes(12), 720);
  assert.throws(() => parseTrainingTimeLimitMinutes(0), BadRequestException);
  assert.throws(() => parseTrainingTimeLimitMinutes(1.5), BadRequestException);
});

test('deterministic fake evaluator supports pass, fail, review and length contracts', () => {
  assert.deepEqual(evaluateLegacyTrainingText('[fake:pass]', 15), {
    score: 15,
    outcome: 'SCORED',
    safeBreakdown: {
      version: 'stage1-length-v1',
      basis: 'FAKE_PASS',
      awardedScore: 15,
      maxScore: 15,
    },
  });
  assert.equal(evaluateLegacyTrainingText('[fake:fail]', 55).score, 0);
  assert.equal(evaluateLegacyTrainingText('[fake:review]', 55).outcome, 'REQUIRES_REVIEW');
  assert.equal(evaluateLegacyTrainingText('1234567890', 15).score, 10);
  assert.equal(evaluateLegacyTrainingText('x'.repeat(100), 15).score, 15);
});

test('follow-up selector returns three unique candidates with injected randomness', () => {
  const selector = new TrainingFollowUpSelector();
  const candidates = Array.from({ length: 10 }, (_, index) => ({ id: index + 1 }));
  const selected = selector.select(candidates, () => 0);

  assert.equal(selected.length, 3);
  assert.equal(new Set(selected.map((item) => item.id)).size, 3);
  assert.equal(candidates.length, 10);
  assert.throws(() => selector.select(candidates, () => 1));
});

test('total score clamps to the 0..100 range', () => {
  assert.equal(clampTrainingTotalScore(-5), 0);
  assert.equal(clampTrainingTotalScore(82.9), 82);
  assert.equal(clampTrainingTotalScore(140), 100);
});

test('snapshot parser enforces one main and ten distinct follow-up questions', () => {
  const snapshot = {
    schemaVersion: 1,
    projectTitle: 'Тестовый проект',
    settings: {
      attemptLimit: 3,
      timeLimitSeconds: 420,
      passScore: 75,
      allowRetakeAfterPass: false,
    },
    questions: Array.from({ length: 11 }, (_, index) => ({
      sourceQuestionId: `question-${index}`,
      type: index === 0 ? TrainingQuestionType.MAIN : TrainingQuestionType.FOLLOW_UP,
      text: `Вопрос ${index}`,
      position: index === 0 ? 1 : index,
    })),
  };

  assert.equal(parseTrainingProjectSnapshot(snapshot).questions.length, 11);
  assert.throws(
    () => parseTrainingProjectSnapshot({ ...snapshot, questions: snapshot.questions.slice(0, 10) }),
    /Invalid training snapshot question structure/,
  );
  assert.throws(
    () => parseTrainingProjectSnapshot({
      ...snapshot,
      questions: snapshot.questions.map((question, index) =>
        index === 10 ? { ...question, sourceQuestionId: 'question-9' } : question,
      ),
    }),
    /Invalid training snapshot question structure/,
  );
});

test('employee attempt service exposes only the current question and safe result fields', async () => {
  const now = new Date('2026-08-01T12:00:00.000Z');
  const attempt = {
    id: 'attempt-id',
    userId: 'user-id',
    projectId: 'project-id',
    attemptNumber: 1,
    status: TrainingAttemptStatus.IN_PROGRESS,
    completionReason: null,
    startedAt: now,
    expiresAt: new Date('2026-08-01T12:07:00.000Z'),
    completedAt: null,
    finalScore: null,
    isPassed: null,
    projectSnapshotJson: {
      schemaVersion: 1,
      projectTitle: 'Тестовый проект',
      settings: {
        attemptLimit: 3,
        timeLimitSeconds: 420,
        passScore: 75,
        allowRetakeAfterPass: false,
      },
      questions: Array.from({ length: 11 }, (_, index) => ({
        sourceQuestionId: `question-${index}`,
        type: index === 0 ? TrainingQuestionType.MAIN : TrainingQuestionType.FOLLOW_UP,
        text: `Скрытый вопрос ${index}`,
        position: index === 0 ? 1 : index,
      })),
    },
    fakeEvaluationVersion: 'stage1-length-v1',
    createdAt: now,
    updatedAt: now,
    project: { id: 'project-id', title: 'Живое изменённое название' },
    user: { id: 'user-id', email: 'user@example.test', name: 'User' },
    questions: [
      {
        id: 'presented-question',
        attemptId: 'attempt-id',
        sourceQuestionId: 'question-0',
        sequence: 1,
        type: TrainingQuestionType.MAIN,
        questionTextSnapshot: 'Текущий вопрос',
        maxScore: 55,
        status: TrainingAttemptQuestionStatus.PRESENTED,
        presentedAt: now,
        answeredAt: null,
        createdAt: now,
        updatedAt: now,
        answer: null,
      },
    ],
  };
  const service = new TrainingAttemptService(
    { trainingAttempt: { findFirst: async () => attempt } },
    { finalizeAttemptIfExpired: async () => false },
    { assertParticipant: async () => undefined },
  );
  const serialized = await service.getEmployeeAttempt(attempt.id, attempt.userId);
  const json = JSON.stringify(serialized);

  assert.equal(serialized.project.title, 'Тестовый проект');
  assert.equal(serialized.currentQuestion.text, 'Текущий вопрос');
  assert.doesNotMatch(json, /Скрытый вопрос/);
  assert.doesNotMatch(json, /projectSnapshotJson|startIdempotencyKey|email/);
});
