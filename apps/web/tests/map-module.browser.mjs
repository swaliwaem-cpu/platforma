import assert from 'node:assert/strict';

import { chromium } from '@playwright/test';

const baseUrl = process.env.MAP_WEB_TEST_URL;
const vectorTileFixture = Buffer.from(
  'GmN4AgoGcG9pbnRzKIAgEhMSCAAAAQECAgMDGAEiBQmAIIAgGgRuYW1lGgVjbGFzcxoIc3ViY2xhc3MaBHJhbmsiCQoHZml4dHVyZSIJCgdyYWlsd2F5IggKBnN1YndheSICKAEa5AF4AgoDcG9pKIAgEhMSCAAAAQECAgMDGAEiBQnoIIQgEhMSCAAEAQECAgMFGAEiBQmIJ7AiEhMSCAAGAQECAgMHGAEiBQnwLtAoGgRuYW1lGgVjbGFzcxoIc3ViY2xhc3MaBHJhbmsiHQob0JzQtdGC0YDQviDQodC10LLQtdGA0L3QsNGPIgkKB3JhaWx3YXkiCAoGc3Vid2F5IgIoASIjCiHQnNC10YLRgNC+INCm0LXQvdGC0YDQsNC70YzQvdCw0Y8iAigCIhcKFdCc0LXRgtGA0L4g0K7QttC90LDRjyICKAMagAF4AgoOdHJhbnNwb3J0YXRpb24ogCASFBIGAAABAQICGAIiCAkA6CAKgEAAEhISBAADAQMYAiIICQCIJwqAQAAaBWNsYXNzGghzdWJjbGFzcxoHYnJ1bm5lbCIJCgd0cmFuc2l0IggKBnN1YndheSIICgZ0dW5uZWwiBgoEcmFpbA==',
  'base64',
);

if (!baseUrl) {
  throw new Error('MAP_WEB_TEST_URL is required');
}

const browser = await chromium.launch({ headless: true });

try {
  await verifyCatalogMap();
  await verifyWalkingRouteRetry();
  await verifyAdminWalkingRouteRefresh();
  await verifyObjectDetailMap();
  await verifyProviderFailureKeepsCatalogUsable();
  await verifyProviderTimeoutKeepsCatalogUsable();
  await verifyMobileMap();
  process.stdout.write('MAP_MODULE_BROWSER_OK\n');
} finally {
  await browser.close();
}

