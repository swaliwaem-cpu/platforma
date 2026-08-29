import assert from 'node:assert/strict';

import { chromium } from '@playwright/test';

const baseUrl = process.env.ASSISTANT_WEB_TEST_URL;
if (!baseUrl) throw new Error('ASSISTANT_WEB_TEST_URL is required');

const browser = await chromium.launch({ headless: true });
const consoleIssues = [];
let expectedRetryNetworkErrors = 0;

try {
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  desktop.on('console', (message) => {
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    if (message.text() === 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)') {
      expectedRetryNetworkErrors += 1;
      return;
    }
    consoleIssues.push(message.text());
  });
  desktop.on('pageerror', (error) => consoleIssues.push(error.message));
  const desktopState = createAssistantState();
  await installRoutes(desktop, desktopState, ['objects:read']);
  await desktop.goto(`${baseUrl}/cabinet`, { waitUntil: 'domcontentloaded' });

  const launcher = desktop.getByRole('button', { name: 'Открыть ИИ-помощника' });
  await launcher.waitFor();
  await launcher.click();
  const dialog = desktop.getByRole('dialog', { name: 'ИИ-помощник по недвижимости' });
  await dialog.waitFor();
  await assertFocused(desktop, 'textarea');

  const initialBox = await dialog.boundingBox();
  assert.ok(initialBox);
  const title = desktop.getByText('Помощник по недвижимости', { exact: true });
  const titleBox = await title.boundingBox();
  assert.ok(titleBox);
  await desktop.mouse.move(titleBox.x + 20, titleBox.y + 12);
  await desktop.mouse.down();
  await desktop.mouse.move(titleBox.x - 100, titleBox.y - 60, { steps: 5 });
  await desktop.mouse.up();
  const movedBox = await dialog.boundingBox();
  assert.ok(movedBox && movedBox.x < initialBox.x && movedBox.y < initialBox.y);

  await desktop.evaluate(() => {
    const chat = document.querySelector('[data-assistant-chat]');
    if (!(chat instanceof HTMLElement)) throw new Error('ASSISTANT_CHAT_NOT_FOUND');
    chat.style.width = '620px';
    chat.style.height = '700px';
  });
  await desktop.waitForTimeout(50);
  const storedGeometry = await desktop.evaluate(() =>
    Object.keys(localStorage).find((key) => key.startsWith('platforma-assistant-geometry:')),
  );
  assert.ok(storedGeometry);
  await desktop.getByRole('button', { name: 'Сбросить размер и положение' }).click();
  assert.equal(await desktop.evaluate((key) => localStorage.getItem(key), storedGeometry), null);

  await desktop.evaluate(() => {
    history.pushState(null, '', '/objects/zhk-test');
  });
  await desktop.getByRole('button', { name: 'Закрыть помощника' }).click();
  await launcher.click();
  await desktop.getByText('Текущий ЖК', { exact: true }).waitFor();
  await desktop.getByRole('button', { name: 'Убрать контекст «Текущий ЖК»' }).click();
  assert.equal(await desktop.getByText('Текущий ЖК', { exact: true }).count(), 0);

  await desktop.evaluate(() => {
    history.pushState(
      null,
      '',
      '/catalog/comm?developerId=11111111-1111-4111-8111-111111111111&metroStationId=22222222-2222-4222-8222-222222222222&lotRooms=2',
    );
    window.dispatchEvent(new Event('platforma-location-changed'));
  });
  await desktop.getByText('Застройщик из фильтра', { exact: true }).waitFor();

  await desktop.evaluate(() => {
    window.__assistantProgressLabels = [];
    const captureProgress = () => {
      const label = document.querySelector('.assistant-progress')?.textContent?.trim();
      if (label && !window.__assistantProgressLabels.includes(label)) {
        window.__assistantProgressLabels.push(label);
      }
    };
    window.__assistantProgressObserver = new MutationObserver(captureProgress);
    window.__assistantProgressObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    captureProgress();
  });

  await desktop.getByLabel('Сообщение помощнику').fill('Найди квартиру рядом');
  await desktop.getByRole('button', { name: 'Отправить' }).click();
  await desktop.getByText('TEMPORARY_CREATE_ERROR').waitFor();
  await desktop.getByRole('button', { name: 'Повторить отправку' }).click();
  await desktop.getByText('TEMPORARY_ASSISTANT_ERROR').waitFor();
  await desktop.getByRole('button', { name: 'Повторить отправку' }).click();
  await desktop.getByText('Понимаю запрос').waitFor();
  await desktop.getByText('Тестовый помощник получил запрос: «Найди квартиру рядом».').waitFor();
  await desktop.getByRole('heading', { name: 'Лучшие по этим критериям' }).waitFor();
  await desktop.getByText('Всего найдено: 37', { exact: true }).waitFor();
  const exactResultsRegion = desktop.getByRole('region', { name: 'Лучшие по этим критериям' });
  assert.equal(await exactResultsRegion.locator('.assistant-result-card').count(), 3);
  assert.equal(await desktop.getByRole('link', { name: 'ЖК Тест 4' }).count(), 0);
  const showMoreResults = desktop.getByRole('button', { name: 'Показать далее' });
  const showMoreBox = await showMoreResults.boundingBox();
  assert.ok(showMoreBox && showMoreBox.height >= 44);
  assert.ok(await showMoreResults.getAttribute('aria-controls'));
  assert.equal(await showMoreResults.getAttribute('aria-expanded'), null);
  await showMoreResults.focus();
  await desktop.keyboard.press('Enter');
  await desktop.getByRole('link', { name: 'ЖК Тест 8' }).waitFor();
  assert.equal(await exactResultsRegion.locator('.assistant-result-card').count(), 8);
  assert.equal(await showMoreResults.count(), 0);
  assert.equal(
    await desktop.evaluate(() => document.activeElement?.textContent?.trim()),
    'ЖК Тест 4',
  );
  assert.equal(
    await desktop.getByRole('link', { name: 'ЖК Тест', exact: true }).getAttribute('href'),
    '/objects/zhk-test/lots/77777777-7777-4777-8777-777777777777',
  );
  await desktop.getByText('25 000 000 ₽').waitFor();
  await desktop.getByText('обновлено 10 часов назад').first().waitFor();
  assert.equal(await desktop.getByRole('link', { name: 'Презентация проекта' }).getAttribute('href'), '/media/files/88888888-8888-4888-8888-888888888888/content?download=true');
  assert.deepEqual(await desktop.evaluate(() => {
    window.__assistantProgressObserver?.disconnect();
    return window.__assistantProgressLabels;
  }), ['Понимаю запрос', 'Ищу данные', 'Сравниваю варианты', 'Формирую ответ']);
  assert.equal(desktopState.messageIdempotencyKeys.length, 2);
  assert.equal(desktopState.messageIdempotencyKeys[0], desktopState.messageIdempotencyKeys[1]);
  assert.deepEqual(desktopState.messageContexts, [
    {
      kind: 'CATALOG_FILTERS',
      key: 'developerId=11111111-1111-4111-8111-111111111111&metroStationId=22222222-2222-4222-8222-222222222222&lotRooms=2&type=COMMERCIAL',
      label: 'Застройщик из фильтра',
    },
    {
      kind: 'CATALOG_FILTERS',
      key: 'developerId=11111111-1111-4111-8111-111111111111&metroStationId=22222222-2222-4222-8222-222222222222&lotRooms=2&type=COMMERCIAL',
      label: 'Застройщик из фильтра',
    },
  ]);
  assert.equal(desktopState.conversationCreationKeys.length, 2);
  assert.equal(desktopState.conversationCreationKeys[0], desktopState.conversationCreationKeys[1]);

  await desktop.getByRole('button', { name: 'История разговоров' }).click();
  await desktop.getByRole('button', { name: 'Найди квартиру рядом' }).waitFor();
  await desktop.getByRole('button', { name: 'Что известно о Северном саде' }).click();
  await desktop.getByRole('heading', { name: 'Подтверждённые факты' }).waitFor();
  await desktop.getByText('Кирпичные фасады и закрытый двор.').waitFor();
  await desktop.getByRole('heading', { name: 'На официальном сайте застройщика' }).waitFor();
  const officialLotLink = desktop.getByRole('link', { name: '2-комнатная квартира 67 м²' });
  assert.equal(await officialLotLink.getAttribute('href'), 'https://developer.example/apartments/lot-42');
  assert.equal(await officialLotLink.getAttribute('target'), '_blank');
  assert.equal(await officialLotLink.getAttribute('rel'), 'noopener noreferrer');
  await desktop.getByText('23 900 000 ₽').waitFor();
  await desktop.getByText('обновлено 10 часов назад').first().waitFor();
  await desktop.getByRole('button', { name: 'История разговоров' }).click();

  await desktop.evaluate(() => {
    history.pushState(null, '', '/admin');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await desktop.getByText('Недостаточно прав').waitFor();
  await dialog.waitFor();
  await desktop.getByText('Нашёл подтверждённые данные в официальных источниках.').waitFor();
  assert.equal(expectedRetryNetworkErrors, 2);
  assert.deepEqual(consoleIssues, []);

  await desktop.keyboard.press('Escape');
  assert.equal(await dialog.count(), 0);

  const denied = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await installRoutes(denied, createAssistantState(), []);
  await denied.goto(`${baseUrl}/cabinet`, { waitUntil: 'domcontentloaded' });
  await denied.getByRole('heading', { name: 'Assistant User' }).waitFor();
  assert.equal(await denied.getByRole('button', { name: 'Открыть ИИ-помощника' }).count(), 0);
  await denied.close();

  const disabled = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await installRoutes(disabled, createAssistantState({ enabled: false }), ['objects:read']);
  await disabled.goto(`${baseUrl}/cabinet`, { waitUntil: 'domcontentloaded' });
  await disabled.getByRole('heading', { name: 'Assistant User' }).waitFor();
  await disabled.waitForTimeout(100);
  assert.equal(await disabled.getByRole('button', { name: 'Открыть ИИ-помощника' }).count(), 0);
  await disabled.close();

  const mobile = await browser.newPage({ viewport: { width: 375, height: 900 } });
  await installRoutes(mobile, createAssistantState({ conversationPosts: 1, messagePosts: 1 }), ['objects:read']);
  await mobile.goto(`${baseUrl}/objects/zhk-mobile`, { waitUntil: 'domcontentloaded' });
  await mobile.getByRole('button', { name: 'Открыть ИИ-помощника' }).click();
  const mobileDialog = mobile.getByRole('dialog', { name: 'ИИ-помощник по недвижимости' });
  const mobileBox = await mobileDialog.boundingBox();
  assert.ok(mobileBox);
  assert.equal(mobileBox.x, 0);
  assert.equal(mobileBox.y, 0);
  assert.equal(mobileBox.width, 375);
  assert.equal(mobileBox.height, 900);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  const mobileContextCloseBox = await mobile.getByRole('button', { name: 'Убрать контекст «Текущий ЖК»' }).boundingBox();
  const mobileSendBox = await mobile.getByRole('button', { name: 'Отправить' }).boundingBox();
  assert.ok(mobileContextCloseBox && mobileContextCloseBox.width >= 44 && mobileContextCloseBox.height >= 44);
  assert.ok(mobileSendBox && mobileSendBox.width >= 44 && mobileSendBox.height >= 44);
  await mobile.getByLabel('Сообщение помощнику').fill('Найди квартиру рядом');
  await mobile.getByRole('button', { name: 'Отправить' }).click();
  await mobile.getByText('Всего найдено: 37', { exact: true }).waitFor();
  const mobileExactResults = mobile.getByRole('region', { name: 'Лучшие по этим критериям' });
  assert.equal(await mobileExactResults.locator('.assistant-result-card').count(), 3);
  const mobileShowMore = mobile.getByRole('button', { name: 'Показать далее' });
  const mobileShowMoreBox = await mobileShowMore.boundingBox();
  assert.ok(mobileShowMoreBox && mobileShowMoreBox.height >= 44);
  await mobileShowMore.click();
  assert.equal(
    await mobileExactResults.locator('.assistant-result-card').count(),
    8,
  );
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await mobile.close();

  process.stdout.write('ASSISTANT_T01_BROWSER_OK\n');
} finally {
  await browser.close();
}

function createAssistantState(overrides = {}) {
  return {
    enabled: true,
    conversationCreated: false,
    conversationPosts: 0,
    conversationCreationKeys: [],
    runReads: 0,
    messagePosts: 0,
    messageIdempotencyKeys: [],
    messageContexts: [],
    ...overrides,
  };
}

async function installRoutes(page, state, permissions) {
  await page.route('http://localhost:3000/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === '/auth/refresh') {
      await json(route, {
        accessToken: 'assistant-browser-access-token',
        user: {
          id: '11111111-1111-4111-8111-111111111111',
          email: 'assistant-user@example.test',
          name: 'Assistant User',
          brokerPhone: null,
          brokerEmail: null,
          status: 'ACTIVE',
          role: { id: '22222222-2222-4222-8222-222222222222', name: 'user' },
          profilePhotoFile: null,
          permissions,
        },
      });
      return;
    }

    if (path === '/training/config') {
      await json(route, { enabled: false });
      return;
    }

    if (path === '/assistant/config') {
      await json(route, { enabled: state.enabled });
      return;
    }

    if (path === '/assistant/geo/resolve' && request.method() === 'POST') {
      await json(route, { status: 'NOT_APPLICABLE' });
      return;
    }

    if (path === '/assistant/conversations' && request.method() === 'GET') {
      await json(route, {
        items: state.conversationCreated ? [knowledgeConversationSummary(), conversationSummary()] : [],
        nextCursor: null,
      });
      return;
    }

    if (path === '/assistant/conversations' && request.method() === 'POST') {
      state.conversationPosts += 1;
      state.conversationCreationKeys.push(request.headers()['idempotency-key']);
      state.conversationCreated = true;
      if (state.conversationPosts === 1) {
        await json(route, { message: 'TEMPORARY_CREATE_ERROR' }, 503);
        return;
      }
      await json(route, { conversation: conversationDetail([]) }, 201);
      return;
    }

    if (path === '/assistant/conversations/33333333-3333-4333-8333-333333333333/messages') {
      state.messagePosts += 1;
      state.messageIdempotencyKeys.push(request.headers()['idempotency-key']);
      state.messageContexts.push(request.postDataJSON().context);
      if (state.messagePosts === 1) {
        await json(route, { message: 'TEMPORARY_ASSISTANT_ERROR' }, 503);
        return;
      }
      await json(route, { run: runFixture('PENDING', []) }, 202);
      return;
    }

    if (path === '/assistant/runs/44444444-4444-4444-8444-444444444444') {
      state.runReads += 1;
      const definitions = [
        ['UNDERSTANDING', 'Понимаю запрос'],
        ['SEARCHING', 'Ищу данные'],
        ['COMPARING', 'Сравниваю варианты'],
        ['ANSWERING', 'Формирую ответ'],
      ];
      if (state.runReads <= definitions.length) {
        await json(route, {
          run: runFixture('RUNNING', definitions.slice(0, state.runReads)),
        });
        return;
      }
      await json(route, {
        run: runFixture('COMPLETED', definitions, assistantMessage()),
      });
      return;
    }

    if (path === '/assistant/conversations/33333333-3333-4333-8333-333333333333') {
      await json(route, {
        conversation: conversationDetail([
          {
            id: '55555555-5555-4555-8555-555555555555',
            role: 'USER',
            content: 'Найди квартиру рядом',
            context: null,
            createdAt: '2026-08-24T12:00:00.000Z',
          },
          assistantMessage(),
        ]),
      });
      return;
    }

    if (path === '/assistant/conversations/99999999-9999-4999-8999-999999999999') {
      await json(route, {
        conversation: {
          ...knowledgeConversationSummary(),
          messages: [knowledgeAssistantMessage()],
        },
      });
      return;
    }

    await json(route, { message: `Unexpected ${request.method()} ${path}` }, 404);
  });
}

