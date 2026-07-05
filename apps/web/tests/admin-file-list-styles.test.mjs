import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const baseStyles = readFileSync(resolve(currentDir, '../src/styles.css'), 'utf8');
const objectsRouteStyles = readFileSync(resolve(currentDir, '../src/admin/objects-admin-route.css'), 'utf8');
const styles = `${baseStyles}\n${objectsRouteStyles}`;

test('admin file list keeps file name readable next to actions', () => {
  assert.match(styles, /\.file-list li\s*\{[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?\}/);

  assert.match(styles, /\.file-main\s*\{[\s\S]*?flex:\s*1 1 220px;[\s\S]*?\}/);

  assert.match(
    styles,
    /\.file-actions\s*\{[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?justify-content:\s*flex-end;[\s\S]*?\}/,
  );
});
