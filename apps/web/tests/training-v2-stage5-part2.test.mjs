import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = (path) => readFileSync(resolve(currentDir, `../src/${path}`), 'utf8');
const api = source('training/trainingApi.ts');
const ranking = source('training/TrainingAdminRankingPage.tsx');
const routes = source('training/TrainingRoutes.tsx');
const projects = source('training/TrainingAdminProjectsPage.tsx');

test('Stage 5 Part 2 ranking uses server pagination and the server-provided order', () => {
  assert.match(api, /\/training\/admin\/ranking\?/u);
  assert.match(ranking, /page:\s*1,[\s\S]*limit:\s*20/u);
  assert.match(ranking, /currentlyAssigned/u);
  assert.match(ranking, /currentlyEligible/u);
  assert.match(ranking, /items\.map\(\(item, index\)/u);
  assert.doesNotMatch(ranking, /\.sort\(/u);
});

test('Stage 5 Part 2 exposes permission-gated navigation, breakdown and CSV lifecycle', () => {
  assert.match(routes, /admin\\\/training\\\/ranking/u);
  assert.match(routes, /canReadResults[\s\S]*TrainingAdminRankingPage/u);
  assert.match(projects, /navigate\('\/admin\/training\/ranking'\)/u);
  assert.match(ranking, /<TableHead>Доступ<\/TableHead>/u);
  assert.match(ranking, /aria-expanded=\{isExpanded\}/u);
  assert.match(ranking, /training-ranking-expanded-row/u);
  assert.match(ranking, /Результаты по проектам/u);
  assert.match(ranking, /Есть доступ/u);
  assert.match(ranking, /Нет доступа/u);
  assert.match(ranking, /currentCoveragePercent/u);
  assert.doesNotMatch(ranking, /training-ranking-summary/u);
  assert.match(api, /\/training\/admin\/ranking\/export\.csv/u);
  assert.match(api, /URL\.createObjectURL/u);
  assert.match(api, /URL\.revokeObjectURL/u);
  assert.match(api, /link\.remove\(\)/u);
  assert.doesNotMatch(ranking, /evaluationJson|projectSnapshotJson|passwordHash|refreshToken/iu);
});
