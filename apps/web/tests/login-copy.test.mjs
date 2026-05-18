import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(resolve(currentDir, '../src/App.tsx'), 'utf8');

test('login screen shows broker platform and Fluffy White titles', () => {
  assert.match(appSource, /<p className="eyebrow">Платформа брокеров<\/p>/);
  assert.match(appSource, /<h1 id="login-title">Fluffy White<\/h1>/);
});
