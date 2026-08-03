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

test('apiRequest localizes standard HTTP error messages returned by the server', () => {
  assert.match(source, /'Internal server error': 'Внутренняя ошибка сервера'/);
  assert.match(source, /'Bad Request': 'Некорректный запрос'/);
  assert.match(source, /Unauthorized: 'Требуется авторизация'/);
  assert.match(source, /Forbidden: 'Недостаточно прав'/);
  assert.match(source, /'Not Found': 'Ресурс не найден'/);
  assert.match(source, /standardApiErrorTranslations\[message\] \?\? message/);
});

test('apiRequest bypasses browser cache for JSON API state', () => {
  assert.match(source, /cache:\s*options\.cache \?\? 'no-store'/);
});
