import { expect, test, type Page, type Route } from '@playwright/test';

const attemptId = '11111111-1111-4111-8111-111111111111';
const answerAId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const answerBId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const apiOrigin = 'http://localhost:3000';

test('review POST success and refresh failure never produce a second POST', async ({
  page,
}) => {
  let reviewPosts = 0;
  let postCommitted = false;
  let committedDetailFailures = 0;
  await installApi(page, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === `/training/admin/results/${attemptId}`) {
      if (postCommitted && committedDetailFailures === 0) {
        committedDetailFailures += 1;
        await fulfillJson(route, { message: 'refresh failed' }, 500);
      } else {
        await fulfillJson(route, adminDetail());
      }
      return true;
    }
    if (
      path === `/training/admin/results/${attemptId}/review` &&
      request.method() === 'POST'
    ) {
      reviewPosts += 1;
      postCommitted = true;
      await fulfillJson(route, { review: { id: 'review-1' } });
      return true;
    }
    if (path === '/training/admin/ranking') {
      await fulfillJson(route, emptyRanking());
      return true;
    }
    return false;
  });

  await openAdminDetail(page);
  await submitReview(page, 'Проверка сохранена один раз');
  await expect(
    page.getByText('Проверка сохранена, но обновить данные не удалось'),
  ).toBeVisible();
  expect(reviewPosts).toBe(1);

  await page.getByRole('button', { name: 'Повторить обновление' }).click();
  await expect(
    page.getByText('Решение сохранено, результат и рейтинг обновлены.'),
  ).toBeVisible();
  expect(reviewPosts).toBe(1);
});

test('ranking refresh failure after committed POST retries GET only', async ({
  page,
}) => {
  let reviewPosts = 0;
  let rankingGets = 0;
  await installApi(page, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === `/training/admin/results/${attemptId}`) {
      await fulfillJson(route, adminDetail());
      return true;
    }
    if (path === `/training/admin/results/${attemptId}/review`) {
      reviewPosts += 1;
      await fulfillJson(route, { review: { id: 'review-1' } });
      return true;
    }
    if (path === '/training/admin/ranking') {
      rankingGets += 1;
      if (rankingGets === 1) {
        await fulfillJson(route, { message: 'ranking refresh failed' }, 500);
      } else {
        await fulfillJson(route, emptyRanking());
      }
      return true;
    }
    return false;
  });

  await openAdminDetail(page);
  await submitReview(page, 'Ranking refresh');
  await expect(
    page.getByText('Проверка сохранена, но обновить данные не удалось'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Повторить обновление' }).click();
  await expect(
    page.getByText('Решение сохранено, результат и рейтинг обновлены.'),
  ).toBeVisible();
  expect(reviewPosts).toBe(1);
  expect(rankingGets).toBe(2);
});

test('ambiguous review retries the same key and renders duplicate history once', async ({
  page,
}) => {
  const keys: string[] = [];
  let reviewPosts = 0;
  await installApi(page, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === `/training/admin/results/${attemptId}`) {
      await fulfillJson(
        route,
        reviewPosts < 2
          ? adminDetail()
          : adminDetail({
              reviews: [
                {
                  id: 'review-existing',
                  reviewNumber: 1,
                  previousFinalScore: '90',
                  adminScore: null,
                  finalScore: '90',
                  decision: 'APPROVED',
                  comment: 'Ambiguous network',
                  unsupportedClaimsDecisions: [],
                  reviewedAt: '2026-07-28T10:10:00.000Z',
                  reviewer: {
                    id: 'admin-1',
                    name: 'Admin',
                    email: 'admin@example.test',
                  },
                },
              ],
            }),
      );
      return true;
    }
    if (path === `/training/admin/results/${attemptId}/review`) {
      reviewPosts += 1;
      keys.push(request.headers()['idempotency-key']);
      if (reviewPosts === 1) {
        await route.abort('failed');
      } else {
        await fulfillJson(route, { review: { id: 'review-existing' } });
      }
      return true;
    }
    if (path === '/training/admin/ranking') {
      await fulfillJson(route, emptyRanking());
      return true;
    }
    return false;
  });

  await openAdminDetail(page);
  await submitReview(page, 'Ambiguous network');
  await expect(
    page.getByText(/Результат сохранения неизвестен/u),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Повторить сохранение' }).click();
  await expect(
    page.getByText('Решение сохранено, результат и рейтинг обновлены.'),
  ).toBeVisible();
  expect(reviewPosts).toBe(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
  await expect(
    page.locator('.training-review-history article'),
  ).toHaveCount(1);
});

