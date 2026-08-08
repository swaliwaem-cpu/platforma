import assert from 'node:assert/strict';

import { chromium } from '@playwright/test';

const baseUrl = process.env.TRAINING_WEB_TEST_URL;
if (!baseUrl) throw new Error('TRAINING_WEB_TEST_URL is required');

const browser = await chromium.launch({ headless: true });

try {
  await verifyInitialNavigation();
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
  const runtimeErrors = collectRuntimeErrors(page);

  try {
    await installApiFixtures(page, ['training:participate']);
    await page.goto(`${baseUrl}/cabinet`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Code Splitting User' }).waitFor();
    assert.deepEqual(trainingAssets, []);

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
  let releaseChunk;
  const chunkReleased = new Promise((resolve) => {
    releaseChunk = resolve;
  });
  let resolveChunkRequested;
  const chunkRequested = new Promise((resolve) => {
    resolveChunkRequested = resolve;
  });

  try {
    await installApiFixtures(page, ['training:participate']);
    await page.route(/\/assets\/TrainingEmployeeRoutes-[^/]+\.js$/u, async (route) => {
      resolveChunkRequested();
      await chunkReleased;
      await route.continue();
    });

    await page.goto(`${baseUrl}/training`, { waitUntil: 'domcontentloaded' });
    await chunkRequested;
    await page.getByRole('heading', { name: 'Загрузка раздела' }).waitFor();
    await page.screenshot({ path: '/tmp/training-code-splitting-loading-mobile.png' });
    releaseChunk();
    await page.getByRole('heading', { name: 'Учебные проекты' }).waitFor();
    assert.deepEqual(runtimeErrors, []);
  } finally {
    releaseChunk?.();
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

async function installApiFixtures(page, permissions) {
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

async function json(route, body, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}
