import assert from 'node:assert/strict';

import { chromium } from '@playwright/test';

const baseUrl = process.env.TRAINING_WEB_TEST_URL;

if (!baseUrl) throw new Error('TRAINING_WEB_TEST_URL is required');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const projectId = '31111111-1111-4111-8111-111111111111';
const approveAttemptId = '32222222-2222-4222-8222-222222222222';
const overrideAttemptId = '33333333-3333-4333-8333-333333333333';
const pendingEmployeeAttemptId = '34444444-4444-4444-8444-444444444444';
const overriddenEmployeeAttemptId = '35555555-5555-4555-8555-555555555555';
const technicalEmployeeAttemptId = '36666666-6666-4666-8666-666666666666';
const resolvedReviews = new Map();
const reviewRequests = [];

try {
  await page.route('http://localhost:3000/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === '/auth/refresh') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          accessToken: 'stage3-browser-access-token',
          user: {
            id: '37777777-7777-4777-8777-777777777777',
            email: 'stage3-admin@training.test',
            name: 'Stage 3 Admin',
            brokerPhone: null,
            brokerEmail: null,
            status: 'ACTIVE',
            role: { id: '38888888-8888-4888-8888-888888888888', name: 'admin' },
            profilePhotoFile: null,
            permissions: [
              'admin:access',
              'training:participate',
              'training:projects:manage',
              'training:results:read',
              'training:results:review',
            ],
          },
        }),
      });
      return;
    }

    if (path === `/training/admin/projects/${projectId}`) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(adminProject()),
      });
      return;
    }

    const adminAttemptMatch = path.match(/^\/training\/admin\/attempts\/([^/]+)$/u);
    if (adminAttemptMatch) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(adminAttempt(
          adminAttemptMatch[1],
          resolvedReviews.get(adminAttemptMatch[1]) ?? null,
        )),
      });
      return;
    }

    const reviewMatch = path.match(/^\/training\/admin\/attempts\/([^/]+)\/review$/u);
    if (reviewMatch && request.method() === 'POST') {
      const payload = request.postDataJSON();
      reviewRequests.push({ attemptId: reviewMatch[1], payload });
      resolvedReviews.set(reviewMatch[1], payload);
      await new Promise((resolve) => setTimeout(resolve, 250));
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          attemptId: reviewMatch[1],
          status: 'COMPLETED',
          calculatedScore: 67,
          finalScore: payload.decision === 'OVERRIDE' ? payload.finalScore : 67,
          isPassed: false,
          reviewStatus: 'RESOLVED',
          reviewDecision: payload.decision === 'OVERRIDE' ? 'OVERRIDDEN' : 'APPROVED',
          reviewedAt: '2026-08-02T10:00:00.000Z',
        }),
      });
      return;
    }

    const employeeAttemptMatch = path.match(/^\/training\/attempts\/([^/]+)$/u);
    if (employeeAttemptMatch) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(employeeAttempt(employeeAttemptMatch[1])),
      });
      return;
    }

    await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });

  await page.goto(`${baseUrl}/admin/training/projects/${projectId}`);
  await page.getByRole('heading', { name: 'Stage 3 browser project' }).waitFor();
  await page.getByText('55 / 55', { exact: true }).waitFor();
  await page.getByText('15 / 15', { exact: true }).waitFor();
  await page.getByText('Проверьте краткость aliases перед публикацией.').waitFor();
  assert.equal(await page.getByText(/Утверждённый факт 1/u).count(), 11);
  await page.getByRole('button', { name: 'Добавить факт' }).first().click();
  await page.getByText('Утверждённый факт 2', { exact: true }).waitFor();

  await page.goto(`${baseUrl}/admin/training/attempts/${approveAttemptId}`);
  await page.getByRole('heading', { name: 'Подтвердить или скорректировать итог' }).waitFor();
  await page.getByText('Утверждённые факты').waitFor();
  await page.getByText('Unsupported claims').waitFor();
  await page.getByText('gpt-4o-mini-transcribe-2025-12-15').waitFor();
  await page.getByText('gpt-5.6-terra').waitFor();
  const approveButton = page.getByRole('button', { name: 'Подтвердить расчёт' });
  await approveButton.click();
  assert.equal(await approveButton.isDisabled(), true);
  await page.getByText('Расчётный результат подтверждён.').waitFor();
  assert.equal(reviewRequests.filter((item) => item.attemptId === approveAttemptId).length, 1);

  await page.goto(`${baseUrl}/admin/training/attempts/${overrideAttemptId}`);
  await page.getByLabel('Override').check();
  await page.getByLabel('Итоговый балл').fill('44');
  await page.getByLabel('Причина / комментарий').fill('Проверено руководителем');
  const overrideButton = page.getByRole('button', { name: 'Сохранить новый итог' });
  await overrideButton.click();
  assert.equal(await overrideButton.isDisabled(), true);
  await page.getByText('Итоговый балл скорректирован.').waitFor();
  assert.deepEqual(
    reviewRequests.find((item) => item.attemptId === overrideAttemptId)?.payload,
    {
      decision: 'OVERRIDE',
      finalScore: 44,
      comment: 'Проверено руководителем',
    },
  );

  await page.goto(`${baseUrl}/training/attempts/${pendingEmployeeAttemptId}`);
  await page.getByText('Требует проверки.').waitFor();
  await page.getByText('—', { exact: true }).waitFor();
  assert.equal(await page.getByText('Скрытый transcript сотрудника').count(), 0);
  assert.equal(await page.getByText('gpt-5.6-terra').count(), 0);

  await page.goto(`${baseUrl}/training/attempts/${overriddenEmployeeAttemptId}`);
  await page.getByText('Итог скорректирован после проверки.').waitFor();
  await page.getByText('44', { exact: true }).waitFor();
  assert.equal(await page.locator('.training-breakdown-list > *').count(), 0);

  await page.goto(`${baseUrl}/training/attempts/${technicalEmployeeAttemptId}`);
  await page.getByRole('heading', { name: 'Техническая ошибка' }).waitFor();
  await page.getByText('Произошла техническая ошибка. Попытка возвращена.').waitFor();
  assert.equal(await page.getByText('OPENAI_UPSTREAM_FAILURE').count(), 0);
} finally {
  await browser.close();
}

