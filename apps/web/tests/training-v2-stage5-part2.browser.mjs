import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { fulfillTrainingConfig } from './training-v2-browser-config-fixture.mjs';

const baseUrl = process.env.TRAINING_WEB_TEST_URL;
if (!baseUrl) throw new Error('TRAINING_WEB_TEST_URL is required');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const queries = [];
const exportQueries = [];
let exportReads = 0;
let initialDelay = true;

try {
  await page.route('http://localhost:3000/**', async (route) => {
    if (await fulfillTrainingConfig(route, true)) return;

    const url = new URL(route.request().url());
    if (url.pathname === '/auth/refresh') return json(route, { accessToken: 'ranking-token', user: { id: '1', email: 'admin@test', name: 'Admin', status: 'ACTIVE', role: { id: '1', name: 'admin' }, permissions: ['admin:access', 'training:results:read'] } });
    if (url.pathname === '/training/admin/ranking') {
      queries.push(Object.fromEntries(url.searchParams.entries()));
      if (initialDelay) { initialDelay = false; await new Promise((resolve) => setTimeout(resolve, 150)); }
      const search = url.searchParams.get('search');
      if (search === 'error') return json(route, { message: 'RANKING_FAILED' }, 500);
      return json(route, { items: search === 'empty' ? [] : [fixture(), fixture('u2', 'Борис Брокер', '75.00')], total: search === 'empty' ? 0 : 21, page: Number(url.searchParams.get('page') ?? 1), limit: 20, totalPages: search === 'empty' ? 0 : 2 });
    }
    if (url.pathname === '/training/admin/ranking/export.csv') {
      exportReads += 1;
      exportQueries.push(Object.fromEntries(url.searchParams.entries()));
      return route.fulfill({ status: 200, contentType: 'text/csv; charset=utf-8', body: '\uFEFF"name"\r\n"Анна"\r\n' });
    }
    return json(route, { message: `Unexpected ${url.pathname}` }, 404);
  });

  await page.goto(`${baseUrl}/admin/training/ranking`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Загрузка рейтинга').waitFor();
  await page.getByText('Рейтинг сотрудников').waitFor();
  await page.getByText('Анна Брокер').waitFor();
  assert.deepEqual(await page.locator('tbody tr td:first-child strong').allTextContents(), ['1. Анна Брокер', '2. Борис Брокер']);
  await page.getByText('87.50%').waitFor();
  await page.getByText('По проектам').first().click();
  await page.getByText('Проект А').first().waitFor();
  await page.getByRole('button', { name: 'Далее' }).click();
  await page.getByText('Страница 2 из 2').waitFor();
  assert.equal(queries.at(-1).page, '2');
  await page.getByLabel('Сотрудник').fill('empty');
  await page.getByLabel('Сейчас доступно').selectOption('true');
  await page.getByRole('button', { name: 'Применить' }).click();
  await page.getByText('Рейтинг пуст').waitFor();
  assert.equal(queries.at(-1).currentlyEligible, 'true');
  await page.getByRole('button', { name: 'Скачать CSV' }).click();
  await page.waitForTimeout(50);
  assert.equal(exportReads, 1);
  assert.equal(exportQueries[0].search, 'empty');
  assert.equal(exportQueries[0].currentlyEligible, 'true');
  await page.getByLabel('Сотрудник').fill('error');
  await page.getByRole('button', { name: 'Применить' }).click();
  await page.getByText('RANKING_FAILED').waitFor();
  assert.equal(await page.getByText('Анна Брокер').count(), 0);
  await page.setViewportSize({ width: 500, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  process.stdout.write('TRAINING_STAGE5_PART2_BROWSER_OK\n');
} finally {
  await browser.close();
}

function fixture(id = 'u1', name = 'Анна Брокер', coverage = '87.50') {
  return { user: { id, email: `${id}@test`, name }, passedProjectsCount: 2, completedProjectsCount: 2, averageBestScore: '91.50', attemptsUsed: 3, lastCompletedAt: '2026-08-02T10:00:00.000Z', totalDurationSeconds: 240, averageDurationSeconds: '120.00', currentEligibleProjectsCount: 8, currentCompletedEligibleProjectsCount: 7, currentPassedEligibleProjectsCount: 6, currentCoveragePercent: coverage, currentAccess: { allParticipantsProjectsCount: 5, assignedProjectsCount: 3, activeAssignmentsCount: 3 }, bestResults: [{ attemptId: `a-${id}`, projectId: `p-${id}`, projectTitle: 'Проект А', accessMode: 'ASSIGNED_USERS', assignmentStatus: 'ASSIGNED', currentlyEligible: true, finalScore: 95, isPassed: true, completedAt: '2026-08-02T10:00:00.000Z', durationSeconds: 120, factualErrorsCount: 0, unsupportedClaimsCount: 0, harmlessExtraClaimsCount: 0, reviewRequiredClaimsCount: 0 }], summary: { text: 'Стабильный результат.', strongestCriterion: null, weakestCriterion: null, factualErrorsCount: 0, unsupportedClaimsCount: 0, harmlessExtraClaimsCount: 0, reviewRequiredClaimsCount: 0 } };
}

async function json(route, body, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}
