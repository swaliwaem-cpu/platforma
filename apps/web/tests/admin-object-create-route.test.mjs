import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(currentDir, '../src/admin/ObjectsAdminPage.tsx'), 'utf8');

test('object create route clears loading state so the editor form is enabled', () => {
  const createRouteBranch = source.match(/if \(isCreateRoute\) \{[\s\S]*?return;\n    \}/)?.[0] ?? '';

  assert.match(createRouteBranch, /setIsLoading\(false\);/);
});
