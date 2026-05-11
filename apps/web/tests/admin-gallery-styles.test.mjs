import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const styles = readFileSync(resolve(currentDir, '../src/styles.css'), 'utf8');

test('admin gallery item keeps preview text readable next to action buttons', () => {
  assert.match(
    styles,
    /\.gallery-item\s*\{[\s\S]*?cursor:\s*grab;[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.gallery-item-main\s*\{[\s\S]*?flex:\s*1 1 240px;[\s\S]*?grid-template-columns:\s*58px minmax\(0,\s*1fr\);[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.gallery-actions\s*\{[\s\S]*?justify-content:\s*flex-end;[\s\S]*?\}/,
  );
});
