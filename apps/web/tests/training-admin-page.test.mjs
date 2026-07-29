import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(
  resolve(currentDir, '../src/App.tsx'),
  'utf8',
);
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
const wizardSource = readFileSync(
  resolve(currentDir, '../src/training/TrainingWizardNav.tsx'),
  'utf8',
);
const pickerSource = readFileSync(
  resolve(currentDir, '../src/training/TrainingSearchPicker.tsx'),
  'utf8',
);
const readinessSource = readFileSync(
  resolve(currentDir, '../src/training/TrainingReadiness.tsx'),
  'utf8',
);
const evaluationSource = readFileSync(
  resolve(currentDir, '../src/training/QuestionEvaluationContext.tsx'),
  'utf8',
);
const uploadQueueSource = readFileSync(
  resolve(currentDir, '../src/training/trainingUploadQueue.ts'),
  'utf8',
);
const sharedApiSource = readFileSync(
  resolve(currentDir, '../src/admin/api.ts'),
  'utf8',
);

test('training admin exposes the seven-step project setup wizard', () => {
  for (const label of [
    'Основные данные',
    'Источники',
    'Предложенные факты',
    'Участники',
    'Вопросы',
    'Критерии',
    'Проверка',
  ]) {
    assert.match(wizardSource, new RegExp(`label: '${label}'`));
  }
  assert.match(pageSource, /data-wizard-step="main"/);
  assert.match(pageSource, /data-wizard-step="assignments"/);
  assert.match(pageSource, /hidden=\{activeStep !== 'questions'\}/);
  assert.match(wizardSource, /aria-current=\{current \? 'step' : undefined\}/);
});

test('training admin uses AdminUi, shadcn fields and the existing apiRequest client', () => {
  assert.match(pageSource, /AdminPanel/);
  assert.match(pageSource, /AdminButton/);
  assert.match(pageSource, /AdminStatusBadge/);
  assert.match(pageSource, /from '\.\.\/components\/ui\/field'/);
  assert.match(apiSource, /import \{ apiDownload, apiRequest \} from '\.\.\/admin\/api';/);
  assert.doesNotMatch(pageSource, /react-router/);
});

test('project editor supports working-revision CRUD, optional object links and strict publication', () => {
  assert.match(apiSource, /realEstateObjectId:\s*string \| null/);
  assert.match(apiSource, /\/real-estate-objects\?\$\{query\.toString\(\)\}/);
  assert.match(apiSource, /\/draft-version/);
  assert.match(apiSource, /\/questions/);
  assert.match(apiSource, /\/facts/);
  assert.match(apiSource, /\/criteria/);
  assert.match(apiSource, /\/publish/);
  assert.match(pageSource, /Все факты должны быть подтверждены администратором/);
  assert.match(pageSource, /allErrors\.length > 0/);
  assert.match(pageSource, /Рабочая редакция/);
  assert.match(pageSource, /Редактировать/);
  assert.doesNotMatch(pageSource, />Создать draft</i);
  assert.doesNotMatch(pageSource, />Новый draft</i);
  assert.match(pageSource, /Позиция в списке проектов/);
  assert.match(pageSource, /Позиция в списке критериев/);
});

test('source UI covers bounded batch upload, URL snapshots and protected document operations', () => {
  assert.match(pageSource, /type="file"[\s\S]{0,80}multiple/);
  assert.match(pageSource, /type="file"[\s\S]{0,80}tabIndex=\{-1\}/);
  assert.match(pageSource, /accept="\.pdf,\.docx,\.pptx,\.xlsx"/);
  assert.match(pageSource, /не более 20 файлов/);
  assert.match(pageSource, /Повторить ошибки/);
  assert.match(pageSource, /runTrainingUploadQueue/);
  assert.match(uploadQueueSource, /concurrency = 2/);
  assert.match(uploadQueueSource, /item\.status = 'FAILED'/);
  assert.match(pageSource, /documentStatusLabels/);
  assert.match(pageSource, /getTrainingDocumentText/);
  assert.match(pageSource, /updateTrainingDocumentText/);
  assert.match(pageSource, /retryTrainingDocument/);
  assert.match(pageSource, /downloadTrainingDocument/);
  assert.match(apiSource, /\/official-url-sources/);
  assert.match(pageSource, /Подтверждаю официальный домен/);
  assert.match(pageSource, /Официальная ссылка/);
  assert.match(pageSource, /сохранённый снимок официальной страницы/);
});

