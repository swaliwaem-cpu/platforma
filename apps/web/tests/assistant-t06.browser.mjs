import assert from 'node:assert/strict';

import { chromium } from '@playwright/test';

const baseUrl = process.env.ASSISTANT_T06_WEB_TEST_URL;
if (!baseUrl) throw new Error('ASSISTANT_T06_WEB_TEST_URL is required');

const now = '2026-08-26T12:00:00.000Z';
const ids = {
  run: '11111111-1111-4111-8111-111111111111',
  message: '22222222-2222-4222-8222-222222222222',
  conversation: '33333333-3333-4333-8333-333333333333',
  review: '44444444-4444-4444-8444-444444444444',
  feedback: '55555555-5555-4555-8555-555555555555',
};

const browser = await chromium.launch({ headless: true });

try {
  await verifyAuditFlow();
  await verifyFeedbackFlow();
  await verifyMobileAudit();
  process.stdout.write('ASSISTANT_T06_BROWSER_OK\n');
} finally {
  await browser.close();
}

async function verifyAuditFlow() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const state = createState();
  const issues = collectRuntimeIssues(page);
  await installRoutes(page, state);
  try {
    await page.goto(`${baseUrl}/admin/assistant-audit`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Аудит ответов' }).waitFor();
    assert.equal(await page.title(), 'Platforma');
    await page.getByLabel('Сигнал качества').selectOption('NEGATIVE_FEEDBACK');
    await page.getByRole('button', { name: 'Открыть', exact: true }).click();
    await page.getByRole('heading', { name: 'Candidate set' }).waitFor();
    await page.getByText('unit-primary', { exact: false }).first().waitFor();
    await page.getByText('gpt-5.6-terra', { exact: false }).first().waitFor();
    await page.getByRole('radio', { name: 'Пользовательская оценка ошибочна' }).first().click();
    await page.getByLabel('Комментарий reviewer').fill('Evidence подтверждает цену');
    await page.getByRole('button', { name: 'Сохранить классификацию' }).click();
    await page.getByText('Классификация сохранена отдельно от пользовательской оценки.').waitFor();
    assert.deepEqual(state.reviewBodies, [{
      classification: 'USER_RATING_INCORRECT',
      comment: 'Evidence подтверждает цену',
    }]);

    await page.getByRole('button', { name: 'К списку' }).click();
    await page.getByRole('tab', { name: 'Источники' }).click();
    await page.getByText('severny-sad', { exact: true }).waitFor();
    await page.getByRole('tab', { name: 'Geo' }).click();
    await page.getByText('fake / RESOLVED', { exact: true }).waitFor();
    await page.getByRole('tab', { name: 'Лимиты и метрики' }).click();
    await page.getByText('gpt-5.6-terra', { exact: true }).waitFor();
    assert.deepEqual(issues, []);
    assert.equal(state.externalProviderCalls, 0);
  } finally {
    await context.close();
  }
}

async function verifyFeedbackFlow() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const state = createState();
  const issues = collectRuntimeIssues(page);
  await installRoutes(page, state);
  try {
    await page.goto(`${baseUrl}/cabinet`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Открыть ИИ-помощника' }).click();
    await page.getByRole('button', { name: 'История разговоров' }).click();
    await page.getByRole('button', { name: /Проверка feedback/u }).click();
    await page.getByRole('button', { name: 'Ответ не помог' }).click();
    await page.getByLabel(/Причина/u).selectOption('STALE_DATA');
    await page.getByLabel(/Комментарий/u).fill('Проверьте дату обновления');
    await page.getByRole('button', { name: 'Сохранить оценку' }).click();
    await page.getByText('Спасибо, оценка попадёт на проверку.').waitFor();
    assert.deepEqual(state.feedbackBodies, [{
      rating: 'DISLIKE',
      reason: 'STALE_DATA',
      comment: 'Проверьте дату обновления',
    }]);
    assert.deepEqual(issues, []);
    assert.equal(state.externalProviderCalls, 0);
  } finally {
    await context.close();
  }
}

async function verifyMobileAudit() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const state = createState();
  await installRoutes(page, state);
  try {
    await page.goto(`${baseUrl}/admin/assistant-audit`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Аудит ответов' }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    const filter = await page.getByLabel('Сигнал качества').boundingBox();
    assert.ok(filter && filter.height >= 44);
  } finally {
    await context.close();
  }
}

function createState() {
  return { feedbackBodies: [], reviewBodies: [], externalProviderCalls: 0 };
}

function collectRuntimeIssues(page) {
  const issues = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') issues.push(message.text());
  });
  page.on('pageerror', (error) => issues.push(error.message));
  return issues;
}

