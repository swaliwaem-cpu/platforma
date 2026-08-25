import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(resolve(currentDir, '../src/App.tsx'), 'utf8');
const dockerfile = readFileSync(resolve(currentDir, '../Dockerfile'), 'utf8');
const composeFile = readFileSync(resolve(currentDir, '../../../docker-compose.yml'), 'utf8');
const staticServer = readFileSync(resolve(currentDir, '../server.mjs'), 'utf8');

test('web Docker image includes root logo asset used by App import', () => {
  assert.match(appSource, /_Fluffy_White_1-02\.svg/);
  assert.match(dockerfile, /COPY _Fluffy_White_1-02\.svg \.\/_Fluffy_White_1-02\.svg/);
});

test('web Docker image serves a built production bundle without Vite runtime', () => {
  assert.match(dockerfile, /ARG VITE_API_URL=http:\/\/localhost:3000/);
  assert.match(
    dockerfile,
    /RUN VITE_API_URL="\$VITE_API_URL" pnpm --filter @platforma\/web build/,
  );
  assert.match(dockerfile, /COPY apps\/web\/server\.mjs \.\/apps\/web\/server\.mjs/);
  assert.match(dockerfile, /COPY --from=builder \/app\/apps\/web\/dist \.\/apps\/web\/dist/);
  assert.match(dockerfile, /CMD \["node", "apps\/web\/server\.mjs"\]/);
  assert.doesNotMatch(dockerfile, /"dev"/);
  assert.doesNotMatch(dockerfile, /vite", "preview"/);
  assert.match(composeFile, /args:[\s\S]*VITE_API_URL: \$\{VITE_API_URL:-http:\/\/localhost:3000\}/);
  assert.match(composeFile, /environment:[\s\S]*MAP_PROVIDER_ENABLED: \$\{MAP_PROVIDER_ENABLED:-true\}/);
  assert.match(composeFile, /environment:[\s\S]*MAP_STYLE_URL: \$\{MAP_STYLE_URL:-https:\/\/tiles\.openfreemap\.org\/styles\/liberty\}/);
});

test('web static server blocks source and Vite client requests', () => {
  assert.match(staticServer, /pathname === '\/@vite\/client'/);
  assert.match(staticServer, /pathname\.startsWith\('\/src\/'\)/);
  assert.match(staticServer, /pathname\.startsWith\('\/apps\/'\)/);
  assert.match(staticServer, /pathname\.endsWith\('\/Dockerfile'\)/);
  assert.match(staticServer, /public, max-age=31536000, immutable/);
});
