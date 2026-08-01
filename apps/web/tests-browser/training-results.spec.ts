import { expect, test, type Page, type Route } from '@playwright/test';

const attemptId = '11111111-1111-4111-8111-111111111111';
const answerAId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const answerBId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const apiOrigin = 'http://localhost:3000';
const legacyResultsSelectors = [
  '.training-detail-summary--admin',
  '.training-detail-summary-final',
  '.training-attempt-summary',
  '.training-admin-question-list',
  '.training-timeline',
  '.training-answer-meta',
  '.training-answer-section',
  '.training-answer-section-heading',
  '.training-transcript',
  '.training-component-list',
  '.training-component',
  '.training-component--warning',
  '.training-provider-details',
  '.training-provider-run-list',
  '.training-segment-list',
  '.training-evaluation-history',
  '.training-job-list',
  '.training-safe-json',
].join(', ');

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
  await page.getByLabel('Подтвердить системный результат').check();
  await page.getByLabel('Комментарий (обязательно)').fill('Первое решение');
  const submit = page.getByRole('button', { name: 'Сохранить решение' });
  await submit.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(
    page.getByText('Решение сохранено, результат и рейтинг обновлены.'),
  ).toBeVisible();
  expect(keys).toHaveLength(1);

  await page
    .getByLabel('Комментарий (обязательно)')
    .fill('Новое осознанное решение');
  await page.getByRole('button', { name: 'Сохранить решение' }).click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).not.toBe(keys[0]);
});