function conversationSummary() {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    title: 'Найди квартиру рядом',
    createdAt: '2026-08-24T12:00:00.000Z',
    updatedAt: '2026-08-24T12:00:01.000Z',
    messagesCount: 2,
  };
}

function conversationDetail(messages) {
  return { ...conversationSummary(), messages };
}

function knowledgeConversationSummary() {
  return {
    id: '99999999-9999-4999-8999-999999999999',
    title: 'Что известно о Северном саде',
    createdAt: '2026-08-24T13:00:00.000Z',
    updatedAt: '2026-08-24T13:00:01.000Z',
    messagesCount: 1,
  };
}

function knowledgeAssistantMessage() {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    role: 'ASSISTANT',
    content: 'Нашёл подтверждённые данные в официальных источниках.',
    context: { kind: 'OBJECT', key: 'severny-sad', label: 'ЖК Северный сад' },
    answer: {
      kind: 'KNOWLEDGE_RESULTS',
      facts: [{
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        label: 'Архитектура',
        value: 'Кирпичные фасады и закрытый двор.',
        freshnessLabel: 'обновлено 10 часов назад',
        isStale: false,
      }],
      externalLots: [{
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        title: '2-комнатная квартира 67 м²',
        subtitle: '2-комнатная · 67 м² · 8 этаж',
        priceRub: 23_900_000,
        availabilityLabel: 'В продаже на официальном сайте',
        freshnessLabel: 'обновлено 10 часов назад',
        isStale: false,
        href: 'https://developer.example/apartments/lot-42',
      }],
    },
    createdAt: '2026-08-24T13:00:01.000Z',
  };
}