test('linked object PDF sources are explicit, eligible and use the existing document pipeline', () => {
  assert.match(apiSource, /\/linked-object-pdfs/);
  assert.match(apiSource, /\/documents\/from-linked-object/);
  assert.match(apiSource, /eligible:\s*boolean/);
  assert.match(apiSource, /eligibilityError:\s*string \| null/);
  assert.match(pageSource, /PDF связанного ЖК/);
  assert.match(pageSource, /импорт не запускается автоматически/);
  assert.match(pageSource, /!pdf\.eligible/);
  assert.match(pageSource, /pdf\.recommendedByDefault/);
  assert.match(pageSource, /Добавить выбранные PDF/);
  assert.match(stylesSource, /\.training-linked-pdf-panel/);
});

test('project assignments support explicit audience and remain editable outside archive', () => {
  assert.match(apiSource, /\/assignees\?/);
  assert.match(apiSource, /\/projects\/\$\{encodeURIComponent\(projectId\)\}\/assignments/);
  assert.match(apiSource, /\/projects\/\$\{encodeURIComponent\(projectId\)\}\/audience/);
  assert.match(pageSource, /Только назначенные аккаунты/);
  assert.match(pageSource, /Все сотрудники с правом обучения/);
  assert.match(pageSource, /readOnly=\{project\.status === 'ARCHIVED'\}/);
  assert.match(pageSource, /activeStep === 'assignments'/);
  assert.match(pageSource, /activeStep !== 'assignments'/);
  assert.match(pageSource, /assignmentSummary\.eligibleTotal/);
  assert.match(pageSource, /Для открытия назначьте хотя бы один подходящий аккаунт/);
  assert.match(stylesSource, /\.training-audience-modes/);
  assert.match(stylesSource, /\.training-assignment-list/);
});

test('training search picker exposes keyboard and screen-reader combobox semantics', () => {
  assert.match(pickerSource, /role="combobox"/);
  assert.match(pickerSource, /role="listbox"/);
  assert.match(pickerSource, /role="option"/);
  assert.match(pickerSource, /aria-activedescendant/);
  assert.match(pickerSource, /aria-multiselectable/);
  assert.match(pickerSource, /event\.key === 'ArrowDown'/);
  assert.match(pickerSource, /event\.key === 'Escape'/);
  assert.match(pickerSource, /event\.key === 'Home'/);
  assert.match(pickerSource, /event\.key === 'End'/);
  assert.match(stylesSource, /\.training-picker-control[\s\S]*min-height: 44px/);
  assert.match(stylesSource, /\.training-picker-option[\s\S]*min-height: 52px/);
  assert.match(stylesSource, /\.training-picker-control:focus-within/);
});

test('fact suggestions require explicit administrator acceptance or a rejection reason', () => {
  assert.match(apiSource, /\/fact-suggestion-runs/);
  assert.match(apiSource, /\/fact-suggestions/);
  assert.match(apiSource, /Idempotency-Key/);
  assert.match(pageSource, /Предложить факты из материалов/);
  assert.match(pageSource, /Ни один факт не участвует в оценке без явного подтверждения/);
  assert.match(pageSource, /Подтвердить факт/);
  assert.match(pageSource, /Укажите причину отклонения/);
  assert.match(pageSource, /Причина отклонения/);
});