test('review navigation keeps the active submission and prevents a second POST', async ({
  page,
}) => {
  let reviewPosts = 0;
  let releasePost = () => {};
  const postGate = new Promise<void>((resolve) => {
    releasePost = resolve;
  });
  await installApi(page, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/training/admin/results/${attemptId}`) {
      await fulfillJson(route, adminDetail());
      return true;
    }
    if (path === `/training/admin/results/${attemptId}/review`) {
      reviewPosts += 1;
      await postGate;
      await fulfillJson(route, { review: { id: 'review-navigation' } });
      return true;
    }
    if (path === '/training/admin/ranking') {
      await fulfillJson(route, emptyRanking());
      return true;
    }
    return false;
  });

  await openAdminDetail(page);
  await page.getByLabel('Подтвердить системный результат').check();
  await page
    .getByLabel('Комментарий (обязательно)')
    .fill('Решение сохраняется при навигации');
  await page.getByRole('button', { name: 'Сохранить решение' }).click();
  await expect(page.getByRole('button', { name: 'Сохранение' })).toBeDisabled();

  await page.getByRole('tab', { name: /Вопрос 1/u }).click();
  await expect(page.getByRole('heading', { name: /Вопрос 1/u })).toBeVisible();
  await page.getByRole('tab', { name: /Итог проверки/u }).click();
  await expect(page.getByLabel('Подтвердить системный результат')).toBeChecked();
  await expect(page.getByLabel('Комментарий (обязательно)')).toHaveValue(
    'Решение сохраняется при навигации',
  );
  await expect(page.getByRole('button', { name: 'Сохранение' })).toBeDisabled();
  expect(reviewPosts).toBe(1);

  releasePost();
  await expect(
    page.getByText('Решение сохранено, результат и рейтинг обновлены.'),
  ).toBeVisible();
  expect(reviewPosts).toBe(1);
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
  await page.getByRole('tab', { name: /Вопрос 1/u }).click();
  await page
    .getByRole('button', { name: 'Прослушать ответ' })
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
    .getByRole('button', { name: 'Прослушать ответ' })
    .click();
  await expect(page.locator('audio')).toHaveAttribute('src', 'blob:test-1');
  currentAnswer = answerBId;
  await page.getByRole('button', { name: 'Обновить' }).click();
  await page
    .getByRole('button', { name: 'Прослушать ответ' })
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
  await page.getByRole('tab', { name: /Вопрос 1/u }).click();
  await page
    .getByRole('button', { name: 'Прослушать ответ' })
    .click();
  await expect.poll(() => authRefreshes).toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: 'Результаты обучения' }).click();
  await expect.poll(() => listRequests).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(900);
  expect(audioRequests).toBe(1);
  expect(await objectUrlState(page)).toEqual({ created: [], revoked: [] });
  await expect(page.getByText('Не удалось загрузить аудио')).toHaveCount(0);
});

test('training CSS visual baseline: desktop admin detail renders one readable reviewer workspace without diagnostics', async ({
  page,
}) => {
  const firstQuestion = evaluatedAdminQuestion({
    questionId: 'question-1',
    answerId: answerAId,
    sequence: 1,
    type: 'MAIN',
    text: 'Расскажите о проекте',
    transcript: 'РАСШИФРОВКА_ВОПРОСА_1',
    components: [
      {
        componentKey: 'main.structure',
        title: 'Структура презентации',
        criterionCode: 'main.structure',
        factCode: null,
        awardedPoints: '5',
        maxPoints: '10',
        penaltyPoints: '0',
        factVerdict: 'PARTIAL',
        evidence: {
          text: 'Фрагмент ответа сотрудника',
          explanation: 'Ответ раскрывает тему только частично.',
          source: 'TRANSCRIPT',
          anchorId: 'technical-anchor',
        },
      },
      {
        componentKey: 'claim-1',
        title: 'landscape.wowhaus',
        criterionCode: null,
        factCode: 'landscape.wowhaus',
        awardedPoints: '0',
        maxPoints: '0',
        penaltyPoints: '0',
        factVerdict: 'UNSUPPORTED',
        evidence: {
          claim: 'Концепцию благоустройства разработало бюро VaaS.',
          explanation: 'Утверждение не найдено в подтверждённых материалах.',
        },
      },
    ],
  });
  const secondQuestion = evaluatedAdminQuestion({
    questionId: 'question-2',
    answerId: answerBId,
    sequence: 2,
    type: 'FOLLOW_UP',
    text: 'Уточните инфраструктуру',
    transcript: 'РАСШИФРОВКА_ВОПРОСА_2',
    components: [],
  });
  await installApi(page, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/training/admin/results/${attemptId}`) {
      await fulfillJson(
        route,
        adminDetail({
          timeline: [
            {
              at: '2026-07-28T10:00:00.000Z',
              kind: 'RAW',
              label: 'RAW_TIMELINE_EVENT_TEST',
            },
          ],
          jobs: [
            {
              id: 'job-raw',
              kind: 'SEND_TELEGRAM_MESSAGE',
              status: 'SUCCEEDED',
              attempts: 1,
            },
          ],
          questions: [firstQuestion, secondQuestion],
        }),
      );
      return true;
    }
    return false;
  });

  await page.goto(`/admin/training/results/${attemptId}`);
  await expect(page.getByText('Навигация по вопросам')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Вопрос 1 · Основной вопрос' }),
  ).toBeVisible();
  await expect(page.getByText('РАСШИФРОВКА_ВОПРОСА_1')).toBeVisible();
  await expect(page.getByText('Фрагмент ответа сотрудника')).toBeVisible();
  await expect(page.getByText('Ответ раскрывает тему только частично.')).toBeVisible();
  await expect(page.getByText('main.structure')).toHaveCount(0);
  await expect(page.getByText('landscape.wowhaus')).toHaveCount(0);
  await expect(page.getByText('RAW_TIMELINE_EVENT_TEST')).toHaveCount(0);
  await expect(page.getByText('SEND_TELEGRAM_MESSAGE')).toHaveCount(0);
  await expect(page.getByText('provider-request-secret')).toHaveCount(0);
  await expect(page.getByText('audio/test-raw')).toHaveCount(0);
  await expect(page.getByText('gpt-raw-model')).toHaveCount(0);

  const questionTwoTab = page.getByRole('tab', { name: /Вопрос 2/u });
  await questionTwoTab.click();
  await expect(
    page.getByRole('heading', { name: 'Вопрос 2 · Уточняющий вопрос' }),
  ).toBeVisible();
  await expect(page.getByText('РАСШИФРОВКА_ВОПРОСА_2')).toBeVisible();
  await expect(page.getByText('РАСШИФРОВКА_ВОПРОСА_1')).toHaveCount(0);

  await questionTwoTab.press('Home');
  await expect(page.getByRole('tab', { name: /Вопрос 1/u })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: /Вопрос 1/u }).press('End');
  await expect(page.getByRole('tab', { name: /Итог проверки/u })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator(legacyResultsSelectors)).toHaveCount(0);
  await expect(page).toHaveScreenshot('training-results-desktop.png', {
    animations: 'disabled',
    caret: 'hide',
    fullPage: true,
  });
});