async function verifyCatalogMap() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const styleBarrier = createBarrier(10_000, 'Map style request did not reach the fixture barrier');
  const requestedUrls = [];
  const walkingRouteRequests = [];
  const runtimeErrors = collectRuntimeErrors(page);

  try {
    page.on('request', (request) => requestedUrls.push(request.url()));
    await installApiFixtures(page, { walkingRouteRequests });
    await installMapFixtures(page, { styleBarrier });

    await page.goto(`${baseUrl}/catalog/map`, { waitUntil: 'domcontentloaded' });
    await styleBarrier.waitForArrival();
    await page.getByText('Загрузка карты', { exact: true }).waitFor();

    styleBarrier.release();

    const map = page.getByRole('region', { name: 'Карта объектов' });
    await map.locator('[data-map-surface] canvas').waitFor();
    await map.getByText('OpenFreeMap', { exact: true }).waitFor();
    await map.getByText('OpenStreetMap', { exact: true }).waitFor();
    try {
      await map.locator('.platform-map-shell[data-map-status="ready"]').waitFor({ timeout: 10_000 });
    } catch (error) {
      const mapRequests = requestedUrls.filter((url) => url.includes('maplibre') || url.includes('map-fixtures'));

      throw new Error(
        [
          error instanceof Error ? error.message : String(error),
          'Runtime errors:',
          runtimeErrors.join('\n') || '(none)',
          'Map requests:',
          mapRequests.join('\n') || '(none)',
        ].join('\n'),
      );
    }
    await page.waitForTimeout(100);
    assert.equal(
      await map.locator('.platform-map-shell').getAttribute('data-map-status'),
      'ready',
      'local map fixtures should not trigger a provider error',
    );

    const mapList = page.getByRole('complementary', { name: 'Объекты на карте' });
    const initialBoundsLabel = await mapList.locator('.table-meta span').first().innerText();
    const northMarker = map.locator('.map-price-marker[aria-label="ЖК Северный"]');
    await northMarker.waitFor();
    await northMarker.click();
    const northCard = page.getByRole('article', { name: 'Объект ЖК Северный' });
    await northCard.waitFor();
    await northCard.getByRole('heading', { name: 'Ближайшее метро пешком' }).waitFor();
    await northCard.getByText('Метро Северная', { exact: true }).waitFor();
    await northCard.getByText('1,3 км · 16 мин', { exact: true }).waitFor();
    assert.equal(await northCard.getByRole('button', { name: 'Обновить маршруты метро' }).count(), 0);
    assert.equal(await northCard.locator('.map-nearby-metro-list li').count(), 3);
    const singleLineMarker = northCard.getByRole('img', { name: 'Линии метро: Солнцевская' });
    const transferMarker = northCard.getByRole('img', {
      name: 'Линии метро: Арбатско-Покровская, Троицкая',
    });
    assert.equal(await singleLineMarker.evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(255, 205, 28)');
    assert.match(
      await transferMarker.evaluate((element) => getComputedStyle(element).backgroundImage),
      /conic-gradient\(rgb\(0, 114, 186\).*rgb\(3, 121, 95\)/,
    );
    assert.deepEqual(await northCard.locator('.map-nearby-metro-icon').allTextContents(), ['', '', '']);
    assert.equal(walkingRouteRequests.length, 1);
    assert.deepEqual(walkingRouteRequests[0].origin, [55.79, 37.61]);
    assert.equal(walkingRouteRequests[0].destinations.length, 3);
    assert.equal(await northMarker.getAttribute('aria-pressed'), 'true');
    await page.waitForFunction(
      ({ selector, previous }) => document.querySelector(selector)?.textContent?.trim() !== previous,
      { selector: '.catalog-map-list .table-meta span', previous: initialBoundsLabel },
    );
    assert.equal(
      await page.getByRole('article', { name: 'Объект ЖК Северный' }).getByRole('link', { name: 'Подробнее' }).getAttribute('href'),
      '/objects/zhk-severnyy',
    );

    const measureButton = map.getByRole('button', { name: 'Измерить расстояние' });
    await measureButton.click();
    assert.equal(await map.getByRole('button', { name: 'Завершить измерение' }).getAttribute('aria-pressed'), 'true');
    const mapSurface = map.locator('[data-map-surface]');
    await mapSurface.click({ position: { x: 520, y: 360 } });
    await map.getByText('Выберите следующую точку', { exact: true }).waitFor();
    await mapSurface.click({ position: { x: 700, y: 440 } });
    await map.locator('.map-measurement-distance').waitFor();
    await map.getByRole('button', { name: 'Очистить измерение' }).click();
    await map.getByText('Выберите начальную точку', { exact: true }).waitFor();

    const fullscreen = map.getByRole('button', { name: 'Открыть карту на весь экран' });
    await fullscreen.click();
    await page.locator('.platform-map-shell[data-map-fullscreen="true"]').waitFor();
    await map.getByRole('button', { name: 'Закрыть полноэкранную карту' }).click();
    await page.locator('.platform-map-shell[data-map-fullscreen="false"]').waitFor();

    await page.screenshot({ path: '/tmp/platforma-maplibre-catalog-desktop.png' });

    assert.equal(requestedUrls.some((url) => /api-maps\.yandex\.ru|yandex\.net\/maps/u.test(url)), false);
    assert.deepEqual(runtimeErrors, []);
  } finally {
    styleBarrier.release();
    await context.close();
  }
}

async function verifyObjectDetailMap() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const requestedUrls = [];
  const runtimeErrors = collectRuntimeErrors(page);

  try {
    page.on('request', (request) => requestedUrls.push(request.url()));
    await installApiFixtures(page);
    await installMapFixtures(page);

    await page.goto(`${baseUrl}/objects/zhk-severnyy`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'ЖК Северный', exact: true }).waitFor();
    const map = page.getByRole('region', { name: 'Карта объекта' });
    const marker = map.locator('.map-price-marker[aria-label="ЖК Северный"]');
    await marker.waitFor();
    await marker.click();
    const popup = map.locator('.platform-map-popup');
    await popup.getByText('ЖК Северный', { exact: true }).waitFor();
    await popup.getByText('Москва, Северная улица, 1', { exact: true }).waitFor();
    await page.screenshot({ path: '/tmp/platforma-maplibre-object-detail.png' });

    assert.equal(requestedUrls.some((url) => /api-maps\.yandex\.ru|yandex\.net\/maps/u.test(url)), false);
    assert.deepEqual(runtimeErrors, []);

    const styleRequestsBeforeMissingCoordinates = requestedUrls.filter((url) => url.includes('tiles.openfreemap.org/styles')).length;
    await page.goto(`${baseUrl}/objects/no-coordinates`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Объект без координат', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Координаты не указаны', exact: true }).waitFor();
    const styleRequestsAfterMissingCoordinates = requestedUrls.filter((url) => url.includes('tiles.openfreemap.org/styles')).length;

    assert.equal(styleRequestsAfterMissingCoordinates, styleRequestsBeforeMissingCoordinates);
  } finally {
    await context.close();
  }
}

