import assert from 'node:assert/strict';

import { chromium } from '@playwright/test';

const baseUrl = process.env.TRAINING_WEB_TEST_URL;
if (!baseUrl) throw new Error('TRAINING_WEB_TEST_URL is required');

const browser = await chromium.launch({ headless: true });

try {
  await verifyInitialNavigation();
  await verifyObjectDomainNavigation();
  await verifyDeniedObjectDeepLink();
  await verifyFailClosedTrainingConfig();
  await verifyObjectLoadingState();
  await verifyObjectChunkErrorState();
  await verifyEmployeeDeepLink();
  await verifyAdminDeepLink();
  await verifyDeniedAdminDeepLink();
  await verifyLoadingState();
  await verifyChunkErrorState();
  process.stdout.write('TRAINING_CODE_SPLITTING_BROWSER_OK\n');
} finally {
  await browser.close();
}

async function verifyInitialNavigation() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const trainingAssets = collectTrainingAssets(page);
  const objectAssets = collectObjectAssets(page);
  const runtimeErrors = collectRuntimeErrors(page);

  try {
    await installApiFixtures(page, ['training:participate']);
    await page.goto(`${baseUrl}/cabinet`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Code Splitting User' }).waitFor();
    assert.deepEqual(trainingAssets, []);
    assert.deepEqual(objectAssets, []);

    await page.getByRole('button', { name: 'Раскрыть меню' }).click();
    await page.getByRole('button', { name: 'Обучение' }).click();
    await page.getByRole('heading', { name: 'Учебные проекты' }).waitFor();

    assert.equal(trainingAssets.some(isEmployeeRouteAsset), true);
    assert.equal(trainingAssets.some(isAdminRouteAsset), false);
    assert.deepEqual(runtimeErrors, []);
  } finally {
    await context.close();
  }
}

