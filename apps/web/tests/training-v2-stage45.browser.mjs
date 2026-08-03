import assert from 'node:assert/strict';

import { chromium } from '@playwright/test';
import { fulfillTrainingConfig } from './training-v2-browser-config-fixture.mjs';

const baseUrl = process.env.TRAINING_WEB_TEST_URL;
if (!baseUrl) throw new Error('TRAINING_WEB_TEST_URL is required');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const projectId = '81111111-1111-4111-8111-111111111111';
const employeeId = '82222222-2222-4222-8222-222222222222';
const secondEmployeeId = '85555555-5555-4555-8555-555555555555';
let project = projectFixture();
let pickerErrorEnabled = false;
let bulkDelayMs = 0;
const assignedUsers = new Set();
const pickerQueries = [];
const modePayloads = [];
const bulkPayloads = [];

try {
  await page.route('http://localhost:3000/**', async (route) => {
    if (await fulfillTrainingConfig(route, true)) return;

    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === '/auth/refresh') {
      await json(route, {
        accessToken: 'stage45-browser-access-token',
        user: {
          id: '83333333-3333-4333-8333-333333333333',
          email: 'stage45-admin@training.test',
          name: 'Stage 4.5 Admin',
          brokerPhone: null,
          brokerEmail: null,
          status: 'ACTIVE',
          role: { id: '84444444-4444-4444-8444-444444444444', name: 'admin' },
          profilePhotoFile: null,
          permissions: ['admin:access', 'training:participate', 'training:projects:manage'],
        },
      });
      return;
    }

    if (path === `/training/admin/projects/${projectId}` && request.method() === 'GET') {
      await json(route, project);
      return;
    }

    if (path === `/training/admin/projects/${projectId}` && request.method() === 'PATCH') {
      const payload = request.postDataJSON();
      modePayloads.push(payload);
      project = { ...project, accessMode: payload.accessMode };
      await json(route, project);
      return;
    }

    if (path === `/training/admin/projects/${projectId}/materials` && request.method() === 'GET') {
      await json(route, { items: [] });
      return;
    }

    if (path === `/training/admin/projects/${projectId}/object-options` && request.method() === 'GET') {
      await json(route, { items: [], selected: null });
      return;
    }

    if (path === `/training/admin/projects/${projectId}/assignment-users`) {
      pickerQueries.push(Object.fromEntries(url.searchParams.entries()));
      if (pickerErrorEnabled && url.searchParams.get('search') === 'ошибка') {
        await json(route, { message: 'PICKER_FIXTURE_ERROR' }, 500);
        return;
      }
      if (url.searchParams.get('search') === 'медленно') {
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      const empty = url.searchParams.get('search') === 'нет';
      const allItems = [
        {
          userId: employeeId,
          name: 'Анна Брокер',
          email: 'anna@example.test',
          status: 'ACTIVE',
          canParticipate: false,
          isAssigned: assignedUsers.has(employeeId),
          assignedAt: assignedUsers.has(employeeId) ? '2026-08-02T12:00:00.000Z' : null,
        },
        {
          userId: secondEmployeeId,
          name: 'Борис Агент',
          email: 'boris@example.test',
          status: 'ACTIVE',
          canParticipate: true,
          isAssigned: assignedUsers.has(secondEmployeeId),
          assignedAt: assignedUsers.has(secondEmployeeId) ? '2026-08-02T12:00:00.000Z' : null,
        },
      ];
      const assignmentFilter = url.searchParams.get('assigned');
      const filteredItems = allItems.filter((item) =>
        assignmentFilter === 'yes'
          ? item.isAssigned
          : assignmentFilter === 'no'
            ? !item.isAssigned
            : true,
      );
      await json(route, {
        items: empty ? [] : filteredItems,
        total: empty ? 0 : 21,
        page: Number(url.searchParams.get('page') ?? 1),
        limit: 20,
        totalPages: empty ? 0 : 2,
        activeAssignments: assignedUsers.size,
      });
      return;
    }

    if (path === `/training/admin/projects/${projectId}/assignments/bulk`) {
      const payload = request.postDataJSON();
      bulkPayloads.push(payload);
      if (bulkDelayMs) await new Promise((resolve) => setTimeout(resolve, bulkDelayMs));
      for (const userId of payload.userIds) {
        if (payload.action === 'ASSIGN') assignedUsers.add(userId);
        else assignedUsers.delete(userId);
      }
      await json(route, {
        assigned: payload.action === 'ASSIGN' ? payload.userIds.length : 0,
        revoked: payload.action === 'REVOKE' ? payload.userIds.length : 0,
        unchanged: 0,
        activeAssignments: assignedUsers.size,
      }, 201);
      return;
    }

    await json(route, { message: `Unexpected ${request.method()} ${path}` }, 404);
  });

  await page.goto(`${baseUrl}/admin/training/projects/${projectId}?theme=c`);
  assert.equal(await page.locator('html').getAttribute('data-app-theme'), 'dark-premium');
  await page.getByRole('tab', { name: 'Назначения' }).click();
  await page.getByText('Анна Брокер').waitFor();
  await page.getByText('Нет', { exact: true }).waitFor();
  await page.getByText(/нет активных назначений/iu).waitFor();

  const assignedMode = page.locator('.training-access-mode-option').filter({ hasText: 'Только назначенные сотрудники' });
  const allParticipantsMode = page.locator('.training-access-mode-option').filter({ hasText: 'Все участники обучения' });
  const assignedRadio = assignedMode.getByRole('radio');
  const allParticipantsRadio = allParticipantsMode.getByRole('radio');
  assert.equal(await assignedMode.getAttribute('data-selected'), 'true');
  assert.equal(await allParticipantsMode.getAttribute('data-selected'), 'false');
  assert.equal(await assignedRadio.getAttribute('data-state'), 'checked');
  assert.equal(await allParticipantsRadio.getAttribute('data-state'), 'unchecked');
  assert.equal(await assignedMode.getByText('Выбрано', { exact: true }).count(), 1);
  assert.ok(await contrastRatio(assignedMode.getByText('Выбрано', { exact: true })) >= 4.5);
  const assignedRadioBox = await assignedRadio.boundingBox();
  assert.ok(assignedRadioBox && assignedRadioBox.width >= 24 && assignedRadioBox.height >= 24);
  const [assignedModeStyles, allParticipantsModeStyles] = await Promise.all([
    assignedMode.evaluate((element) => {
      const styles = getComputedStyle(element);
      return { backgroundColor: styles.backgroundColor, borderColor: styles.borderColor, boxShadow: styles.boxShadow };
    }),
    allParticipantsMode.evaluate((element) => {
      const styles = getComputedStyle(element);
      return { backgroundColor: styles.backgroundColor, borderColor: styles.borderColor, boxShadow: styles.boxShadow };
    }),
  ]);
  assert.notEqual(assignedModeStyles.backgroundColor, allParticipantsModeStyles.backgroundColor);
  assert.notEqual(assignedModeStyles.borderColor, allParticipantsModeStyles.borderColor);
  assert.notEqual(assignedModeStyles.boxShadow, 'none');
  if (process.env.TRAINING_ACCESS_SCREENSHOT) {
    await page.locator('.training-access-mode-panel').screenshot({ path: process.env.TRAINING_ACCESS_SCREENSHOT });
  }

  await page.getByText('Все участники обучения').click();
  await page.getByText(/доступны всем сотрудникам/iu).waitFor();
  assert.deepEqual(modePayloads.at(-1), { accessMode: 'ALL_PARTICIPANTS' });
  assert.equal(project.isOpen, true);
  assert.equal(await assignedMode.getAttribute('data-selected'), 'false');
  assert.equal(await allParticipantsMode.getAttribute('data-selected'), 'true');
  assert.equal(await allParticipantsMode.getByText('Выбрано', { exact: true }).count(), 1);

  await page.getByText('Только назначенные сотрудники').click();

  await page.getByPlaceholder('Имя или электронная почта').fill('медленно');
  await page.locator('.training-assignment-skeleton').waitFor();
  await page.getByText('Анна Брокер').waitFor();

  pickerErrorEnabled = true;
  await page.getByPlaceholder('Имя или электронная почта').fill('ошибка');
  await page.getByText('PICKER_FIXTURE_ERROR').waitFor();
  pickerErrorEnabled = false;
  await page.getByRole('button', { name: 'Повторить' }).click();
  await page.getByText('Анна Брокер').waitFor();

  const assignmentFilter = page.locator('select.training-select');
  await assignmentFilter.selectOption('no');
  await page.getByText('Анна Брокер').waitFor();
  assert.equal(pickerQueries.at(-1).assigned, 'no');
  await page.getByRole('checkbox', { name: 'Выбрать всех сотрудников на текущей странице' }).check();
  await page.getByText('Выбрано на странице: 2').waitFor();
  bulkDelayMs = 500;
  await page.getByRole('button', { name: 'Назначить выбранных' }).click();
  await page.getByRole('button', { name: 'Назначаем…' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Назначаем…' }).isDisabled(), true);
  assert.equal(bulkPayloads.length, 1);
  await page.getByText(/Назначено: 2/).waitFor();
  bulkDelayMs = 0;
  assert.deepEqual(new Set(bulkPayloads.at(-1).userIds), new Set([employeeId, secondEmployeeId]));

  await assignmentFilter.selectOption('yes');
  await page.getByText('Выбрано на странице: 0').waitFor();
  assert.equal(pickerQueries.at(-1).assigned, 'yes');
  await page.getByRole('checkbox', { name: 'Выбрать Анна Брокер' }).check();
  await page.getByRole('button', { name: 'Снять выбранных' }).click();
  await page.getByText(/Отозвано: 1/).waitFor();
  assert.deepEqual(bulkPayloads.at(-1), { action: 'REVOKE', userIds: [employeeId] });

  await page.getByPlaceholder('Имя или электронная почта').fill('нет');
  await page.getByText('Сотрудники не найдены').waitFor();
  assert.equal(pickerQueries.at(-1).search, 'нет');

  await page.getByPlaceholder('Имя или электронная почта').fill('Анна');
  await assignmentFilter.selectOption('all');
  await page.getByText('Анна Брокер').waitFor();
  await page.getByRole('checkbox', { name: 'Выбрать Анна Брокер' }).check();
  await page.getByRole('button', { name: 'Далее' }).click();
  await page.getByText('Страница 2 из 2').waitFor();
  await page.getByText('Выбрано на странице: 0').waitFor();
  assert.equal(pickerQueries.at(-1).page, '2');

  await page.goto(`${baseUrl}/admin/training/projects/${projectId}?theme=d`);
  assert.equal(await page.locator('html').getAttribute('data-app-theme'), 'minimal-luxury');
  await page.getByRole('tab', { name: 'Назначения' }).click();
  const lightAssignedMode = page.locator('.training-access-mode-option').filter({ hasText: 'Только назначенные сотрудники' });
  const lightAllParticipantsMode = page.locator('.training-access-mode-option').filter({ hasText: 'Все участники обучения' });
  await lightAssignedMode.getByText('Выбрано', { exact: true }).waitFor();
  assert.ok(await contrastRatio(lightAssignedMode.getByText('Выбрано', { exact: true })) >= 4.5);
  const [lightAssignedBackground, lightAllBackground] = await Promise.all([
    lightAssignedMode.evaluate((element) => getComputedStyle(element).backgroundColor),
    lightAllParticipantsMode.evaluate((element) => getComputedStyle(element).backgroundColor),
  ]);
  assert.notEqual(lightAssignedBackground, lightAllBackground);
  if (process.env.TRAINING_ACCESS_LIGHT_SCREENSHOT) {
    await page.locator('.training-access-mode-panel').screenshot({ path: process.env.TRAINING_ACCESS_LIGHT_SCREENSHOT });
  }

  process.stdout.write('TRAINING_STAGE45_BROWSER_OK\n');
} finally {
  await browser.close();
}

function projectFixture() {
  return {
    id: projectId,
    realEstateObjectId: null,
    title: 'Проект назначений',
    description: null,
    status: 'PUBLISHED',
    accessMode: 'ASSIGNED_USERS',
    activeAssignments: 0,
    isOpen: true,
    sortOrder: 0,
    attemptLimit: 3,
    timeLimitSeconds: 420,
    passScore: 75,
    allowRetakeAfterPass: true,
    contentSchemaVersion: 3,
    mainQuestion: 'Главный вопрос',
    followUpQuestions: Array.from({ length: 10 }, (_, index) => `Вопрос ${index + 1}`),
    facts: [],
    criteria: [],
    publicationErrors: [],
    createdAt: '2026-08-02T10:00:00.000Z',
    updatedAt: '2026-08-02T10:00:00.000Z',
  };
}

async function json(route, body, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function contrastRatio(locator) {
  return locator.evaluate((element) => {
    const parseRgb = (value) => value.match(/[\d.]+/gu)?.slice(0, 3).map(Number) ?? [0, 0, 0];
    const luminance = (rgb) => {
      const channels = rgb.map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.03928
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const styles = getComputedStyle(element);
    const foreground = luminance(parseRgb(styles.color));
    const background = luminance(parseRgb(styles.backgroundColor));
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
}
