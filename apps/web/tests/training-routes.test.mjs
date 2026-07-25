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

test('employee training route and navigation require project read permission', () => {
  assert.match(
    appSource,
    /id:\s*'training',[\s\S]*label:\s*'Обучение',[\s\S]*path:\s*'\/training',[\s\S]*section:\s*'training',[\s\S]*requiredPermissions:\s*\['training:projects:read'\]/,
  );
  assert.match(appSource, /pathname === '\/training'[\s\S]*\? 'training'/);
  assert.match(
    appSource,
    /activeSection === 'training'[\s\S]*hasPermission\('training:projects:read'\)[\s\S]*<TrainingShellPage mode="employee" \/>/,
  );
  assert.match(
    appSource,
    /group:\s*'Обучение',[\s\S]*path:\s*'\/training',[\s\S]*requiredPermissions:\s*\['training:projects:read'\]/,
  );
});

test('admin training route and navigation require admin access and project management', () => {
  assert.match(appSource, /pathname\.startsWith\('\/admin\/training'\)/);
  assert.match(
    appSource,
    /pathname\.startsWith\('\/admin\/training'\)[\s\S]*hasPermission\('training:projects:manage'\)[\s\S]*<TrainingShellPage mode="admin"/,
  );
  assert.match(
    appSource,
    /id:\s*'admin-training',[\s\S]*path:\s*'\/admin\/training',[\s\S]*requiredPermissions:\s*\['admin:access', 'training:projects:manage'\]/,
  );
  assert.match(appSource, /onOpenTraining=\{\(\) => navigate\('\/admin\/training'\)\}/);
  assert.match(
    appSource,
    /label:\s*'Обучение',[\s\S]*canAccess:\s*hasPermission\('training:projects:manage'\)[\s\S]*onClick:\s*onOpenTraining/,
  );
});

test('training shells use the protected backend config without adding a router dependency', () => {
  assert.match(appSource, /import \{ TrainingShellPage \} from '\.\/training\/TrainingShellPage';/);
  assert.match(appSource, /pathname === '\/training'/);
  assert.doesNotMatch(appSource, /react-router/);
  assert.match(
    shellSource,
    /apiRequest<TrainingModuleConfigResponse>\('\/training\/config', accessToken\)/,
  );
  assert.match(shellSource, /config\?\.status === 'disabled'/);
  assert.match(shellSource, /config\?\.status === 'enabled'/);
});
