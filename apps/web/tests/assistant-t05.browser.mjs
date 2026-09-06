import assert from 'node:assert/strict';

import { chromium } from '@playwright/test';

const baseUrl = process.env.ASSISTANT_T05_WEB_TEST_URL;
if (!baseUrl) throw new Error('ASSISTANT_T05_WEB_TEST_URL is required');
const apiBaseUrl = process.env.ASSISTANT_T05_API_TEST_URL ?? 'http://localhost:3000';

const LINE_LANDMARK_ID = '55555555-5555-4555-8555-555555555555';
const AREA_LANDMARK_ID = '66666666-6666-4666-8666-666666666666';
const BELORUSSKY_LANDMARK_ID = '88888888-8888-4888-8888-888888888888';
const PAVELETSKAYA_PLAZA_LANDMARK_ID = '99999999-9999-4999-8999-999999999991';
const COMPOSITE_BELORUSSKY_LANDMARK_ID = '99999999-9999-4999-8999-999999999992';

const browser = await chromium.launch({ headless: true });

try {
  await verifyDesktopGeoFlow();
  await verifyCompositeGeoFlow();
  await verifyDesktopLineGeometry();
  await verifyRenderedMarkerVariants();
  await verifyMobilePickerAndAreaGeometry();
  process.stdout.write('ASSISTANT_T05_BROWSER_OK\n');
} finally {
  await browser.close();
}

