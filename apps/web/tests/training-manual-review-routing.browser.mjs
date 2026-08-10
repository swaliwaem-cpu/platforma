import assert from 'node:assert/strict';

import { chromium } from '@playwright/test';
import { fulfillTrainingConfig } from './training-v2-browser-config-fixture.mjs';

const baseUrl = process.env.TRAINING_WEB_TEST_URL;
if (!baseUrl) throw new Error('TRAINING_WEB_TEST_URL is required');

const attemptId = '62222222-2222-4222-8222-222222222222';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const runtimeErrors = [];
let reviewRequests = 0;

page.on('pageerror', (error) => runtimeErrors.push(`pageerror:${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') {
    runtimeErrors.push(`${message.type()}:${message.text()}`);
  }
});

try {
  await page.route('http://localhost:3000/**', async (route) => {
    if (await fulfillTrainingConfig(route, true)) return;
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === '/auth/refresh') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          accessToken: 'manual-review-routing-browser-token',
          user: {
            id: '63333333-3333-4333-8333-333333333333',
            email: 'reviewer@training.test',
            name: 'Reviewer',
            brokerPhone: null,
            brokerEmail: null,
            status: 'ACTIVE',
            role: { id: '64444444-4444-4444-8444-444444444444', name: 'admin' },
            profilePhotoFile: null,
            permissions: ['admin:access', 'training:results:read', 'training:results:review'],
          },
        }),
      });
      return;
    }

    if (path === `/training/admin/attempts/${attemptId}` && request.method() === 'GET') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(adminAttempt()) });
      return;
    }

    if (path === `/training/admin/attempts/${attemptId}/review` && request.method() === 'POST') {
      reviewRequests += 1;
      assert.deepEqual(request.postDataJSON(), {
        decision: 'APPROVE',
        finalScore: null,
        comment: null,
      });
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          attemptId,
          status: 'COMPLETED',
          calculatedScore: 50,
          finalScore: 50,
          isPassed: false,
          reviewStatus: 'RESOLVED',
          reviewDecision: 'APPROVED',
          reviewedAt: '2026-08-08T10:00:00.000Z',
        }),
      });
      return;
    }

    await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });

  await page.goto(`${baseUrl}/admin/training/attempts/${attemptId}`);
  assert.equal(new URL(page.url()).pathname, `/admin/training/attempts/${attemptId}`);
  assert.match(await page.title(), /Platforma/u);
  await page.getByRole('heading', { name: 'Подтвердить или скорректировать итог' }).waitFor();
  const categoryLabel = page.getByText('Существенный неподтверждённый факт');
  await categoryLabel.waitFor();
  await page.locator('span').getByText('Неподтверждённое утверждение', { exact: true }).waitFor();
  assert.equal(await page.locator('body').innerText().then((text) => text.trim().length > 100), true);
  await categoryLabel.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: process.env.TRAINING_BROWSER_SCREENSHOT_PATH ?? '/tmp/training-manual-review-routing.png',
    fullPage: false,
  });

  await page.getByRole('button', { name: 'Подтвердить расчёт' }).click();
  await page.getByText('Расчётный результат подтверждён.').waitFor();
  assert.equal(reviewRequests, 1);
  assert.deepEqual(runtimeErrors, []);
  process.stdout.write('TRAINING_MANUAL_REVIEW_ROUTING_BROWSER_OK\n');
} finally {
  await browser.close();
}

function adminAttempt() {
  const factId = '65555555-5555-4555-8555-555555555555';
  const criterionId = '66666666-6666-4666-8666-666666666666';

  return {
    id: attemptId,
    user: { id: '67777777-7777-4777-8777-777777777777', email: 'employee@training.test', name: 'Employee' },
    project: { id: '68888888-8888-4888-8888-888888888888', title: 'Routing project', settings: { attemptLimit: 3, timeLimitSeconds: 420, passScore: 75, allowRetakeAfterPass: true } },
    attemptNumber: 1,
    status: 'REQUIRES_REVIEW',
    completionReason: 'COMPLETED',
    snapshotVersion: 3,
    durationSeconds: 120,
    currentAccess: { projectStatus: 'PUBLISHED', isOpen: true, accessMode: 'ALL_PARTICIPANTS', assignmentStatus: 'NEVER_ASSIGNED', userStatus: 'ACTIVE', canParticipate: true, hasCurrentAccess: true },
    calculatedScore: 50,
    reviewStatus: 'PENDING',
    reviewDecision: null,
    reviewedAt: null,
    reviewedBy: null,
    reviewComment: null,
    reviewFinalScore: null,
    countsTowardAttemptLimit: true,
    finalScore: null,
    isPassed: null,
    fakeEvaluationVersion: 'training-v2-evaluation-v2',
    startedAt: '2026-08-08T09:00:00.000Z',
    expiresAt: '2026-08-08T09:07:00.000Z',
    completedAt: '2026-08-08T09:02:00.000Z',
    questions: [{
      id: '69999999-9999-4999-8999-999999999999',
      sourceQuestionId: '70000000-0000-4000-8000-000000000000',
      sequence: 1,
      type: 'MAIN',
      text: 'Расскажите о проекте только в рамках материалов обучения.',
      maxScore: 55,
      status: 'ANSWERED',
      presentedAt: '2026-08-08T09:00:00.000Z',
      answeredAt: '2026-08-08T09:02:00.000Z',
      responseDurationSeconds: 120,
      facts: [{ id: factId, statement: 'Утверждённый факт', aliases: [], required: true, position: 1 }],
      criteria: [{ id: criterionId, code: 'main', title: 'Полнота', guidance: '', maxPoints: 55, position: 1 }],
      answer: {
        id: '71111111-1111-4111-8111-111111111111',
        source: 'TELEGRAM',
        processingStatus: 'COMPLETED',
        text: 'Утверждённый факт. Неподтверждённое утверждение.',
        score: 50,
        safeBreakdown: { version: 'training-v2-evaluation-v2', basis: 'AI_CRITERIA', criteriaPoints: 55, incorrectFactCount: 1, penaltyPoints: 5, awardedScore: 50, maxScore: 55 },
        submittedAt: '2026-08-08T09:02:00.000Z',
        transcriptionModel: 'fake-transcriber',
        evaluationModel: 'fake-evaluator',
        transcriptionRequestId: null,
        evaluationRequestId: null,
        evaluation: {
          schema_version: 'training-v2-evaluation-v2',
          fact_assessments: [{ fact_id: factId, verdict: 'INCORRECT', evidence: 'Утверждённый факт', explanation: 'Fixture.' }],
          criterion_assessments: [{ criterion_id: criterionId, awarded_points: 55, evidence: 'Утверждённый факт', explanation: 'Fixture.' }],
          unsupported_claims: [{ claim: 'Неподтверждённое утверждение', evidence: 'Неподтверждённое утверждение', category: 'MATERIAL_UNVERIFIED' }],
          summary: 'Требуется проверка.',
          requires_review: true,
        },
        objectiveMetrics: { audioDurationSeconds: 30, segmentCount: 1, wordCount: 4, wordsPerMinute: 8, fillerWordsCount: 0, fillerWordsFound: [] },
        technicalErrorCode: null,
        audioAvailable: false,
      },
    }],
  };
}
