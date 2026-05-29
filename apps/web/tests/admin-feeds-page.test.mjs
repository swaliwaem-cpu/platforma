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
  assert.match(source, /apiRequest<FeedSourceAnalysisResponse>\('\/feeds\/analyze'/);
  assert.match(source, /apiRequest<FeedImportRunResponse>\(`\/feeds\/sources\/\$\{sourceId\}\/preview`/);
  assert.match(source, /apiRequest<FeedImportRunResponse>\(`\/feeds\/sources\/\$\{sourceId\}\/run`/);
  assert.match(source, /apiRequest<FeedImportRunResponse>\(`\/feeds\/runs\/\$\{selectedRun\.id\}\/stop`/);
  assert.match(source, /apiRequest<FeedImportRunsResponse>\(`\/feeds\/sources\/\$\{sourceId\}\/runs\?\$\{params\.toString\(\)\}`/);
  assert.match(source, /apiRequest<FeedImportRunResponse>\(`\/feeds\/runs\/\$\{runId\}`/);
  assert.match(source, /apiRequest<FeedUnitsResponse>\(`\/feeds\/units\?\$\{params\.toString\(\)\}`/);
});

test('feeds admin page exposes required source form fields and unit filters', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /name="feedSourceInput"/);
  assert.match(source, /className="feed-source-input-row"/);
  assert.match(source, /aria-label="Загрузить XML-файл"/);
  assert.match(source, /name="xmlFile"/);
  assert.doesNotMatch(source, /name="format"/);
  assert.match(source, /name="filterJson"/);
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
  assert.match(source, /const sourceKind = getConcreteFeedSourceKind\(form\)/);
  assert.match(source, /formData\.append\('sourceKind', sourceKind\)/);
  assert.match(source, /formData\.append\('filterJson', form\.filterJson\.trim\(\)\)/);
  assert.match(source, /formData\.append\('mappings', JSON\.stringify\(selectedMappings\)\)/);
  assert.match(source, /formData\.append\('xmlFile', form\.xmlFile\)/);
  assert.match(source, /body: createSourceRequestBody\(form\)/);
  assert.match(source, /source\.sourceKind === 'FILE'/);
});

test('feeds admin page includes Yandex source filter help fields', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /filterJson: string;/);
  assert.match(source, /mappings: SourceMappingFormState\[\];/);
  assert.match(source, /Фильтр Yandex/);
  assert.match(source, /Разбор фида/);
  assert.match(source, /Исключить из загрузки/);
  assert.match(source, /onMappingChange/);
  assert.match(source, /developerName/);
  assert.match(source, /objects\.map\(\(feedObject\) =>/);
  assert.match(source, /buildingNames/);
  assert.match(source, /yandexBuildingIds/);
  assert.match(source, /yandexHouseIds/);
  assert.match(source, /addressIncludes/);
});

test('feeds admin page includes CIAN project mapping fields in source analysis', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /projectNames/);
  assert.match(source, /externalIds/);
  assert.match(source, />Предупреждения</);
  assert.doesNotMatch(source, /<dt>Warnings<\/dt>/);
});

test('feeds admin page includes Avito development id mapping fields', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /avitoDevelopmentIds/);
  assert.match(source, /developmentIds:/);
});

test('feeds admin page defaults new feed sources to automatic format detection', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /const emptySourceForm[\s\S]*?format:\s*'AUTO',\n\s*filterJson:/);
});

test('feeds admin page hides manual format and index platform selection', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.doesNotMatch(source, />Формат</);
  assert.doesNotMatch(source, /feedFormatChoiceLabels/);
  assert.doesNotMatch(source, /sourceDiscovery/);
  assert.doesNotMatch(source, /function FeedSourceDiscoveryPanel/);
  assert.doesNotMatch(source, /onSelectPlatform/);
  assert.doesNotMatch(source, /platforms\.map\(\(platform\) =>/);
  assert.doesNotMatch(source, /Выбрать площадку/);
});

