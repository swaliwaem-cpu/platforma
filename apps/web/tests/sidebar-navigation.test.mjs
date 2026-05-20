import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(resolve(currentDir, '../src/App.tsx'), 'utf8');

test('sidebar keeps cabinet navigation available for the plain user role', () => {
  assert.match(
    appSource,
    /id:\s*'cabinet',[\s\S]*?label:\s*'Кабинет',[\s\S]*?requiredPermissions:\s*\[\]/,
  );
  assert.doesNotMatch(appSource, /user\.role\.name\s*===\s*'user'[\s\S]*?item\.id\s*===\s*'cabinet'/);
});
