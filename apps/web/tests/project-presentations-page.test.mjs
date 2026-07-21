import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const accessSource = await readFile(new URL('../src/presentations/presentationAccess.ts', import.meta.url), 'utf8');
const apiSource = await readFile(new URL('../src/presentations/projects/projectPresentationApi.ts', import.meta.url), 'utf8');
const editorSource = await readFile(new URL('../src/presentations/projects/ProjectPresentationEditorPage.tsx', import.meta.url), 'utf8');
const previewSource = await readFile(new URL('../src/presentations/projects/ProjectPresentationPreview.tsx', import.meta.url), 'utf8');
const stateSource = await readFile(new URL('../src/presentations/projects/projectPresentationState.ts', import.meta.url), 'utf8');
const stylesSource = await readFile(new URL('../src/presentations/projects/projectPresentations.css', import.meta.url), 'utf8');

test('project presentation routes allow localhost and keep production admin restriction', () => {
  assert.match(accessSource, /canAccessProjectPresentations[\s\S]*hostname = window\.location\.hostname/u);
  assert.match(accessSource, /import\.meta\.env\.DEV/u);
  assert.match(accessSource, /localHostnames\.has\(hostname\.trim\(\)\.toLowerCase\(\)\)/u);
  assert.match(accessSource, /canAccessProjectPresentations[\s\S]*role\.name\.trim\(\)\.toLowerCase\(\) === 'admin'/u);
  assert.match(appSource, /\/presentations\/projects/u);
  assert.match(appSource, /ProjectPresentationsPage/u);
  assert.match(appSource, /ProjectPresentationEditorPage/u);
  assert.match(appSource, /canAccessProjectPresentations\(user\)[\s\S]*ProjectPresentationsPage/u);
  assert.match(appSource, /canAccessLotPresentations\(user\)[\s\S]*LotPresentationsPage/u);
});

test('project presentation API covers drafts, catalog search, generation and history', () => {
  assert.match(apiSource, /\/project-presentations/u);
  assert.match(apiSource, /\/objects\?/u);
  assert.doesNotMatch(apiSource, /status.*PUBLISHED|type.*RESIDENTIAL/u);
  assert.match(apiSource, /method: 'PATCH'/u);
  assert.match(apiSource, /method: 'PUT'/u);
  assert.match(apiSource, /\/documents/u);
  assert.match(apiSource, /\/retry/u);
  assert.match(apiSource, /\/content/u);
  assert.match(apiSource, /uploadProjectPresentationCover[\s\S]*new FormData\(\)[\s\S]*\/cover`/u);
});

test('project editor implements versioned autosave and approved field limits', () => {
  assert.match(editorSource, /window\.setTimeout\([\s\S]*800/u);
  assert.match(editorSource, /updateProjectPresentationDraft[\s\S]*replaceProjectPresentationObjects/u);
  assert.match(editorSource, /version: currentDraft\.version/u);
  assert.match(editorSource, /saveState === 'conflict'/u);
  assert.match(editorSource, /projectPresentationMaxObjects/u);
  assert.match(editorSource, /projectPresentationMaxImages/u);
  assert.match(editorSource, /manualTitle/u);
  assert.match(editorSource, /manualDescription/u);
  assert.match(editorSource, /advantages/u);
  assert.match(editorSource, /propertyClass/u);
  assert.match(editorSource, /completion/u);
  assert.match(editorSource, /district/u);
  assert.match(editorSource, /developer/u);
  assert.match(editorSource, /metro/u);
});

test('cover subtitle captures the input value before the deferred form update', () => {
  assert.match(editorSource, /const coverSubtitle = event\.currentTarget\.value;[\s\S]*coverSubtitle \}\)\);/u);
  assert.doesNotMatch(editorSource, /coverSubtitle: event\.currentTarget\.value/u);
});

test('project generation validates cover, project count and resolved descriptions', () => {
  assert.match(stateSource, /!form\.coverImageId && !form\.coverFile/u);
  assert.match(stateSource, /projectPresentationMaxObjects/u);
  assert.match(stateSource, /manualDescription \?\? item\.object\.description/u);
  assert.match(editorSource, /openValidationIssue\(issues\[0\]\)/u);
});

test('custom cover upload validates 10 MB locally and keeps catalog photos as an alternative', () => {
  assert.match(editorSource, /projectPresentationMaxCoverFileSizeBytes/u);
  assert.match(editorSource, /file\.size > projectPresentationMaxCoverFileSizeBytes/u);
  assert.match(editorSource, /Максимальный размер фото — 10 МБ/u);
  assert.match(editorSource, /isCoverUploadingRef\.current/u);
  assert.match(editorSource, /window\.clearTimeout\(autosaveTimerRef\.current\)/u);
  assert.match(editorSource, /inert=\{isCoverUploading\}/u);
  assert.match(editorSource, /isGenerating \|\| isCoverUploading/u);
  assert.match(editorSource, /Загрузить своё фото/u);
  assert.match(editorSource, /Выбрать из фото ЖК/u);
  assert.match(editorSource, /coverFile: null/u);
  assert.match(editorSource, /form\.coverImageId \|\| form\.coverFile \? 'Фото и заголовок выбраны'/u);
  assert.match(previewSource, /form\.coverFile\?\.id \?\? coverImage\?\.file\.id/u);
});

test('project preview keeps 4:5 pages, broker contacts and responsive sticky presentation', () => {
  assert.match(previewSource, /kind: 'cover'/u);
  assert.match(previewSource, /kind: 'contents'/u);
  assert.match(previewSource, /kind: 'telegram'/u);
  assert.match(previewSource, /kind: 'contacts'/u);
  assert.match(previewSource, /brokerPhone/u);
  assert.match(previewSource, /brokerEmail/u);
  assert.match(stylesSource, /aspect-ratio: 4 \/ 5/u);
  assert.match(stylesSource, /position: sticky/u);
  assert.match(stylesSource, /@container \(max-width: 1180px\)/u);
});