test('duplicate click sends one POST and a completed new action gets a new key', async ({
  page,
}) => {
  const keys: string[] = [];
  await installApi(page, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === `/training/admin/results/${attemptId}`) {
      await fulfillJson(route, adminDetail());
      return true;
    }
    if (path === `/training/admin/results/${attemptId}/review`) {
      keys.push(request.headers()['idempotency-key']);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await fulfillJson(route, { review: { id: `review-${keys.length}` } });
      return true;
    }
    if (path === '/training/admin/ranking') {
      await fulfillJson(route, emptyRanking());
      return true;
    }
    return false;
  });

  await openAdminDetail(page);
  await page.locator('textarea').fill('Первое решение');
  const submit = page.getByRole('button', { name: 'Сохранить решение' });
  await submit.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(
    page.getByText('Решение сохранено, результат и рейтинг обновлены.'),
  ).toBeVisible();
  expect(keys).toHaveLength(1);

  await page.locator('textarea').fill('Новое осознанное решение');
  await page.getByRole('button', { name: 'Сохранить решение' }).click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).not.toBe(keys[0]);
});

test('audio generation aborts stale response, revokes A and keeps only B', async ({
  page,
}) => {
  await instrumentObjectUrls(page);
  let currentAnswer = answerAId;
  let delayA = true;
  let audioARequests = 0;
  await installApi(page, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === `/training/admin/results/${attemptId}`) {
      await fulfillJson(
        route,
        adminDetail({
          questions: [adminQuestion('question-stable', currentAnswer)],
        }),
      );
      return true;
    }
    if (path === `/training/admin/answers/${answerAId}/audio`) {
      audioARequests += 1;
      if (delayA) {
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      await route.fulfill({
        status: 200,
        contentType: 'audio/ogg',
        body: Buffer.from('audio-a'),
      });
      return true;
    }
    if (path === `/training/admin/answers/${answerBId}/audio`) {
      await route.fulfill({
        status: 200,
        contentType: 'audio/ogg',
        body: Buffer.from('audio-b'),
      });
      return true;
    }
    return false;
  });

  await openAdminDetail(page);
  await page
    .getByRole('button', { name: 'Загрузить защищённое аудио' })
    .click();
  currentAnswer = answerBId;
  await page.getByRole('button', { name: 'Обновить' }).click();
  await expect.poll(() => audioARequests).toBe(1);
  await page.waitForTimeout(800);
  expect(await objectUrlState(page)).toEqual({ created: [], revoked: [] });
  await expect(page.getByText('Не удалось загрузить аудио')).toHaveCount(0);

  delayA = false;
  currentAnswer = answerAId;
  await page.getByRole('button', { name: 'Обновить' }).click();
  await page
    .getByRole('button', { name: 'Загрузить защищённое аудио' })
    .click();
  await expect(page.locator('audio')).toHaveAttribute('src', 'blob:test-1');
  currentAnswer = answerBId;
  await page.getByRole('button', { name: 'Обновить' }).click();
  await page
    .getByRole('button', { name: 'Загрузить защищённое аудио' })
    .click();
  await expect(page.locator('audio')).toHaveAttribute('src', 'blob:test-2');
  expect(await objectUrlState(page)).toEqual({
    created: ['blob:test-1', 'blob:test-2'],
    revoked: ['blob:test-1'],
  });
});

