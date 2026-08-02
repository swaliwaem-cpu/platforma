import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = (path) => readFileSync(resolve(currentDir, `../src/${path}`), 'utf8');
const api = source('training/trainingApi.ts');
const results = source('training/TrainingAdminResultsPage.tsx');
const detail = source('training/TrainingAdminAttemptPage.tsx');
const audio = source('training/TrainingProtectedAudioPlayer.tsx');
const employee = source('training/TrainingProjectsPage.tsx');

test('Stage 5 Part 1 results page uses server filters, pagination and detail navigation', () => {
  assert.match(api, /\/training\/admin\/results\?/);
  assert.match(results, /getTrainingAdminResults/);
  assert.match(results, /page: 1/);
  assert.match(results, /limit: 20/);
  assert.match(results, /scoreMin/);
  assert.match(results, /assignmentStatus/);
  assert.match(results, /durationMax/);
  assert.match(results, /\/admin\/training\/attempts\/\$\{item\.id\}/);
  assert.doesNotMatch(results, /ranking|leaderboard|csv/iu);
});

test('Stage 5 Part 1 review commits POST state before a separate detail refresh', () => {
  const reviewIndex = detail.indexOf('reviewTrainingAdminAttempt');
  const optimisticIndex = detail.indexOf('setAttempt((current)');
  const refreshIndex = detail.indexOf('getTrainingAdminAttempt(accessToken, attempt.id)', optimisticIndex);

  assert.ok(reviewIndex >= 0);
  assert.ok(optimisticIndex > reviewIndex);
  assert.ok(refreshIndex > optimisticIndex);
  assert.match(detail, /Решение сохранено, но detail не обновился/);
});

test('Stage 5 Part 1 protected audio owns abort and object URL lifecycle', () => {
  assert.match(api, /\/training\/admin\/answers\/\$\{encodeURIComponent\(answerId\)\}\/audio/);
  assert.match(audio, /AbortController/);
  assert.match(audio, /URL\.createObjectURL/);
  assert.match(audio, /URL\.revokeObjectURL/);
  assert.match(audio, /requestIdRef/);
  assert.doesNotMatch(audio, /localStorage|sessionStorage|bucket|storage key/iu);
});

test('Stage 5 Part 1 employee history keeps results independent from Telegram status', () => {
  assert.match(employee, /Promise\.all\(\[/);
  assert.match(employee, /getTrainingTelegramAccount\(accessToken, controller\.signal\)[\s\S]*?\.catch/);
  assert.match(employee, /attempt\.safeBreakdown/);
  assert.match(employee, /attempt\.attemptRefunded/);
  assert.match(employee, /project\.lastConfirmedScore/);
});
