import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const styles = readFileSync(resolve(currentDir, '../src/styles.css'), 'utf8');

test('admin gallery item keeps preview text readable next to action buttons', () => {
  assert.match(
    styles,
    /\.gallery-item\s*\{[\s\S]*?align-items:\s*center;[\s\S]*?cursor:\s*grab;[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.gallery-item-main\s*\{[\s\S]*?flex:\s*1 1 240px;[\s\S]*?grid-template-columns:\s*58px minmax\(0,\s*1fr\);[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.gallery-actions\s*\{[\s\S]*?justify-content:\s*flex-end;[\s\S]*?\}/,
  );
});

test('admin gallery modal uses stable cover slot and large responsive tile grid', () => {
  assert.match(
    styles,
    /\.gallery-modal-backdrop\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?inset:\s*0;[\s\S]*?align-items:\s*center;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.gallery-modal\s*\{[\s\S]*?width:\s*90vw;[\s\S]*?height:\s*90dvh;[\s\S]*?max-width:\s*90vw;[\s\S]*?max-height:\s*90dvh;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.gallery-modal-header-actions\s*\{[\s\S]*?margin-left:\s*auto;[\s\S]*?position:\s*relative;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.gallery-modal-header-save\s*\{[\s\S]*?min-height:\s*36px;[\s\S]*?padding:\s*8px 12px;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.gallery-cover-slot\s*\{[\s\S]*?min-height:\s*180px;[\s\S]*?border:\s*1px dashed[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.gallery-tile-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(140px,\s*1fr\)\);[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.gallery-tile-preview\s*\{[\s\S]*?aspect-ratio:\s*4 \/ 3;[\s\S]*?overflow:\s*hidden;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.gallery-tile-name\s*\{[\s\S]*?overflow-wrap:\s*anywhere;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?\.gallery-tile-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(120px,\s*1fr\)\);[\s\S]*?\}/,
  );
});

test('admin gallery modal styles compact close confirmation', () => {
  assert.match(
    styles,
    /\.gallery-close-confirm\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?right:\s*0;[\s\S]*?width:\s*min\(260px,\s*calc\(100vw - 48px\)\);[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.gallery-close-confirm-actions\s*\{[\s\S]*?display:\s*flex;[\s\S]*?justify-content:\s*flex-end;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.gallery-close-confirm-action\s*\{[\s\S]*?min-height:\s*30px;[\s\S]*?padding:\s*6px 10px;[\s\S]*?\}/,
  );
});

test('admin gallery modal exposes visual drag targets and compact order controls', () => {
  assert.match(
    styles,
    /\.gallery-cover-slot--drop-target\s*\{[\s\S]*?border-color:\s*#2563eb;[\s\S]*?box-shadow:\s*0 0 0 3px rgb\(37 99 235 \/ 14%\);[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.gallery-tile--drop-target \.gallery-tile-button\s*\{[\s\S]*?border-color:\s*#2563eb;[\s\S]*?box-shadow:\s*0 0 0 3px rgb\(37 99 235 \/ 14%\);[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.gallery-tile-order-actions\s*\{[\s\S]*?display:\s*flex;[\s\S]*?justify-content:\s*space-between;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.gallery-tile-order-button\s*\{[\s\S]*?width:\s*32px;[\s\S]*?height:\s*32px;[\s\S]*?\}/,
  );
});

test('admin gallery modal uses per-tile thematic section selects without section slots', () => {
  assert.match(
    styles,
    /\.gallery-tile-section-select\s*\{[\s\S]*?min-height:\s*34px;[\s\S]*?\}/,
  );

  assert.doesNotMatch(styles, /\.gallery-section-slots\s*\{/);
  assert.doesNotMatch(styles, /\.gallery-section-slot\s*\{/);
  assert.doesNotMatch(styles, /\.gallery-section-slot--drop-target\s*\{/);
  assert.doesNotMatch(styles, /\.gallery-section-thumbnails\s*\{/);
});

test('admin gallery modal keeps tile remove action compact and anchored', () => {
  assert.match(
    styles,
    /\.gallery-tile\s*\{[\s\S]*?position:\s*relative;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.gallery-tile-remove-button\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?top:\s*8px;[\s\S]*?right:\s*8px;[\s\S]*?width:\s*32px;[\s\S]*?height:\s*32px;[\s\S]*?\}/,
  );
});

test('admin gallery modal lets the browser skip offscreen tile rendering work', () => {
  assert.match(
    styles,
    /\.gallery-tile\s*\{[\s\S]*?content-visibility:\s*auto;[\s\S]*?contain-intrinsic-size:\s*260px 220px;[\s\S]*?\}/,
  );
});
