import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(currentDir, '../src/admin/ObjectsAdminPage.tsx'), 'utf8');

test('object PDF upload starts immediately after file selection without a separate upload button', () => {
  assert.match(source, /async function uploadLinkedFiles\(selectedFiles: FileList \| File\[\]\)/);
  assert.match(source, /onObjectFilesChange=\{\(files\) => \{[\s\S]*?void uploadLinkedFiles\(files\);[\s\S]*?\}\}/);
  assert.match(source, /onChange=\{\(event\) => \{[\s\S]*?const nextFiles = Array\.from\(event\.target\.files \?\? \[\]\);[\s\S]*?onChange\(nextFiles\);[\s\S]*?event\.currentTarget\.value = '';/);
  assert.match(source, /className="upload-file-button"[\s\S]*?>\s*Выбрать файл\s*</);
  assert.match(source, /<input[\s\S]*?accept=\{accept\}[\s\S]*?disabled=\{disabled\}[\s\S]*?multiple=\{multiple\}[\s\S]*?type="file"/);
  assert.doesNotMatch(source, /buttonLabel="Загрузить PDF"/);
  assert.doesNotMatch(source, /onUpload=\{props\.onUploadLinkedFile\}/);
});

test('object PDF upload creates a new object before saving the selected file', () => {
  const uploadLinkedFileSource = extractFunctionSource(source, 'async function uploadLinkedFiles');

  assert.doesNotMatch(uploadLinkedFileSource, /if \(!accessToken \|\| !editObjectId\)/);
  assert.match(uploadLinkedFileSource, /let targetObjectId = editObjectId;/);
  assert.match(uploadLinkedFileSource, /if \(!targetObjectId && isCreateRoute\) \{/);
  assert.match(uploadLinkedFileSource, /const validationError = validateObjectForm\(form\);/);
  assert.match(uploadLinkedFileSource, /apiRequest<ObjectResponse>\('\/objects',\s*accessToken,\s*\{/);
  assert.match(uploadLinkedFileSource, /apiRequest<ObjectResponse>\(`\/objects\/\$\{targetObjectId\}\/files`,\s*accessToken,\s*\{/);
  assert.match(uploadLinkedFileSource, /pendingEditorNoticeRef\.current = getUploadedPdfNotice\(uploadedCount, true\);/);
  assert.match(uploadLinkedFileSource, /pendingEditorErrorRef\.current = `Объект создан, но PDF не загрузился: \$\{uploadErrorMessage\}`;/);
  assert.match(uploadLinkedFileSource, /navigate\(`\/admin\/objects\/\$\{createdObjectId\}\/edit`\)/);
});

test('object PDF upload accepts up to ten selected files and stops when the object is full', () => {
  const uploadLinkedFileSource = extractFunctionSource(source, 'async function uploadLinkedFiles');

  assert.match(source, /const objectPdfUploadLimit = 10;/);
  assert.match(source, /const objectFileCount = props\.object\?\.files\.length \?\? 0;/);
  assert.match(source, /const isObjectFileLimitReached = objectFileCount >= objectPdfUploadLimit;/);
  assert.match(source, /disabled=\{!props\.canUpload \|\| props\.isUploading \|\| props\.isSubmitting \|\| isObjectFileLimitReached\}/);
  assert.match(source, /multiple/);
  assert.match(uploadLinkedFileSource, /const filesToUpload = Array\.from\(selectedFiles\);/);
  assert.match(uploadLinkedFileSource, /const currentFileCount = object\?\.files\.length \?\? 0;/);
  assert.match(uploadLinkedFileSource, /const remainingSlots = objectPdfUploadLimit - currentFileCount;/);
  assert.match(uploadLinkedFileSource, /if \(filesToUpload\.length > remainingSlots\) \{/);
});

test('object PDF upload sends selected files sequentially with the single-file title only', () => {
  const uploadLinkedFileSource = extractFunctionSource(source, 'async function uploadLinkedFiles');

  assert.match(uploadLinkedFileSource, /const uploadTitle = filesToUpload\.length === 1 \? objectFileTitle : '';/);
  assert.match(uploadLinkedFileSource, /for \(const selectedFile of filesToUpload\) \{/);
  assert.match(uploadLinkedFileSource, /body\.append\('file', selectedFile\);/);
  assert.match(uploadLinkedFileSource, /body\.append\('title', uploadTitle\);/);
  assert.match(uploadLinkedFileSource, /uploadedCount \+= 1;/);
  assert.match(uploadLinkedFileSource, /setNotice\(getUploadedPdfNotice\(uploadedCount\)\);/);
});

test('object editor shows the PDF upload panel on create and edit routes', () => {
  assert.match(source, /<AdminPanel className="editor-panel media-panel" role="region" aria-label="Файлы объекта">/);
  assert.doesNotMatch(source, /PDF-файлы можно будет добавить после создания объекта/);
  assert.doesNotMatch(
    source,
    /\{!props\.isCreateRoute \? \(\s*<AdminPanel className="editor-panel media-panel" role="region" aria-label="Файлы объекта">/,
  );
});

function extractFunctionSource(sourceText, marker) {
  const markerIndex = sourceText.indexOf(marker);

  assert.notEqual(markerIndex, -1, `${marker} should exist`);

  const nextFunctionIndex = sourceText.indexOf('\n  async function ', markerIndex + marker.length);

  return sourceText.slice(markerIndex, nextFunctionIndex === -1 ? sourceText.length : nextFunctionIndex);
}