test('review starts blank and submits readable unsupported decisions', async ({
  page,
}) => {
  let submittedBody: Record<string, unknown> | null = null;
  const question = evaluatedAdminQuestion({
    questionId: 'question-review',
    answerId: answerAId,
    sequence: 1,
    type: 'MAIN',
    text: 'Проверьте спорный факт',
    transcript: 'Концепцию благоустройства разработало бюро VaaS.',
    components: [
      {
        componentKey: 'claim-1',
        title: 'landscape.wowhaus',
        criterionCode: null,
        factCode: 'landscape.wowhaus',
        awardedPoints: '0',
        maxPoints: '0',
        penaltyPoints: '0',
        factVerdict: 'UNSUPPORTED',
        evidence: {
          claim: 'Концепцию благоустройства разработало бюро VaaS.',
          explanation: 'Утверждение не подтверждено источником.',
        },
      },
    ],
  });
  await installApi(page, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === `/training/admin/results/${attemptId}`) {
      await fulfillJson(
        route,
        adminDetail({
          finalScore: null,
          reviewStatus: 'PENDING',
          requiresReview: true,
          questions: [question],
        }),
      );
      return true;
    }
    if (path === `/training/admin/results/${attemptId}/review`) {
      submittedBody = request.postDataJSON() as Record<string, unknown>;
      await fulfillJson(route, { review: { id: 'review-readable' } });
      return true;
    }
    if (path === '/training/admin/ranking') {
      await fulfillJson(route, emptyRanking());
      return true;
    }
    return false;
  });

  await openAdminDetail(page);
  const approveResult = page.getByLabel('Подтвердить системный результат');
  const overrideResult = page.getByLabel('Скорректировать итог');
  await expect(approveResult).not.toBeChecked();
  await expect(overrideResult).not.toBeChecked();
  await expect(page.getByText('Утверждения, требующие решения')).toBeVisible();
  await expect(
    page.getByText('Концепцию благоустройства разработало бюро VaaS.'),
  ).toBeVisible();
  await expect(page.getByText('claim-1')).toHaveCount(0);

  const saveDecision = page.getByRole('button', { name: 'Сохранить решение' });
  await saveDecision.click();
  await expect(approveResult).toBeFocused();
  await expect(page.getByText('Выберите итоговое решение по попытке.')).toBeVisible();

  await approveResult.check();
  await saveDecision.click();
  await expect(page.getByLabel('Допустимый факт')).toBeFocused();
  await expect(
    page.getByText('Примите решение по каждому спорному утверждению.'),
  ).toBeVisible();

  await page.getByLabel('Ошибка сотрудника').check();
  await saveDecision.click();
  await expect(page.getByLabel('Комментарий (обязательно)')).toBeFocused();
  await expect(
    page.getByText('Добавьте обязательный комментарий проверяющего.'),
  ).toBeVisible();

  await page
    .getByLabel('Комментарий (обязательно)')
    .fill('Проверено по материалам проекта');
  await saveDecision.click();
  await expect.poll(() => submittedBody).not.toBeNull();
  expect(submittedBody).toEqual({
    decision: 'APPROVED',
    comment: 'Проверено по материалам проекта',
    unsupportedClaimsDecisions: [
      { componentKey: 'claim-1', decision: 'INCORRECT' },
    ],
  });
});

