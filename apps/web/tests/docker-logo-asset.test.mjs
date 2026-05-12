import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(resolve(currentDir, '../src/App.tsx'), 'utf8');
const dockerfile = readFileSync(resolve(currentDir, '../Dockerfile'), 'utf8');

test('web Docker image includes root logo asset used by App import', () => {
  assert.match(appSource, /_Fluffy_White_1-02\.svg/);
  assert.match(dockerfile, /COPY _Fluffy_White_1-02\.svg \.\/_Fluffy_White_1-02\.svg/);
});
