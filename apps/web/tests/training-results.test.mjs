import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { TrainingAudioObjectUrl } from '../src/training/trainingAudioUrl.mjs';
import { TrainingReviewSubmission } from '../src/training/trainingReviewSubmission.mjs';
import {
  attemptStatusLabels,
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

test('review retry keeps one idempotency key until success', () => {
  let sequence = 0;
  const submission = new TrainingReviewSubmission(
    () => `uuid-${++sequence}`,
  );
  const payload = {
    decision: 'APPROVED',
    comment: 'Проверено',
    unsupportedClaimsDecisions: [],
  };

  const first = submission.keyFor(payload);
  assert.equal(submission.keyFor(structuredClone(payload)), first);
  assert.notEqual(
    submission.keyFor({ ...payload, comment: 'Исправлено' }),
    first,
  );
  submission.complete();
  assert.equal(
    submission.keyFor({ ...payload, comment: 'Исправлено' }),
    'training-review-uuid-3',
  );
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
  assert.match(employeeSource, /attempt\.reviewStatus === 'PENDING'/u);
  assert.doesNotMatch(employeeSource, /attempt\.summary/u);
  assert.match(employeeSource, /project\.allowRetakeAfterPass/u);
  assert.match(employeeSource, /project\.activeAttempt/u);
  assert.match(employeeSource, /TELEGRAM_NOT_CONNECTED/u);
  assert.match(adminSource, /downloadTrainingAnswerAudio/u);
  assert.match(adminSource, /managerRef\.current\.revoke\(\)/u);
  assert.match(adminSource, /getTrainingRanking\(accessToken/u);
  assert.match(adminSource, /caughtError\.status === 409/u);
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
