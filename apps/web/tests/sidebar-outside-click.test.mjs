import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(currentDir, '../src/App.tsx'), 'utf8');
const styles = readFileSync(resolve(currentDir, '../src/styles.css'), 'utf8');
const themeStyles = readFileSync(resolve(currentDir, '../src/app-theme.css'), 'utf8');

test('sidebar closes when clicking outside of the menu panel', () => {
  assert.match(source, /useRef/);
  assert.match(source, /const sidebarRef = useRef<HTMLElement \| null>\(null\);/);
  assert.match(source, /document\.addEventListener\('pointerdown', handleDocumentPointerDown\);/);
  assert.match(source, /document\.removeEventListener\('pointerdown', handleDocumentPointerDown\);/);
  assert.match(source, /if \(sidebarRef\.current\.contains\(event\.target\)\) \{/);
  assert.match(source, /setIsSidebarOpen\(false\);/);
  assert.match(source, /<aside[\s\S]*?ref=\{sidebarRef\}/);
});

test('collapsed sidebar renders as an icon-only burger control', () => {
  assert.match(source, /className="sidebar-toggle"/);
  assert.match(source, /aria-hidden=\{!isSidebarOpen\}/);
  assert.match(styles, /\.sidebar:not\(\.sidebar--open\)\s*\{[\s\S]*?border-width:\s*0;[\s\S]*?border-color:\s*transparent;[\s\S]*?background:\s*transparent;[\s\S]*?box-shadow:\s*none;[\s\S]*?\}/);
  assert.match(styles, /\.sidebar:not\(\.sidebar--open\)\s+\.sidebar-content\s*\{[\s\S]*?display:\s*none;[\s\S]*?\}/);
  assert.match(themeStyles, /html\[data-app-theme\]\s+\.sidebar:not\(\.sidebar--open\)\s*\{[\s\S]*?border-width:\s*0;[\s\S]*?border-color:\s*transparent;[\s\S]*?background:\s*transparent;[\s\S]*?box-shadow:\s*none;[\s\S]*?\}/);
});