async function verifyObjectDomainNavigation() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const objectAssets = collectObjectAssets(page);
  const runtimeErrors = collectRuntimeErrors(page);

  try {
    await installApiFixtures(page, ['objects:read']);
    await page.goto(`${baseUrl}/cabinet`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Code Splitting User' }).waitFor();
    assert.deepEqual(objectAssets, []);

    await page.getByRole('button', { name: 'Раскрыть меню' }).click();
    await page.getByRole('button', { name: 'Каталог' }).click();
    await page.getByRole('heading', { name: 'Все объекты недвижимости' }).waitFor();
    await page.getByRole('link', { name: 'Тестовый объект', exact: true }).waitFor();

    assert.equal(new URL(page.url()).pathname, '/catalog');
    assert.equal(objectAssets.some(isCatalogRouteAsset), true);
    assert.equal(objectAssets.some(isObjectDetailRouteAsset), false);
    assert.equal(objectAssets.some(isObjectsAdminRouteAsset), false);

    await page.evaluate(() => {
      window.history.pushState(null, '', '/objects/test-object');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await page.getByRole('heading', { name: 'Тестовый объект' }).waitFor();

    assert.equal(new URL(page.url()).pathname, '/objects/test-object');
    assert.equal(objectAssets.some(isObjectDetailRouteAsset), true);
    assert.equal(objectAssets.some(isObjectsAdminRouteAsset), false);

    await page.goBack();
    await page.getByRole('heading', { name: 'Все объекты недвижимости' }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/catalog');

    await page.goForward();
    await page.getByRole('heading', { name: 'Тестовый объект' }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/objects/test-object');
    assert.deepEqual(runtimeErrors, []);
  } finally {
    await context.close();
  }
}

async function verifyDeniedObjectDeepLink() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const objectAssets = collectObjectAssets(page);
  const apiRequests = collectApiRequests(page);
  const runtimeErrors = collectRuntimeErrors(page);

  try {
    await installApiFixtures(page, ['admin:access']);
    await page.goto(`${baseUrl}/admin/objects`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Недостаточно прав' }).waitFor();

    assert.deepEqual(objectAssets, []);
    assert.equal(apiRequests.some((pathname) => pathname === '/objects' || pathname.startsWith('/objects/')), false);
    assert.deepEqual(runtimeErrors, []);
  } finally {
    await context.close();
  }
}

async function verifyFailClosedTrainingConfig() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const trainingAssets = collectTrainingAssets(page);
  const apiRequests = collectApiRequests(page);
  const runtimeErrors = collectRuntimeErrors(page);
  const configBarrier = createBarrier(10_000, 'Training config request did not reach the fixture barrier');
  let resolveConfigFinished;
  const configFinished = new Promise((resolve) => {
    resolveConfigFinished = resolve;
  });

  try {
    await installApiFixtures(page, ['training:participate'], {
      async trainingConfig(route) {
        try {
          await configBarrier.hold();
          await json(route, { message: 'TRAINING_CONFIG_UNAVAILABLE' }, 500);
        } finally {
          resolveConfigFinished();
        }
      },
    });

    await page.goto(`${baseUrl}/training`, { waitUntil: 'domcontentloaded' });
    await configBarrier.waitForArrival();
    await page.getByRole('heading', { name: 'Недостаточно прав' }).waitFor();

    assert.deepEqual(trainingAssets, []);
    assert.equal(hasTrainingDataRequest(apiRequests), false);

    configBarrier.release();
    await withTimeout(configFinished, 10_000, 'Training config fixture did not finish');
    await page.waitForTimeout(50);

    await page.getByRole('heading', { name: 'Недостаточно прав' }).waitFor();
    assert.deepEqual(trainingAssets, []);
    assert.equal(hasTrainingDataRequest(apiRequests), false);
    assert.equal(runtimeErrors.length, 1);
    assert.match(runtimeErrors[0], /^error:Failed to load resource:.*500 \(Internal Server Error\)$/u);
  } finally {
    configBarrier.release();
    await context.close();
  }
}

async function verifyObjectLoadingState() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const runtimeErrors = collectRuntimeErrors(page);
  const chunkBarrier = createBarrier(10_000, 'Catalog chunk did not reach the fixture barrier');

  try {
    await installApiFixtures(page, ['objects:read']);
    await page.route(/\/assets\/CatalogPage-[^/]+\.js$/u, async (route) => {
      await chunkBarrier.hold();
      await route.continue();
    });

    await page.goto(`${baseUrl}/catalog`, { waitUntil: 'domcontentloaded' });
    await chunkBarrier.waitForArrival();
    await page.getByRole('heading', { name: 'Загрузка раздела' }).waitFor();
    await page.screenshot({ path: '/tmp/object-code-splitting-loading-mobile.png' });

    chunkBarrier.release();
    await page.getByRole('heading', { name: 'Все объекты недвижимости' }).waitFor();
    assert.deepEqual(runtimeErrors, []);
  } finally {
    chunkBarrier.release();
    await context.close();
  }
}

async function verifyObjectChunkErrorState() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();

  try {
    await installApiFixtures(page, ['objects:read']);
    await page.route(/\/assets\/CatalogPage-[^/]+\.js$/u, async (route) => {
      await route.abort('failed');
    });

    await page.goto(`${baseUrl}/catalog`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Не удалось открыть раздел' }).waitFor();
    await page.getByRole('button', { name: 'Обновить страницу' }).waitFor();
    await page.screenshot({ path: '/tmp/object-code-splitting-error-mobile.png' });
  } finally {
    await context.close();
  }
}

async function verifyEmployeeDeepLink() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const trainingAssets = collectTrainingAssets(page);
  const runtimeErrors = collectRuntimeErrors(page);

  try {
    await installApiFixtures(page, ['training:participate']);
    await page.goto(`${baseUrl}/training`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Учебные проекты' }).waitFor();
    await page.screenshot({ path: '/tmp/training-code-splitting-employee.png' });

    assert.equal(new URL(page.url()).pathname, '/training');
    assert.equal(trainingAssets.some(isEmployeeRouteAsset), true);
    assert.equal(trainingAssets.some(isAdminRouteAsset), false);
    assert.deepEqual(runtimeErrors, []);
  } finally {
    await context.close();
  }
}

async function verifyAdminDeepLink() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const trainingAssets = collectTrainingAssets(page);
  const runtimeErrors = collectRuntimeErrors(page);

  try {
    await installApiFixtures(page, ['admin:access', 'training:projects:manage']);
    await page.goto(`${baseUrl}/admin/training`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Модуль обучения' }).waitFor();
    await page.screenshot({ path: '/tmp/training-code-splitting-admin.png' });

    assert.equal(new URL(page.url()).pathname, '/admin/training');
    assert.equal(trainingAssets.some(isAdminRouteAsset), true);
    assert.equal(trainingAssets.some(isEmployeeRouteAsset), false);
    assert.deepEqual(runtimeErrors, []);
  } finally {
    await context.close();
  }
}

async function verifyDeniedAdminDeepLink() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const trainingAssets = collectTrainingAssets(page);
  const runtimeErrors = collectRuntimeErrors(page);

  try {
    await installApiFixtures(page, ['admin:access']);
    await page.goto(`${baseUrl}/admin/training`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Недостаточно прав' }).waitFor();

    assert.deepEqual(trainingAssets, []);
    assert.deepEqual(runtimeErrors, []);
  } finally {
    await context.close();
  }
}

async function verifyLoadingState() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const runtimeErrors = collectRuntimeErrors(page);
  const chunkBarrier = createBarrier(10_000, 'Training employee chunk did not reach the fixture barrier');

  try {
    await installApiFixtures(page, ['training:participate']);
    await page.route(/\/assets\/TrainingEmployeeRoutes-[^/]+\.js$/u, async (route) => {
      await chunkBarrier.hold();
      await route.continue();
    });

    await page.goto(`${baseUrl}/training`, { waitUntil: 'domcontentloaded' });
    await chunkBarrier.waitForArrival();
    await page.getByRole('heading', { name: 'Загрузка раздела' }).waitFor();
    await page.screenshot({ path: '/tmp/training-code-splitting-loading-mobile.png' });
    chunkBarrier.release();
    await page.getByRole('heading', { name: 'Учебные проекты' }).waitFor();
    assert.deepEqual(runtimeErrors, []);
  } finally {
    chunkBarrier.release();
    await context.close();
  }
}

async function verifyChunkErrorState() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();

  try {
    await installApiFixtures(page, ['training:participate']);
    await page.route(/\/assets\/TrainingEmployeeRoutes-[^/]+\.js$/u, async (route) => {
      await route.abort('failed');
    });

    await page.goto(`${baseUrl}/training`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Не удалось открыть раздел' }).waitFor();
    await page.getByRole('button', { name: 'Обновить страницу' }).waitFor();
    await page.screenshot({ path: '/tmp/training-code-splitting-error-mobile.png' });
  } finally {
    await context.close();
  }
}

async function installApiFixtures(page, permissions, options = {}) {
  await page.route('http://localhost:3000/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;

    if (pathname === '/auth/refresh' && request.method() === 'POST') {
      await json(route, {
        accessToken: 'training-code-splitting-token',
        user: {
          id: '81111111-1111-4111-8111-111111111111',
          email: 'code-splitting@training.test',
          name: 'Code Splitting User',
          brokerPhone: null,
          brokerEmail: null,
          status: 'ACTIVE',
          role: { id: '82222222-2222-4222-8222-222222222222', name: 'test' },
          profilePhotoFile: null,
          permissions,
        },
      });
      return;
    }

    if (pathname === '/training/config' && request.method() === 'GET') {
      if (options.trainingConfig) {
        await options.trainingConfig(route);
        return;
      }

      await json(route, { enabled: true });
      return;
    }

    if (pathname === '/training/projects' || pathname === '/training/attempts') {
      await json(route, { items: [] });
      return;
    }

    if (pathname === '/training/telegram/account') {
      await json(route, { linked: false, username: null, linkedAt: null });
      return;
    }

    if (pathname === '/training/admin/projects') {
      await json(route, { items: [] });
      return;
    }

    if (pathname === '/catalog-links' && request.method() === 'GET') {
      await json(route, { items: [] });
      return;
    }

    if (
      (pathname === '/developers' || pathname === '/locations' || pathname === '/metro') &&
      request.method() === 'GET'
    ) {
      await json(route, { items: [] });
      return;
    }

    if (pathname === '/objects' && request.method() === 'GET') {
      await json(route, {
        items: [objectSummaryFixture()],
        total: 1,
        page: 1,
        limit: 25,
        totalPages: 1,
      });
      return;
    }

    if (pathname === '/objects/slug/test-object' && request.method() === 'GET') {
      await json(route, { object: objectDetailFixture() });
      return;
    }

    if (pathname === '/objects/91111111-1111-4111-8111-111111111111/feed-units/groups' && request.method() === 'GET') {
      await json(route, { groups: [], total: 0, hasDiscountPrices: false });
      return;
    }

    await json(route, { message: `Unexpected ${request.method()} ${pathname}` }, 404);
  });
}