async function verifyWalkingRouteRetry() {
  const context = await browser.newContext({ viewport: { width: 1366, height: 850 } });
  const page = await context.newPage();
  const walkingRouteRequests = [];
  const runtimeErrors = collectRuntimeErrors(page);

  try {
    await installApiFixtures(page, { walkingRouteFailures: 1, walkingRouteRequests });
    await installMapFixtures(page);

    await page.goto(`${baseUrl}/catalog/map`, { waitUntil: 'domcontentloaded' });
    const map = page.getByRole('region', { name: 'Карта объектов' });
    const northMarker = map.locator('.map-price-marker[aria-label="ЖК Северный"]');
    await northMarker.waitFor();
    await northMarker.click();

    const card = page.getByRole('article', { name: 'Объект ЖК Северный' });
    await card.getByText('Пешие маршруты временно недоступны.', { exact: true }).waitFor();
    await card.getByRole('button', { name: 'Повторить построение маршрутов' }).click();
    await card.getByText('1,3 км · 16 мин', { exact: true }).waitFor();

    assert.equal(walkingRouteRequests.length, 2);
    assert.deepEqual(runtimeErrors.filter((error) => !error.includes('502 (Bad Gateway)')), []);
  } finally {
    await context.close();
  }
}

async function verifyAdminWalkingRouteRefresh() {
  const context = await browser.newContext({ viewport: { width: 1366, height: 850 } });
  const page = await context.newPage();
  const walkingRouteRefreshRequests = [];
  const runtimeErrors = collectRuntimeErrors(page);

  try {
    await installApiFixtures(page, {
      permissions: ['objects:read', 'admin:access'],
      walkingRouteRefreshRequests,
    });
    await installMapFixtures(page);

    await page.goto(`${baseUrl}/catalog/map`, { waitUntil: 'domcontentloaded' });
    const map = page.getByRole('region', { name: 'Карта объектов' });
    const northMarker = map.locator('.map-price-marker[aria-label="ЖК Северный"]');
    await northMarker.waitFor();
    await northMarker.click();

    const card = page.getByRole('article', { name: 'Объект ЖК Северный' });
    await card.getByText('1,3 км · 16 мин', { exact: true }).waitFor();
    const refreshButton = card.getByRole('button', { name: 'Обновить маршруты метро' });
    assert.equal(await refreshButton.locator('svg').count(), 1);
    assert.equal(await refreshButton.evaluate((button) => button.textContent?.trim()), '');
    assert.equal(await refreshButton.locator('xpath=..').getAttribute('class'), 'map-nearby-metro-heading');
    await refreshButton.click();
    await card.getByText('1,5 км · 17 мин', { exact: true }).waitFor();

    assert.equal(walkingRouteRefreshRequests.length, 1);
    assert.equal(walkingRouteRefreshRequests[0].destinations.length, 3);
    assert.deepEqual(runtimeErrors, []);
  } finally {
    await context.close();
  }
}

