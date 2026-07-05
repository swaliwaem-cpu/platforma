import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(resolve(currentDir, '../src/App.tsx'), 'utf8');

test('admin feeds route is registered in app routing, cabinet navigation, and admin home', () => {
  assert.match(appSource, /const FeedsAdminPage = lazy\(\(\) => import\('\.\/admin\/FeedsAdminPage'\)\.then\(\(module\) => \(\{ default: module\.FeedsAdminPage \}\)\)\);/);
  assert.match(appSource, /pathname\.startsWith\('\/admin\/feeds'\)/);
  assert.match(appSource, /<FeedsAdminPage pathname=\{pathname\} navigate=\{navigate\} onBack=\{\(\) => navigate\('\/admin'\)\} \/>/);
  assert.match(appSource, /onOpenFeeds=\{\(\) => navigate\('\/admin\/feeds'\)\}/);
  assert.match(appSource, /id:\s*'admin-feeds'[\s\S]*label:\s*'Фиды'[\s\S]*path:\s*'\/admin\/feeds'[\s\S]*requiredPermissions:\s*\['admin:access', 'feeds:read'\]/);
  assert.match(appSource, /label:\s*'Фиды'[\s\S]*canAccess:\s*hasPermission\('feeds:read'\)[\s\S]*onClick:\s*onOpenFeeds/);
});