test('feeds admin page keeps auto format analysis-only and conservative automapping explicit', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /formData\.append\('format', 'AUTO'\)/);
  assert.match(source, /createSourceAnalysisFormAttempts/);
  assert.match(source, /findFeedDeveloperSuggestion/);
  assert.match(source, /findFeedObjectSuggestion/);
  assert.match(source, /objectId: findFeedObjectSuggestion/);
});

test('feeds admin page automaps sheet objects before deriving developer from mapped objects', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /const initialObjectOptions = developerId[\s\S]*: objects/);
  assert.match(source, /const mappedDeveloperId = findMappedDeveloperSuggestion/);
  assert.match(source, /developerId: developerId \|\| mappedDeveloperId/);
  assert.match(source, /function findMappedDeveloperSuggestion/);
});

test('feeds admin page shows linked developer in analysis summary when feed omits developer', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /selectedDeveloper={developers\.find\(\(developer\) => developer\.id === form\.developerId\) \?\? null}/);
  assert.match(source, /const analysisDeveloperName = analysis\?\.developerName \?\? selectedDeveloper\?\.name \?\? null/);
  assert.match(source, /analysisDeveloperName \?\? 'Застройщик не указан'/);
  assert.match(source, /analysisDeveloperName \?\? 'не указан'/);
});

test('feeds admin page clears fallback object when analysis mappings exist', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /objectId: mappings\.length > 0 \? '' : currentForm\.objectId/);
  assert.match(source, /const objectId = selectedMappings\.length > 0 \? '' : form\.objectId/);
  assert.match(source, /formData\.append\('objectId', objectId\)/);
});

test('feeds admin page keeps raw Yandex filter hidden until it has data', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /const hasFilterJson = form\.filterJson\.trim\(\)\.length > 0/);
  assert.match(source, /hasFilterJson \? \(/);
  assert.match(source, /Очистить фильтр/);
});

test('feeds admin page uses one source input row instead of source kind buttons', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /key="feed-source-input"/);
  assert.match(source, /key="feed-source-file-input"/);
  assert.doesNotMatch(source, /role="radiogroup"/);
  assert.doesNotMatch(source, /feed-source-kind-option/);
  assert.doesNotMatch(source, />Способ</);
});

test('feeds admin page auto-detects URL feed kind before falling back to index XML', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /createSourceAnalysisFormAttempts\(form\)/);
  assert.match(source, /sourceKind:\s*'URL'/);
  assert.match(source, /sourceKind:\s*'INDEX_URL'/);
  assert.match(source, /resolvedAnalysisForm/);
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

test('feeds admin page renders reports table without the right report detail column', () => {
  const source = readFileSync(sourcePath, 'utf8');
  const reportsIndex = source.indexOf('<AdminPanel className="table-panel feed-runs-panel"');
  const runControlsIndex = source.indexOf('<SourceRunControlPanel');
  const sourceSidePanelIndex = source.indexOf('<AdminPanel className="editor-panel feed-source-side-panel"');

  assert.match(source, /<AdminPanel className="table-panel feed-runs-panel"/);
  assert.match(source, /<span>\{isLoadingRuns \? 'Загрузка отчётов' : `Отчётов: \$\{runsTotal\}`\}<\/span>/);
  assert.ok(reportsIndex > runControlsIndex);
  assert.ok(reportsIndex < sourceSidePanelIndex);
  assert.doesNotMatch(source, /feed-reports-layout/);
  assert.doesNotMatch(source, /feed-run-detail-panel/);
  assert.doesNotMatch(source, /aria-label="Детали отчёта фида"/);
  assert.doesNotMatch(source, /<ReportSummary summary=\{selectedRunSummary\} \/>/);
  assert.match(source, />Статус</);
  assert.match(source, />Цена</);
  assert.match(source, />Цена за м²</);
  assert.match(source, />Площадь</);
  assert.match(source, />Комнаты\/тип</);
  assert.match(source, />Медиа</);
  assert.match(source, /<TableCell>\{formatFeedUnitPricePerMeter\(unit\)\}<\/TableCell>/);
});