test('training CSS visual baseline: mobile detail uses a sequential pager and never overflows', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const longTranscript = 'Подробный ответ сотрудника. '.repeat(40);
  await installApi(page, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/training/admin/results/${attemptId}`) {
      await fulfillJson(
        route,
        adminDetail({
          questions: [
            evaluatedAdminQuestion({
              questionId: 'question-mobile-1',
              answerId: answerAId,
              sequence: 1,
              type: 'MAIN',
              text: 'Первый вопрос',
              transcript: longTranscript,
              components: [],
            }),
            evaluatedAdminQuestion({
              questionId: 'question-mobile-2',
              answerId: answerBId,
              sequence: 2,
              type: 'FOLLOW_UP',
              text: 'Второй вопрос',
              transcript: 'МОБИЛЬНЫЙ_ОТВЕТ_2',
              components: [],
            }),
          ],
        }),
      );
      return true;
    }
    return false;
  });

  await page.goto(`/admin/training/results/${attemptId}`);
  await expect(page.getByText('Вопрос 1 из 2')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Предыдущий вопрос' })).toBeDisabled();
  const expandTranscript = page.getByRole('button', { name: 'Показать полностью' });
  await expect(expandTranscript).toHaveAttribute('aria-expanded', 'false');
  await expandTranscript.click();
  await expect(page.getByRole('button', { name: 'Свернуть' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await page.getByRole('button', { name: 'Следующий вопрос' }).click();
  await expect(page.getByText('Вопрос 2 из 2')).toBeVisible();
  await expect(page.getByText('МОБИЛЬНЫЙ_ОТВЕТ_2')).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect(page.locator(legacyResultsSelectors)).toHaveCount(0);
  await expect(page).toHaveScreenshot('training-results-mobile.png', {
    animations: 'disabled',
    caret: 'hide',
    fullPage: true,
  });
});

test('employee accepts the current policy before a Telegram start link is issued', async ({
  page,
}) => {
  let policyPosts = 0;
  let startLinkPosts = 0;
  let accepted = false;
  await page.addInitScript(() => {
    window.open = () => null;
  });
  await installApi(
    page,
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/training/config') {
        await fulfillJson(route, { enabled: true, status: 'enabled' });
        return true;
      }
      if (path === '/training/projects') {
        await fulfillJson(route, { items: [employeeProject()] });
        return true;
      }
      if (path === '/training/telegram/account') {
        await fulfillJson(route, { connected: true, account: { displayName: 'Test bot' } });
        return true;
      }
      if (path === '/training/attempts') {
        await fulfillJson(route, {
          items: [],
          pagination: { page: 1, pageSize: 100, total: 0, totalPages: 0 },
        });
        return true;
      }
      if (path === '/training/policy' && request.method() === 'GET') {
        await fulfillJson(route, policyResponse(accepted));
        return true;
      }
      if (path === '/training/policy/accept') {
        policyPosts += 1;
        accepted = true;
        await fulfillJson(route, policyResponse(true));
        return true;
      }
      if (path === '/training/projects/project-1/start-link') {
        startLinkPosts += 1;
        await fulfillJson(route, {
          token: 'not-rendered',
          expiresAt: '2026-07-28T12:00:00.000Z',
          deepLink: 'https://t.me/example_bot?start=safe',
          projectId: 'project-1',
        });
        return true;
      }
      return false;
    },
    employeePermissions,
  );

  await page.goto('/training');
  await page.getByRole('button', { name: 'Перейти в Telegram' }).click();
  await expect(page.getByRole('dialog')).toContainText(
    'Голосовые ответы сохраняются в закрытом хранилище.',
  );
  expect(startLinkPosts).toBe(0);

  await page
    .getByRole('button', { name: 'Ознакомлен и согласен продолжить' })
    .click();
  await expect.poll(() => policyPosts).toBe(1);
  await expect.poll(() => startLinkPosts).toBe(1);
  await expect(
    page.getByText('Ссылка на запуск открыта в Telegram.'),
  ).toBeVisible();
});

test('employee training route keeps the take-permission boundary', async ({
  page,
}) => {
  let employeeDataRequests = 0;
  await installApi(
    page,
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (
        path === '/training/projects' ||
        path === '/training/attempts' ||
        path === '/training/telegram/account'
      ) {
        employeeDataRequests += 1;
      }
      return false;
    },
    [],
  );

  await page.goto('/training');
  await expect(
    page.getByRole('heading', { name: 'Недостаточно прав' }),
  ).toBeVisible();
  expect(employeeDataRequests).toBe(0);
});

test('operations dashboard exposes safe status and audits an explicit retry reason', async ({
  page,
}) => {
  let retryPosts = 0;
  let submittedReason = '';
  await installApi(page, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/training/admin/operations/summary') {
      await fulfillJson(route, operationsResponse());
      return true;
    }
    if (path === '/training/admin/operations/jobs/job-safe/retry') {
      retryPosts += 1;
      submittedReason = (request.postDataJSON() as { reason: string }).reason;
      await fulfillJson(route, { job: { id: 'job-safe', status: 'PENDING' } });
      return true;
    }
    return false;
  });

  await page.goto('/admin/training/operations');
  await expect(page.getByText('Состояние модуля')).toBeVisible();
  await expect(page.getByText('Требует утверждения')).toBeVisible();
  await expect(page.getByText('SAFE_PROVIDER_FAILURE')).toBeVisible();
  await expect(page.getByText('super-secret-provider-message')).toHaveCount(0);

  await page.getByRole('button', { name: 'Повторить' }).click();
  await page.locator('textarea').fill('Проверено дежурным администратором');
  await page.getByRole('button', { name: 'Повторить задание' }).click();
  await expect.poll(() => retryPosts).toBe(1);
  expect(submittedReason).toBe('Проверено дежурным администратором');
  await expect(
    page.getByText('Задание возвращено в очередь. Действие записано в аудит.'),
  ).toBeVisible();
});

test('disabled training module is absent from employee navigation', async ({
  page,
}) => {
  let configGets = 0;
  await installApi(
    page,
    async (route) => {
      if (new URL(route.request().url()).pathname === '/training/config') {
        configGets += 1;
        await fulfillJson(route, { enabled: false, status: 'disabled' });
        return true;
      }
      return false;
    },
    employeePermissions,
  );

  await page.goto('/cabinet');
  await expect.poll(() => configGets).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Раскрыть меню' }).click();
  await expect(page.getByRole('button', { name: 'Обучение' })).toHaveCount(0);
});

test('employee manual adjustment shows final score and hides old breakdown', async ({
  page,
}) => {
  await installApi(
    page,
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/training/config') {
        await fulfillJson(route, { enabled: true, status: 'enabled' });
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
        await fulfillJson(route, { enabled: true, status: 'enabled' });
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
    'Загрузка результата',
  );
  releaseDetail();
  await expect(page.getByText('detail failed')).toBeVisible();
});

async function openAdminDetail(page: Page) {
  await page.goto(`/admin/training/results/${attemptId}`);
  await expect(page.getByText('Навигация по вопросам')).toBeVisible();
  await page.getByRole('tab', { name: /Итог проверки/u }).click();
  await expect(page.getByRole('heading', { name: 'Итог проверки' })).toBeVisible();
}

async function submitReview(page: Page, comment: string) {
  await page.getByLabel('Подтвердить системный результат').check();
  await page.getByLabel('Комментарий (обязательно)').fill(comment);
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
    if (path === '/training/policy') {
      await fulfillJson(route, policyResponse(true));
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
      questions: [adminQuestion('question-default', answerAId)],
      jobs: [],
      reviews: [],
      ...overrides,
    },
  };
}

function adminQuestion(
  questionId: string,
  answerId: string,
  overrides: Record<string, unknown> = {},
) {
  const answerOverrides =
    overrides.answer && typeof overrides.answer === 'object'
      ? (overrides.answer as Record<string, unknown>)
      : {};
  const questionOverrides = { ...overrides };
  delete questionOverrides.answer;
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
      ...answerOverrides,
    },
    ...questionOverrides,
  };
}

function evaluatedAdminQuestion({
  questionId,
  answerId,
  sequence,
  type,
  text,
  transcript,
  components,
}: {
  questionId: string;
  answerId: string;
  sequence: number;
  type: 'MAIN' | 'FOLLOW_UP';
  text: string;
  transcript: string;
  components: Array<Record<string, unknown>>;
}) {
  const awardedScore = components.reduce((total, component) => {
    const value = Number(component.awardedPoints ?? 0);
    return total + (Number.isFinite(value) ? value : 0);
  }, 0);

  return adminQuestion(questionId, answerId, {
    sequence,
    type,
    text,
    answer: {
      combinedTranscript: transcript,
      audioMimeType: 'audio/test-raw',
      audioSizeBytes: '123456',
      transcriptionModel: 'gpt-raw-model',
      transcriptionRequestId: 'provider-request-secret',
      segments: [
        {
          id: `segment-${sequence}`,
          segmentIndex: 0,
          mimeType: 'audio/test-raw',
          sizeBytes: '123456',
          durationMilliseconds: 44_000,
          downloadedAt: null,
          receivedAt: '2026-07-28T10:01:00.000Z',
        },
      ],
      transcriptions: [
        {
          id: `transcription-${sequence}`,
          transcriptionNumber: 1,
          transcript,
          language: 'ru',
          wordCount: 10,
          isActive: true,
          createdAt: '2026-07-28T10:04:00.000Z',
        },
      ],
      evaluations: [
        {
          id: `evaluation-${sequence}`,
          evaluationNumber: 1,
          actualModelId: 'gpt-raw-model',
          reasoningEffort: null,
          promptVersion: 'prompt-secret',
          schemaVersion: 'schema-secret',
          rubricVersion: 'rubric-secret',
          aiSuggestedScore: String(awardedScore),
          serverScore: String(awardedScore),
          summary: 'Понятное резюме',
          requiresReview: components.some(
            (component) => component.factVerdict === 'UNSUPPORTED',
          ),
          reviewReasons: null,
          usage: { raw: 'usage-secret' },
          latencyMs: 123,
          requestId: 'provider-request-secret',
          isActive: true,
          components,
          createdAt: '2026-07-28T10:04:00.000Z',
        },
      ],
      providerRuns: [
        {
          id: `provider-run-${sequence}`,
          kind: 'EVALUATION',
          status: 'SUCCEEDED',
          requestedModelId: 'gpt-raw-model',
          requestId: 'provider-request-secret',
        },
      ],
    },
  });
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

function employeeProject() {
  return {
    id: 'project-1',
    slug: 'shagal',
    title: 'ЖК «Шагал»',
    description: 'Пилотная аттестация',
    object: null,
    sortOrder: 1,
    availableFrom: '2026-07-28T08:00:00.000Z',
    deadlineAt: '2026-08-15T18:00:00.000Z',
    passScore: 80,
    attemptLimit: 2,
    attemptsUsed: 0,
    attemptsLeft: 2,
    cooldownMinutes: 60,
    totalTimeLimitSeconds: 900,
    allowRetakeAfterPass: false,
    requiresTelegramConnection: true,
    telegramConnected: true,
    bestScore: null,
    lastScore: null,
    lastAttemptStatus: null,
    activeAttempt: null,
    eligibility: {
      canStart: true,
      reason: 'AVAILABLE',
      retryAt: null,
    },
  };
}

function policyResponse(accepted: boolean) {
  return {
    policy: {
      id: 'policy-1',
      version: '2026-07-28.1',
      title: 'Правила прохождения аттестации',
      body:
        'Голосовые ответы сохраняются в закрытом хранилище. Они транскрибируются и анализируются системой искусственного интеллекта.',
      checksum: 'safe-checksum',
      effectiveAt: '2026-07-28T08:00:00.000Z',
      isActive: true,
      approvalStatus: 'REQUIRES_MANAGER_APPROVAL',
    },
    acceptance: accepted
      ? {
          acceptedAt: '2026-07-28T09:00:00.000Z',
          source: 'PLATFORM',
        }
      : null,
    accepted,
  };
}

function operationsResponse() {
  return {
    generatedAt: '2026-07-28T10:00:00.000Z',
    training: { enabled: true, status: 'enabled' },
    modes: { telegram: 'fake', openAi: 'fake' },
    audioPrivacy: {
      status: 'VERIFIED',
      checkedAt: '2026-07-28T09:59:00.000Z',
    },
    queue: [{ kind: 'PROCESS_ANSWER', status: 'FAILED', count: 1 }],
    providerRuns: [],
    oldestPendingAgeSeconds: 42,
    activeAttempts: 2,
    stuckAttempts: 0,
    attemptsRequiringReview: 1,
    recentErrors: [
      {
        jobId: 'job-safe',
        kind: 'PROCESS_ANSWER',
        status: 'FAILED',
        code: 'SAFE_PROVIDER_FAILURE',
        occurredAt: '2026-07-28T09:58:00.000Z',
      },
    ],
    workers: [
      {
        kind: 'attempt-worker',
        status: 'ONLINE',
        startedAt: '2026-07-28T09:00:00.000Z',
        lastSeenAt: '2026-07-28T09:59:30.000Z',
      },
    ],
    lastSuccessfulProcessing: {
      jobAt: '2026-07-28T09:57:00.000Z',
      telegramUpdateAt: null,
    },
    activePolicy: {
      id: 'policy-1',
      version: '2026-07-28.1',
      title: 'Правила прохождения аттестации',
      effectiveAt: '2026-07-28T08:00:00.000Z',
      approvalStatus: 'REQUIRES_MANAGER_APPROVAL',
      checksum: 'safe-checksum',
    },
    policyAcceptances: {
      activeCount: 1,
      revokedCount: 0,
      bySource: {
        PLATFORM: 1,
        TELEGRAM: 0,
      },
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
  'training:operations:read',
  'training:operations:manage',
];
const employeePermissions = [
  'training:take',
  'training:own-results:read',
];
