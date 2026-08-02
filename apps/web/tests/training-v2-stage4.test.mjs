import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = (path) => readFileSync(resolve(currentDir, `../src/${path}`), 'utf8');
const routesSource = source('training/TrainingRoutes.tsx');
const apiSource = source('training/trainingApi.ts');
const editorSource = source('training/TrainingAdminProjectEditorPage.tsx');
const panelSource = source('training/TrainingMaterialsPanel.tsx');
const viewSource = source('training/trainingView.ts');
const adminAttemptSource = source('training/TrainingAdminAttemptPage.tsx');
const employeeProjectsSource = source('training/TrainingProjectsPage.tsx');
const employeeAttemptSource = source('training/TrainingAttemptPage.tsx');
const stylesSource = source('training/training.css');

test('Stage 4 stays inside the existing admin editor and adds the explicit Platforma object import flow', () => {
  assert.match(editorSource, /TabsTrigger value="materials">Материалы/);
  assert.match(editorSource, /TrainingMaterialsPanel/);
  assert.doesNotMatch(routesSource, /materials|material-revisions/iu);
  assert.match(panelSource, /PDF: 'PDF'/);
  assert.match(panelSource, /OFFICIAL_URL: 'Официальный URL'/);
  assert.match(panelSource, /MANUAL_TEXT: 'Ручной текст'/);
  assert.match(panelSource, /OBJECT_SNAPSHOT: 'Карточка Platforma'/);
  assert.match(panelSource, /Подтверждаю, что это официальный источник проекта/);
  assert.match(panelSource, /PDF с текстовым слоем/);
  assert.match(panelSource, /Allowlisted поля карточки/);
  assert.match(panelSource, /Данные ЖК из Platforma/);
  assert.match(panelSource, /aria-label="Поиск ЖК"/);
  assert.match(panelSource, /role="combobox"/);
  assert.match(panelSource, /role="listbox"/);
  assert.match(panelSource, /Поиск понимает текст в другой раскладке/);
  assert.match(panelSource, /Загрузить данные и создать вопросы/);
  assert.match(panelSource, /Созданы 1 главный и 10 дополнительных черновиков вопросов/);
  assert.doesNotMatch(editorSource, /UUID связанного ЖК|training-object-id/);
});

test('material UI covers loading, empty, failed extraction, revisions, bounded diff and manual suggestions', () => {
  assert.match(panelSource, /training-materials-skeleton/);
  assert.match(panelSource, /Источников пока нет/);
  assert.match(panelSource, /setError\(loadError/);
  assert.match(panelSource, /selectedRevision\.status === 'FAILED'/);
  assert.match(panelSource, /PDF_TEXT_LAYER_MISSING|MATERIAL_EXTRACTION_FAILED/);
  assert.match(panelSource, /training-material-segments/);
  assert.match(panelSource, /Без изменений:/);
  assert.match(panelSource, /Добавленные segments/);
  assert.match(panelSource, /setSelectedRevisionId\(revision\.id\)/);
  assert.match(panelSource, /Сгенерировать/);
  assert.match(panelSource, /Применить выбранные/);
  assert.match(panelSource, /Дубликатов пропущено/);
  assert.match(panelSource, /AI-черновики не участвуют в публикации до ручного apply/);
  assert.match(stylesSource, /training-revision-button--active/);
  assert.match(stylesSource, /training-material-url-meta/);
});

test('admin API owns the complete resource boundary and private PDF download keeps refresh retry', () => {
  assert.match(apiSource, /JSON\.stringify\(\{ type: 'MANUAL_TEXT'/);
  assert.match(apiSource, /JSON\.stringify\(\{ type: 'OFFICIAL_URL'/);
  assert.match(apiSource, /JSON\.stringify\(\{ type: 'OBJECT_SNAPSHOT'/);
  assert.match(apiSource, /\/object-options\$\{suffix\}/);
  assert.match(apiSource, /query\.set\('search', search\.trim\(\)\)/);
  assert.match(apiSource, /\/import-object/);
  assert.match(apiSource, /JSON\.stringify\(input\)/);
  assert.match(apiSource, /\/materials\/pdf/);
  assert.match(apiSource, /\/materials\/\$\{encodeURIComponent\(materialId\)\}\/revisions/);
  assert.match(apiSource, /\/material-revisions\/\$\{encodeURIComponent\(revisionId\)\}\/suggestions/);
  assert.match(apiSource, /\/material-revisions\/\$\{encodeURIComponent\(revisionId\)\}\/apply-suggestions/);
  assert.match(apiSource, /apiResponse\(/);
  assert.doesNotMatch(apiSource, /fetch\(\s*`\$\{apiUrl\}\/training\/admin\/materials/);
});

test('source badges are admin-only and editor saves cannot overwrite provenance fields', () => {
  assert.match(editorSource, /sourceType === 'MATERIAL'/);
  assert.match(editorSource, /sourceExcerpt/);
  assert.match(editorSource, /formatTrainingFactSourceBadge/);
  assert.match(adminAttemptSource, /sourceExcerpt/);
  assert.match(adminAttemptSource, /formatTrainingFactSourceBadge/);
  assert.match(viewSource, /PDF · \$\{formatLocator/);
  assert.match(viewSource, /URL · \$\{formatSourceUrl/);
  assert.match(viewSource, /Platforma · \$\{formatObjectField/);
  const updateMapper = editorSource.match(/function toUpdateRequest[\s\S]*?\n\}/u)?.[0] ?? '';
  assert.ok(updateMapper);
  assert.doesNotMatch(updateMapper, /sourceType|sourceRevisionId|sourceLabel|sourceLocator|sourceExcerpt/);
  assert.doesNotMatch(employeeProjectsSource, /TrainingMaterialsPanel|training\/admin\/materials|sourceRevision/);
  assert.doesNotMatch(employeeAttemptSource, /TrainingMaterialsPanel|training\/admin\/materials|sourceRevision/);
});
