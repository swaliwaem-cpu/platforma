import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { TrainingAudioObjectUrl } from '../src/training/trainingAudioUrl.mjs';
import { TrainingReviewSubmission } from '../src/training/trainingReviewSubmission.mjs';
import {
  attemptStatusLabels,
  employeeBreakdownStatusLabels,
  formatTrainingDuration,
  formatTrainingScore,
  visibleEmployeeScore,
} from '../src/training/trainingViewModel.mjs';

const currentDir = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(
  resolve(currentDir, '../src/App.tsx'),
  'utf8',
);
const employeeSource = readFileSync(
  resolve(currentDir, '../src/training/TrainingShellPage.tsx'),
  'utf8',
);
const adminSource = readFileSync(
  resolve(currentDir, '../src/training/TrainingAdminResultsPage.tsx'),
  'utf8',
);
const rankingSource = readFileSync(
  resolve(currentDir, '../src/training/TrainingRankingPage.tsx'),
  'utf8',
);
const cssSource = readFileSync(
  resolve(currentDir, '../src/training/trainingResults.css'),
  'utf8',
);

test('employee view model masks pending scores and formats stable states', () => {
  assert.equal(
    visibleEmployeeScore({ reviewStatus: 'PENDING', finalScore: '99.00' }),
    null,
  );
  assert.equal(
    visibleEmployeeScore({
      reviewStatus: 'APPROVED',
      finalScore: '88.50',
    }),
    '88.50',
  );
  assert.equal(attemptStatusLabels.TECHNICAL_FAILURE, 'Техническая ошибка');
  assert.equal(
    employeeBreakdownStatusLabels.MANUALLY_ADJUSTED_BREAKDOWN_UNAVAILABLE,
    'Итоговая оценка скорректирована после проверки. Детализация по вопросам недоступна.',
  );
  assert.equal(formatTrainingScore('88.50'), '88,5');
  assert.equal(formatTrainingDuration(125), '2 мин 5 сек');
});

test('protected audio object URLs are revoked on replacement and cleanup', () => {
  const created = [];
  const revoked = [];
  const manager = new TrainingAudioObjectUrl({
    createObjectURL(blob) {
      const value = `blob:test-${blob.size}-${created.length}`;
      created.push(value);
      return value;
    },
    revokeObjectURL(value) {
      revoked.push(value);
    },
  });

  const first = manager.replace(new Blob(['first']));
  const second = manager.replace(new Blob(['second']));
  manager.revoke();
  manager.revoke();

  assert.notEqual(first, second);
  assert.deepEqual(revoked, [first, second]);
});

test('review operation keeps one key for ambiguous POST and refresh retries', () => {
  let sequence = 0;
  const submission = new TrainingReviewSubmission(
    () => `uuid-${++sequence}`,
  );
  const payload = {
    decision: 'APPROVED',
    comment: 'Проверено',
    unsupportedClaimsDecisions: [],
  };

  const first = submission.begin(payload);
  assert.equal(first.key, 'training-review-uuid-1');
  assert.deepEqual(first.payload, payload);
  assert.match(first.payloadHash, /^[a-f0-9]{8}$/u);

  submission.markPostAmbiguous();
  const retry = submission.retryAmbiguous();
  assert.equal(retry.key, first.key);
  assert.equal(retry.payloadHash, first.payloadHash);
  assert.deepEqual(retry.payload, payload);

  submission.markCommitted();
  submission.markRefreshing();
  submission.markRefreshFailed();
  assert.throws(
    () => submission.begin({ ...payload, comment: 'Другой payload' }),
    /payload cannot be changed/u,
  );
  submission.markRefreshing();
  submission.markCompleted();

  const next = submission.begin({
    ...payload,
    comment: 'Новая осознанная проверка',
  });
  assert.equal(next.key, 'training-review-uuid-2');
  assert.notEqual(next.payloadHash, first.payloadHash);
});

test('review operation canonicalizes object key order and isolates permanent failures', () => {
  let sequence = 0;
  const submission = new TrainingReviewSubmission(
    () => `uuid-${++sequence}`,
  );
  const first = submission.begin({
    comment: 'Проверено',
    decision: 'APPROVED',
    unsupportedClaimsDecisions: [{ verdict: 'APPROVED', componentId: '1' }],
  });
  submission.markPostAmbiguous();
  const retry = submission.retryAmbiguous();
  assert.equal(retry.payloadHash, first.payloadHash);

  submission.markPostFailed();
  const replacement = submission.begin({
    unsupportedClaimsDecisions: [],
    decision: 'OVERRIDDEN',
    comment: 'Исправлено',
  });
  assert.equal(replacement.key, 'training-review-uuid-2');
  assert.notEqual(replacement.payloadHash, first.payloadHash);
});

test('stage 9 routes use server permissions and route-level loading', () => {
  const resultsRouteIndex = appSource.indexOf(
    "pathname.startsWith('/admin/training/results')",
  );
  const projectRouteIndex = appSource.indexOf(
    "pathname.startsWith('/admin/training')",
  );
  assert.ok(resultsRouteIndex > 0);
  assert.ok(projectRouteIndex > resultsRouteIndex);
  assert.match(
    appSource,
    /hasPermission\('training:results:read'\)[\s\S]*TrainingAdminResultsPage/u,
  );
  assert.match(appSource, /lazy\(\(\) =>[\s\S]*TrainingRankingPage/u);
  assert.match(employeeSource, /getTrainingTelegramAccount/u);
  assert.match(employeeSource, /getTrainingAttempt/u);
  assert.match(employeeSource, /attempt\.breakdownStatus/u);
  assert.doesNotMatch(employeeSource, /attempt\.summary/u);
  assert.match(employeeSource, /project\.allowRetakeAfterPass/u);
  assert.match(employeeSource, /project\.activeAttempt/u);
  assert.match(employeeSource, /TELEGRAM_NOT_CONNECTED/u);
  assert.match(adminSource, /downloadTrainingAnswerAudio/u);
  assert.match(adminSource, /managerRef\.current\.revoke\(\)/u);
  assert.match(adminSource, /generationRef/u);
  assert.match(adminSource, /AbortController/u);
  assert.match(adminSource, /getTrainingRanking\(accessToken/u);
  assert.match(adminSource, /caughtError\.status === 409/u);
  assert.match(
    adminSource,
    /Проверка сохранена, но обновить данные не удалось/u,
  );
  assert.match(adminSource, /Повторить обновление/u);
  assert.match(rankingSource, /downloadTrainingRankingCsv/u);
  assert.match(
    rankingSource,
    /\/admin\/training\/results\/\$\{project\.attemptId\}/u,
  );
  assert.match(rankingSource, /project\.scoreChangeFromFirst/u);
});

test('training results layout covers mobile, tablet and reduced motion', () => {
  assert.match(cssSource, /@media \(max-width: 1180px\)/u);
  assert.match(cssSource, /@media \(max-width: 760px\)/u);
  assert.match(cssSource, /@media \(max-width: 430px\)/u);
  assert.match(cssSource, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(cssSource, /\.training-results-table\s*\{[\s\S]*min-width/u);
});
