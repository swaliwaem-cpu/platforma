import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

test('Training feature config hides navigation, admin entry and direct routes when disabled', () => {
  assert.match(appSource, /apiRequest<\{ enabled: boolean \}>\('\/training\/config'/u);
  assert.match(appSource, /item\.id !== 'training' \|\| trainingEnabled/u);
  assert.match(appSource, /trainingEnabled && hasPermission\('training:participate'\)/u);
  assert.match(
    appSource,
    /trainingEnabled &&\s*\(hasPermission\('training:projects:manage'\) \|\| hasPermission\('training:results:read'\)\)/u,
  );
  assert.match(appSource, /trainingEnabled=\{trainingEnabled\}/u);
});
