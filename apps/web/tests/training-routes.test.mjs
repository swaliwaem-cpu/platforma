import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(resolve(currentDir, '../src/App.tsx'), 'utf8');
const shellSource = readFileSync(
  resolve(currentDir, '../src/training/TrainingShellPage.tsx'),
  'utf8',
);
const adminSource = readFileSync(
  resolve(currentDir, '../src/training/TrainingAdminPage.tsx'),
  'utf8',
);
const operationsSource = readFileSync(
  resolve(currentDir, '../src/training/TrainingOperationsPage.tsx'),
  'utf8',
);
const adminHomeSource = appSource.slice(
  appSource.indexOf('function AdminHome('),
  appSource.indexOf('function AccessDenied('),
);

test('employee training route and navigation require pilot take permission', () => {
  assert.match(
    appSource,
    /id:\s*'training',[\s\S]*label:\s*'Обучение',[\s\S]*path:\s*'\/training',[\s\S]*section:\s*'training',[\s\S]*requiredPermissions:\s*\['training:take'\]/,
  );
  assert.match(appSource, /pathname === '\/training'[\s\S]*\? 'training'/);
  assert.match(
    appSource,
    /group:\s*'Обучение',[\s\S]*path:\s*'\/training',[\s\S]*requiredPermissions:\s*\['training:take'\]/,
  );
});

test('admin training route and navigation require admin access and project management', () => {
  assert.match(appSource, /pathname\.startsWith\('\/admin\/training'\)/);
  assert.match(
    appSource,
    /pathname\.startsWith\('\/admin\/training'\)[\s\S]*hasPermission\('training:projects:manage'\)[\s\S]*<TrainingAdminPage/,
  );
  assert.match(
    appSource,
    /id:\s*'admin-training',[\s\S]*path:\s*'\/admin\/training',[\s\S]*requiredPermissions:\s*\['admin:access', 'training:projects:manage'\]/,
  );
  assert.match(appSource, /onOpenTraining=\{\(\) => navigate\('\/admin\/training'\)\}/);
  assert.match(
    appSource,
    /user\?\.permissions\.includes\('training:projects:manage'\)[\s\S]*'\/training\/admin\/config'/,
  );
  assert.match(
    appSource,
    /label:\s*'Обучение',[\s\S]*canAccess:\s*isTrainingEnabled\s*&&\s*hasPermission\('training:projects:manage'\)[\s\S]*onClick:\s*onOpenTraining/,
  );
});

test('top-level training navigation remains available to training admins and opens admin training', () => {
  assert.match(
    appSource,
    /function canAccessNavigationItem[\s\S]*item\.id === 'training'[\s\S]*hasPermission\('training:take'\)[\s\S]*hasPermission\('training:projects:manage'\)/,
  );
  assert.match(
    appSource,
    /function getNavigationPath[\s\S]*item\.id === 'training'[\s\S]*user\.permissions\.includes\('training:projects:manage'\)[\s\S]*'\/admin\/training'/,
  );
});

test('employee shell and manual admin routes do not add a router dependency', () => {
  assert.match(appSource, /import \{ TrainingAdminPage \} from '\.\/training\/TrainingAdminPage';/);
  assert.match(appSource, /import \{ TrainingShellPage \} from '\.\/training\/TrainingShellPage';/);
  assert.match(appSource, /pathname === '\/training'/);
  assert.doesNotMatch(appSource, /react-router/);
  assert.doesNotMatch(adminSource, /react-router/);
  assert.match(adminSource, /pathname === '\/admin\/training\/new'/);
  assert.match(adminSource, /\/admin\\\/training\\\/\(\[0-9a-f-\]\+\)\\\/edit/);
  assert.match(
    shellSource,
    /apiRequest<TrainingModuleConfigResponse>\(\s*'\/training\/config',\s*accessToken,\s*\)/,
  );
  assert.match(shellSource, /config\?\.status === 'disabled'/);
  assert.match(shellSource, /config\?\.status === 'enabled'/);
});

test('stage ten policy and operations routes keep explicit permission checks', () => {
  assert.match(
    appSource,
    /id:\s*'admin-training-operations'[\s\S]*path:\s*'\/admin\/training\/operations'[\s\S]*requiredPermissions:\s*\['admin:access', 'training:operations:read'\]/,
  );
  assert.match(
    appSource,
    /pathname\.startsWith\('\/admin\/training\/operations'\)[\s\S]*hasPermission\('training:operations:read'\)[\s\S]*<TrainingOperationsPage/,
  );
  assert.match(shellSource, /getTrainingPolicy\(accessToken\)/);
  assert.match(shellSource, /acceptTrainingPolicy\(accessToken\)/);
  assert.match(shellSource, /Ознакомлен и согласен продолжить/);
  assert.match(
    operationsSource,
    /hasPermission\('training:operations:manage'\)/,
  );
  assert.match(
    operationsSource,
    /retryTrainingJob\(\s*accessToken,\s*retryJobId,\s*normalizedReason,\s*idempotencyKey,\s*\)/,
  );
  assert.match(operationsSource, /createOperationsRetryIdempotencyKey\(\)/);
  assert.doesNotMatch(operationsSource, /recentPolicyAcceptances|item\.user/);
  assert.match(
    appSource,
    /item\.section !== 'training' \|\| isTrainingEnabled === true/,
  );
  assert.match(
    appSource,
    /section\.id !== 'training' \|\| isTrainingEnabled/,
  );
});

test('admin home hides training operations and ranking duplicate cards', () => {
  assert.doesNotMatch(adminHomeSource, /Состояние обучения/u);
  assert.doesNotMatch(adminHomeSource, /Рейтинг обучения/u);
  assert.doesNotMatch(adminHomeSource, /onOpenTrainingOperations/u);
  assert.doesNotMatch(adminHomeSource, /onOpenTrainingRanking/u);
  assert.match(appSource, /path:\s*'\/admin\/training\/operations'/u);
  assert.match(appSource, /path:\s*'\/admin\/training\/ranking'/u);
});
