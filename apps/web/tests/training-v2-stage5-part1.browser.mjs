import assert from 'node:assert/strict';

import { chromium } from '@playwright/test';

const baseUrl = process.env.TRAINING_WEB_TEST_URL;
if (!baseUrl) throw new Error('TRAINING_WEB_TEST_URL is required');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const attemptId = '91111111-1111-4111-8111-111111111111';
const answerId = '92222222-2222-4222-8222-222222222222';
const resultQueries = [];
let detailReads = 0;
let reviewPosts = 0;
let resultDelayMs = 250;
let audioFails = false;

try {
  await page.route('http://localhost:3000/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === '/auth/refresh') {
      await json(route, {
        accessToken: 'stage5-browser-access-token',
        user: {
          id: '93333333-3333-4333-8333-333333333333',
          email: 'stage5-admin@training.test',
          name: 'Stage 5 Admin',
          brokerPhone: null,
          brokerEmail: null,
          status: 'ACTIVE',
          role: { id: '94444444-4444-4444-8444-444444444444', name: 'admin' },
          profilePhotoFile: null,
          permissions: ['admin:access', 'training:participate', 'training:results:read', 'training:results:review', 'training:audio:read'],
        },
      });
      return;
    }

    if (path === '/training/admin/results') {
      resultQueries.push(Object.fromEntries(url.searchParams.entries()));
      if (resultDelayMs) await new Promise((resolve) => setTimeout(resolve, resultDelayMs));
      const search = url.searchParams.get('search');
      if (search === 'error') {
        await json(route, { message: 'RESULTS_FAILED' }, 500);
        return;
      }
      const pageNumber = Number(url.searchParams.get('page') ?? 1);
      await json(route, {
        items: search === 'empty' ? [] : [resultFixture()],
        total: search === 'empty' ? 0 : 21,
        page: pageNumber,
        limit: 20,
        totalPages: search === 'empty' ? 0 : 2,
      });
      return;
    }

    if (path === `/training/admin/attempts/${attemptId}` && request.method() === 'GET') {
      detailReads += 1;
      if (reviewPosts > 0) {
        await json(route, { message: 'DETAIL_REFRESH_FAILED' }, 500);
      } else {
        await json(route, detailFixture());
      }
      return;
    }

    if (path === `/training/admin/attempts/${attemptId}/review` && request.method() === 'POST') {
      reviewPosts += 1;
      await json(route, {
        attemptId,
        status: 'COMPLETED',
        calculatedScore: 76,
        finalScore: 76,
        isPassed: true,
        reviewStatus: 'RESOLVED',
        reviewDecision: 'APPROVED',
        reviewedAt: '2026-08-02T12:05:00.000Z',
      }, 201);
      return;
    }

    if (path === `/training/admin/answers/${answerId}/audio`) {
      if (audioFails) {
        await json(route, { message: 'AUDIO_FAILED' }, 404);
        return;
      }
      const wav = Buffer.alloc(48);
      wav.write('RIFF', 0, 'ascii');
      wav.write('WAVE', 8, 'ascii');
      await route.fulfill({
        status: 200,
        contentType: 'audio/wav',
        headers: { 'Cache-Control': 'private, no-store' },
        body: wav,
      });
      return;
    }

    if (path === '/training/projects') {
      await json(route, { items: [employeeProjectFixture()] });
      return;
    }

    if (path === '/training/attempts') {
      await json(route, { items: employeeHistoryFixture() });
      return;
    }

    if (path === '/training/telegram/account') {
      await json(route, { message: 'TELEGRAM_STATUS_FAILED' }, 500);
      return;
    }

    await json(route, { message: `Unexpected ${request.method()} ${path}` }, 404);
  });

  await page.goto(`${baseUrl}/admin/training/results`, { waitUntil: 'domcontentloaded' });
  await page.locator('.training-list-skeleton').waitFor();
  await page.getByText('Результаты сотрудников').waitFor();
  await page.getByText('Анна Брокер').waitFor();
  resultDelayMs = 0;
  assert.equal(await page.locator('html').getAttribute('data-app-theme'), 'minimal-luxury');
  await page.getByRole('button', { name: 'Раскрыть меню' }).click();
  await page.getByRole('button', { name: 'Включить темную тему' }).click();
  assert.equal(await page.locator('html').getAttribute('data-app-theme'), 'dark-premium');
  await page.getByRole('button', { name: 'Далее' }).click();
  await page.getByText('Страница 2 из 2').waitFor();
  assert.equal(resultQueries.at(-1).page, '2');
  await page.getByRole('button', { name: 'Назад' }).click();
  await page.getByText('Страница 1 из 2').waitFor();
  await page.getByLabel('Сотрудник').fill('Анна');
  await page.getByLabel('Статус').selectOption('REQUIRES_REVIEW');
  await page.getByRole('button', { name: 'Применить' }).click();
  await page.getByText('Анна Брокер').waitFor();
  assert.equal(resultQueries.at(-1).search, 'Анна');
  assert.equal(resultQueries.at(-1).attemptStatus, 'REQUIRES_REVIEW');

  await page.getByLabel('Сотрудник').fill('empty');
  await page.getByRole('button', { name: 'Применить' }).click();
  await page.getByText('Результаты не найдены').waitFor();
  await page.getByLabel('Сотрудник').fill('error');
  await page.getByRole('button', { name: 'Применить' }).click();
  await page.getByText('RESULTS_FAILED').waitFor();
  await page.getByRole('button', { name: 'Сбросить' }).click();
  await page.getByText('Анна Брокер').waitFor();
  await page.setViewportSize({ width: 500, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

  await page.getByRole('button', { name: 'Открыть' }).click();
  await page.waitForURL(`**/admin/training/attempts/${attemptId}`);
  await page.getByText('Вопросы, факты и оценивание').waitFor();
  await page.getByRole('button', { name: 'Прослушать запись' }).click();
  await page.locator('audio').waitFor();
  await page.getByRole('button', { name: 'Закрыть запись' }).click();
  assert.equal(await page.locator('audio').count(), 0);
  audioFails = true;
  await page.getByRole('button', { name: 'Прослушать запись' }).click();
  await page.getByText('AUDIO_FAILED').waitFor();

  await page.getByRole('button', { name: 'Подтвердить расчёт' }).click();
  await page.getByText(/Решение сохранено, но detail не обновился/).waitFor();
  assert.equal(reviewPosts, 1);
  assert.ok(detailReads >= 2);
  assert.equal(await page.getByRole('button', { name: 'Подтвердить расчёт' }).count(), 0);

  await page.goto(`${baseUrl}/training`);
  await page.getByText('Доступ к новым попыткам отозван. Текущую попытку можно завершить.').waitFor();
  await page.getByText('Результат проверяется.').waitFor();
  await page.getByText('Итог скорректирован после проверки.').waitFor();
  await page.getByText('Произошла техническая ошибка. Попытка возвращена.').waitFor();
  await page.getByText('Статус Telegram временно недоступен. Результаты и проекты загружены.').waitFor();

  process.stdout.write('TRAINING_STAGE5_PART1_BROWSER_OK\n');
} finally {
  await browser.close();
}

function resultFixture() {
  return {
    id: attemptId,
    user: { id: '95555555-5555-4555-8555-555555555555', email: 'anna@example.test', name: 'Анна Брокер' },
    project: { id: '96666666-6666-4666-8666-666666666666', title: 'Продажи ЖК' },
    currentAccess: { accessMode: 'ASSIGNED_USERS', assignmentStatus: 'REVOKED', hasCurrentAccess: false },
    attemptNumber: 2,
    status: 'REQUIRES_REVIEW',
    completionReason: 'COMPLETED',
    reviewStatus: 'PENDING',
    reviewDecision: null,
    countsTowardAttemptLimit: true,
    finalScore: null,
    isPassed: null,
    startedAt: '2026-08-02T12:00:00.000Z',
    completedAt: '2026-08-02T12:04:00.000Z',
    durationSeconds: 240,
    answerCount: 1,
    answerSources: ['TELEGRAM'],
    hasPendingReview: true,
    hasTechnicalFailure: false,
  };
}

function detailFixture() {
  return {
    id: attemptId,
    user: resultFixture().user,
    project: { id: resultFixture().project.id, title: 'Продажи ЖК · snapshot', settings: { attemptLimit: 3, timeLimitSeconds: 420, passScore: 75, allowRetakeAfterPass: true } },
    attemptNumber: 2,
    status: 'REQUIRES_REVIEW',
    finalScore: null,
    isPassed: null,
    startedAt: '2026-08-02T12:00:00.000Z',
    completedAt: '2026-08-02T12:04:00.000Z',
    completionReason: 'COMPLETED',
    snapshotVersion: 3,
    durationSeconds: 240,
    currentAccess: { projectStatus: 'PUBLISHED', isOpen: true, accessMode: 'ASSIGNED_USERS', assignmentStatus: 'REVOKED', userStatus: 'ACTIVE', canParticipate: true, hasCurrentAccess: false },
    calculatedScore: 76,
    reviewStatus: 'PENDING',
    reviewDecision: null,
    reviewedAt: null,
    reviewedBy: null,
    reviewComment: null,
    reviewFinalScore: null,
    countsTowardAttemptLimit: true,
    fakeEvaluationVersion: 'training-v2-evaluation-v1',
    expiresAt: '2026-08-02T12:07:00.000Z',
    questions: [{
      id: '97777777-7777-4777-8777-777777777777',
      sourceQuestionId: null,
      sequence: 1,
      type: 'MAIN',
      text: 'Расскажите о проекте',
      maxScore: 55,
      status: 'ANSWERED',
      presentedAt: '2026-08-02T12:00:00.000Z',
      answeredAt: '2026-08-02T12:02:00.000Z',
      responseDurationSeconds: 120,
      facts: [],
      criteria: [],
      answer: {
        id: answerId,
        source: 'TELEGRAM',
        processingStatus: 'COMPLETED',
        text: 'Транскрипт ответа',
        score: 55,
        safeBreakdown: null,
        submittedAt: '2026-08-02T12:02:00.000Z',
        transcriptionModel: 'fake',
        evaluationModel: 'fake',
        transcriptionRequestId: null,
        evaluationRequestId: null,
        evaluation: null,
        objectiveMetrics: null,
        technicalErrorCode: null,
        audioAvailable: true,
      },
    }],
  };
}

function employeeProjectFixture() {
  return {
    id: resultFixture().project.id,
    title: 'Продажи ЖК',
    description: null,
    attemptLimit: 3,
    timeLimitSeconds: 420,
    passScore: 75,
    attemptsUsed: 2,
    attemptsLeft: 1,
    eligibility: 'ACTIVE_ATTEMPT',
    canStart: false,
    newAttemptAccessRevoked: true,
    activeAttempt: { id: attemptId, expiresAt: '2026-08-02T12:07:00.000Z' },
    bestConfirmedScore: 80,
    bestConfirmedStatus: 'PASSED',
    lastConfirmedScore: 70,
    lastConfirmedStatus: 'FAILED',
    lastConfirmedAt: '2026-08-02T12:04:00.000Z',
    hasPendingReview: true,
    status: 'PASSED',
  };
}

function employeeHistoryFixture() {
  const base = {
    projectId: resultFixture().project.id,
    projectTitle: 'Продажи ЖК · snapshot',
    completionReason: 'COMPLETED',
    countsTowardAttemptLimit: true,
    safeBreakdown: [],
    attemptRefunded: false,
    startedAt: '2026-08-02T12:00:00.000Z',
    completedAt: '2026-08-02T12:04:00.000Z',
    durationSeconds: 240,
  };
  return [
    { ...base, id: 'a1111111-1111-4111-8111-111111111111', attemptNumber: 3, status: 'REQUIRES_REVIEW', finalScore: null, isPassed: null, message: 'Результат проверяется.' },
    { ...base, id: 'a2222222-2222-4222-8222-222222222222', attemptNumber: 2, status: 'COMPLETED', finalScore: 70, isPassed: false, message: 'Итог скорректирован после проверки.' },
    { ...base, id: 'a3333333-3333-4333-8333-333333333333', attemptNumber: 1, status: 'TECHNICAL_FAILED', completionReason: 'TECHNICAL_FAILURE', countsTowardAttemptLimit: false, finalScore: null, isPassed: null, message: 'Произошла техническая ошибка. Попытка возвращена.', attemptRefunded: true },
  ];
}

async function json(route, body, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}
