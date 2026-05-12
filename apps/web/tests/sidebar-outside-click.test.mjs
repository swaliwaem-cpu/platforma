import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(currentDir, '../src/App.tsx'), 'utf8');

test('sidebar closes when clicking outside of the menu panel', () => {
  assert.match(source, /useRef/);
  assert.match(source, /const sidebarRef = useRef<HTMLElement \| null>\(null\);/);
  assert.match(source, /document\.addEventListener\('pointerdown', handleDocumentPointerDown\);/);
  assert.match(source, /document\.removeEventListener\('pointerdown', handleDocumentPointerDown\);/);
  assert.match(source, /if \(sidebarRef\.current\.contains\(event\.target\)\) \{/);
  assert.match(source, /setIsSidebarOpen\(false\);/);
  assert.match(source, /<aside[\s\S]*?ref=\{sidebarRef\}/);
});