async function verifyCompositeGeoFlow() {
  const context = await browser.newContext({ viewport: { width: 390, height: 700 } });
  const page = await context.newPage();
  const state = createState();
  await disableMapTiles(page);
  await installRoutes(page, state);

  try {
    await page.goto(`${baseUrl}/cabinet`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Открыть ИИ-помощника' }).click();
    const input = page.getByLabel('Сообщение помощнику');
    const genericContent = 'у воды у реки возле парка такого-то возле моста около школы такой-то';
    await input.fill(genericContent);
    await page.getByRole('button', { name: 'Отправить' }).click();
    await page.getByText('Уточните названия ориентиров.', { exact: true }).waitFor();
    assert.equal(state.messageBodies.length, 1, 'raw ambiguous composite must start one backend run');
    assert.equal(state.messageBodies[0].geo, null);
    assert.equal(state.resolveBodies.length, 0, 'raw submit must not call the browser geo resolver');

    const namedContent = 'возле Павелецкой Плаза около Белорусского вокзала';
    await input.fill(namedContent);
    await page.getByRole('button', { name: 'Отправить' }).click();
    await page.getByText('ЖК Радиус 1', { exact: true }).waitFor();
    assert.equal(state.messageBodies.length, 2, 'raw composite must start exactly one additional run');
    assert.equal(state.messageBodies[1].geo, null);
    assert.equal(state.resolveBodies.length, 0);
    assert.equal(await page.locator('[data-assistant-geo-chip]').count(), 0);
    assert.equal(
      await page.locator('.assistant-geo-result-map').getAttribute('data-geo-constraint-count'),
      '2',
    );
  } finally {
    await context.close();
  }
}

async function verifyDesktopGeoFlow() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const state = createState();
  const runtimeIssues = [];
  const requestedUrls = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') runtimeIssues.push(message.text());
  });
  page.on('pageerror', (error) => runtimeIssues.push(error.message));
  page.on('request', (request) => requestedUrls.push(request.url()));
  await disableMapTiles(page);
  await installRoutes(page, state);

  try {
    await page.goto(`${baseUrl}/cabinet`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Открыть ИИ-помощника' }).click();
    const dialog = page.getByRole('dialog', { name: 'ИИ-помощник по недвижимости' });
    const input = page.getByLabel('Сообщение помощнику');
    await input.fill('Найди квартиры до 25 млн');
    await page.getByRole('button', { name: 'Выбрать точку на карте' }).click();

    const picker = page.getByRole('region', { name: 'Выбор точки и радиуса' });
    await picker.waitFor();
    const pickerDialogBox = await dialog.boundingBox();
    assert.ok(pickerDialogBox && pickerDialogBox.width >= 700 && pickerDialogBox.height >= 700);
    await picker.getByRole('button', { name: '3 км' }).click();
    assert.equal(state.messageBodies.length, 0, 'map draft must not start property search');
    await picker.getByRole('button', { name: 'Отмена' }).click();
    assert.equal(await input.inputValue(), 'Найди квартиры до 25 млн');
    assert.equal(state.messageBodies.length, 0, 'cancel must not start property search');

    await input.fill('Скрытый запрос после Escape');
    await page.getByRole('button', { name: 'Выбрать точку на карте' }).click();
    await page.keyboard.press('Escape');
    await picker.waitFor({ state: 'hidden' });
    await input.fill('');
    await page.getByRole('button', { name: 'Выбрать точку на карте' }).click();
    await picker.getByRole('button', { name: 'Подтвердить точку' }).click();
    await page.waitForTimeout(200);
    assert.equal(state.messageBodies.length, 0, 'Escape must discard the hidden pending draft');
    await page.getByRole('button', { name: 'Убрать геопоиск' }).click();

    await input.fill('');
    await page.getByRole('button', { name: 'Выбрать точку на карте' }).click();
    await picker.getByRole('button', { name: 'Подтвердить точку' }).click();
    assert.equal(state.messageBodies.length, 0, 'cancelled draft must not survive as hidden pending state');
    await page.getByRole('button', { name: 'Убрать геопоиск' }).click();
    await input.fill('Найди квартиры до 25 млн');

    await page.getByRole('button', { name: 'Выбрать точку на карте' }).click();
    await picker.getByRole('button', { name: '3 км' }).click();
    await picker.getByRole('button', { name: 'Подтвердить точку' }).click();
    await page.getByText('ЖК Радиус 1', { exact: true }).waitFor();
    assert.equal(state.messageBodies.length, 1, 'confirm must start exactly one run');
    assert.equal(state.resolveBodies.length, 0, 'manual picker must bypass geocoder');
    assert.deepEqual(state.messageBodies[0].geo, {
      referenceType: 'MANUAL_POINT',
      point: { latitude: 55.751244, longitude: 37.618423, label: 'Точка на карте' },
      mode: 'NEAR',
      distanceMeters: 3_000,
    });

    await page.getByText('Точка на карте · до 3 км', { exact: true }).waitFor();
    await page.getByText('650 м по прямой', { exact: true }).waitFor();
    await page.getByText('Карта временно отключена', { exact: true }).waitFor();

    await page.getByRole('button', { name: 'Изменить точку и расстояние' }).click();
    await picker.getByRole('button', { name: '2 км' }).click();
    await picker.getByRole('button', { name: 'Отмена' }).click();
    await page.getByText('Точка на карте · до 3 км', { exact: true }).waitFor();
    assert.equal(state.messageBodies.length, 1);

    await page.getByRole('button', { name: 'Изменить точку и расстояние' }).click();
    await picker.getByRole('button', { name: '5 км' }).click();
    await picker.getByRole('button', { name: 'Подтвердить точку' }).click();
    await page.getByText('Точка на карте · до 5 км', { exact: true }).waitFor();
    assert.equal(state.messageBodies.length, 2);
    assert.equal(state.resolveBodies.length, 0, 'moving confirmed manual anchor must bypass geocoder');

    await page.getByRole('button', { name: 'Убрать геопоиск' }).click();
    await input.fill('Найди в радиусе 2 км от Плотинки ambiguous');
    await page.getByRole('button', { name: 'Отправить' }).click();
    await page.getByText('Уточните, какую Плотинку вы имеете в виду.', { exact: true }).waitFor();
    assert.equal(state.messageBodies.length, 3);
    assert.equal(state.messageBodies.at(-1).geo, null);
    assert.equal(state.resolveBodies.length, 0);

    await input.fill('Найди в радиусе 2 км от geocoder unavailable');
    await page.getByRole('button', { name: 'Отправить' }).click();
    await page.getByText('Геоданные сейчас недоступны. Попробуйте позже.', { exact: true }).last().waitFor();
    assert.equal(state.messageBodies.length, 4);
    assert.equal(state.messageBodies.at(-1).geo, null);

    state.failNextPropertySearch = true;
    await input.fill('Найди рядом с ручной точкой');
    await page.getByRole('button', { name: 'Выбрать точку на карте' }).click();
    await picker.getByRole('button', { name: 'Подтвердить точку' }).click();
    await page.getByText('PROPERTY_SEARCH_UNAVAILABLE', { exact: true }).waitFor();
    await page.getByText('Точка на карте · до 2 км', { exact: true }).waitFor();
    assert.equal(state.messageBodies.length, 5);

    await page.getByRole('button', { name: 'Убрать геопоиск' }).click();
    const belorussky = 'Найди в 900 м от Белорусского вокзала';
    await input.fill(belorussky);
    await page.getByRole('button', { name: 'Отправить' }).click();
    await page.getByRole('region', { name: 'Результаты до 900 м от точки Белорусский вокзал' }).waitFor();
    assert.equal(state.messageBodies.at(-1).geo, null);
    assert.equal(state.resolveBodies.length, 0);

    const missingBelorussky = 'Найди в 900 м от Белорусского вокзала not found';
    await input.fill(missingBelorussky);
    await page.getByRole('button', { name: 'Отправить' }).click();
    await page.getByText('Геоданные сейчас недоступны. Попробуйте позже.', { exact: true }).last().waitFor();
    assert.equal(state.messageBodies.at(-1).geo, null);

    const resolverErrorContent = 'Найди внутри района resolver network error';
    await input.fill(resolverErrorContent);
    await page.getByRole('button', { name: 'Отправить' }).click();
    await page.getByText('Геоданные сейчас недоступны. Попробуйте позже.', { exact: true }).last().waitFor();
    assert.equal(state.messageBodies.at(-1).content, resolverErrorContent);
    assert.equal(state.messageBodies.at(-1).geo, null);

    assert.equal(
      requestedUrls.some((url) => /locationiq|api-maps\.yandex|tiles\.openfreemap/iu.test(url)),
      false,
    );
    assert.deepEqual(runtimeIssues.filter((message) => !message.includes('503 (Service Unavailable)')), []);
  } finally {
    await context.close();
  }
}