test('feeds admin page shows latest preview lot and media counts in source meta', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /type FeedSourceMetaSummaryMap = Record<string, Record<string, unknown>>/);
  assert.match(source, /const \[sourceMetaSummaries, setSourceMetaSummaries\] = useState<FeedSourceMetaSummaryMap>\(\{\}\)/);
  assert.match(source, /async function loadLatestSourceMetaRun\(sourceId: string\)/);
  assert.match(source, /limit:\s*'20'/);
  assert.match(source, /rememberSourceMetaSummaryFromRuns\(sourceId, data\.items\)/);
  assert.match(source, /const editorSourceMetaSummary = editorSource \? sourceMetaSummaries\[editorSource\.id\] \?\? null : null/);
  assert.match(source, /const selectedSourceMetaSummary = selectedSource \? sourceMetaSummaries\[selectedSource\.id\] \?\? null : null/);
  assert.match(source, /<SourceMeta source=\{editorSource\} metaSummary=\{editorSourceMetaSummary\} \/>/);
  assert.match(source, /function SourceMeta\(\{ source, metaSummary \}/);
  assert.match(source, /const previewMetrics = getFeedPreviewMetrics\(metaSummary\)/);
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
  assert.match(source, /function hasFeedMetaMetrics/);
  assert.match(source, /Object\.values\(metrics\)\.some\(\(value\) => value !== null\)/);
});

test('feeds admin page reports pending run commands as started instead of finished', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /setNotice\(getFeedCommandNotice\(mode, data\.run\.status\)\)/);
  assert.match(source, /Run фида запущен/);
});

test('feeds admin page polls pending runs and renders compact run progress', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /const feedRunPollMs = 2000/);
  assert.match(source, /selectedRun\.status !== 'PENDING'/);
  assert.match(source, /apiRequest<FeedImportRunResponse>\(`\/feeds\/runs\/\$\{selectedRun\.id\}`/);
  assert.match(source, /function FeedRunProgressCard/);
  assert.match(source, /role="progressbar"/);
  assert.match(source, /aria-valuemax=\{100\}/);
  assert.match(source, />Осталось мин:</);
  assert.match(source, /getFeedRunProgress\(selectedRun, source\.id\)/);
  assert.match(source, /formatRemainingProgressMinutes/);
});

test('feeds admin page keeps source run controls and persistent progress below the source list', () => {
  const source = readFileSync(sourcePath, 'utf8');

  assert.match(source, /<SourceRunControlPanel[\s\S]*source=\{selectedSource\}/);
  assert.match(source, /className="feed-source-run-panel"/);
  assert.match(source, /aria-label="Запуск выбранного фида"/);
  assert.match(source, /progress \? getFeedRunProgressPercent\(progress\) : 0/);
  assert.match(source, /progress \? getFeedRunProgressStageLabel\(progress\.stage\) : 'Ожидает запуска Run'/);
  assert.match(source, /stage === 'QUEUED'/);
  assert.match(source, /В очереди на импорт/);
  assert.match(source, /const canStopRun = Boolean/);
  assert.match(source, /<SquareIcon data-icon="inline-start" \/>/);
  assert.match(source, /stoppingRunId \? 'Stop\.\.\.' : 'Stop'/);
  assert.match(source, /stage === 'STOPPED'/);
  assert.match(source, /Импорт остановлен/);
  assert.match(source, /rememberSourceMetaSummary\(data\.run\)/);
  assert.match(source, /rememberSourceMetaSummary\(run\)/);
  assert.match(source, /runSourceCommand\(selectedSource\.id, 'preview'\)/);
  assert.match(source, /runSourceCommand\(selectedSource\.id, 'run'\)/);
  assert.doesNotMatch(source, /runSourceCommand\(editorSource\.id, 'run'\)/);
  assert.doesNotMatch(source, /<SourceRunProgress source=\{editorSource\} selectedRun=\{selectedRun\} \/>/);
});
