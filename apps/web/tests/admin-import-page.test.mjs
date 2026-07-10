import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(currentDir, '../src/admin/ImportAdminPage.tsx'), 'utf8');

test('import reports show WordPress profile and object type metadata', () => {
  assert.match(source, /const profileLabel = getReportProfileLabel\(summary\);/);
  assert.match(source, /\{profileLabel \? <span className="table-subtext">\{profileLabel\}<\/span> : null\}/);
  assert.match(source, /\{ label: 'Профиль', value: summary\.profile \}/);
  assert.match(source, /\{ label: 'Тип объектов', value: summary\.objectType \}/);
  assert.match(source, /\{ label: 'WP post type', value: summary\.postType \}/);
  assert.match(source, /function getReportProfileLabel\(summary: Record<string, unknown> \| null\)/);
  assert.match(source, /function formatSummaryValue\(value: unknown\)/);
  assert.match(source, /formatSummaryValue\(item\.value\)/);
});
