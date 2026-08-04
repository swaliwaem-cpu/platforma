import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = (path) => readFileSync(resolve(currentDir, `../src/${path}`), 'utf8');
const routes = source('training/TrainingRoutes.tsx');
const editor = source('training/TrainingAdminProjectEditorPage.tsx');
const panel = source('training/TrainingProjectAccessPanel.tsx');
const api = source('training/trainingApi.ts');
const adminProjects = source('training/TrainingAdminProjectsPage.tsx');
const employeeProjects = source('training/TrainingProjectsPage.tsx');
const styles = source('training/training.css');

test('Stage 4.5 extends the existing editor without a new route', () => {
  assert.match(editor, /EditorStageTrigger value="assignments"[^\n]*label="Назначения"/);
  assert.match(editor, /TrainingProjectAccessPanel/);
  assert.doesNotMatch(routes, /assignments|assignment-users|project-access/iu);
  assert.match(adminProjects, /accessMode: 'ASSIGNED_USERS'/);
  assert.match(adminProjects, /project\.activeAssignments/);
});

test('Stage 4.5 access panel covers modes, warnings and bounded bulk selection', () => {
  assert.match(panel, /ASSIGNED_USERS/);
  assert.match(panel, /ALL_PARTICIPANTS/);
  assert.match(panel, /data-selected=\{project\.accessMode === 'ASSIGNED_USERS'\}/);
  assert.match(panel, /data-selected=\{project\.accessMode === 'ALL_PARTICIPANTS'\}/);
  assert.match(panel, /training-access-mode-radio/);
  assert.match(panel, />Выбрано<\/Badge>/);
  assert.match(panel, /нет активных назначений/iu);
  assert.match(panel, /server|Имя или электронная почта/iu);
  assert.match(panel, /assigned/);
  assert.match(panel, /Выбрать всех сотрудников на текущей странице/);
  assert.match(panel, /Назначить/);
  assert.match(panel, /Снять выбранных/);
  assert.match(panel, /canParticipate/);
  assert.match(panel, /isAssigned/);
  assert.match(panel, /Skeleton/);
  assert.match(panel, /Сотрудники не найдены/);
  assert.match(panel, /setError/);
});

test('Stage 4.5 API uses two assignment endpoints and existing project PATCH', () => {
  assert.match(api, /\/assignment-users\?/);
  assert.match(api, /\/assignments\/bulk/);
  assert.match(api, /status: 'active'/);
  assert.match(api, /method: 'POST'/);
  assert.match(api, /UpdateTrainingProjectAccessModeRequest/);
});

test('Stage 4.5 employee UI shows the exact safe active-attempt message', () => {
  assert.match(employeeProjects, /project\.newAttemptAccessRevoked/);
  assert.match(
    employeeProjects,
    /Доступ к новым попыткам отозван\. Текущую попытку можно завершить\./,
  );
  assert.match(employeeProjects, /project\.newAttemptAccessRevoked\s*\|\|/);
  assert.match(employeeProjects, /Продолжите через \/start в Telegram/);
  assert.match(styles, /training-access-revoked-note/);
  assert.match(styles, /training-access-modes/);
  assert.match(styles, /training-access-mode-option\[data-selected='true'\]/);
  assert.match(styles, /training-access-mode-radio\[data-state='checked'\]/);
  assert.match(styles, /training-access-mode-selected/);
  assert.match(styles, /training-assignment-pagination/);
});
