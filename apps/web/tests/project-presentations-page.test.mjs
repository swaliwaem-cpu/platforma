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
const mapSnapshotSource = await readFile(new URL('../src/presentations/projects/projectPresentationMapSnapshot.ts', import.meta.url), 'utf8');
const templateSource = await readFile(new URL('../../../packages/shared/src/project-presentation-template.mjs', import.meta.url), 'utf8');

test('project presentation routes need the project presentation permission, lot presentations stay open', () => {
  assert.match(
    accessSource,
    /canAccessProjectPresentations[\s\S]*Pick<AuthUser, 'id' \| 'permissions'>[\s\S]*permissions\?\.includes\(PROJECT_PRESENTATIONS_PERMISSION\)/u,
  );
  assert.match(accessSource, /PROJECT_PRESENTATIONS_PERMISSION = 'presentations:projects:manage'/u);
  assert.match(accessSource, /canAccessLotPresentations[\s\S]*return Boolean\(user\);/u);
  assert.doesNotMatch(accessSource, /hostname|import\.meta\.env\.DEV|role\.name|admin@fluffywhite\.moscow/u);
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
  assert.match(editorSource, /\['price', 'Стоимость'/u);
  assert.match(editorSource, /\['propertyClass', 'Класс'/u);
  assert.match(editorSource, /\['metro', 'Метро'/u);
  assert.match(editorSource, /mapTitle: normalizeOptionalText\(snapshot\.mapTitle\)/u);
  assert.match(editorSource, /maxLength=\{projectPresentationLimits\.description\}/u);
  assert.match(editorSource, /maxLength=\{projectPresentationLimits\.advantage\}/u);
  for (const field of ['completion', 'district', 'developer']) {
    assert.match(stateSource, new RegExp(`${field}: normalizeOptionalText\\(item\\.${field}\\)`, 'u'));
  }
});

test('cover subtitle captures the input value before the deferred form update', () => {
  assert.match(editorSource, /const coverSubtitle = event\.currentTarget\.value;[\s\S]*coverSubtitle \}\)\);/u);
  assert.doesNotMatch(editorSource, /coverSubtitle: event\.currentTarget\.value/u);
});

test('project generation validates cover, project count and resolved descriptions', () => {
  assert.match(stateSource, /!form\.coverImageId && !form\.coverFile/u);
  assert.match(stateSource, /projectPresentationMaxObjects/u);
  assert.match(stateSource, /manualDescription \?\? truncateProjectPresentationDescription\(item\.object\.description\)/u);
  assert.match(editorSource, /openValidationIssue\(issues\[0\]\)/u);
});