test('audio unmount aborts delayed request and 401 refresh without leaking URLs', async ({
  page,
}) => {
  await instrumentObjectUrls(page);
  let authRefreshes = 0;
  let audioRequests = 0;
  let listRequests = 0;
  await installApi(page, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/auth/refresh') {
      authRefreshes += 1;
      if (authRefreshes === 1) {
        await fulfillJson(route, authResponse());
      } else {
        await new Promise((resolve) => setTimeout(resolve, 800));
        await fulfillJson(route, authResponse('refreshed-token'));
      }
      return true;
    }
    if (path === `/training/admin/results/${attemptId}`) {
      await fulfillJson(
        route,
        adminDetail({
          questions: [adminQuestion('question-stable', answerAId)],
        }),
      );
      return true;
    }
    if (path === `/training/admin/answers/${answerAId}/audio`) {
      audioRequests += 1;
      if (audioRequests === 1) {
        await route.fulfill({ status: 401, body: '' });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'audio/ogg',
          body: Buffer.from('must-not-be-read'),
        });
      }
      return true;
    }
    if (path === '/training/admin/results') {
      listRequests += 1;
      await fulfillJson(route, emptyAdminResults());
      return true;
    }
    if (path === '/training/admin/ranking') {
      await fulfillJson(route, emptyRanking());
      return true;
    }
    return false;
  });

  await openAdminDetail(page);
  await page
    .getByRole('button', { name: 'Загрузить защищённое аудио' })
    .click();
  await expect.poll(() => authRefreshes).toBe(2);
  await page.getByRole('button', { name: 'Результаты' }).click();
  await expect.poll(() => listRequests).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(900);
  expect(audioRequests).toBe(1);
  expect(await objectUrlState(page)).toEqual({ created: [], revoked: [] });
  await expect(page.getByText('Не удалось загрузить аудио')).toHaveCount(0);
});

test('employee manual adjustment shows final score and hides old breakdown', async ({
  page,
}) => {
  await installApi(
    page,
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/training/config') {
        await fulfillJson(route, { status: 'enabled' });
        return true;
      }
      if (path === '/training/projects') {
        await fulfillJson(route, { items: [] });
        return true;
      }
      if (path === '/training/telegram/account') {
        await fulfillJson(route, { connected: false, account: null });
        return true;
      }
      if (path === '/training/attempts' && !path.endsWith(attemptId)) {
        await fulfillJson(route, {
          items: [employeeAttempt()],
          pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 },
        });
        return true;
      }
      if (path === `/training/attempts/${attemptId}`) {
        await fulfillJson(route, {
          attempt: {
            ...employeeAttempt(),
            attemptsLeft: 1,
            bestScore: '90',
            breakdownStatus: 'MANUALLY_ADJUSTED_BREAKDOWN_UNAVAILABLE',
            breakdown: null,
          },
        });
        return true;
      }
      return false;
    },
    employeePermissions,
  );

  await page.goto('/training');
  await page.getByRole('button', { name: 'Открыть попытку 1' }).click();
  await expect(page.getByText('Итог').locator('..').getByText('70')).toBeVisible();
  await expect(
    page.getByText(
      'Итоговая оценка скорректирована после проверки. Детализация по вопросам недоступна.',
    ),
  ).toBeVisible();
  await expect(page.getByText('Старый server breakdown')).toHaveCount(0);
});

