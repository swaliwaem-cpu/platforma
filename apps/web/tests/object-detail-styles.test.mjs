import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const styles = readFileSync(resolve(currentDir, '../src/styles.css'), 'utf8');

function getRuleBody(selector) {
  const startIndex = styles.indexOf(`${selector} {`);

  assert.notEqual(startIndex, -1, `${selector} rule should exist`);

  const openIndex = styles.indexOf('{', startIndex);
  const closeIndex = styles.indexOf('}', openIndex);

  return styles.slice(openIndex + 1, closeIndex);
}

test('object detail page uses the approved desktop and mobile width', () => {
  assert.match(
    styles,
    /\.object-detail-page\s*\{[\s\S]*?width:\s*min\(80vw,\s*1760px\);[\s\S]*?max-width:\s*none;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*?\.object-detail-page\s*\{[\s\S]*?width:\s*100%;[\s\S]*?\}/,
  );
});

test('object detail carousel is a framed standalone media section', () => {
  assert.match(
    styles,
    /\.object-image-carousel\s*\{[\s\S]*?border:\s*1px solid #d6dde5;[\s\S]*?border-radius:\s*8px;[\s\S]*?box-shadow:\s*0 16px 40px rgb\(24 32 42 \/ 8%\);[\s\S]*?overflow:\s*hidden;[\s\S]*?\}/,
  );

  assert.match(styles, /\.object-detail-location-line\s*\{/);
});

test('object parameters grid has desktop, tablet, and mobile layouts', () => {
  const baseParametersRuleIndex = styles.indexOf('.object-parameters-grid {', styles.indexOf('.object-parameters-section'));
  const tabletParametersRuleIndex = styles.lastIndexOf('@media (max-width: 1100px)');

  assert.ok(
    tabletParametersRuleIndex > baseParametersRuleIndex,
    'tablet object parameters rule should be declared after the desktop rule so it wins in the cascade',
  );

  assert.match(
    styles,
    /\.object-parameters-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\);[\s\S]*?gap:\s*10px;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.object-parameters-grid div\s*\{[\s\S]*?border:\s*1px solid #e0e6ed;[\s\S]*?border-radius:\s*8px;[\s\S]*?background:\s*#f8fafc;[\s\S]*?\}/,
  );

  assert.match(
    getRuleBody('.object-parameters-grid dd'),
    /overflow-wrap:\s*anywhere;/,
  );

  assert.match(
    styles,
    /@media\s*\(max-width:\s*1100px\)\s*\{[\s\S]*?\.object-parameters-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*?\.object-parameters-grid\s*\{[\s\S]*?grid-template-columns:\s*1fr;[\s\S]*?\}/,
  );
});

test('object actions and map keep the stage seven layout constraints', () => {
  assert.match(styles, /\.object-detail-actions\s*\{/);
  assert.match(styles, /\.object-detail-action-button--primary\s*\{/);
  assert.match(styles, /\.object-detail-action-button--disabled\s*\{/);

  assert.match(
    styles,
    /\.object-map-section \.yandex-map-shell,\s*\.object-map-section \.yandex-map,\s*\.object-map-section \.map-fallback\s*\{[\s\S]*?height:\s*70svh;[\s\S]*?min-height:\s*520px;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*?\.object-map-section \.yandex-map-shell,\s*[\s\S]*?\.object-map-section \.yandex-map,\s*[\s\S]*?\.object-map-section \.map-fallback\s*\{[\s\S]*?min-height:\s*420px;[\s\S]*?\}/,
  );
});