test('generator requires the map title, cover tiles, four advantages and three hand-picked photos', () => {
  assert.match(stateSource, /'mapTitle', form\.mapTitle, 'Заполните заголовок страницы с картой'/u);
  assert.match(stateSource, /form\.coverFeatures\.forEach\(\(feature, index\)/u);
  assert.match(stateSource, /limits\.coverFeatureTitle/u);
  assert.match(stateSource, /limits\.coverFeatureCaption/u);
  assert.match(stateSource, /Заполните все \$\{limits\.advantages\} преимущества/u);
  assert.match(stateSource, /item\.imageIds\.length !== limits\.images/u);
  assert.match(stateSource, /createDraftObject[\s\S]*imageIds: \[\],/u);
  assert.match(editorSource, /id="project-map-title"/u);
  assert.match(editorSource, /label="Заголовок страницы с картой"/u);
  assert.match(editorSource, /projectPresentationCoverIssuePaths\.has\(issue\.path\)/u);
});

test('the photo picker shows whole photos next to a live preview of the page', () => {
  assert.match(editorSource, /className="project-presentation-image-picker"/u);
  assert.match(editorSource, /preferredPageKey=\{imagePickerPageKey\}/u);
  assert.match(editorSource, /imagePickerTarget\.kind === 'cover' \? 'cover' : imagePickerTarget\.objectId/u);
  assert.match(stylesSource, /\.project-presentation-image-grid \{[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/u);
  assert.match(stylesSource, /\.project-presentation-image-grid button img \{[\s\S]*object-fit: contain/u);
});

test('the four cover tiles are editable and start from the catalog wording', () => {
  assert.match(editorSource, /project-presentation-field-wide project-presentation-cover-features/u);
  assert.match(editorSource, /id=\{`project-cover-feature-\$\{index\}-title`\}/u);
  assert.match(editorSource, /id=\{`project-cover-feature-\$\{index\}-caption`\}/u);
  assert.match(editorSource, /Вернуть стандартные/u);
  assert.doesNotMatch(editorSource, /Имя клиента/u);
  assert.match(stateSource, /export function createProjectPresentationCoverFeatures/u);
  assert.match(stateSource, /PROJECT_PRESENTATION_DEFAULT_COVER_FEATURES/u);
});

test('generation runs one PDF at a time instead of queueing duplicates', () => {
  assert.match(editorSource, /const isDocumentInProgress = Boolean\(document && activeDocumentStatuses\.has\(document\.status\)\)/u);
  assert.match(editorSource, /disabled=\{isGenerating \|\| isCoverUploading \|\| isDocumentInProgress/u);
  assert.match(editorSource, /isGenerating \|\| isCoverUploading \|\| isDocumentInProgress\) \{\s*return;/u);
  assert.match(editorSource, /PDF формируется — дождитесь готовности/u);
});

test('continue and stepper jumps stop at the first incomplete step', () => {
  assert.match(editorSource, /function requestStep\(step: EditorStepId\)/u);
  assert.match(editorSource, /editorSteps\.slice\(0, targetIndex\)\.find\(\(item\) => !completedSteps\.has\(item\.id\)\)/u);
  assert.match(editorSource, /onClick=\{\(\) => requestStep\(nextStep\.id\)\}/u);
  assert.match(editorSource, /onStepChange=\{requestStep\}/u);
  assert.match(editorSource, /Чтобы продолжить: /u);
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

test('project preview renders the shared PDF template with the reference fonts and a live map snapshot', () => {
  assert.match(previewSource, /renderProjectPresentationHtml\(/u);
  assert.match(previewSource, /pageKeys: \[activePageKey\]/u);
  assert.match(previewSource, /<iframe[\s\S]*srcDoc=\{html\}/u);
  assert.match(previewSource, /features: form\.coverFeatures/u);
  for (const font of ['Involve-Regular', 'Involve-Medium', 'Inter-Regular', 'Inter-Medium', 'Lora-Italic']) {
    assert.ok(previewSource.includes(`@platforma/shared/project-presentation-fonts/${font}.woff2?url`), font);
  }
  assert.doesNotMatch(previewSource, /fluffywhite-logo-gold\.png/u);
  assert.doesNotMatch(stylesSource, /Noto Serif Display/u);
  assert.match(mapSnapshotSource, /PROJECT_PRESENTATION_MAP_VIEW/u);
  assert.match(mapSnapshotSource, /localizeOpenMapTilesLabels\(map\)/u);
  assert.match(mapSnapshotSource, /preserveDrawingBuffer: true/u);
  // The boss dropped the client line from the cover and the note from the map page.
  assert.doesNotMatch(templateSource, /Подготовлено для/u);
  assert.doesNotMatch(templateSource, /Локации проектов/u);
  assert.doesNotMatch(templateSource, /OpenStreetMap/u);
  assert.match(stylesSource, /\.project-preview-document\s*\{[\s\S]*transform: scale\(var\(--project-preview-scale/u);
  assert.match(stylesSource, /aspect-ratio: 3 \/ 4/u);
  assert.match(stylesSource, /position: sticky/u);
  assert.match(stylesSource, /@container \(max-width: 1180px\)/u);
});
