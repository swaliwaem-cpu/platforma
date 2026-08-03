import assert from 'node:assert/strict';

import { chromium } from '@playwright/test';
import { fulfillTrainingConfig } from './training-v2-browser-config-fixture.mjs';

const baseUrl = process.env.TRAINING_WEB_TEST_URL;
if (!baseUrl) throw new Error('TRAINING_WEB_TEST_URL is required');

const browser = await chromium.launch({ headless: true });

try {
  await verifyTrainingConfigScenario('enabled');
  await verifyTrainingConfigScenario('disabled');
  await verifyTrainingConfigScenario('server-error');
  await verifyTrainingConfigScenario('network-error');
  process.stdout.write('TRAINING_STAGE5_PART3_BROWSER_OK\n');
} finally {
  await browser.close();
}

async function verifyTrainingConfigScenario(mode) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  const unexpectedRequests = [];
  let configRequests = 0;
  let trainingDataRequests = 0;
  let resolveConfigHandled;
  const configHandled = new Promise((resolve) => {
    resolveConfigHandled = resolve;
  });

  page.on('pageerror', (error) => pageErrors.push(error.message));

  try {
    await page.route('http://localhost:3000/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;

      if (path === '/auth/refresh' && request.method() === 'POST') {
        await json(route, {
          accessToken: `training-config-${mode}-token`,
          user: {
            id: 'f1111111-1111-4111-8111-111111111111',
            email: 'training-config@training.test',
            name: 'Training Config Employee',
            brokerPhone: null,
            brokerEmail: null,
            status: 'ACTIVE',
            role: { id: 'f2222222-2222-4222-8222-222222222222', name: 'user' },
            profilePhotoFile: null,
            permissions: ['training:participate'],
          },
        });
        return;
      }

      if (path === '/training/config') {
        configRequests += 1;
        assert.equal(request.method(), 'GET');
        assert.equal(
          request.headers().authorization,
          `Bearer training-config-${mode}-token`,
        );

        try {
          if (mode === 'enabled' || mode === 'disabled') {
            const handled = await fulfillTrainingConfig(route, mode === 'enabled');
            assert.equal(handled, true);
          } else if (mode === 'server-error') {
            await json(route, { message: 'TRAINING_CONFIG_UNAVAILABLE' }, 500);
          } else {
            await route.abort('failed');
          }
        } finally {
          resolveConfigHandled();
        }
        return;
      }

      if (mode === 'enabled' && path === '/training/projects') {
        trainingDataRequests += 1;
        await json(route, { items: [] });
        return;
      }

      if (mode === 'enabled' && path === '/training/attempts') {
        trainingDataRequests += 1;
        await json(route, { items: [] });
        return;
      }

      if (mode === 'enabled' && path === '/training/telegram/account') {
        trainingDataRequests += 1;
        await json(route, { linked: false, username: null, linkedAt: null });
        return;
      }

      unexpectedRequests.push(`${request.method()} ${path}`);
      await json(route, { message: `Unexpected ${request.method()} ${path}` }, 404);
    });

    await page.goto(`${baseUrl}/training`, { waitUntil: 'domcontentloaded' });
    await configHandled;

    if (mode === 'enabled') {
      await page.getByRole('heading', { name: 'Учебные проекты' }).waitFor();
      await page.getByRole('button', { name: 'Раскрыть меню' }).click();
      await page.getByRole('button', { name: 'Обучение' }).waitFor();
      assert.equal(trainingDataRequests, 3);
    } else {
      await page.getByRole('heading', { name: 'Недостаточно прав' }).waitFor();
      await page.getByRole('button', { name: 'Раскрыть меню' }).click();
      assert.equal(await page.getByRole('button', { name: 'Обучение' }).count(), 0);
      assert.equal(await page.getByText('Загрузка', { exact: true }).count(), 0);
      assert.equal(trainingDataRequests, 0);
    }

    assert.equal(configRequests, 1);
    assert.deepEqual(unexpectedRequests, []);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
}

async function json(route, body, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}