async function verifyProviderFailureKeepsCatalogUsable() {
  const context = await browser.newContext({ viewport: { width: 1366, height: 850 } });
  const page = await context.newPage();

  try {
    await installApiFixtures(page);
    await installMapFixtures(page, { failTiles: true });

    await page.goto(`${baseUrl}/catalog/map`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Карта временно недоступна', exact: true }).waitFor();

    const mapList = page.getByRole('complementary', { name: 'Объекты на карте' });
    await mapList.getByRole('button', { name: 'ЖК Северный', exact: true }).click();
    const card = page.getByRole('article', { name: 'Объект ЖК Северный' });
    await card.waitFor();
    await card.getByText('Не удалось определить станции по данным текущей подложки.', { exact: true }).waitFor();
    assert.equal(await card.getByRole('link', { name: 'Подробнее' }).getAttribute('href'), '/objects/zhk-severnyy');
    await page.screenshot({ path: '/tmp/platforma-maplibre-provider-fallback.png' });
  } finally {
    await context.close();
  }
}

async function verifyProviderTimeoutKeepsCatalogUsable() {
  const context = await browser.newContext({ viewport: { width: 1366, height: 850 } });
  const page = await context.newPage();
  const tileBarrier = createBarrier(10_000, 'Vector tile request did not reach the fixture barrier');

  try {
    await installApiFixtures(page);
    await installMapFixtures(page, { tileBarrier });

    await page.goto(`${baseUrl}/catalog/map`, { waitUntil: 'domcontentloaded' });
    await tileBarrier.waitForArrival();
    await page.getByRole('heading', { name: 'Карта временно недоступна', exact: true }).waitFor({ timeout: 20_000 });

    const mapList = page.getByRole('complementary', { name: 'Объекты на карте' });
    await mapList.getByRole('button', { name: 'ЖК Южный', exact: true }).click();
    await page.getByRole('article', { name: 'Объект ЖК Южный' }).waitFor();
  } finally {
    tileBarrier.release();
    await context.close();
  }
}

async function verifyMobileMap() {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const runtimeErrors = collectRuntimeErrors(page);

  try {
    await installApiFixtures(page);
    await installMapFixtures(page);

    await page.goto(`${baseUrl}/catalog/map`, { waitUntil: 'domcontentloaded' });
    const map = page.getByRole('region', { name: 'Карта объектов' });
    const marker = map.locator('.map-price-marker[aria-label="ЖК Северный"]');
    await marker.waitFor();
    const zoomControlBox = await map.getByRole('button', { name: 'Увеличить масштаб' }).boundingBox();
    const fullscreenControlBox = await map.getByRole('button', { name: 'Открыть карту на весь экран' }).boundingBox();

    assert.ok(zoomControlBox && zoomControlBox.width >= 44 && zoomControlBox.height >= 44);
    assert.ok(fullscreenControlBox && fullscreenControlBox.width >= 44 && fullscreenControlBox.height >= 44);
    await marker.tap();
    await page.getByRole('article', { name: 'Объект ЖК Северный' }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: '/tmp/platforma-maplibre-catalog-mobile.png' });
    assert.deepEqual(runtimeErrors, []);
  } finally {
    await context.close();
  }
}

async function installMapFixtures(
  page,
  { failStyle = false, failTiles = false, styleBarrier = null, tileBarrier = null } = {},
) {
  await page.route('https://tiles.openfreemap.org/styles/liberty', async (route) => {
    if (styleBarrier) {
      await styleBarrier.hold();
    }

    if (failStyle) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(mapStyleFixture()),
    });
  });

  await page.route(`${baseUrl}/map-fixtures/tiles/**`, async (route) => {
    if (tileBarrier) {
      await tileBarrier.hold();
    }

    if (failTiles) {
      await route.fulfill({ status: 503, contentType: 'text/plain', body: 'tile unavailable' });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/vnd.mapbox-vector-tile',
      body: vectorTileFixture,
    });
  });
}

