import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const styles = readFileSync(resolve(currentDir, '../src/styles.css'), 'utf8');
const appThemeStyles = readFileSync(resolve(currentDir, '../src/app-theme.css'), 'utf8');
const objectDetailSource = readFileSync(resolve(currentDir, '../src/objects/ObjectDetailPage.tsx'), 'utf8');

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
  assert.match(objectDetailSource, /className="media-gallery-frame object-image-carousel"/);

  assert.match(
    styles,
    /\.media-gallery-frame\s*\{[\s\S]*?border:\s*1px solid #d6dde5;[\s\S]*?border-radius:\s*8px;[\s\S]*?box-shadow:\s*0 16px 40px rgb\(24 32 42 \/ 8%\);[\s\S]*?overflow:\s*hidden;[\s\S]*?\}/,
  );

  assert.match(styles, /\.object-detail-location-line\s*\{/);
});

test('object detail carousel crops active images inside a fixed sixteen by nine frame', () => {
  assert.match(
    objectDetailSource,
    /className="media-gallery-image object-carousel-image"[\s\S]*?variant="original"/,
  );

  assert.match(
    styles,
    /\.media-gallery-frame\s*\{[\s\S]*?aspect-ratio:\s*16 \/ 9;[\s\S]*?height:\s*auto;[\s\S]*?min-height:\s*0;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.media-gallery-button\s*\{[\s\S]*?position:\s*relative;[\s\S]*?display:\s*grid;[\s\S]*?overflow:\s*hidden;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.media-gallery-image\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?inset:\s*0;[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%;[\s\S]*?object-fit:\s*cover;[\s\S]*?object-position:\s*center center;[\s\S]*?\}/,
  );

  assert.doesNotMatch(
    styles,
    /\.media-gallery-image\s*\{[\s\S]*?min-width:\s*100%;[\s\S]*?min-height:\s*100%;[\s\S]*?\}/,
  );
});

test('object detail carousel hides thumbnails until lower hover or focus zone', () => {
  assert.match(
    styles,
    /\.carousel-thumbnail-zone\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?bottom:\s*0;[\s\S]*?left:\s*0;[\s\S]*?right:\s*0;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.carousel-thumbnails\s*\{[\s\S]*?left:\s*50%;[\s\S]*?width:\s*min\(calc\(100% - 28px\),\s*1240px\);[\s\S]*?justify-content:\s*center;[\s\S]*?opacity:\s*0;[\s\S]*?pointer-events:\s*none;[\s\S]*?transform:\s*translate\(-50%,\s*8px\);[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.carousel-thumbnail-zone:hover \.carousel-thumbnails,\s*\.carousel-thumbnail-zone:focus-within \.carousel-thumbnails\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?pointer-events:\s*auto;[\s\S]*?transform:\s*translate\(-50%,\s*0\);[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /@media\s*\(hover:\s*none\)\s*\{[\s\S]*?\.carousel-thumbnails\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?pointer-events:\s*auto;[\s\S]*?\}/,
  );
});

test('object detail carousel section filter pills share lower hover and touch behavior', () => {
  assert.match(
    styles,
    /\.carousel-section-filters\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?bottom:\s*106px;[\s\S]*?left:\s*50%;[\s\S]*?opacity:\s*0;[\s\S]*?pointer-events:\s*none;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.carousel-thumbnail-zone:hover \.carousel-section-filters,\s*\.carousel-thumbnail-zone:focus-within \.carousel-section-filters\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?pointer-events:\s*auto;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.carousel-section-filter\s*\{[\s\S]*?border-radius:\s*999px;[\s\S]*?min-height:\s*34px;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.carousel-section-filter:disabled\s*\{[\s\S]*?opacity:\s*0\.48;[\s\S]*?cursor:\s*not-allowed;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /@media\s*\(hover:\s*none\)\s*\{[\s\S]*?\.carousel-section-filters\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?pointer-events:\s*auto;[\s\S]*?\}/,
  );
});

test('object detail carousel modal download action stays at the top edge', () => {
  assert.match(
    styles,
    /\.carousel-modal-download\s*\{[\s\S]*?top:\s*0;[\s\S]*?left:\s*0;[\s\S]*?min-height:\s*42px;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.carousel-modal-download svg\s*\{[\s\S]*?width:\s*18px;[\s\S]*?height:\s*18px;[\s\S]*?\}/,
  );
});

test('object detail carousel modal keeps lightbox image contained', () => {
  assert.match(
    styles,
    /\.carousel-modal-backdrop\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?inset:\s*0;[\s\S]*?z-index:\s*90;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.carousel-modal-image img\s*\{[\s\S]*?max-width:\s*calc\(100vw - 48px\);[\s\S]*?max-height:\s*calc\(100dvh - 112px\);[\s\S]*?object-fit:\s*contain;[\s\S]*?object-position:\s*center center;[\s\S]*?\}/,
  );
});

test('object parameters and files share a desktop row before the map', () => {
  const summaryGridIndex = objectDetailSource.indexOf('className="object-parameters-files-grid"');
  const parametersIndex = objectDetailSource.indexOf('id="object-parameters-title"');
  const filesIndex = objectDetailSource.indexOf('id="object-files-title"');
  const actionsIndex = objectDetailSource.indexOf('className="object-detail-actions object-files-primary-actions"');
  const mapIndex = objectDetailSource.indexOf('id="object-map-title"');

  assert.notEqual(summaryGridIndex, -1, 'parameters and files grid should exist');
  assert.notEqual(parametersIndex, -1, 'parameters section should exist');
  assert.notEqual(filesIndex, -1, 'files section should exist');
  assert.notEqual(actionsIndex, -1, 'object action buttons should exist');
  assert.notEqual(mapIndex, -1, 'map section should exist');
  assert.doesNotMatch(
    objectDetailSource,
    /<section className="detail-section object-parameters-section"[\s\S]*?<p className="eyebrow">Параметры<\/p>/,
  );
  assert.match(
    objectDetailSource,
    /<section className="detail-section object-parameters-section"[\s\S]*?<h3 id="object-parameters-title">Основные параметры<\/h3>/,
  );
  assert.ok(summaryGridIndex < parametersIndex);
  assert.ok(parametersIndex < filesIndex);
  assert.ok(filesIndex < actionsIndex);
  assert.ok(actionsIndex < mapIndex);

  assert.match(
    styles,
    /\.object-parameters-files-grid\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);[\s\S]*?gap:\s*18px;[\s\S]*?align-items:\s*stretch;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.object-parameters-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);[\s\S]*?gap:\s*10px;[\s\S]*?\}/,
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
    /@media\s*\(max-width:\s*1100px\)\s*\{[\s\S]*?\.object-parameters-files-grid\s*\{[\s\S]*?grid-template-columns:\s*1fr;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*?\.object-parameters-grid\s*\{[\s\S]*?grid-template-columns:\s*1fr;[\s\S]*?\}/,
  );
});

test('object files block keeps primary actions inline and labels additional files', () => {
  const actionsIndex = objectDetailSource.indexOf('className="object-detail-actions object-files-primary-actions"');
  const additionalFilesIndex = objectDetailSource.indexOf(
    '<FileList accessToken={accessToken} files={listedFiles} title="Дополнительные файлы" />',
  );
  const emptyFilesIndex = objectDetailSource.indexOf('className="muted-text object-files-empty"');

  assert.doesNotMatch(
    objectDetailSource,
    /<section className="detail-section object-files-section"[\s\S]*?<p className="eyebrow">Файлы<\/p>/,
  );
  assert.match(
    objectDetailSource,
    /<section className="detail-section object-files-section"[\s\S]*?<h3 id="object-files-title">Файлы и документы<\/h3>/,
  );
  assert.match(objectDetailSource, /<FileActionLabel>Презентация<\/FileActionLabel>/);
  assert.match(objectDetailSource, /<FileActionLabel>Планировки<\/FileActionLabel>/);
  assert.match(objectDetailSource, /import \{ getLinkedFileTitle \} from '\.\.\/files\/fileDisplay';/);
  assert.match(objectDetailSource, /const primaryPresentationFile = object\.files\.find\(\(file\) => file\.type === 'PRESENTATION'\) \?\? null;/);
  assert.match(objectDetailSource, /const listedFiles = object\.files\.filter\(\(file\) => file\.id !== primaryPresentationFile\?\.id\);/);
  assert.match(objectDetailSource, /const displayTitle = getLinkedFileTitle\(file, fileTypeLabels\);/);
  assert.match(objectDetailSource, /<strong>\{displayTitle\}<\/strong>/);
  assert.match(
    objectDetailSource,
    /className="object-detail-action-button object-detail-action-button--disabled object-detail-action-button--missing"/,
  );
  assert.doesNotMatch(objectDetailSource, /<strong>\{file\.title \|\| file\.file\.originalName \|\| fileTypeLabels\[file\.type\]\}<\/strong>/);
  assert.doesNotMatch(objectDetailSource, /const otherFiles = object\.files\.filter\(\(file\) => file\.type !== 'PRESENTATION'\);/);
  assert.doesNotMatch(objectDetailSource, /value="Отсутствует"|value="Открыть цены"|value="Отсутствуют"/);

  assert.notEqual(actionsIndex, -1, 'files primary actions should have a dedicated layout class');
  assert.notEqual(additionalFilesIndex, -1, 'additional files list should have an explicit title');
  assert.notEqual(emptyFilesIndex, -1, 'empty additional files state should sit in the additional files group');
  assert.ok(actionsIndex < additionalFilesIndex);
  assert.ok(actionsIndex < emptyFilesIndex);

  assert.match(
    styles,
    /\.object-files-section \.object-files-primary-actions\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);[\s\S]*?align-items:\s*start;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.object-files-section\s*\{[\s\S]*?align-content:\s*start;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.object-files-section \.object-detail-action-button\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?align-items:\s*flex-start;[\s\S]*?justify-content:\s*flex-start;[\s\S]*?border:\s*1px solid #e0e6ed;[\s\S]*?border-radius:\s*8px;[\s\S]*?background:\s*#f8fafc;[\s\S]*?padding:\s*14px;[\s\S]*?text-align:\s*left;[\s\S]*?\}/,
  );
  assert.doesNotMatch(styles, /\.object-files-section \.object-detail-action-button\s*\{[\s\S]*?height:\s*104px;/);

  assert.match(
    styles,
    /\.object-file-action-label\s*\{[\s\S]*?font-size:\s*12px;[\s\S]*?font-weight:\s*800;[\s\S]*?line-height:\s*1\.35;[\s\S]*?\}/,
  );

  assert.match(
    appThemeStyles,
    /html\[data-app-theme\] \.object-files-section \.object-detail-action-button\s*\{[\s\S]*?border-color:\s*var\(--app-theme-border-soft\);[\s\S]*?background:\s*var\(--app-theme-surface-soft\);[\s\S]*?color:\s*var\(--app-theme-ink-800\);[\s\S]*?\}/,
  );

  assert.match(
    appThemeStyles,
    /html\[data-app-theme\] \.object-files-section :is\(\.object-detail-action-button:hover,\s*\.object-detail-action-button:focus-visible\)\s*\{[\s\S]*?background:\s*color-mix\(in srgb,\s*var\(--app-theme-primary-soft\) 44%,\s*var\(--app-theme-surface\)\);[\s\S]*?\}/,
  );

  assert.match(
    appThemeStyles,
    /html\[data-app-theme\] \.object-files-section \.object-detail-action-button--missing:hover\s*\{[\s\S]*?background:\s*var\(--app-theme-danger-soft\);[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.detail-file-list li > div\s*\{[\s\S]*?flex:\s*1 1 auto;[\s\S]*?min-width:\s*0;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*?\.object-files-section \.object-files-primary-actions\s*\{[\s\S]*?grid-template-columns:\s*1fr;[\s\S]*?\}/,
  );
});

test('object description and location share a desktop row with two-third and one-third columns', () => {
  const descriptionGridIndex = objectDetailSource.indexOf('className="object-description-location-grid"');
  const descriptionIndex = objectDetailSource.indexOf('id="object-description-title"');
  const locationIndex = objectDetailSource.indexOf('id="object-location-title"');
  const contentIndex = objectDetailSource.indexOf('id="object-content-sections-title"');

  assert.notEqual(descriptionGridIndex, -1, 'description and location grid should exist');
  assert.notEqual(descriptionIndex, -1, 'description section should exist');
  assert.notEqual(locationIndex, -1, 'location section should exist');
  assert.notEqual(contentIndex, -1, 'content sections should exist');
  assert.ok(descriptionGridIndex < descriptionIndex);
  assert.ok(descriptionIndex < locationIndex);
  assert.ok(locationIndex < contentIndex);

  assert.match(
    styles,
    /\.object-description-location-grid\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*minmax\(0,\s*2fr\)\s+minmax\(280px,\s*1fr\);[\s\S]*?gap:\s*18px;[\s\S]*?align-items:\s*stretch;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /@media\s*\(max-width:\s*1100px\)\s*\{[\s\S]*?\.object-description-location-grid\s*\{[\s\S]*?grid-template-columns:\s*1fr;[\s\S]*?\}/,
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
