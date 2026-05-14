import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(currentDir, '../src/objects/ObjectDetailPage.tsx'), 'utf8');
const styles = readFileSync(resolve(currentDir, '../src/styles.css'), 'utf8');

test('object detail page exposes admin edit link only for object editors', () => {
  assert.match(source, /const \{ accessToken,\s*hasPermission \} = useAuth\(\);/);
  assert.match(source, /const canEditObject = hasPermission\('admin:access'\) && hasPermission\('objects:update'\);/);
  assert.match(source, /<ObjectDetail[\s\S]*?canEditObject=\{canEditObject\}[\s\S]*?object=\{object\}/);
  assert.match(source, /canEditObject: boolean;/);
  assert.match(source, /const editObjectPath = `\/admin\/objects\/\$\{object\.id\}\/edit`;/);
  assert.match(source, /canEditObject \? \([\s\S]*?<a className="object-detail-edit-link" href=\{editObjectPath\}>[\s\S]*?Редактировать[\s\S]*?<\/a>[\s\S]*?\) : null/);
});

test('object detail edit link keeps the header action aligned with the title block', () => {
  assert.match(styles, /\.object-detail-header-actions\s*\{[\s\S]*?align-items:\s*flex-end;[\s\S]*?\}/);
  assert.match(styles, /\.object-detail-edit-link\s*\{[\s\S]*?min-height:\s*42px;[\s\S]*?border:\s*1px solid #c6d0dc;[\s\S]*?\}/);
  assert.match(
    styles,
    /@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*?\.object-detail-header-actions\s*\{[\s\S]*?align-items:\s*flex-start;[\s\S]*?\}/,
  );
});
