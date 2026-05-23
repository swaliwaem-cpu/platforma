import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(currentDir, '../src/admin/FeedsAdminPage.tsx');

test('feeds admin page source exists', () => {
  assert.equal(existsSync(sourcePath), true);
});

test('feeds admin page wires source CRUD, preview, run, reports, and units API calls', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /apiRequest<FeedSourcesResponse>\(`\/feeds\/sources\?\$\{params\.toString\(\)\}`/);
  assert.match(source, /apiRequest<FeedSourceResponse>\('\/feeds\/sources'/);
  assert.match(source, /method:\s*'POST'/);
  assert.match(source, /apiRequest<FeedSourceResponse>\(`\/feeds\/sources\/\$\{sourceId\}`/);
  assert.match(source, /method:\s*'PATCH'/);
  assert.match(source, /apiRequest<FeedImportRunResponse>\(`\/feeds\/sources\/\$\{sourceId\}\/preview`/);
  assert.match(source, /apiRequest<FeedImportRunResponse>\(`\/feeds\/sources\/\$\{sourceId\}\/run`/);
  assert.match(source, /apiRequest<FeedImportRunsResponse>\(`\/feeds\/sources\/\$\{sourceId\}\/runs\?\$\{params\.toString\(\)\}`/);
  assert.match(source, /apiRequest<FeedImportRunResponse>\(`\/feeds\/runs\/\$\{runId\}`/);
  assert.match(source, /apiRequest<FeedUnitsResponse>\(`\/feeds\/units\?\$\{params\.toString\(\)\}`/);
});

test('feeds admin page exposes required source form fields and unit filters', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /name="sourceKind"/);
  assert.match(source, /name="url"/);
  assert.match(source, /name="xmlFile"/);
  assert.match(source, /name="format"/);
  assert.match(source, /name="developerId"/);
  assert.match(source, /name="objectId"/);
  assert.match(source, /name="isActive"/);
  assert.match(source, /aria-label="Фильтр лотов по статусу"/);
  assert.match(source, /aria-label="Фильтр лотов по типу"/);
});

test('feeds admin page submits multipart form data for uploaded XML sources', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /xmlFile: File \| null/);
  assert.match(source, /const formData = new FormData\(\)/);
  assert.match(source, /formData\.append\('sourceKind', form\.sourceKind\)/);
  assert.match(source, /formData\.append\('xmlFile', form\.xmlFile\)/);
  assert.match(source, /body: createSourceRequestBody\(form\)/);
  assert.match(source, /source\.sourceKind === 'FILE'/);
});

test('feeds admin page loads every object page for the linked object selector', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /const objectDirectoryPageSize = 100/);
  assert.match(source, /async function loadObjectDirectoryPages\(accessToken: string\)/);
  assert.match(source, /page: String\(page\)/);
  assert.match(source, /page <= firstPage\.totalPages/);
  assert.match(source, /flatMap\(\(page\) => page\.items\)/);
  assert.doesNotMatch(source, /apiRequest<ObjectsResponse>\('\/objects\?limit=500&sortBy=title&sortDirection=asc'/);
});

test('feeds admin page renders report details with summary, warnings, errors, and unit table labels', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /<ReportSummary summary=\{selectedRunSummary\} \/>/);
  assert.match(source, /<ReportIssues title="Warnings" issues=\{selectedRunWarnings\} \/>/);
  assert.match(source, /<ReportIssues title="Errors" issues=\{selectedRunErrors\} \/>/);
  assert.match(source, />Статус</);
  assert.match(source, />Цена</);
  assert.match(source, />Площадь</);
  assert.match(source, />Комнаты\/тип</);
  assert.match(source, />Медиа</);
});
