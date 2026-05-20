import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(currentDir, '../src/admin/ObjectsAdminPage.tsx'), 'utf8');

test('object PDF upload starts immediately after file selection without a separate upload button', () => {
  assert.match(source, /async function uploadLinkedFile\(selectedFile: File\)/);
  assert.match(source, /onObjectFileChange=\{\(file\) => \{[\s\S]*?void uploadLinkedFile\(file\);[\s\S]*?setObjectFile\(null\);[\s\S]*?\}\}/);
  assert.match(source, /onChange=\{\(event\) => \{[\s\S]*?const nextFile = event\.target\.files\?\.\[0\] \?\? null;[\s\S]*?onChange\(nextFile\);[\s\S]*?event\.currentTarget\.value = '';/);
  assert.match(source, /className="upload-file-button"[\s\S]*?>\s*Выбрать файл\s*</);
  assert.match(source, /<input[\s\S]*?accept=\{accept\}[\s\S]*?disabled=\{disabled\}[\s\S]*?type="file"/);
  assert.doesNotMatch(source, /buttonLabel="Загрузить PDF"/);
  assert.doesNotMatch(source, /onUpload=\{props\.onUploadLinkedFile\}/);
});
