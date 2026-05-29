import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(currentDir, '../src/admin/api.ts'), 'utf8');

test('apiRequest converts fetch failures into readable Russian connection errors', () => {
  assert.match(source, /const apiConnectionErrorMessage = 'Не удалось связаться с сервером';/);
  assert.match(source, /try \{[\s\S]*?response = await sendApiRequest\(path, initialToken, options\);[\s\S]*?\} catch \{[\s\S]*?throw new Error\(apiConnectionErrorMessage\);[\s\S]*?\}/);
  assert.match(source, /try \{[\s\S]*?response = await sendApiRequest\(path, refreshedSession\.accessToken, options\);[\s\S]*?\} catch \{[\s\S]*?throw new Error\(apiConnectionErrorMessage\);[\s\S]*?\}/);
});

test('apiRequest bypasses browser cache for JSON API state', () => {
  assert.match(source, /cache:\s*options\.cache \?\? 'no-store'/);
});
