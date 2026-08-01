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
const projectsSource = source('training/TrainingProjectsPage.tsx');
const attemptSource = source('training/TrainingAttemptPage.tsx');
const adminProjectsSource = source('training/TrainingAdminProjectsPage.tsx');
const editorSource = source('training/TrainingAdminProjectEditorPage.tsx');
const adminAttemptSource = source('training/TrainingAdminAttemptPage.tsx');
const viewSource = source('training/trainingView.ts');
const stylesSource = source('training/training.css');

test('Training V2 uses exactly five Stage 1 page routes', () => {
  assert.equal(routesSource.includes('/^\\/training\\/?$/u'), true);
  assert.equal(routesSource.includes('/^\\/training\\/attempts\\/([^/]+)\\/?$/u'), true);
  assert.equal(routesSource.includes('/^\\/admin\\/training\\/?$/u'), true);
  assert.equal(routesSource.includes('/^\\/admin\\/training\\/projects\\/([^/]+)\\/?$/u'), true);
  assert.equal(routesSource.includes('/^\\/admin\\/training\\/attempts\\/([^/]+)\\/?$/u'), true);
  assert.doesNotMatch(routesSource, /telegram|audio|voice|review\/|ranking|leaderboard/iu);
});

test('application shell enforces employee and admin permission gates', () => {
  assert.match(appSource, /requiredPermissions: \['training:participate'\]/);
  assert.match(appSource, /hasPermission\('training:participate'\)[\s\S]*?<TrainingEmployeeRoutes/);
  assert.match(appSource, /hasPermission\('admin:access'\)[\s\S]*?pathname\.startsWith\('\/admin\/training'\)/);
  assert.match(appSource, /hasPermission\('training:projects:manage'\) \|\| hasPermission\('training:results:read'\)/);
  assert.match(routesSource, /canManageProjects[\s\S]*?TrainingAdminProjectEditorPage/);
  assert.match(routesSource, /canReadResults[\s\S]*?TrainingAdminAttemptPage/);
});

test('employee flow uses server state, stable start idempotency and current question only', () => {
  assert.match(apiSource, /Idempotency-Key/);
  assert.match(projectsSource, /startIdempotencyKeyRef/);
  assert.match(projectsSource, /activeAttempt\?\.id/);
  assert.match(attemptSource, /attempt\.currentQuestion/);
  assert.match(attemptSource, /new Date\(attempt\.expiresAt\)\.getTime\(\) - now/);
  assert.match(attemptSource, /window\.setInterval\([\s\S]*?1000\)/);
  assert.match(attemptSource, /timeoutRefreshAttemptRef/);
  assert.match(attemptSource, /response\.status === 'IN_PROGRESS'[\s\S]*?setTimeoutRefreshKey/);
  assert.doesNotMatch(attemptSource, /followUpQuestions|questionPool|hiddenQuestions/);
});

test('Stage 2 employee flow makes project-bound Telegram voice transport primary', () => {
  assert.match(apiSource, /\/training\/telegram\/account/);
  assert.match(apiSource, /\/training\/projects\/\$\{encodeURIComponent\(projectId\)\}\/telegram-link/);
  assert.match(projectsSource, /Пройти в Telegram/);
  assert.match(projectsSource, /Продолжить в Telegram/);
  assert.match(projectsSource, /Открыть Telegram/);
  assert.match(projectsSource, /import\.meta\.env\.DEV/);
  assert.match(projectsSource, /Тестовый текстовый режим/);
  assert.match(projectsSource, /Срок действия ссылки истёк/);
  assert.match(projectsSource, /target="_blank" rel="noreferrer"/);
  assert.match(projectsSource, /telegramAccount\?\.linked/);
});

test('employee screens render loading, error, empty, result and review states', () => {
  assert.match(projectsSource, /aria-label="Загрузка проектов"/);
  assert.match(projectsSource, /tone="error"/);
  assert.match(projectsSource, /Нет открытых проектов/);
  assert.match(attemptSource, /aria-label="Загрузка попытки"/);
  assert.match(attemptSource, /attempt\.result\.finalScore \?\? '—'/);
  assert.match(attemptSource, /attempt\.status === 'REQUIRES_REVIEW'/);
  assert.match(attemptSource, /if \(!attempt\)[\s\S]*?setReloadKey/);
  assert.match(adminAttemptSource, /if \(!attempt\)[\s\S]*?setReloadKey/);
  assert.match(editorSource, /if \(!project \|\| !form\)[\s\S]*?setReloadKey/);
  assert.match(viewSource, /PASSED[\s\S]*?Пройдено/);
  assert.match(viewSource, /FAILED[\s\S]*?Не пройдено/);
  assert.match(viewSource, /REQUIRES_REVIEW[\s\S]*?Требует проверки/);
});

test('Stage 2 keeps text answers only as explicit development/test fallback', () => {
  assert.match(attemptSource, /Development\/test fallback Stage 2/);
  assert.match(attemptSource, /\[fake:pass\]/);
  assert.match(attemptSource, /\[fake:fail\]/);
  assert.match(attemptSource, /\[fake:review\]/);
});

test('admin authoring validates one main and exactly ten follow-up questions', () => {
  assert.match(editorSource, /1 главный и 10 дополнительных вопросов/);
  assert.match(editorSource, /Array\.from\(\{ length: 10 \}/);
  assert.match(editorSource, /form\.followUpQuestions\.forEach/);
  assert.match(editorSource, /if \(!form\.mainQuestion\.trim\(\)\)/);
  assert.match(editorSource, /validateInteger\(form\.passScore,[\s\S]*?0, 100\)/);
  assert.match(editorSource, /Закройте проект перед редактированием\. Уже начатые попытки не изменятся\./);
});

test('admin list and attempt detail expose only Stage 1 operational data', () => {
  assert.match(adminProjectsSource, /Проекты/);
  assert.match(adminProjectsSource, /Последние попытки/);
  assert.match(adminAttemptSource, /attempt\.questions\.map/);
  assert.match(adminAttemptSource, /question\.answer\.text/);
  assert.doesNotMatch(adminAttemptSource, /reviewAction|ranking|leaderboard|audio|transcript/iu);
});

test('Training UI has responsive, focus-visible and reduced-motion states', () => {
  assert.match(stylesSource, /:focus-visible/);
  assert.match(stylesSource, /@media \(max-width: 820px\)/);
  assert.match(stylesSource, /@media \(max-width: 520px\)/);
  assert.match(stylesSource, /@media \(prefers-reduced-motion: reduce\)/);
});
