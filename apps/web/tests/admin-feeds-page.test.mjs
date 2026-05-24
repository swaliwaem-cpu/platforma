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

test('feeds admin page filters linked object options by selected developer', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /const filteredObjects = useMemo\(\(\) =>/);
  assert.match(source, /object\.developer\?\.id === form\.developerId/);
  assert.match(source, /const selectedObjectMatchesDeveloper =/);
  assert.match(source, /objectId: selectedObjectMatchesDeveloper \? currentForm\.objectId : ''/);
  assert.match(source, /filteredObjects\.map\(\(object\) =>/);
  assert.doesNotMatch(source, /objects\.map\(\(object\) =>/);
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

test('feeds admin page shows latest preview lot and media counts in source meta', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /async function loadLatestPreviewRun\(sourceId: string\)/);
  assert.match(source, /mode:\s*'preview'/);
  assert.match(source, /<SourceMeta source=\{editorSource\} previewSummary=\{editorPreviewSummary\} \/>/);
  assert.match(source, /function SourceMeta\(\{ source, previewSummary \}/);
  assert.match(source, /const previewMetrics = getFeedPreviewMetrics\(previewSummary\)/);
  assert.match(source, />Лотов к загрузке</);
  assert.match(source, />Медиа к загрузке</);
  assert.match(source, />Новые лоты</);
  assert.match(source, />Обновятся</);
  assert.match(source, />В архив</);
  assert.match(source, />Новые медиа</);
  assert.match(source, />Медиа уже есть</);
  assert.match(source, /unitsParsed/);
  assert.match(source, /summary\?\.created/);
  assert.match(source, /summary\?\.updated/);
  assert.match(source, /summary\?\.archived/);
  assert.match(source, /media\.created/);
  assert.match(source, /media\.existing/);
});

test('feeds admin page reports pending run commands as started instead of finished', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /setNotice\(getFeedCommandNotice\(mode, data\.run\.status\)\)/);
  assert.match(source, /Run фида запущен/);
});