function collectTrainingAssets(page) {
  const assets = [];

  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;

    if (/\/assets\/(?:TrainingAdminRoutes|TrainingEmployeeRoutes|training)-/u.test(pathname)) {
      assets.push(pathname);
    }
  });

  return assets;
}

function collectObjectAssets(page) {
  const assets = [];

  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;

    if (/\/assets\/(?:CatalogPage|ObjectDetailPage|ObjectsAdminPage)-/u.test(pathname)) {
      assets.push(pathname);
    }
  });

  return assets;
}

function collectApiRequests(page) {
  const requests = [];

  page.on('request', (request) => {
    const url = new URL(request.url());

    if (url.origin === 'http://localhost:3000') {
      requests.push(url.pathname);
    }
  });

  return requests;
}

function collectRuntimeErrors(page) {
  const errors = [];

  page.on('pageerror', (error) => errors.push(`pageerror:${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      errors.push(`${message.type()}:${message.text()}`);
    }
  });

  return errors;
}

function isEmployeeRouteAsset(pathname) {
  return /\/TrainingEmployeeRoutes-[^/]+\.js$/u.test(pathname);
}

function isAdminRouteAsset(pathname) {
  return /\/TrainingAdminRoutes-[^/]+\.js$/u.test(pathname);
}

function isCatalogRouteAsset(pathname) {
  return /\/CatalogPage-[^/]+\.js$/u.test(pathname);
}

function isObjectDetailRouteAsset(pathname) {
  return /\/ObjectDetailPage-[^/]+\.js$/u.test(pathname);
}

function isObjectsAdminRouteAsset(pathname) {
  return /\/ObjectsAdminPage-[^/]+\.js$/u.test(pathname);
}

function hasTrainingDataRequest(pathnames) {
  return pathnames.some((pathname) => pathname.startsWith('/training/') && pathname !== '/training/config');
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
      await withTimeout(arrival, timeoutMs, timeoutMessage);
    },
    release() {
      if (isReleased) return;
      isReleased = true;
      resolveRelease();
    },
  };
}

async function withTimeout(promise, timeoutMs, message) {
  let timeout;

  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function objectSummaryFixture() {
  const { files: _files, images: _images, ...object } = objectDetailFixture();

  return {
    ...object,
    coverImage: null,
    presentationFile: null,
  };
}

function objectDetailFixture() {
  return {
    id: '91111111-1111-4111-8111-111111111111',
    wpPostId: null,
    type: 'RESIDENTIAL',
    title: 'Тестовый объект',
    slug: 'test-object',
    status: 'PUBLISHED',
    description: 'Объект для проверки динамической загрузки маршрута.',
    architectureDescription: null,
    infrastructureDescription: null,
    fillingDescription: null,
    shortDescription: null,
    mapName: null,
    aerotourUrl: null,
    layoutsUrl: null,
    krtName: null,
    apartmentAreaRange: null,
    ceilingHeight: null,
    propertyClass: null,
    floorRange: null,
    apartmentsCountText: null,
    priceFrom: null,
    pricePerMeterFrom: null,
    feedPriceFrom: null,
    feedPricePerMeterFrom: null,
    feedAreaRange: null,
    feedFloorRange: null,
    feedUnitsCount: 0,
    feedUnitsCountText: null,
    matchedFeedUnitsCount: 0,
    feedCompletionYear: null,
    feedCompletionQuarter: null,
    feedUpdatedAt: null,
    completionYear: null,
    completionQuarter: null,
    address: null,
    latitude: null,
    longitude: null,
    featuresJson: {},
    developer: null,
    primaryLocation: null,
    locations: [],
    metroStations: [],
    publishedAt: '2026-08-09T00:00:00.000Z',
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
    deletedAt: null,
    images: [],
    files: [],
  };
}

async function json(route, body, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}