test('employee, admin list, ranking and detail expose behavioral loading/empty/error states', async ({
  page,
}) => {
  let releaseEmployee!: () => void;
  const employeeGate = new Promise<void>((resolve) => {
    releaseEmployee = resolve;
  });
  let employeeError = false;
  await installApi(
    page,
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/training/config') {
        await fulfillJson(route, { status: 'enabled' });
        return true;
      }
      if (path === '/training/projects') {
        await employeeGate;
        await fulfillJson(
          route,
          employeeError ? { message: 'employee failed' } : { items: [] },
          employeeError ? 500 : 200,
        );
        return true;
      }
      if (path === '/training/telegram/account') {
        await fulfillJson(route, { connected: false, account: null });
        return true;
      }
      if (path === '/training/attempts') {
        await fulfillJson(route, {
          items: [],
          pagination: { page: 1, pageSize: 100, total: 0, totalPages: 0 },
        });
        return true;
      }
      return false;
    },
    employeePermissions,
  );
  await page.goto('/training');
  await expect(page.getByRole('status')).toContainText(
    'Загрузка данных обучения',
  );
  releaseEmployee();
  await expect(page.getByText('Нет доступных проектов')).toBeVisible();
  await expect(page.getByText('Попыток пока нет')).toBeVisible();
  employeeError = true;
  await page.getByRole('button', { name: 'Обновить данные обучения' }).click();
  await expect(page.getByText('employee failed')).toBeVisible();

  await page.unrouteAll({ behavior: 'wait' });
  let adminError = false;
  await installApi(page, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/training/admin/results') {
      await fulfillJson(
        route,
        adminError ? { message: 'admin failed' } : emptyAdminResults(),
        adminError ? 500 : 200,
      );
      return true;
    }
    if (path === '/training/admin/ranking') {
      await fulfillJson(route, emptyRanking());
      return true;
    }
    return false;
  });
  await page.goto('/admin/training/results');
  await expect(page.getByText('Результаты не найдены')).toBeVisible();
  adminError = true;
  await page.getByRole('button', { name: 'Обновить' }).click();
  await expect(page.getByText('admin failed')).toBeVisible();

  await page.unrouteAll({ behavior: 'wait' });
  let rankingError = false;
  await installApi(page, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/training/admin/ranking') {
      await fulfillJson(
        route,
        rankingError ? { message: 'ranking failed' } : emptyRanking(),
        rankingError ? 500 : 200,
      );
      return true;
    }
    return false;
  });
  await page.goto('/admin/training/ranking');
  await expect(page.getByText('Данных для рейтинга пока нет')).toBeVisible();
  rankingError = true;
  await page.getByRole('button', { name: 'Обновить' }).click();
  await expect(page.getByText('ranking failed')).toBeVisible();

  await page.unrouteAll({ behavior: 'wait' });
  let releaseDetail!: () => void;
  const detailGate = new Promise<void>((resolve) => {
    releaseDetail = resolve;
  });
  await installApi(page, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/training/admin/results/${attemptId}`) {
      await detailGate;
      await fulfillJson(route, { message: 'detail failed' }, 500);
      return true;
    }
    return false;
  });
  await page.goto(`/admin/training/results/${attemptId}`);
  await expect(page.getByRole('status')).toContainText(
    'Загрузка полного разбора',
  );
  releaseDetail();
  await expect(page.getByText('detail failed')).toBeVisible();
});

async function openAdminDetail(page: Page) {
  await page.goto(`/admin/training/results/${attemptId}`);
  await expect(page.getByText('Решение администратора', { exact: true })).toBeVisible();
}

async function submitReview(page: Page, comment: string) {
  await page.locator('textarea').fill(comment);
  await page.getByRole('button', { name: 'Сохранить решение' }).click();
}

async function installApi(
  page: Page,
  handler: (route: Route) => Promise<boolean>,
  permissions = adminPermissions,
) {
  await page.route(`${apiOrigin}/**`, async (route) => {
    if (await handler(route)) return;
    const path = new URL(route.request().url()).pathname;
    if (path === '/auth/refresh') {
      await fulfillJson(route, authResponse('test-token', permissions));
      return;
    }
    await fulfillJson(route, { message: `Unhandled test API route: ${path}` }, 404);
  });
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function authResponse(
  accessToken = 'test-token',
  permissions = adminPermissions,
) {
  return {
    accessToken,
    user: {
      id: 'admin-1',
      email: 'admin@example.test',
      name: 'Admin',
      brokerPhone: null,
      brokerEmail: null,
      status: 'ACTIVE',
      role: { id: 'role-admin', name: 'admin' },
      profilePhotoFile: null,
      permissions,
    },
  };
}

function adminDetail(
  overrides: Record<string, unknown> = {},
) {
  return {
    attempt: {
      id: attemptId,
      user: {
        id: 'employee-1',
        name: 'Employee',
        email: 'employee@example.test',
      },
      project: {
        id: 'project-1',
        title: 'Проект',
        slug: 'project',
      },
      projectVersion: { id: 'version-1', versionNumber: 1 },
      attemptNumber: 1,
      status: 'COMPLETED',
      isConsumed: true,
      startedAt: '2026-07-28T10:00:00.000Z',
      completedAt: '2026-07-28T10:05:00.000Z',
      totalDurationSeconds: 300,
      aiScore: '90',
      serverScore: '90',
      adminScore: null,
      finalScore: '90',
      passStatus: 'PASSED',
      reviewStatus: 'NOT_REQUIRED',
      answerErrorsCount: 0,
      unsupportedClaimsCount: 0,
      answersCompleted: 1,
      attemptsUsed: 1,
      requiresReview: false,
      summary: 'Safe summary',
      expiresAt: '2026-07-28T10:10:00.000Z',
      graceExpiresAt: '2026-07-28T10:12:00.000Z',
      timeline: [],
      questions: [],
      jobs: [],
      reviews: [],
      ...overrides,
    },
  };
}

function adminQuestion(questionId: string, answerId: string) {
  return {
    id: questionId,
    sequence: 1,
    type: 'MAIN',
    text: 'Вопрос с аудио',
    status: 'SCORED',
    presentedAt: '2026-07-28T10:00:00.000Z',
    firstSegmentAt: '2026-07-28T10:01:00.000Z',
    finishedAt: '2026-07-28T10:04:00.000Z',
    responseTimeSeconds: 240,
    answerDurationSeconds: 120,
    answer: {
      id: answerId,
      status: 'SCORED',
      audioAvailable: true,
      audioUrl: `/training/admin/answers/${answerId}/audio`,
      audioMimeType: 'audio/ogg',
      audioSizeBytes: '7',
      audioDurationMilliseconds: 1_000,
      combinedTranscript: 'Тест',
      normalizedLanguage: 'ru',
      transcriptionProvider: 'fake',
      transcriptionModel: 'fake',
      transcriptionRequestId: 'fake-request',
      acousticMetrics: null,
      processingStartedAt: null,
      processingFinishedAt: null,
      errorCode: null,
      errorMessage: null,
      segments: [],
      transcriptions: [],
      evaluations: [],
      providerRuns: [],
    },
  };
}

function emptyRanking() {
  return {
    items: [],
    pagination: { page: 1, pageSize: 25, total: 0, totalPages: 0 },
    projects: [],
  };
}

function emptyAdminResults() {
  return {
    items: [],
    pagination: { page: 1, pageSize: 25, total: 0, totalPages: 0 },
  };
}

function employeeAttempt() {
  return {
    id: attemptId,
    attemptNumber: 1,
    status: 'COMPLETED',
    isConsumed: true,
    startedAt: '2026-07-28T10:00:00.000Z',
    expiresAt: '2026-07-28T10:10:00.000Z',
    completedAt: '2026-07-28T10:05:00.000Z',
    totalDurationSeconds: 300,
    finalScore: '70',
    passStatus: 'FAILED',
    reviewStatus: 'OVERRIDDEN',
    project: {
      id: 'project-1',
      title: 'Manual Review Project',
      slug: 'manual-review-project',
    },
  };
}

async function instrumentObjectUrls(page: Page) {
  await page.addInitScript(() => {
    const state = {
      created: [] as string[],
      revoked: [] as string[],
    };
    Object.defineProperty(window, '__trainingAudioUrls', {
      value: state,
      configurable: false,
    });
    URL.createObjectURL = () => {
      const value = `blob:test-${state.created.length + 1}`;
      state.created.push(value);
      return value;
    };
    URL.revokeObjectURL = (value) => {
      state.revoked.push(value);
    };
  });
}

async function objectUrlState(page: Page) {
  return page.evaluate(() => {
    const state = (
      window as Window & {
        __trainingAudioUrls: { created: string[]; revoked: string[] };
      }
    ).__trainingAudioUrls;
    return {
      created: [...state.created],
      revoked: [...state.revoked],
    };
  });
}

const adminPermissions = [
  'admin:access',
  'training:results:read',
  'training:results:review',
  'training:audio:read',
];
const employeePermissions = [
  'training:projects:read',
  'training:take',
  'training:own-results:read',
];