async function installRoutes(page, state) {
  page.on('request', (request) => {
    if (/openai|locationiq|api\.anthropic/iu.test(request.url())) state.externalProviderCalls += 1;
  });
  await page.route('http://localhost:3000/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/auth/refresh') return json(route, { accessToken: 'fixture-token', user: authUser() });
    if (path === '/training/config') return json(route, { enabled: false });
    if (path === '/assistant/config') return json(route, { enabled: true });
    if (path === '/assistant/conversations' && request.method() === 'GET') {
      return json(route, { items: [conversation(false)], nextCursor: null });
    }
    if (path === `/assistant/conversations/${ids.conversation}`) {
      return json(route, { conversation: conversation(true) });
    }
    if (path === `/assistant/messages/${ids.message}/feedback`) {
      const body = request.postDataJSON();
      state.feedbackBodies.push(body);
      return json(route, { feedback: { id: ids.feedback, ...body, createdAt: now, updatedAt: now } }, 201);
    }
    if (path === '/assistant/audit/runs') {
      return json(route, { items: [runSummary()], total: 1, page: 1, limit: 50, totalPages: 1 });
    }
    if (path === `/assistant/audit/runs/${ids.run}`) return json(route, { run: runDetail() });
    if (path === `/assistant/audit/reviews/${ids.review}`) {
      const body = request.postDataJSON();
      state.reviewBodies.push(body);
      return json(route, { review: {
        ...runSummary().review,
        status: 'REVIEWED', classification: body.classification, reviewerComment: body.comment, reviewedAt: now,
      } });
    }
    if (path === '/assistant/audit/sources') return json(route, { items: [sourceFixture()] });
    if (path === '/assistant/audit/geo/operations') return json(route, { items: [geoFixture()] });
    if (path === '/assistant/audit/geo/aliases') return json(route, { items: [aliasFixture()] });
    if (path === '/assistant/audit/metrics') return json(route, { items: [metricFixture()] });
    return json(route, { message: `Unexpected ${request.method()} ${path}` }, 404);
  });
}

function authUser() {
  return {
    id: '66666666-6666-4666-8666-666666666666', email: 'assistant-audit@example.test', name: 'QA Reviewer',
    brokerPhone: null, brokerEmail: null, status: 'ACTIVE', profilePhotoFile: null,
    role: { id: '77777777-7777-4777-8777-777777777777', name: 'admin' },
    permissions: ['admin:access', 'assistant:audit:read', 'assistant:sources:manage', 'objects:read'],
  };
}

function conversation(withMessages) {
  return {
    id: ids.conversation, title: 'Проверка feedback', createdAt: now, updatedAt: now, messagesCount: 2,
    ...(withMessages ? { messages: [
      { id: '88888888-8888-4888-8888-888888888888', role: 'USER', content: 'Какая цена?', context: null, geo: null, answer: null, feedback: null, createdAt: now },
      { id: ids.message, role: 'ASSISTANT', content: 'Минимальная цена — 19 млн рублей.', context: null, geo: null, answer: { kind: 'CLARIFICATION', question: 'Уточнить?' }, feedback: null, createdAt: now },
    ] } : {}),
  };
}

function runSummary() {
  return {
    id: ids.run, status: 'COMPLETED', query: 'Найди квартиру рядом с Плотинкой до 20 млн',
    answer: 'Подходит квартира за 19 млн рублей.', qualityFlags: ['UNSUPPORTED_FACT', 'MODEL_FALLBACK'],
    latencyMs: 1630, model: 'gpt-5.6-terra', reasoningEffort: 'medium', fallback: true,
    feedback: { id: ids.feedback, rating: 'DISLIKE', reason: 'WRONG_FACT', comment: 'Цена устарела', createdAt: now },
    review: { id: ids.review, status: 'PENDING', classification: null, reviewerComment: null, reviewedAt: null },
    createdAt: now,
  };
}

function runDetail() {
  return {
    ...runSummary(), owner: { id: authUser().id, email: authUser().email, name: authUser().name },
    request: runSummary().query, finalAnswer: runSummary().answer,
    structuredIntent: { taskType: 'SEARCH', hardFilters: { budgetMaxRub: 20000000 } },
    audit: {
      appliedFilters: { budgetMaxRub: 20000000 }, softPreferences: { district: 'Центр' },
      candidateSet: [{ evidenceId: 'unit-primary', priceRub: 19000000 }, { evidenceId: 'unit-rejected', priceRub: 23000000 }],
      rankingDecisions: [{ evidenceId: 'unit-primary', outcome: 'PRIMARY' }, { evidenceId: 'unit-rejected', outcome: 'REJECTED' }],
      evidenceRevisions: [{ kind: 'PLATFORMA_FEED_UNIT', evidenceId: 'unit-primary', revisionId: 'unit-primary', observedAt: now }],
    },
    evidence: [{ feedUnitId: 'unit-primary' }],
    telemetry: [{ provider: 'fake', model: 'gpt-5.6-luna', outcome: 'LOCAL_VALIDATION_FAILED' }, { provider: 'fake', model: 'gpt-5.6-terra', outcome: 'ACCEPTED', isFallback: true }],
    errorClassification: null, startedAt: now, completedAt: now,
  };
}

function sourceFixture() {
  return { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', canonicalUrl: 'https://developer.example/project', type: 'DEVELOPMENT_PAGE', state: 'ACTIVE', projectKey: 'severny-sad', connectorKey: 'OFFICIAL_HTML', lastSuccessAt: now, lastIndexedAt: now, lastErrorCode: null, counts: { revisions: 3, facts: 18, chunks: 7 } };
}

function geoFixture() {
  return { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', normalizedQuery: 'плотинка', provider: 'fake', status: 'RESOLVED', durationMs: 17, cacheHit: false, providerCallCount: 1, errorCode: null, createdAt: now };
}

function aliasFixture() {
  return { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', query: 'Плотинка', locale: 'ru', country: 'ru', label: 'Плотинка, Екатеринбург', latitude: 56.8377, longitude: 60.6038, city: 'Екатеринбург', countryCode: 'ru', updatedAt: now };
}

function metricFixture() {
  return { provider: 'fake', model: 'gpt-5.6-terra', window: 'MINUTE', windowStartedAt: now, requestCount: 4, completedCount: 3, errorCount: 1, totalTokens: 128, totalLatencyMs: 680 };
}

async function json(route, body, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}
