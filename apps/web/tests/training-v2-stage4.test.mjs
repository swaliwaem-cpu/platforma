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
  assert.match(editorSource, /Эталонный ответ · проверяемые факты/);
  assert.match(editorSource, /Эталонный ответ вопроса/);
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
  assert.match(panelSource, /Создать вопросы и ответы из данных ЖК/);
  assert.match(panelSource, /Созданы 1 главный и 10 дополнительных вопросов с активными эталонными ответами/);
  assert.doesNotMatch(editorSource, /UUID связанного ЖК|training-object-id/);
});

test('material UI covers loading, auto questions, failed extraction, revisions and guarded fact generation', () => {
  assert.match(panelSource, /training-materials-skeleton/);
  assert.match(panelSource, /Источников пока нет/);
  assert.match(panelSource, /setError\(loadError/);
  assert.match(panelSource, /selectedRevision\.status === 'FAILED'/);
  assert.match(panelSource, /PDF_TEXT_LAYER_MISSING|MATERIAL_EXTRACTION_FAILED/);
  assert.match(panelSource, /training-material-segments/);
  assert.match(panelSource, /Без изменений:/);
  assert.match(panelSource, /Добавленные segments/);
  assert.match(panelSource, /setSelectedRevisionId\(revision\.id\)/);
  assert.match(panelSource, /Сгенерировать дополнительные факты/);
  assert.match(panelSource, /Сначала создайте вопросы проекта/);
  assert.match(panelSource, /disabled=\{disabled \|\| !hasQuestions/);
  assert.match(panelSource, /Применить выбранные/);
  assert.match(panelSource, /Дубликатов пропущено/);
  assert.match(panelSource, /новые AI-факты не участвуют в публикации до ручного применения/);
  assert.match(panelSource, /Сформированы 1 главный и 10 дополнительных вопросов с активными эталонными ответами/);
  assert.match(panelSource, /Заменить их новыми AI-черновиками/);
  assert.doesNotMatch(panelSource, /Утверждённые факты не удаляются/);
  assert.match(panelSource, /PROJECT_QUESTIONS_REPLACE_CONFIRMATION_REQUIRED/);
  assert.match(panelSource, /createMaterial\(true\)/);
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
  assert.match(apiSource, /form\.set\('replaceExistingQuestions', String\(replaceExistingQuestions\)\)/);
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