function adminProject() {
  const facts = Array.from({ length: 11 }, (_, index) => ({
    id: `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    questionType: index === 0 ? 'MAIN' : 'FOLLOW_UP',
    questionPosition: index === 0 ? 1 : index,
    statement: `Утверждённый browser факт ${index + 1}`,
    aliases: [`browser термин ${index + 1}`],
    isRequired: true,
    position: 1,
  }));

  return {
    id: projectId,
    realEstateObjectId: null,
    title: 'Stage 3 browser project',
    description: 'Browser fixture',
    status: 'DRAFT',
    isOpen: false,
    sortOrder: 0,
    attemptLimit: 3,
    timeLimitSeconds: 420,
    passScore: 75,
    allowRetakeAfterPass: true,
    contentSchemaVersion: 2,
    mainQuestion: 'Главный browser вопрос',
    followUpQuestions: Array.from(
      { length: 10 },
      (_, index) => `Дополнительный browser вопрос ${index + 1}`,
    ),
    facts,
    criteria: [
      { id: '41111111-1111-4111-8111-111111111111', questionType: 'MAIN', code: 'completeness', title: 'Полнота', guidance: '', maxPoints: 5, position: 1 },
      { id: '42222222-2222-4222-8222-222222222222', questionType: 'MAIN', code: 'vocabulary', title: 'Лексика', guidance: '', maxPoints: 15, position: 2 },
      { id: '43333333-3333-4333-8333-333333333333', questionType: 'MAIN', code: 'factual_accuracy', title: 'Точность', guidance: '', maxPoints: 15, position: 3 },
      { id: '44444444-4444-4444-8444-444444444444', questionType: 'MAIN', code: 'structure', title: 'Структура', guidance: '', maxPoints: 10, position: 4 },
      { id: '45555555-5555-4555-8555-555555555555', questionType: 'MAIN', code: 'delivery', title: 'Подача', guidance: '', maxPoints: 10, position: 5 },
      { id: '46666666-6666-4666-8666-666666666666', questionType: 'FOLLOW_UP', code: 'answer_quality', title: 'Качество ответа', guidance: '', maxPoints: 15, position: 1 },
    ],
    publicationErrors: ['Проверьте краткость aliases перед публикацией.'],
    createdAt: '2026-08-02T09:00:00.000Z',
    updatedAt: '2026-08-02T09:00:00.000Z',
  };
}

function adminAttempt(attemptId, resolvedReview) {
  const factId = '47777777-7777-4777-8777-777777777777';
  const criterionId = '48888888-8888-4888-8888-888888888888';
  const finalScore = resolvedReview
    ? resolvedReview.decision === 'OVERRIDE' ? resolvedReview.finalScore : 67
    : null;

  return {
    id: attemptId,
    user: { id: '49999999-9999-4999-8999-999999999999', email: 'employee@training.test', name: 'Employee' },
    project: { id: projectId, title: 'Stage 3 browser project', settings: { attemptLimit: 3, timeLimitSeconds: 420, passScore: 75, allowRetakeAfterPass: true } },
    attemptNumber: 1,
    status: resolvedReview ? 'COMPLETED' : 'REQUIRES_REVIEW',
    completionReason: 'COMPLETED',
    calculatedScore: 67,
    reviewStatus: resolvedReview ? 'RESOLVED' : 'PENDING',
    reviewDecision: resolvedReview ? resolvedReview.decision === 'OVERRIDE' ? 'OVERRIDDEN' : 'APPROVED' : null,
    reviewedAt: resolvedReview ? '2026-08-02T10:00:00.000Z' : null,
    reviewComment: resolvedReview?.comment ?? null,
    reviewFinalScore: resolvedReview?.decision === 'OVERRIDE' ? resolvedReview.finalScore : null,
    countsTowardAttemptLimit: true,
    finalScore,
    isPassed: finalScore === null ? null : finalScore >= 75,
    fakeEvaluationVersion: 'training-v2-evaluation-v1',
    startedAt: '2026-08-02T09:00:00.000Z',
    expiresAt: '2026-08-02T09:07:00.000Z',
    completedAt: '2026-08-02T09:05:00.000Z',
    questions: [{
      id: '50000000-0000-4000-8000-000000000001',
      sourceQuestionId: '50000000-0000-4000-8000-000000000002',
      sequence: 1,
      type: 'MAIN',
      text: 'Главный browser вопрос',
      maxScore: 55,
      status: 'ANSWERED',
      presentedAt: '2026-08-02T09:00:00.000Z',
      answeredAt: '2026-08-02T09:05:00.000Z',
      facts: [{ id: factId, statement: 'Утверждённый факт', aliases: [], required: true, position: 1 }],
      criteria: [{ id: criterionId, code: 'completeness', title: 'Полнота', guidance: '', maxPoints: 55, position: 1 }],
      answer: {
        processingStatus: 'COMPLETED',
        text: 'Скрытый transcript сотрудника',
        score: 50,
        safeBreakdown: { version: 'training-v2-evaluation-v1', basis: 'AI_CRITERIA', criteriaPoints: 55, incorrectFactCount: 1, penaltyPoints: 5, awardedScore: 50, maxScore: 55 },
        submittedAt: '2026-08-02T09:05:00.000Z',
        transcriptionModel: 'gpt-4o-mini-transcribe-2025-12-15',
        evaluationModel: 'gpt-5.6-terra',
        evaluation: {
          schema_version: 'training-v2-evaluation-v1',
          fact_assessments: [{ fact_id: factId, verdict: 'INCORRECT', evidence: 'Скрытый transcript', explanation: 'Не совпадает.' }],
          criterion_assessments: [{ criterion_id: criterionId, awarded_points: 55, evidence: 'Скрытый transcript', explanation: 'Оценено.' }],
          unsupported_claims: [{ claim: 'Неподтверждённое утверждение', evidence: 'Скрытый transcript' }],
          summary: 'Требуется ручная проверка.',
          requires_review: true,
        },
        objectiveMetrics: { audioDurationSeconds: 30, segmentCount: 2, wordCount: 3, wordsPerMinute: 6, fillerWordsCount: 0, fillerWordsFound: [] },
        technicalErrorCode: null,
      },
    }],
  };
}

function employeeAttempt(attemptId) {
  const common = {
    id: attemptId,
    project: { id: projectId, title: 'Stage 3 browser project' },
    attemptNumber: 1,
    startedAt: '2026-08-02T09:00:00.000Z',
    expiresAt: '2026-08-02T09:07:00.000Z',
    completedAt: '2026-08-02T09:05:00.000Z',
    answeredCount: 4,
    totalQuestions: 4,
    currentQuestion: null,
  };

  if (attemptId === pendingEmployeeAttemptId) {
    return { ...common, status: 'REQUIRES_REVIEW', completionReason: 'COMPLETED', result: { status: 'REQUIRES_REVIEW', finalScore: null, isPassed: null, safeBreakdown: [], message: 'Требует проверки.', attemptRefunded: false } };
  }
  if (attemptId === overriddenEmployeeAttemptId) {
    return { ...common, status: 'COMPLETED', completionReason: 'COMPLETED', result: { status: 'COMPLETED', finalScore: 44, isPassed: false, safeBreakdown: [], message: 'Итог скорректирован после проверки.', attemptRefunded: false } };
  }
  return { ...common, status: 'TECHNICAL_FAILED', completionReason: 'TECHNICAL_FAILURE', result: { status: 'TECHNICAL_FAILED', finalScore: null, isPassed: false, safeBreakdown: [], message: 'Произошла техническая ошибка. Попытка возвращена.', attemptRefunded: true } };
}
