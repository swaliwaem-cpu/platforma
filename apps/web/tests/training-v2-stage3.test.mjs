import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = (path) => readFileSync(resolve(currentDir, `../src/${path}`), 'utf8');
const appSource = source('App.tsx');
const routesSource = source('training/TrainingRoutes.tsx');
const apiSource = source('training/trainingApi.ts');
const editorSource = source('training/TrainingAdminProjectEditorPage.tsx');
const adminAttemptSource = source('training/TrainingAdminAttemptPage.tsx');
const employeeAttemptSource = source('training/TrainingAttemptPage.tsx');

test('Stage 3 extends the existing project editor without document or operations routes', () => {
  assert.match(editorSource, /QuestionFactsEditor/);
  assert.match(editorSource, /Утверждённый факт/);
  assert.match(editorSource, /Варианты ответа через запятую/);
  assert.match(editorSource, /Обязательный факт/);
  assert.match(editorSource, /Добавить факт/);
  assert.match(editorSource, /Удалить факт/);
  assert.match(editorSource, /CriteriaEditor/);
  assert.match(editorSource, /expectedTotal=\{55\}/);
  assert.match(editorSource, /expectedTotal=\{15\}/);
  assert.match(editorSource, /publicationErrors/);
  assert.match(editorSource, /Варианты ответа не должны повторяться/);
  assert.match(editorSource, /TRAINING_FACT_ALIAS_MAX_WORDS = 15/);
  assert.match(editorSource, /Коды критериев/);
  assert.match(editorSource, /Проверьте черновик/);
  assert.doesNotMatch(routesSource, /documents|operations/iu);
});

test('Stage 3 review UI is permission-gated and protects duplicate submits', () => {
  assert.match(appSource, /hasPermission\('training:results:review'\)/);
  assert.match(routesSource, /canReviewResults=\{canReviewResults\}/);
  assert.match(apiSource, /\/training\/admin\/attempts\/\$\{encodeURIComponent\(attemptId\)\}\/review/);
  assert.match(adminAttemptSource, /decision === 'APPROVE'/);
  assert.match(adminAttemptSource, /decision === 'OVERRIDE'/);
  assert.match(adminAttemptSource, /finalScore/);
  assert.match(adminAttemptSource, /Причина обязательна для корректировки/);
  assert.match(adminAttemptSource, /if \(!accessToken \|\| !attempt \|\| isReviewing\) return/);
  assert.match(adminAttemptSource, /disabled=\{isReviewing\}/);
  assert.match(adminAttemptSource, /Сохранение…/);
});

test('admin detail renders evaluation evidence and only safe provider metadata', () => {
  assert.match(adminAttemptSource, /Расчётный балл/);
  assert.match(adminAttemptSource, /Модель расшифровки/);
  assert.match(adminAttemptSource, /Модель оценивания/);
  assert.match(adminAttemptSource, /objectiveMetrics/);
  assert.match(adminAttemptSource, /fact_assessments/);
  assert.match(adminAttemptSource, /criterion_assessments/);
  assert.match(adminAttemptSource, /unsupported_claims/);
  assert.match(adminAttemptSource, /technicalErrorCode/);
  assert.doesNotMatch(
    adminAttemptSource,
    /authorization header|api key|system prompt|storage key|raw provider/iu,
  );
});

test('employee result renders only backend-safe pending, overridden and technical messages', () => {
  assert.match(employeeAttemptSource, /attempt\.result\.finalScore \?\? '—'/);
  assert.match(employeeAttemptSource, /attempt\.result\.message/);
  assert.match(employeeAttemptSource, /attempt\.result\.safeBreakdown\.map/);
  assert.match(employeeAttemptSource, /attempt\.status === 'TECHNICAL_FAILED'[\s\S]*?trainingAttemptStatusLabels\[attempt\.status\]/);
  assert.doesNotMatch(
    employeeAttemptSource,
    /calculatedScore|reviewComment|fact_assessments|criterion_assessments|unsupported_claims|transcriptionModel|evaluationModel|technicalErrorCode/,
  );
});
