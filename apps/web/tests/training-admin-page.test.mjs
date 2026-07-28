import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const pageSource = readFileSync(
  resolve(currentDir, '../src/training/TrainingAdminPage.tsx'),
  'utf8',
);
const apiSource = readFileSync(
  resolve(currentDir, '../src/training/trainingAdminApi.ts'),
  'utf8',
);
const stylesSource = readFileSync(
  resolve(currentDir, '../src/training/trainingAdmin.css'),
  'utf8',
);
const sharedApiSource = readFileSync(
  resolve(currentDir, '../src/admin/api.ts'),
  'utf8',
);

test('training admin exposes the seven approved content sections', () => {
  for (const label of [
    'Основное',
    'Материалы',
    'Главный вопрос',
    'Дополнительные вопросы',
    'Факты',
    'Критерии',
    'Проверка / публикация',
  ]) {
    assert.match(pageSource, new RegExp(`label: '${label.replace('/', '\\/')}'`));
  }
});

test('training admin uses AdminUi, shadcn fields and the existing apiRequest client', () => {
  assert.match(pageSource, /AdminPanel/);
  assert.match(pageSource, /AdminButton/);
  assert.match(pageSource, /AdminStatusBadge/);
  assert.match(pageSource, /from '\.\.\/components\/ui\/field'/);
  assert.match(apiSource, /import \{ apiDownload, apiRequest \} from '\.\.\/admin\/api';/);
  assert.doesNotMatch(pageSource, /react-router/);
});

test('project editor supports draft CRUD, optional object links and strict publication', () => {
  assert.match(apiSource, /realEstateObjectId:\s*string \| null/);
  assert.match(apiSource, /\/real-estate-objects\?limit=100/);
  assert.match(apiSource, /\/draft-version/);
  assert.match(apiSource, /\/questions/);
  assert.match(apiSource, /\/facts/);
  assert.match(apiSource, /\/criteria/);
  assert.match(apiSource, /\/publish/);
  assert.match(pageSource, /Все факты должны быть подтверждены администратором/);
  assert.match(pageSource, /allErrors\.length > 0/);
});

test('document UI covers upload, statuses, preview, manual text, retry and protected download', () => {
  assert.match(pageSource, /accept="\.pdf,\.docx,\.pptx,\.xlsx"/);
  assert.match(pageSource, /documentStatusLabels/);
  assert.match(pageSource, /getTrainingDocumentText/);
  assert.match(pageSource, /updateTrainingDocumentText/);
  assert.match(pageSource, /retryTrainingDocument/);
  assert.match(pageSource, /downloadTrainingDocument/);
  assert.match(pageSource, /Извлечённый текст используется только как черновой материал/);
  assert.match(pageSource, /Только подтверждённые администратором факты участвуют в оценивании/);
});

test('structured API errors are retained for validation UI', () => {
  assert.match(sharedApiSource, /export class ApiRequestError extends Error/);
  assert.match(sharedApiSource, /readonly errors: string\[\]/);
  assert.match(sharedApiSource, /data\.errors/);
  assert.match(pageSource, /caughtError instanceof ApiRequestError/);
});

test('training admin layout is responsive and respects reduced motion', () => {
  assert.match(stylesSource, /@media \(max-width: 760px\)/);
  assert.match(stylesSource, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(stylesSource, /overflow-x: auto/);
  assert.match(stylesSource, /var\(--app-theme-surface/);
});

test('editor uses an accessible master-detail pattern without unmounting drafts', () => {
  assert.match(pageSource, /className="training-master-detail"/);
  assert.match(pageSource, /data-training-master-detail/);
  assert.match(pageSource, /data-editor-item-id=\{item\.id\}/);
  assert.match(pageSource, /aria-current=\{selected \? 'true' : undefined\}/);
  assert.match(pageSource, /data-editor-panel-id=\{id\}/);
  assert.match(pageSource, /hidden=\{id !== selectedId\}/);
  assert.match(stylesSource, /\[data-editor-panel-id\]\[hidden\]/);
  assert.doesNotMatch(pageSource, /training-criteria-columns/);
});

test('training checkboxes stay next to their labels and facts expose semantic relations', () => {
  assert.match(pageSource, /function TrainingCheckboxRow/);
  assert.match(pageSource, /className="training-checkbox-control"/);
  assert.match(stylesSource, /\.training-admin \.training-checkbox-control/);
  assert.match(stylesSource, /width: 18px/);
  assert.match(pageSource, /<fieldset className="training-linked-questions/);
  assert.match(pageSource, /<legend>Связанные вопросы<\/legend>/);
  assert.doesNotMatch(pageSource, /orientation="horizontal"/);
});
