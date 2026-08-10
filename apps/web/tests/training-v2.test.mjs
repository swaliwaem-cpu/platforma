import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = (path) => readFileSync(resolve(currentDir, `../src/${path}`), 'utf8');
const appSource = source('App.tsx');
const routesSource = source('training/TrainingRoutes.tsx');
const employeeRoutesSource = source('training/TrainingEmployeeRoutes.tsx');
const adminRoutesSource = source('training/TrainingAdminRoutes.tsx');
const apiSource = source('training/trainingApi.ts');
const projectsSource = source('training/TrainingProjectsPage.tsx');
const attemptSource = source('training/TrainingAttemptPage.tsx');
const adminProjectsSource = source('training/TrainingAdminProjectsPage.tsx');
const editorSource = source('training/TrainingAdminProjectEditorPage.tsx');
const adminAttemptSource = source('training/TrainingAdminAttemptPage.tsx');
const viewSource = source('training/trainingView.ts');
const stylesSource = source('training/training.css');
const dashboardStylesSource = source('training/trainingAdminDashboard.css');
const audioStorageSource = source('training/TrainingAudioStoragePage.tsx');
const audioStorageStylesSource = source('training/trainingAudioStorage.css');
const appThemeSource = source('app-theme.css');

test('Training V2 keeps existing routes and adds the Stage 5 Part 2 ranking route', () => {
  assert.equal(employeeRoutesSource.includes('/^\\/training\\/?$/u'), true);
  assert.equal(employeeRoutesSource.includes('/^\\/training\\/attempts\\/([^/]+)\\/?$/u'), true);
  assert.equal(adminRoutesSource.includes('/^\\/admin\\/training\\/?$/u'), true);
  assert.equal(adminRoutesSource.includes('/^\\/admin\\/training\\/projects\\/([^/]+)\\/?$/u'), true);
  assert.equal(adminRoutesSource.includes('/^\\/admin\\/training\\/attempts\\/([^/]+)\\/?$/u'), true);
  assert.equal(adminRoutesSource.includes('/^\\/admin\\/training\\/results\\/?$/u'), true);
  assert.equal(adminRoutesSource.includes('/^\\/admin\\/training\\/ranking\\/?$/u'), true);
  assert.equal(adminRoutesSource.includes('/^\\/admin\\/training\\/audio-storage\\/?$/u'), true);
});