async function installApiFixtures(
  page,
  {
    permissions = ['objects:read'],
    walkingRouteFailures = 0,
    walkingRouteRefreshRequests = [],
    walkingRouteRequests = [],
  } = {},
) {
  let remainingWalkingRouteFailures = walkingRouteFailures;
  await page.route('https://fonts.googleapis.com/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/css', body: '' });
  });

  await page.route('http://localhost:3000/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;

    if (pathname === '/auth/refresh' && request.method() === 'POST') {
      await json(route, {
        accessToken: 'map-browser-access-token',
        user: {
          id: '11111111-1111-4111-8111-111111111111',
          email: 'map-browser@example.test',
          name: 'Map Browser User',
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

    if (pathname === '/training/config') {
      await json(route, { enabled: false });
      return;
    }

    if (pathname === '/assistant/config') {
      await json(route, { enabled: false });
      return;
    }

    if (pathname === '/catalog-links') {
      await json(route, { items: [] });
      return;
    }

    if (pathname === '/metro') {
      await json(route, { items: metroDirectoryFixture() });
      return;
    }

    if (pathname === '/developers' || pathname === '/locations') {
      await json(route, { items: [] });
      return;
    }

    if (pathname === '/map/objects') {
      await json(route, { items: [mapObjectFixture('north'), mapObjectFixture('south')], total: 2 });
      return;
    }

    if (pathname === '/map/walking-routes' && request.method() === 'POST') {
      walkingRouteRequests.push(request.postDataJSON());

      if (remainingWalkingRouteFailures > 0) {
        remainingWalkingRouteFailures -= 1;
        await json(route, { message: 'Walking routes are temporarily unavailable' }, 502);
        return;
      }

      await json(route, {
        routes: [
          { destinationIndex: 0, distanceMeters: 1340, durationSeconds: 960 },
          { destinationIndex: 1, distanceMeters: 2210, durationSeconds: 1600 },
          { destinationIndex: 2, distanceMeters: 3810, durationSeconds: 2700 },
        ],
      });
      return;
    }

    if (pathname === '/map/walking-routes/refresh' && request.method() === 'POST') {
      walkingRouteRefreshRequests.push(request.postDataJSON());
      await json(route, {
        routes: [
          { destinationIndex: 0, distanceMeters: 1450, durationSeconds: 1020 },
          { destinationIndex: 1, distanceMeters: 2300, durationSeconds: 1650 },
          { destinationIndex: 2, distanceMeters: 3900, durationSeconds: 2760 },
        ],
      });
      return;
    }

    if (pathname === '/objects/slug/zhk-severnyy') {
      await json(route, { object: objectDetailFixture('north') });
      return;
    }

    if (pathname === '/objects/slug/no-coordinates') {
      await json(route, { object: objectDetailFixture('missing') });
      return;
    }

    if (/^\/objects\/[^/]+\/feed-units\/groups$/u.test(pathname)) {
      await json(route, { groups: [], total: 0, hasDiscountPrices: false });
      return;
    }

    await json(route, { message: `Unexpected ${request.method()} ${pathname}` }, 404);
  });
}

function metroDirectoryFixture() {
  return [
    {
      id: '95555555-5555-4555-8555-555555555551',
      wpTermId: null,
      name: 'Метро Северная',
      slug: 'metro-severnaya',
      lineName: 'Солнцевская',
      lineColor: '#FFCD1C',
    },
    {
      id: '95555555-5555-4555-8555-555555555552',
      wpTermId: null,
      name: 'Метро Центральная',
      slug: 'metro-centralnaya-blue',
      lineName: 'Арбатско-Покровская',
      lineColor: '#0072BA',
    },
    {
      id: '95555555-5555-4555-8555-555555555553',
      wpTermId: null,
      name: 'Метро Центральная',
      slug: 'metro-centralnaya-green',
      lineName: 'Троицкая',
      lineColor: '#03795F',
    },
    {
      id: '95555555-5555-4555-8555-555555555554',
      wpTermId: null,
      name: 'Метро Южная',
      slug: 'metro-yuzhnaya',
      lineName: 'Сокольническая',
      lineColor: '#E42313',
    },
  ];
}

function mapStyleFixture() {
  return {
    version: 8,
    sources: {
      'local-vector': {
        type: 'vector',
        tiles: [`${baseUrl}/map-fixtures/tiles/{z}/{x}/{y}.pbf`],
        attribution:
          '<a href="https://openfreemap.org/">OpenFreeMap</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#e8edf2' } },
      {
        id: 'local-vector',
        type: 'circle',
        source: 'local-vector',
        'source-layer': 'points',
        paint: { 'circle-color': '#c9ab72', 'circle-radius': 4 },
      },
      {
        id: 'road_transit_rail',
        type: 'line',
        source: 'local-vector',
        'source-layer': 'transportation',
        paint: { 'line-color': '#a0a8b3', 'line-width': 1 },
      },
      {
        id: 'poi_r1',
        type: 'circle',
        source: 'local-vector',
        'source-layer': 'poi',
        minzoom: 15,
        filter: ['<', ['get', 'rank'], 7],
        paint: { 'circle-color': '#7891a6', 'circle-radius': 3 },
      },
      {
        id: 'poi_transit',
        type: 'circle',
        source: 'local-vector',
        'source-layer': 'poi',
        filter: ['==', ['get', 'class'], 'rail'],
        paint: { 'circle-color': '#d64b45', 'circle-radius': 5 },
      },
    ],
  };
}

function mapObjectFixture(kind) {
  const isNorth = kind === 'north';

  return {
    id: isNorth ? '91111111-1111-4111-8111-111111111111' : '92222222-2222-4222-8222-222222222222',
    type: 'RESIDENTIAL',
    title: isNorth ? 'ЖК Северный' : 'ЖК Южный',
    slug: isNorth ? 'zhk-severnyy' : 'zhk-yuzhnyy',
    status: 'PUBLISHED',
    address: isNorth ? 'Москва, Северная улица, 1' : 'Москва, Южная улица, 2',
    mapName: isNorth ? 'Северный' : 'Южный',
    latitude: isNorth ? 55.79 : 55.71,
    longitude: isNorth ? 37.61 : 37.69,
    priceFrom: isNorth ? '25000000' : '21000000',
    pricePerMeterFrom: isNorth ? '420000' : '390000',
    apartmentAreaRange: '45–90 м²',
    feedPriceFrom: null,
    feedPricePerMeterFrom: null,
    feedAreaRange: null,
    feedFloorRange: null,
    feedUnitsCount: 0,
    feedUnitsCountText: null,
    feedCompletionYear: null,
    feedCompletionQuarter: null,
    feedUpdatedAt: null,
    completionYear: 2028,
    completionQuarter: 2,
    developer: { id: '93333333-3333-4333-8333-333333333333', name: 'Тест Девелопмент' },
    primaryLocation: null,
    locations: [],
    metroStations: [],
    images: [],
    coverImage: null,
  };
}

function objectDetailFixture(kind) {
  const missingCoordinates = kind === 'missing';
  const mapObject = mapObjectFixture('north');

  return {
    ...mapObject,
    id: missingCoordinates ? '94444444-4444-4444-8444-444444444444' : mapObject.id,
    title: missingCoordinates ? 'Объект без координат' : mapObject.title,
    slug: missingCoordinates ? 'no-coordinates' : mapObject.slug,
    description: 'Объект для проверки provider-neutral карты.',
    architectureDescription: null,
    infrastructureDescription: null,
    fillingDescription: null,
    shortDescription: null,
    aerotourUrl: null,
    layoutsUrl: null,
    krtName: null,
    ceilingHeight: null,
    propertyClass: null,
    floorRange: null,
    apartmentsCountText: null,
    matchedFeedUnitsCount: 0,
    latitude: missingCoordinates ? null : mapObject.latitude,
    longitude: missingCoordinates ? null : mapObject.longitude,
    featuresJson: {},
    publishedAt: '2026-08-25T00:00:00.000Z',
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z',
    deletedAt: null,
    files: [],
  };
}

function collectRuntimeErrors(page) {
  const errors = [];

  page.on('pageerror', (error) => errors.push(`pageerror:${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      if (message.text().includes('GL Driver Message')) {
        return;
      }

      errors.push(`${message.type()}:${message.text()}`);
    }
  });

  return errors;
}

function createBarrier(timeoutMs, timeoutMessage) {
  let resolveArrival;
  const arrival = new Promise((resolve) => {
    resolveArrival = resolve;
  });
  let resolveRelease;
  const released = new Promise((resolve) => {
    resolveRelease = resolve;
  });
  let isReleased = false;

  return {
    async hold() {
      resolveArrival();
      await released;
    },
    async waitForArrival() {
      await Promise.race([
        arrival,
        new Promise((_, reject) => setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)),
      ]);
    },
    release() {
      if (isReleased) return;
      isReleased = true;
      resolveRelease();
    },
  };
}

async function json(route, body, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}
