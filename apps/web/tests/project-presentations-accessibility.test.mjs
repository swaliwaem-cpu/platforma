import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = (relativePath) => readFileSync(resolve(currentDir, '../src', relativePath), 'utf8');

const appSource = source('App.tsx');
const accessSource = source('presentations/presentationAccess.ts');
const apiSource = source('presentations/projects/projectPresentationApi.ts');
const typesSource = source('presentations/projects/projectPresentationTypes.ts');
const stateSource = source('presentations/projects/projectPresentationState.ts');
const listSource = source('presentations/projects/ProjectPresentationsPage.tsx');
const editorSource = source('presentations/projects/ProjectPresentationEditorPage.tsx');
const previewSource = source('presentations/projects/ProjectPresentationPreview.tsx');
const styles = source('presentations/projects/projectPresentations.css');

test('list, new draft and editor routes are available to every authenticated role', () => {
  const projectAccessBody = accessSource.match(
    /export function canAccessProjectPresentations[\s\S]*?\n\}/,
  )?.[0] ?? '';

  assert.match(projectAccessBody, /Pick<AuthUser, 'id'>/);
  assert.match(projectAccessBody, /return Boolean\(user\);/);
  assert.doesNotMatch(projectAccessBody, /hostname|import\.meta\.env\.DEV|role|email|admin/);
  assert.match(appSource, /function parseProjectPresentationRoute\(pathname: string\)/);
  assert.match(appSource, /kind: 'list' as const/);
  assert.match(appSource, /kind: 'new' as const/);
  assert.match(appSource, /kind: 'draft' as const, draftId:/);
  assert.match(
    appSource,
    /projectPresentationRoute \? \([\s\S]*canAccessProjectPresentations\(user\) \? \([\s\S]*<ProjectPresentationsPage[\s\S]*<ProjectPresentationEditorPage/,
  );
  assert.match(
    appSource,
    /function getNavigationPath\([\s\S]*canAccessProjectPresentations\(user\)[\s\S]*'\/presentations\/projects'/,
  );
});

test('frontend API exposes versioned drafts, async history, retry, content and deletion', () => {
  assert.match(apiSource, /const basePath = '\/project-presentations'/);
  assert.match(apiSource, /updateProjectPresentationDraft[\s\S]*method: 'PATCH'[\s\S]*version/);
  assert.match(apiSource, /replaceProjectPresentationObjects[\s\S]*method: 'PUT'[\s\S]*version,[\s\S]*objects/);
  assert.match(apiSource, /deleteProjectPresentationDraft[\s\S]*method: 'DELETE'/);
  assert.match(apiSource, /listProjectPresentationDocuments[\s\S]*documents\?limit=100/);
  assert.match(apiSource, /createProjectPresentationDocument[\s\S]*version: draft\.version[\s\S]*idempotencyKey:/);
  assert.match(apiSource, /retryProjectPresentationDocument[\s\S]*\/retry`[\s\S]*method: 'POST'/);
  assert.match(apiSource, /deleteProjectPresentationDocument[\s\S]*method: 'DELETE'/);
  assert.match(apiSource, /downloadProjectPresentationDocument[\s\S]*\/content`[\s\S]*response\.blob\(\)/);
});

test('editor serializes autosave, preserves explicit order and recovers from version conflicts', () => {
  assert.match(editorSource, /type SaveState = 'idle' \| 'pending' \| 'saving' \| 'saved' \| 'conflict' \| 'error'/);
  assert.match(editorSource, /window\.setTimeout\([\s\S]*persistDraft\(\)[\s\S]*800/);
  assert.match(
    editorSource,
    /const headerResponse = await updateProjectPresentationDraft\([\s\S]*version: currentDraft\.version[\s\S]*const objectsResponse = await replaceProjectPresentationObjects\([\s\S]*headerResponse\.draft\.version[\s\S]*toDraftObjectInputs\(snapshot\.objects\)/,
  );
  assert.match(editorSource, /revisionRef\.current === saveRevision[\s\S]*setSaveState\('saved'\)[\s\S]*setSaveState\('pending'\)/);
  assert.match(editorSource, /setSaveState\(isConflict \? 'conflict' : 'error'\)/);
  assert.match(editorSource, /Черновик уже изменён в другой вкладке/);
  assert.match(editorSource, /function SaveIndicator[\s\S]*state === 'conflict'[\s\S]*Перезагрузить/);
  assert.match(
    stateSource,
    /export function reorderDraftObjects[\s\S]*nextObjects\.splice\(currentIndex, 1\)[\s\S]*nextObjects\.splice\(nextIndex, 0, movedItem\)[\s\S]*sortOrder: index/,
  );
  assert.match(editorSource, /reorderDraftObjects\(current\.objects, objectId, direction\)/);
});

test('editor enforces selection limits and validates resolved content before generation', () => {
  assert.match(typesSource, /projectPresentationMaxObjects = 12/);
  assert.match(typesSource, /projectPresentationMaxImages = 3/);
  assert.match(typesSource, /projectPresentationMaxAdvantages = 4/);
  assert.match(editorSource, /currentForm\.objects\.length >= projectPresentationMaxObjects/);
  assert.match(editorSource, /!isSelected && item\.imageIds\.length >= projectPresentationMaxImages/);
  assert.match(editorSource, /disabled=\{form\.objects\.length >= projectPresentationMaxObjects\}/);
  assert.match(editorSource, /\[0, 1, 2, 3\]\.map\(\(advantageIndex\)/);
  for (const field of ['propertyClass', 'completion', 'price', 'district', 'developer', 'metro']) {
    assert.ok(editorSource.includes(`['${field}',`), `manual field ${field} must be editable`);
  }
  assert.match(stateSource, /if \(!form\.coverImageId && !form\.coverFile\)/);
  assert.match(stateSource, /if \(form\.objects\.length === 0\)/);
  assert.match(stateSource, /manualDescription \?\? item\.object\.description/);
  assert.match(editorSource, /openValidationIssue\(issues\[0\]\)/);
  assert.match(editorSource, /role="status" aria-live="polite"[\s\S]*Загружаем фото обложки/);
  assert.match(
    editorSource,
    /const savedDraft = await persistDraft\(\)[\s\S]*createProjectPresentationDocument\(accessToken, savedDraft\)/,
  );
});

test('async generation and shared history expose statuses, polling, retry and confirmed deletion', () => {
  assert.match(editorSource, /activeDocumentStatuses = new Set[\s\S]*\['PENDING', 'RUNNING'\]/);
  assert.match(editorSource, /window\.setInterval\([\s\S]*getProjectPresentationDocument\(accessToken, document\.id\)[\s\S]*2000/);
  assert.match(editorSource, /PENDING: 'PDF поставлен в очередь'/);
  assert.match(editorSource, /RUNNING: `Формируем PDF · \$\{document\.progress\}%`/);
  assert.match(editorSource, /READY: 'PDF готов'/);
  assert.match(editorSource, /FAILED: 'Не удалось сформировать PDF'/);
  assert.match(listSource, /Черновики[\s\S]*История PDF/);
  assert.match(listSource, /draft\.owner\?\.name \?\? draft\.owner\?\.email/);
  assert.match(listSource, /document\.status === 'FAILED'/);
  assert.match(listSource, /retryProjectPresentationDocument\(accessToken, document\.id\)/);
  assert.match(listSource, /deleteTarget\.kind === 'draft'[\s\S]*deleteProjectPresentationDraft[\s\S]*deleteProjectPresentationDocument/);
  assert.match(listSource, /Черновик нельзя будет восстановить/);
  assert.match(listSource, /Файл и запись истории будут удалены без возможности восстановления/);
});

test('interactive controls have labels, state announcements and validation focus recovery', () => {
  assert.match(listSource, /role="tablist"[\s\S]*aria-label="Презентации ЖК"/);
  assert.ok((listSource.match(/role="tab"/g) ?? []).length >= 2);
  assert.ok((listSource.match(/aria-selected=/g) ?? []).length >= 2);
  assert.match(listSource, /aria-label=\{`Удалить черновик \$\{draft\.title\}`\}/);
  assert.match(listSource, /aria-label=\{`Скачать \$\{document\.title\}`\}/);
  assert.match(listSource, /aria-label=\{`Повторить генерацию \$\{document\.title\}`\}/);
  assert.match(listSource, /aria-label=\{`Удалить PDF \$\{document\.title\}`\}/);
  assert.match(editorSource, /<FieldLabel htmlFor=\{id\}>\{label\}<\/FieldLabel>/);
  assert.match(editorSource, /aria-pressed=\{isSelected\}/);
  assert.match(editorSource, /aria-label="Поиск жилого комплекса"/);
  assert.match(editorSource, /aria-label=\{`Поднять \$\{item\.object\.title\}`\}/);
  assert.match(editorSource, /aria-label=\{`Опустить \$\{item\.object\.title\}`\}/);
  assert.match(editorSource, /role="alert"/);
  assert.match(editorSource, /role="status"/);
  assert.match(editorSource, /getElementById\(fieldId\)[\s\S]*scrollIntoView[\s\S]*element\?\.focus\(\)/);
  assert.match(previewSource, /aria-label="Предыдущая страница"/);
  assert.match(previewSource, /aria-label="Следующая страница"/);
  assert.match(previewSource, /aria-live="polite"/);
  assert.match(previewSource, /aria-current=\{index === safePageIndex \? 'page' : undefined\}/);
});

test('preview mirrors N + 4 pages in 3:4 and layout has responsive reduced-motion rules', () => {
  assert.match(
    previewSource,
    /key: 'cover'[\s\S]*key: 'map'[\s\S]*\.\.\.form\.objects\.map[\s\S]*key: 'company'[\s\S]*key: 'final'/,
  );
  assert.match(editorSource, /\{form\.objects\.length \+ 4\} страниц в формате 3:4/);
  assert.match(styles, /\.project-preview-frame\s*\{[\s\S]*aspect-ratio:\s*3 \/ 4/);
  assert.match(styles, /\.project-presentation-preview-column\s*\{[\s\S]*position:\s*sticky/);
  assert.match(styles, /@container \(max-width:\s*1180px\)/);
  assert.match(styles, /@media \(prefers-reduced-motion:\s*reduce\)/);
});

test('guided composer keeps the approved flow, accordion semantics and adaptive actions', () => {
  assert.match(
    editorSource,
    /id: 'objects', label: 'Выбор ЖК'[\s\S]*id: 'cards', label: 'Карточки'[\s\S]*id: 'cover', label: 'Обложка'[\s\S]*id: 'review', label: 'Проверка'/,
  );
  assert.match(editorSource, /aria-label="Этапы создания презентации"/);
  assert.match(editorSource, /aria-current=\{isActive \? 'step' : undefined\}/);
  assert.match(editorSource, /aria-expanded=\{isExpanded\}/);
  assert.match(editorSource, /project-presentation-footer-preview/);
  assert.match(editorSource, /ProjectPresentationPreview[\s\S]*preferredPageKey=\{preferredPreviewPageKey\}/);
  assert.match(styles, /\.project-presentations-page\s*\{[\s\S]*width: min\(100%, 1560px\)/);
  assert.match(styles, /\.project-presentation-editor-footer\s*\{[\s\S]*position: sticky/);
  assert.match(styles, /@media \(max-width: 480px\)/);
});