async function verifyDesktopLineGeometry() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const state = createState();
  const runtimeIssues = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') runtimeIssues.push(message.text());
  });
  page.on('pageerror', (error) => runtimeIssues.push(error.message));
  await enableFixtureMap(page);
  await installRoutes(page, state);

  try {
    await page.goto(`${baseUrl}/cabinet`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Открыть ИИ-помощника' }).click();
    const content = 'Найди мне квартиру возле Садового кольца, например, однокомнатную, бюджет до 35 миллионов.';
    await page.getByLabel('Сообщение помощнику').fill(content);
    await page.getByRole('button', { name: 'Отправить' }).click();

    assert.equal(await page.locator('[data-assistant-geo-picker]').count(), 0, 'default must not open radius dialog');
    const map = page.getByRole('region', {
      name: 'Результаты до 5 км от всей дороги Садовое кольцо',
    });
    await map.locator('canvas').waitFor();
    assert.deepEqual(state.resolveBodies, []);
    assert.equal(state.messageBodies.length, 1);
    assert.equal(state.messageBodies[0].content, content, 'rooms and budget must survive backend geo resolution');
    assert.equal(state.messageBodies[0].geo, null);
    const geometry = page.locator('.assistant-geo-result-map');
    assert.equal(await geometry.getAttribute('data-reference-geometry'), 'LineString');
    assert.equal(await geometry.getAttribute('data-search-area-geometry'), 'Polygon');
    assert.equal(await page.locator('.map-price-marker--anchor').count(), 0);
    await page.locator('[aria-label="Обозначения карты"]').getByText('Ориентир', { exact: true }).waitFor();
    assert.deepEqual(runtimeIssues.filter((message) => !message.includes('GL Driver Message')), []);
  } finally {
    await context.close();
  }
}

async function verifyRenderedMarkerVariants() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const state = createState({ markerSequence: true });
  await enableFixtureMap(page);
  await installRoutes(page, state);

  try {
    await page.goto(`${baseUrl}/cabinet`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Открыть ИИ-помощника' }).click();
    const input = page.getByLabel('Сообщение помощнику');
    await input.fill('Найди лучшие квартиры');
    await page.getByRole('button', { name: 'Выбрать точку на карте' }).click();
    await page.getByRole('button', { name: 'Подтвердить точку' }).click();
    await page.locator('.map-price-marker--primary').first().waitFor();
    assert.equal(await page.locator('.map-price-marker--primary').count(), 3);

    await input.fill('Покажи ближайшие альтернативы');
    await page.getByRole('button', { name: 'Отправить' }).click();
    await page.locator('.map-price-marker--alternative').first().waitFor();
    assert.equal(await page.locator('.map-price-marker--primary').count(), 3);
    assert.equal(await page.locator('.map-price-marker--alternative').count(), 2);
    const [primaryColor, alternativeColor] = await Promise.all([
      page.locator('.map-price-marker--primary .map-price-marker-dot').first()
        .evaluate((element) => getComputedStyle(element).backgroundColor),
      page.locator('.map-price-marker--alternative .map-price-marker-dot').first()
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    ]);
    assert.notEqual(primaryColor, alternativeColor);
  } finally {
    await context.close();
  }
}