test('questions explain the exact facts and criteria used for scoring', () => {
  assert.match(evaluationSource, /Что реально участвует в оценке/);
  assert.match(evaluationSource, /approvedFacts/);
  assert.match(evaluationSource, /Не подтверждён — в оценке не участвует/);
  assert.match(evaluationSource, /questionCriteria/);
  assert.match(evaluationSource, /Эти критерии одинаковы для всех дополнительных вопросов/);
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
  assert.match(stylesSource, /\.training-wizard-mobile/);
  assert.match(stylesSource, /\.training-evaluation-context-grid/);
  assert.match(stylesSource, /\.training-master-add[\s\S]*width: 44px/);
  assert.match(stylesSource, /\.training-search-picker/);
  assert.match(stylesSource, /\.training-picker-popover/);
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

test('server readiness drives the publication summary and issue navigation', () => {
  assert.match(apiSource, /\/readiness/);
  assert.match(pageSource, /getTrainingReadiness/);
  assert.match(readinessSource, /Готовность к публикации/);
  assert.match(readinessSource, /Можно публиковать/);
  assert.match(readinessSource, /pendingSuggestions/);
  assert.match(pageSource, /readiness\.issues/);
});

test('dirty state is item-scoped and remains a fail-closed publication gate', () => {
  assert.match(pageSource, /dirtyItemKeys/);
  assert.match(pageSource, /setDirtyItem\('questions', itemId, dirty\)/);
  assert.match(pageSource, /onDirtyChange\(editorId, false\)/);
  assert.match(pageSource, /hasUnsavedChanges=\{hasUnsavedChanges\}/);
  assert.match(
    pageSource,
    /Есть несохранённые изменения\. Сохраните их перед публикацией\./,
  );
  assert.doesNotMatch(pageSource, /setStepDirty/);
});

test('SPA history protection is direction-aware for Back, Forward and sidebar pushes', () => {
  assert.match(pageSource, /trainingHistoryIndexKey/);
  assert.match(pageSource, /originalPushState\.call/);
  assert.match(pageSource, /const restorationDelta = previousIndex - targetIndex/);
  assert.match(pageSource, /window\.history\.go\(restorationDelta\)/);
  assert.match(pageSource, /window\.confirm\(unsavedChangesMessage\)/);
  assert.match(appSource, /platforma:before-popstate/);
  assert.match(appSource, /if \(!window\.dispatchEvent\(guardEvent\)\) return/);
});

test('new question editors have stable unique control and evaluation-context ids', () => {
  assert.match(pageSource, /editorId=\{newQuestionId\}/);
  assert.match(pageSource, /id=\{`question-text-\$\{editorId\}`\}/);
  assert.match(pageSource, /instanceId=\{editorId\}/);
  assert.match(evaluationSource, /evaluation-context-\$\{instanceId\.replace/);
  assert.doesNotMatch(evaluationSource, /question\.id \|\| 'new'/);
});

test('source editing refreshes selectors, open URL previews and dirty document text', () => {
  assert.match(pageSource, /setSourcesRevision\(\(current\) => current \+ 1\)/);
  assert.match(pageSource, /\[loadFactSources, sourcesRevision\]/);
  assert.match(pageSource, /latest\.updatedAt === selected\.source\.updatedAt/);
  assert.match(pageSource, /getTrainingOfficialUrlSourceText/);
  assert.match(pageSource, /onDirtyChange\(`document:\$\{selected\.source\.id\}`, true\)/);
  assert.match(pageSource, /tabIndex=\{-1\}\s+multiple/);
});

test('readiness and fact suggestion actions fail closed when server state is unknown', () => {
  assert.match(readinessSource, /Не удалось проверить готовность/);
  assert.match(readinessSource, /Публикация заблокирована/);
  assert.match(pageSource, /readinessUnavailable/);
  assert.match(pageSource, /Boolean\(loadError\) \|\| runActive \|\| unresolvedCount > 0/);
  assert.match(pageSource, /Сначала обработайте предложения:/);
  assert.match(pageSource, /questionIds\.size === 0/);
  assert.match(pageSource, /минимум с одним вопросом/);
});

test('master actions use unique desktop and mobile ids with visible focus recovery', () => {
  assert.match(pageSource, /group\.action\('mobile'\)/);
  assert.match(pageSource, /group\.action\?\.\('desktop'\)/);
  assert.match(pageSource, /data-training-focus-key=\{focusKey\}/);
  assert.match(pageSource, /element\.getClientRects\(\)\.length > 0/);
});

test('fact and suggestion selections prune only deleted question ids', () => {
  assert.equal(
    pageSource.match(
      /pruneMissingQuestionIds\(current, availableQuestionIds\)/gu,
    )?.length,
    2,
  );
  assert.match(pageSource, /return changed \? next : selectedIds/);
});
