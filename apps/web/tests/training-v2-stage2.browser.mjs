import assert from 'node:assert/strict';

import { chromium } from '@playwright/test';

const baseUrl = process.env.TRAINING_WEB_TEST_URL;

if (!baseUrl) {
  throw new Error('TRAINING_WEB_TEST_URL is required');
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const projectId = '11111111-1111-4111-8111-111111111111';

try {
  await page.route('http://localhost:3000/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === '/auth/refresh') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          accessToken: 'browser-access-token',
          user: {
            id: '22222222-2222-4222-8222-222222222222',
            email: 'employee@training.test',
            name: 'Employee',
            brokerPhone: null,
            brokerEmail: null,
            status: 'ACTIVE',
            role: { id: '33333333-3333-4333-8333-333333333333', name: 'employee' },
            profilePhotoFile: null,
            permissions: ['training:participate'],
          },
        }),
      });
      return;
    }

    if (path === '/training/projects') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          items: [{
            id: projectId,
            title: 'Голосовая аттестация',
            description: 'Browser Stage 2',
            attemptLimit: 3,
            timeLimitSeconds: 420,
            passScore: 75,
            attemptsUsed: 0,
            attemptsLeft: 3,
            eligibility: 'ELIGIBLE',
            canStart: true,
            activeAttempt: null,
            bestConfirmedScore: null,
            bestConfirmedStatus: null,
            hasPendingReview: false,
            status: null,
          }],
        }),
      });
      return;
    }

    if (path === '/training/attempts') {
      await route.fulfill({ contentType: 'application/json', body: '{"items":[]}' });
      return;
    }

    if (path === '/training/telegram/account') {
      await route.fulfill({
        contentType: 'application/json',
        body: '{"linked":false,"username":null,"linkedAt":null}',
      });
      return;
    }

    if (path === `/training/projects/${projectId}/telegram-link`) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          url: 'https://t.me/platforma_stage2_test_bot?start=one-time-browser-token',
          expiresAt: new Date(Date.now() + 500).toISOString(),
          account: { linked: false, username: null, linkedAt: null },
        }),
      });
      return;
    }

    await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });

  await page.goto(`${baseUrl}/training`);
  await page.getByRole('heading', { name: 'Учебные проекты' }).waitFor();
  await page.getByText('Голосовая аттестация в Telegram').waitFor();
  await page.getByRole('button', { name: 'Пройти в Telegram' }).click();
  const openTelegram = page.getByRole('link', { name: /Открыть Telegram/u });
  await openTelegram.waitFor();

  assert.equal(
    await openTelegram.getAttribute('href'),
    'https://t.me/platforma_stage2_test_bot?start=one-time-browser-token',
  );
  assert.equal(await page.getByText('Тестовый текстовый режим').count(), 0);
  await page.getByText('Срок действия ссылки истёк. Создайте новую ссылку для Telegram.').waitFor({
    timeout: 2_000,
  });
  assert.equal(await openTelegram.count(), 0);
} finally {
  await browser.close();
}
