import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(resolve(currentDir, '../src/App.tsx'), 'utf8');
const dockerfile = readFileSync(resolve(currentDir, '../Dockerfile'), 'utf8');
const composeFile = readFileSync(resolve(currentDir, '../../../docker-compose.yml'), 'utf8');

test('web Docker image includes root logo asset used by App import', () => {
  assert.match(appSource, /_Fluffy_White_1-02\.svg/);
  assert.match(dockerfile, /COPY _Fluffy_White_1-02\.svg \.\/_Fluffy_White_1-02\.svg/);
});

test('web Docker image serves a built production bundle instead of Vite dev server', () => {
  assert.match(dockerfile, /ARG VITE_API_URL=http:\/\/localhost:3000/);
  assert.match(dockerfile, /ARG VITE_YANDEX_MAPS_API_KEY=/);
  assert.match(
    dockerfile,
    /RUN VITE_API_URL="\$VITE_API_URL" VITE_YANDEX_MAPS_API_KEY="\$VITE_YANDEX_MAPS_API_KEY" pnpm --filter @platforma\/web build/,
  );
  assert.match(dockerfile, /COPY --from=builder \/app\/apps\/web\/dist \.\/apps\/web\/dist/);
  assert.match(dockerfile, /vite", "preview", "--host", "0\.0\.0\.0", "--port", "5173"/);
  assert.doesNotMatch(dockerfile, /"dev"/);
  assert.match(composeFile, /args:[\s\S]*VITE_API_URL: \$\{VITE_API_URL:-http:\/\/localhost:3000\}/);
  assert.match(composeFile, /args:[\s\S]*VITE_YANDEX_MAPS_API_KEY: \$\{VITE_YANDEX_MAPS_API_KEY:-\}/);
});