function assistantMessage() {
  return {
    id: '66666666-6666-4666-8666-666666666666',
    role: 'ASSISTANT',
    content: 'Тестовый помощник получил запрос: «Найди квартиру рядом».',
    context: null,
    answer: {
      kind: 'SEARCH_RESULTS',
      totalExactResults: 37,
      exactResults: Array.from({ length: 3 }, (_, index) => searchResultCard(index)),
      additionalExactResults: Array.from({ length: 5 }, (_, index) => searchResultCard(index + 3)),
      alternatives: [],
    },
    createdAt: '2026-08-24T12:00:01.000Z',
  };
}

function searchResultCard(index) {
  const unitId = index === 0
    ? '77777777-7777-4777-8777-777777777777'
    : `${String(index).padStart(8, '0')}-7777-4777-8777-${String(index).padStart(12, '0')}`;
  return {
    unitId,
    title: index === 0 ? 'ЖК Тест' : `ЖК Тест ${index + 1}`,
    subtitle: `2-комнатная · ${60 + index} м² · ${8 + index} этаж`,
    priceRub: 25_000_000 + index * 1_000_000,
    availabilityLabel: 'В продаже',
    freshnessLabel: 'обновлено 10 часов назад',
    isStale: false,
    href: index === 0
      ? '/objects/zhk-test/lots/77777777-7777-4777-8777-777777777777'
      : `/objects/zhk-test-${index + 1}/lots/${unitId}`,
    facts: ['Хамовники', 'м. Спортивная', '3 кв. 2027'],
    pdfs: index === 0 ? [{
      title: 'Презентация проекта',
      href: '/media/files/88888888-8888-4888-8888-888888888888/content?download=true',
    }] : [],
    deviations: [],
  };
}

function runFixture(status, progress, message = null) {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    conversationId: '33333333-3333-4333-8333-333333333333',
    status,
    progressEvents: progress.map(([step, label], index) => ({
      step,
      label,
      createdAt: `2026-08-24T12:00:0${index}.000Z`,
    })),
    assistantMessage: message,
    errorCode: null,
    createdAt: '2026-08-24T12:00:00.000Z',
    updatedAt: '2026-08-24T12:00:01.000Z',
    completedAt: status === 'COMPLETED' ? '2026-08-24T12:00:01.000Z' : null,
  };
}

async function assertFocused(page, selector) {
  await page.waitForFunction((expected) => document.activeElement?.matches(expected), selector);
}

async function json(route, body, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}