test('training employee and admin routes are isolated behind lazy route chunks', () => {
  assert.match(routesSource, /lazy\([\s\S]*?import\('\.\/TrainingEmployeeRoutes'\)/);
  assert.match(routesSource, /lazy\([\s\S]*?import\('\.\/TrainingAdminRoutes'\)/);
  assert.match(routesSource, /<Suspense fallback=\{<TrainingRouteLoading \/>\}>/);
  assert.match(routesSource, /Обновить страницу/);
  assert.doesNotMatch(employeeRoutesSource, /TrainingAdmin/u);
  assert.doesNotMatch(adminRoutesSource, /TrainingProjectsPage|TrainingAttemptPage/u);
});

test('application shell enforces employee and admin permission gates', () => {
  assert.match(appSource, /requiredPermissions: \['training:participate'\]/);
  assert.match(appSource, /hasPermission\('training:participate'\)[\s\S]*?<TrainingEmployeeRoutes/);
  assert.match(appSource, /hasPermission\('admin:access'\)[\s\S]*?pathname\.startsWith\('\/admin\/training'\)/);
  assert.match(appSource, /hasPermission\('training:projects:manage'\)[\s\S]*?hasPermission\('training:results:read'\)[\s\S]*?hasPermission\('training:audio:read'\)/);
  assert.match(adminRoutesSource, /canManageProjects[\s\S]*?TrainingAdminProjectEditorPage/);
  assert.match(adminRoutesSource, /canReadResults[\s\S]*?TrainingAdminAttemptPage/);
  assert.match(appSource, /canReadAudio=\{hasPermission\('training:audio:read'\)\}/);
  assert.match(appSource, /canDeleteFiles=\{hasPermission\('files:delete'\)\}/);
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
  assert.match(editorSource, /useState<EditorTab>\('materials'\)/);
  assert.match(editorSource, /label="Материалы"[\s\S]*?label="Вопросы"[\s\S]*?label="Назначения"/);
  assert.match(editorSource, /Array\.from\(\{ length: 10 \}/);
  assert.match(editorSource, /form\.followUpQuestions\.forEach/);
  assert.match(editorSource, /if \(!form\.mainQuestion\.trim\(\)\)/);
  assert.match(editorSource, /validateInteger\(form\.passScore,[\s\S]*?0, 100\)/);
  assert.match(editorSource, /Закройте проект перед редактированием\. Уже начатые попытки не изменятся\./);
});

test('admin projects link to results and ranking while detail keeps excluded surfaces out', () => {
  assert.match(adminProjectsSource, /Проекты/);
  assert.match(adminProjectsSource, /Результаты сотрудников/);
  assert.match(adminAttemptSource, /attempt\.questions\.map/);
  assert.match(adminAttemptSource, /question\.answer\.text/);
  assert.match(adminAttemptSource, /TrainingProtectedAudioPlayer/);
  assert.doesNotMatch(adminAttemptSource, /ranking|leaderboard|storage key|bucket/iu);
});

test('admin projects overview renders an accessible responsive operations dashboard with modal creation', () => {
  assert.match(adminProjectsSource, /aria-label="Сводка по проектам"/u);
  assert.match(adminProjectsSource, /project\.status === 'PUBLISHED'/u);
  assert.match(adminProjectsSource, /project\.status === 'DRAFT'/u);
  assert.match(adminProjectsSource, /summary\.attempts \+= project\.attemptsCount/u);
  assert.match(adminProjectsSource, /size="icon"[\s\S]*?aria-label="Результаты сотрудников"/u);
  assert.match(adminProjectsSource, /size="icon"[\s\S]*?aria-label="Рейтинг"/u);
  assert.match(adminProjectsSource, /<DialogTitle>Создать проект<\/DialogTitle>/u);
  assert.match(adminProjectsSource, /aria-label=\{`Открыть проект «\$\{project\.title\}»`\}/u);
  assert.match(adminProjectsSource, /required[\s\S]*?autoComplete="off"[\s\S]*?disabled=\{isCreating\}/u);
  assert.match(dashboardStylesSource, /\.training-dashboard-project-panel\s*\{[\s\S]*?width:\s*100%;/u);
  assert.match(dashboardStylesSource, /data-app-theme='dark-premium'[\s\S]*?training-dashboard-metric-icon[\s\S]*?training-dashboard-project-name svg[\s\S]*?color:\s*var\(--app-theme-ink-900\);/u);
  assert.doesNotMatch(dashboardStylesSource, /data-tone='success'\] \.training-dashboard-metric-icon/u);
  assert.match(dashboardStylesSource, /\.training-page\.training-admin-dashboard\s*\{[\s\S]*?width:\s*85vw;/u);
  assert.match(dashboardStylesSource, /\.training-dashboard-project-name strong[\s\S]*?white-space:\s*normal;/u);
  assert.match(dashboardStylesSource, /\.training-dashboard-project-status \.status-pill[\s\S]*?white-space:\s*nowrap;/u);
  assert.match(dashboardStylesSource, /@media \(max-width: 1220px\)[\s\S]*?training-dashboard-project-head/u);
  assert.match(dashboardStylesSource, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.doesNotMatch(adminProjectsSource, /training-dashboard-create-panel/u);
  assert.doesNotMatch(adminProjectsSource, /training-dashboard-entry-grid/u);
});

test('admin project deletion is explicit, destructive and guarded against duplicate submit', () => {
  assert.match(
    apiSource,
    /deleteTrainingAdminProject[\s\S]*?encodeURIComponent\(projectId\)[\s\S]*?method: 'DELETE'/,
  );
  assert.match(editorSource, /Безвозвратно удалить проект «\{project\.title\}»\?/);
  assert.match(editorSource, /tone="danger"[\s\S]*?className="training-editor-delete-action"/);
  assert.match(editorSource, /все попытки и результаты сотрудников/);
  assert.match(editorSource, /Аудиозаписи останутся[\s\S]*?удаляются отдельно вручную/);
  assert.match(editorSource, /pendingAction === 'delete'/);
  assert.match(editorSource, /if \(!accessToken \|\| !project \|\| pendingAction\) return/);
  assert.match(editorSource, /showCloseButton=\{!isDeleting\}/);
  assert.match(editorSource, /disabled=\{isDeleting\}[\s\S]*?Отмена/);
  assert.match(editorSource, /Удалить проект и данные/);
  assert.match(editorSource, /await deleteTrainingAdminProject\(accessToken, project\.id\)/);
  assert.match(editorSource, /navigate\('\/admin\/training'\)/);
  assert.match(editorSource, /deleteError \? <AdminAlert tone="error">/);
});

test('audio storage page is manual-only, filterable and double-confirmed', () => {
  assert.match(adminRoutesSource, /canReadAudio[\s\S]*?TrainingAudioStoragePage/);
  assert.match(adminProjectsSource, /aria-label="Хранилище аудио"[\s\S]*?\/admin\/training\/audio-storage/);
  assert.match(audioStorageSource, /Автоматического GC нет/);
  assert.match(audioStorageSource, /Название, включая удалённые/);
  assert.match(audioStorageSource, /Имя или email/);
  assert.match(audioStorageSource, /type="date"/);
  assert.match(audioStorageSource, /confirmationPhrase = `УДАЛИТЬ \$\{selectedItems\.length\}`/);
  assert.match(audioStorageSource, /createTrainingAudioDeletionManifest[\s\S]*?executeTrainingAudioDeletionManifest/);
  assert.match(audioStorageSource, /backend повторно проверяет все ссылки на File/);
  assert.match(audioStorageStylesSource, /overflow-x:\s*auto/);
  assert.match(audioStorageStylesSource, /@media \(max-width: 720px\)/);
  assert.match(audioStorageStylesSource, /@media \(prefers-reduced-motion: reduce\)/);
});

test('question fact actions stay grouped and dark-theme feedback uses readable semantic colors', () => {
  assert.match(editorSource, /className="training-fact-actions"[\s\S]*?className="training-inline-check"[\s\S]*?className="training-fact-delete-action"/);
  assert.match(stylesSource, /\.training-inline-check input\[type='checkbox'\][\s\S]*?width:\s*18px;[\s\S]*?height:\s*18px;/);
  assert.match(stylesSource, /\.training-fact-actions\s*\{[\s\S]*?justify-content:\s*space-between;/);
  assert.match(appThemeSource, /\.admin-alert--notice\)[\s\S]*?background:\s*var\(--app-theme-success-soft\);/);
  assert.match(appThemeSource, /\.admin-alert \[data-slot='alert-description'\][\s\S]*?color:\s*inherit;/);
  assert.match(appThemeSource, /\.admin-button--danger\s*\{[\s\S]*?background:\s*var\(--app-theme-danger\);/);
});

test('Training UI has responsive, focus-visible and reduced-motion states', () => {
  assert.match(stylesSource, /:focus-visible/);
  assert.match(stylesSource, /@media \(max-width: 820px\)/);
  assert.match(stylesSource, /@media \(max-width: 520px\)/);
  assert.match(stylesSource, /@media \(prefers-reduced-motion: reduce\)/);
});