async function verifyMobilePickerAndAreaGeometry() {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page = await context.newPage();
  const state = createState();
  await enableFixtureMap(page);
  await installRoutes(page, state);

  try {
    await page.goto(`${baseUrl}/cabinet`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Открыть ИИ-помощника' }).click();
    await page.getByLabel('Сообщение помощнику').fill('Найди квартиру');
    await page.getByRole('button', { name: 'Выбрать точку на карте' }).click();
    const dialog = page.getByRole('dialog', { name: 'ИИ-помощник по недвижимости' });
    const box = await dialog.boundingBox();
    assert.deepEqual(box && {
      x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height),
    }, { x: 0, y: 0, width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    for (const label of ['1 км', '2 км', '3 км', '5 км']) {
      const control = await page.getByRole('button', { name: label }).boundingBox();
      assert.ok(control && control.width >= 44 && control.height >= 44);
    }
    await page.getByRole('button', { name: 'Отмена' }).click();

    const content = 'Покажи квартиры внутри района Арбат';
    await page.getByLabel('Сообщение помощнику').fill(content);
    await page.getByRole('button', { name: 'Отправить' }).click();
    assert.equal(await page.locator('[data-assistant-geo-picker]').count(), 0);
    const resultMap = page.getByRole('region', { name: 'Результаты внутри области Арбат' });
    await resultMap.locator('canvas').waitFor();
    assert.equal(state.messageBodies.length, 1);
    assert.equal(state.messageBodies[0].content, content);
    assert.equal(state.messageBodies[0].geo, null);
    assert.equal(state.resolveBodies.length, 0);
    const geometry = page.locator('.assistant-geo-result-map');
    assert.equal(await geometry.getAttribute('data-reference-geometry'), 'Polygon');
    assert.equal(await geometry.getAttribute('data-search-area-geometry'), 'Polygon');
    assert.equal(await page.locator('.map-price-marker--anchor').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

    await page.getByLabel('Сообщение помощнику').fill('Покажи квартиры внутри района Неизвестный');
    await page.getByRole('button', { name: 'Отправить' }).click();
    await page.getByText('Геоданные сейчас недоступны. Попробуйте позже.', { exact: true }).waitFor();
    assert.equal(state.messageBodies.length, 2, 'unresolved INSIDE must start a fail-closed backend run');
    assert.equal(state.messageBodies.at(-1).geo, null);
  } finally {
    await context.close();
  }
}

async function disableMapTiles(page) {
  await page.route(`${baseUrl}/runtime-config.js`, async (route) => {
    await route.fulfill({
      body: 'window.__PLATFORMA_RUNTIME_CONFIG__ = { mapProviderEnabled: false };\n',
      contentType: 'text/javascript; charset=utf-8',
      status: 200,
    });
  });
}

async function enableFixtureMap(page) {
  await page.route(`${baseUrl}/runtime-config.js`, async (route) => {
    await route.fulfill({
      body: `window.__PLATFORMA_RUNTIME_CONFIG__ = ${JSON.stringify({
        mapProviderEnabled: true,
        mapStyleUrl: 'https://map-fixtures.test/style.json',
      })};\n`,
      contentType: 'text/javascript; charset=utf-8',
      status: 200,
    });
  });
  await page.route('https://map-fixtures.test/style.json', async (route) => {
    await json(route, { version: 8, sources: {}, layers: [] });
  });
}

function createState(overrides = {}) {
  return {
    conversationCreated: false,
    messageBodies: [],
    resolveBodies: [],
    messages: [],
    failNextPropertySearch: false,
    markerSequence: false,
    ...overrides,
  };
}

async function installRoutes(page, state) {
  await page.route(`${apiBaseUrl}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/auth/refresh') {
      await json(route, {
        accessToken: 'assistant-t05-browser-token',
        user: {
          id: '11111111-1111-4111-8111-111111111111',
          email: 'assistant-t05@example.test',
          name: 'Assistant T05',
          brokerPhone: null,
          brokerEmail: null,
          status: 'ACTIVE',
          role: { id: '22222222-2222-4222-8222-222222222222', name: 'user' },
          profilePhotoFile: null,
          permissions: ['objects:read'],
        },
      });
      return;
    }
    if (path === '/training/config') {
      await json(route, { enabled: false });
      return;
    }
    if (path === '/assistant/config') {
      await json(route, { enabled: true });
      return;
    }
    if (path === '/assistant/conversations' && request.method() === 'GET') {
      await json(route, { items: [], nextCursor: null });
      return;
    }
    if (path === '/assistant/conversations' && request.method() === 'POST') {
      state.conversationCreated = true;
      await json(route, { conversation: conversation(state.messages) }, 201);
      return;
    }
    if (path === '/assistant/geo/resolve' && request.method() === 'POST') {
      const body = request.postDataJSON();
      state.resolveBodies.push(body);
      if (body.content === 'у воды у реки возле парка такого-то возле моста около школы такой-то') {
        await json(route, {
          status: 'COMPOSITE',
          operator: 'ALL',
          constraints: [
            ['воды', 'вода'],
            ['реки', 'река'],
            ['парка такого-то', 'парк такого-то'],
            ['моста', 'мост'],
            ['школы такой-то', 'школа такой-то'],
          ].map(([sourceText, placeQuery], index) => ({
            status: 'REFINE_REQUIRED',
            slotId: `geo-${index + 1}`,
            sourceText,
            sourceSpan: span(body.content, index === 0 ? 'у воды' : `${index === 1 ? 'у' : index === 2 ? 'возле' : index === 3 ? 'возле' : 'около'} ${sourceText}`),
            mode: 'NEAR',
            placeQuery,
            actions: ['REFINE', 'MANUAL'],
          })),
        });
        return;
      }
      if (body.content === 'возле Павелецкой Плаза около Белорусского вокзала') {
        await json(route, {
          status: 'COMPOSITE',
          operator: 'ALL',
          constraints: [
            {
              status: 'RESOLVED',
              slotId: 'geo-1',
              sourceText: 'Павелецкой Плаза',
              sourceSpan: span(body.content, 'возле Павелецкой Плаза'),
              mode: 'NEAR',
              placeQuery: 'Павелецкая Плаза',
              candidates: [{
                id: '99999999-9999-4999-8999-999999999991',
                label: 'Павелецкая Плаза',
                kind: 'POINT',
                mode: 'NEAR',
                distanceMeters: 2_000,
                point: { latitude: 55.7312, longitude: 37.6364 },
                city: 'Москва',
                countryCode: 'ru',
                source: 'PLACE',
              }],
            },
            {
              status: 'RESOLVED',
              slotId: 'geo-2',
              sourceText: 'Белорусского вокзала',
              sourceSpan: span(body.content, 'около Белорусского вокзала'),
              mode: 'NEAR',
              placeQuery: 'Белорусский вокзал',
              candidates: [{
                id: '99999999-9999-4999-8999-999999999992',
                label: 'Белорусский вокзал',
                kind: 'POINT',
                mode: 'NEAR',
                distanceMeters: 2_000,
                point: { latitude: 55.7763, longitude: 37.5801 },
                city: 'Москва',
                countryCode: 'ru',
                source: 'PLACE',
              }],
            },
          ],
        });
        return;
      }
      if (body.content.includes('900 м от Белорусского вокзала') && body.content.includes('not found')) {
        await json(route, {
          status: 'NOT_FOUND',
          slotId: 'geo-1',
          sourceText: 'Белорусского вокзала not found',
          sourceSpan: span(body.content, 'в 900 м от Белорусского вокзала not found'),
          mode: 'NEAR',
          distanceMeters: 900,
          placeQuery: 'Белорусский вокзал not found',
          actions: ['MANUAL', 'REFINE'],
        });
        return;
      }
      if (body.content.includes('900 м от Белорусского вокзала')) {
        await json(route, {
          status: 'RESOLVED',
          slotId: 'geo-1',
          sourceText: 'Белорусского вокзала',
          sourceSpan: span(body.content, 'в 900 м от Белорусского вокзала'),
          mode: 'NEAR',
          distanceMeters: 900,
          placeQuery: 'Белорусский вокзал',
          candidates: [{
            id: BELORUSSKY_LANDMARK_ID,
            label: 'Белорусский вокзал',
            kind: 'POINT',
            mode: 'NEAR',
            distanceMeters: 900,
            point: { latitude: 55.7763, longitude: 37.5801 },
            city: 'Москва',
            countryCode: 'ru',
            source: 'PLACE',
          }],
        });
        return;
      }
      if (body.content.includes('geocoder unavailable')) {
        await json(route, {
          status: 'UNAVAILABLE',
          slotId: 'geo-1',
          sourceText: 'geocoder unavailable',
          sourceSpan: span(body.content, 'в радиусе 2 км от geocoder unavailable'),
          mode: 'NEAR',
          distanceMeters: 2_000,
          placeQuery: 'geocoder unavailable',
          actions: ['MANUAL', 'REFINE'],
        });
        return;
      }
      if (body.content.includes('resolver network error')) {
        await json(route, { message: 'GEOCODER_UNAVAILABLE' }, 503);
        return;
      }
      if (body.content.includes('Садового кольца')) {
        await json(route, {
          status: 'RESOLVED',
          slotId: 'geo-1',
          sourceText: 'Садового кольца',
          sourceSpan: span(body.content, 'возле Садового кольца'),
          mode: 'NEAR',
          placeQuery: 'Садовое кольцо',
          candidates: [{
            id: LINE_LANDMARK_ID,
            label: 'Садовое кольцо',
            kind: 'LINE',
            mode: 'NEAR',
            distanceMeters: 5_000,
            city: 'Москва',
            countryCode: 'ru',
            source: 'PLACE',
          }],
        });
        return;
      }
      if (body.content.includes('внутри района Арбат')) {
        await json(route, {
          status: 'RESOLVED',
          slotId: 'geo-1',
          sourceText: 'района Арбат',
          sourceSpan: span(body.content, 'внутри района Арбат'),
          mode: 'INSIDE',
          placeQuery: 'Арбат',
          candidates: [{
            id: AREA_LANDMARK_ID,
            label: 'район Арбат',
            kind: 'AREA',
            mode: 'INSIDE',
            city: 'Москва',
            countryCode: 'ru',
            source: 'PLACE',
          }],
        });
        return;
      }
      if (body.content.includes('внутри района Неизвестный')) {
        await json(route, {
          status: 'NOT_FOUND',
          slotId: 'geo-1',
          sourceText: 'района Неизвестный',
          sourceSpan: span(body.content, 'внутри района Неизвестный'),
          mode: 'INSIDE',
          placeQuery: 'район Неизвестный',
          actions: ['MANUAL', 'REFINE'],
        });
        return;
      }
      if (!body.content.includes('Плотинки ambiguous')) {
        await json(route, { status: 'NOT_APPLICABLE' });
        return;
      }
      await json(route, {
        status: 'AMBIGUOUS',
        slotId: 'geo-1',
        sourceText: 'Плотинки ambiguous',
        sourceSpan: { start: 6, end: body.content.length },
        mode: 'NEAR',
        distanceMeters: 2_000,
        placeQuery: 'Плотинка',
        candidates: [1, 2, 3].map((value) => ({
          id: `77777777-7777-4777-8777-${String(value).padStart(12, '0')}`,
          label: `Плотинка · вариант ${value}`,
          kind: 'POINT',
          mode: 'NEAR',
          distanceMeters: 2_000,
          point: {
            latitude: 56.837 + value * 0.001,
            longitude: 60.603 + value * 0.001,
          },
          city: 'Екатеринбург',
          countryCode: 'ru',
          source: 'PLACE',
        })),
      });
      return;
    }
    if (path === '/assistant/conversations/33333333-3333-4333-8333-333333333333/messages') {
      const body = request.postDataJSON();
      state.messageBodies.push(body);
      if (state.failNextPropertySearch) {
        state.failNextPropertySearch = false;
        await json(route, { message: 'PROPERTY_SEARCH_UNAVAILABLE' }, 503);
        return;
      }
      const mode = state.markerSequence && state.messageBodies.length > 1 ? 'ALTERNATIVE' : 'PRIMARY';
      const resultCount = state.markerSequence ? (mode === 'PRIMARY' ? 3 : 2) : 1;
      const responseMessage = assistantMessage(body, mode, resultCount);
      state.messages.push(userMessage(body), responseMessage);
      await json(route, { run: runFixture(responseMessage) }, 202);
      return;
    }
    if (path === '/assistant/conversations/33333333-3333-4333-8333-333333333333') {
      await json(route, { conversation: conversation(state.messages) });
      return;
    }
    await json(route, { message: `Unexpected ${request.method()} ${path}` }, 404);
  });
}

function span(content, clause) {
  const start = content.indexOf(clause);
  assert.notEqual(start, -1, `missing clause: ${clause}`);
  return { start, end: start + clause.length };
}

function conversation(messages) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    title: 'Geo search',
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:01.000Z',
    messagesCount: messages.length,
    messages,
  };
}

function userMessage(body) {
  return {
    id: crypto.randomUUID(),
    role: 'USER',
    content: body.content,
    context: body.context ?? null,
    geo: body.geo ? materializeGeo(body.geo) : null,
    answer: null,
    createdAt: '2026-08-26T00:00:00.000Z',
  };
}

function assistantMessage(body, mode = 'PRIMARY', resultCount = 1) {
  if (!body.geo && body.content === 'у воды у реки возле парка такого-то возле моста около школы такой-то') {
    return assistantStatusMessage('Уточните названия ориентиров.', {
      kind: 'CLARIFICATION',
      reason: 'AMBIGUOUS_PLACE',
    });
  }
  if (!body.geo && body.content.includes('Плотинки ambiguous')) {
    return assistantStatusMessage('Уточните, какую Плотинку вы имеете в виду.', {
      kind: 'CLARIFICATION',
      reason: 'AMBIGUOUS_PLACE',
    });
  }
  if (!body.geo && (
    body.content.includes('geocoder unavailable')
    || body.content.includes('not found')
    || body.content.includes('resolver network error')
    || body.content.includes('внутри района Неизвестный')
  )) {
    return assistantStatusMessage('Геоданные сейчас недоступны. Попробуйте позже.', {
      kind: 'UNAVAILABLE',
      reason: 'DATA',
    });
  }
  const canonicalGeo = materializeGeo(body.geo ?? inferRawGeo(body.content));
  const composite = canonicalGeo.operator === 'ALL';
  const primaryGeo = composite ? canonicalGeo.constraints[0] : canonicalGeo;
  const unitIds = mode === 'PRIMARY'
    ? [
        '70000001-7000-4000-8000-700000000001',
        '70000002-7000-4000-8000-700000000002',
        '70000003-7000-4000-8000-700000000003',
      ]
    : [
        '80000001-8000-4000-8000-800000000001',
        '80000002-8000-4000-8000-800000000002',
      ];
  const results = unitIds.slice(0, resultCount).map((unitId, index) => {
    const distanceMeters = !composite && canonicalGeo.mode === 'NEAR' ? 650 + index * 150 : undefined;
    return {
      unitId,
      title: `ЖК Радиус ${index + 1}`,
      subtitle: '2-комнатная · 60 м²',
      priceRub: 20_000_000 + index * 1_000_000,
      availabilityLabel: 'В продаже',
      freshnessLabel: 'обновлено менее часа назад',
      isStale: false,
      href: `/objects/geo/lots/${unitId}`,
      facts: [],
      pdfs: [],
      deviations: mode === 'ALTERNATIVE' ? [{ type: 'BUDGET', label: 'Выше бюджета' }] : [],
      ...(distanceMeters === undefined ? {} : { distanceMeters }),
    };
  });
  const geometry = composite
    ? null
    : geometryFixture(canonicalGeo);
  const markerOrigin = primaryGeo.kind === 'POINT'
    ? primaryGeo.point
    : primaryGeo.kind === 'LINE'
      ? { latitude: 55.75, longitude: 37.62 }
      : { latitude: 55.752, longitude: 37.594 };
  return {
    id: crypto.randomUUID(),
    role: 'ASSISTANT',
    content: 'Нашёл предложения в заданном радиусе.',
    context: null,
    geo: null,
    answer: {
      kind: 'SEARCH_RESULTS',
      exactResults: mode === 'PRIMARY' ? results : [],
      alternatives: mode === 'ALTERNATIVE' ? results : [],
      geo: composite ? {
        operator: 'ALL',
        constraints: canonicalGeo.constraints.map((constraint) => ({
          ...constraint,
          ...geometryFixture(constraint),
        })),
        markers: results.map((result, index) => ({
          unitId: result.unitId,
          latitude: markerOrigin.latitude + index * 0.001,
          longitude: markerOrigin.longitude + index * 0.001,
          kind: mode,
        })),
      } : {
        ...canonicalGeo,
        ...geometry,
        markers: results.map((result, index) => ({
          unitId: result.unitId,
          latitude: markerOrigin.latitude + index * 0.001,
          longitude: markerOrigin.longitude + index * 0.001,
          ...(result.distanceMeters === undefined ? {} : { distanceMeters: result.distanceMeters }),
          kind: mode,
        })),
      },
    },
    createdAt: '2026-08-26T00:00:01.000Z',
  };
}

function assistantStatusMessage(content, answer) {
  return {
    id: crypto.randomUUID(),
    role: 'ASSISTANT',
    content,
    context: null,
    geo: null,
    answer,
    createdAt: '2026-08-26T00:00:01.000Z',
  };
}

function inferRawGeo(content) {
  if (content === 'возле Павелецкой Плаза около Белорусского вокзала') {
    return {
      operator: 'ALL',
      constraints: [
        {
          referenceType: 'LANDMARK',
          landmarkId: PAVELETSKAYA_PLAZA_LANDMARK_ID,
          mode: 'NEAR',
          distanceMeters: 2_000,
        },
        {
          referenceType: 'LANDMARK',
          landmarkId: COMPOSITE_BELORUSSKY_LANDMARK_ID,
          mode: 'NEAR',
          distanceMeters: 2_000,
        },
      ],
    };
  }
  if (content.includes('Садового кольца')) {
    return {
      referenceType: 'LANDMARK',
      landmarkId: LINE_LANDMARK_ID,
      mode: 'NEAR',
      distanceMeters: 5_000,
    };
  }
  if (content.includes('внутри района Арбат')) {
    return {
      referenceType: 'LANDMARK',
      landmarkId: AREA_LANDMARK_ID,
      mode: 'INSIDE',
    };
  }
  if (content.includes('Белорусского вокзала')) {
    return {
      referenceType: 'LANDMARK',
      landmarkId: BELORUSSKY_LANDMARK_ID,
      mode: 'NEAR',
      distanceMeters: 900,
    };
  }
  return {
    referenceType: 'MANUAL_POINT',
    point: { latitude: 55.751244, longitude: 37.618423, label: 'Точка на карте' },
    mode: 'NEAR',
    distanceMeters: 2_000,
  };
}

function materializeGeo(geo) {
  if (geo.operator === 'ALL') {
    return {
      operator: 'ALL',
      constraints: geo.constraints.map(materializeGeo),
    };
  }
  if (geo.referenceType === 'MANUAL_POINT') {
    return {
      kind: 'POINT',
      mode: 'NEAR',
      label: geo.point.label ?? 'Точка на карте',
      point: { latitude: geo.point.latitude, longitude: geo.point.longitude },
      distanceMeters: geo.distanceMeters ?? 2_000,
      source: 'MANUAL',
    };
  }
  if (geo.landmarkId === LINE_LANDMARK_ID) {
    return {
      kind: 'LINE',
      mode: 'NEAR',
      label: 'Садовое кольцо',
      landmarkId: LINE_LANDMARK_ID,
      distanceMeters: geo.distanceMeters ?? 5_000,
      source: 'LANDMARK',
    };
  }
  if (geo.landmarkId === AREA_LANDMARK_ID) {
    return geo.mode === 'INSIDE'
      ? {
          kind: 'AREA',
          mode: 'INSIDE',
          label: 'Арбат',
          landmarkId: AREA_LANDMARK_ID,
          source: 'LANDMARK',
        }
      : {
          kind: 'AREA',
          mode: 'NEAR',
          label: 'Арбат',
          landmarkId: AREA_LANDMARK_ID,
          distanceMeters: geo.distanceMeters ?? 5_000,
          source: 'LANDMARK',
        };
  }
  if (geo.landmarkId === PAVELETSKAYA_PLAZA_LANDMARK_ID) {
    return {
      kind: 'POINT',
      mode: 'NEAR',
      label: 'Павелецкая Плаза',
      landmarkId: PAVELETSKAYA_PLAZA_LANDMARK_ID,
      point: { latitude: 55.7312, longitude: 37.6364 },
      distanceMeters: geo.distanceMeters ?? 2_000,
      source: 'LANDMARK',
    };
  }
  if (geo.landmarkId === COMPOSITE_BELORUSSKY_LANDMARK_ID || geo.landmarkId === BELORUSSKY_LANDMARK_ID) {
    return {
      kind: 'POINT',
      mode: 'NEAR',
      label: 'Белорусский вокзал',
      landmarkId: geo.landmarkId,
      point: { latitude: 55.7763, longitude: 37.5801 },
      distanceMeters: geo.distanceMeters ?? 2_000,
      source: 'LANDMARK',
    };
  }
  if (geo.referenceType === 'LANDMARK') {
    const value = Number.parseInt(geo.landmarkId.slice(-1), 10);
    return {
      kind: 'POINT',
      mode: 'NEAR',
      label: `Плотинка · вариант ${value}`,
      landmarkId: geo.landmarkId,
      point: { latitude: 56.837 + value * 0.001, longitude: 60.603 + value * 0.001 },
      distanceMeters: geo.distanceMeters ?? 2_000,
      source: 'LANDMARK',
    };
  }
  return geo;
}

function geometryFixture(geo) {
  if (geo.kind === 'LINE') {
    return {
      referenceGeometry: {
        type: 'LineString',
        coordinates: [[37.58, 55.73], [37.60, 55.76], [37.64, 55.76], [37.66, 55.73]],
      },
      searchArea: {
        type: 'Polygon',
        coordinates: [[[37.52, 55.69], [37.72, 55.69], [37.72, 55.81], [37.52, 55.81], [37.52, 55.69]]],
      },
    };
  }
  if (geo.kind === 'AREA') {
    const area = {
      type: 'Polygon',
      coordinates: [[[37.57, 55.74], [37.61, 55.74], [37.61, 55.765], [37.57, 55.765], [37.57, 55.74]]],
    };
    return { referenceGeometry: area, searchArea: area };
  }
  return {
    referenceGeometry: {
      type: 'Point',
      coordinates: [geo.point.longitude, geo.point.latitude],
    },
    searchArea: {
      type: 'Polygon',
      coordinates: [[[37.60, 55.74], [37.64, 55.74], [37.64, 55.77], [37.60, 55.74]]],
    },
  };
}

function runFixture(message) {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    conversationId: '33333333-3333-4333-8333-333333333333',
    status: 'COMPLETED',
    progressEvents: [],
    assistantMessage: message,
    errorCode: null,
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:01.000Z',
    completedAt: '2026-08-26T00:00:01.000Z',
  };
}

async function json(route, body, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}
