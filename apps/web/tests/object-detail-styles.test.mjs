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

test('gallery navigation arrows keep centered transform while pressed', () => {
  assert.match(
    appThemeStyles,
    /html\[data-app-theme\]\s*:is\(\.carousel-button,\s*\.carousel-modal-button,\s*\.map-object-card-gallery-button,\s*\.object-feed-media-carousel-nav,\s*\.object-feed-media-fullscreen-nav\):active\s*\{[\s\S]*?transform:\s*translateY\(-50%\);[\s\S]*?translate:\s*none;[\s\S]*?\}/,
  );
});

test('object detail carousel hides thumbnails until lower hover or focus zone', () => {
  assert.match(
    styles,
    /\.carousel-thumbnail-zone\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?bottom:\s*0;[\s\S]*?left:\s*0;[\s\S]*?right:\s*0;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.carousel-thumbnail-zone::before\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?z-index:\s*0;[\s\S]*?pointer-events:\s*auto;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.carousel-thumbnails\s*\{[\s\S]*?z-index:\s*1;[\s\S]*?left:\s*50%;[\s\S]*?width:\s*min\(calc\(100% - 28px\),\s*1240px\);[\s\S]*?justify-content:\s*center;[\s\S]*?opacity:\s*0;[\s\S]*?pointer-events:\s*auto;[\s\S]*?transform:\s*translate\(-50%,\s*8px\);[\s\S]*?\}/,
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
    /\.carousel-section-filters\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?z-index:\s*1;[\s\S]*?bottom:\s*106px;[\s\S]*?left:\s*50%;[\s\S]*?opacity:\s*0;[\s\S]*?pointer-events:\s*auto;[\s\S]*?\}/,
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

test('object detail follows the reference layout: gallery beside the price summary', () => {
  const heroIndex = objectDetailSource.indexOf('className="object-detail-hero"');
  const carouselIndex = objectDetailSource.indexOf('<ObjectImageCarousel accessToken={accessToken}');
  const parametersIndex = objectDetailSource.indexOf('id="object-parameters-title"');
  const filesIndex = objectDetailSource.indexOf('id="object-files-title"');
  const actionsIndex = objectDetailSource.indexOf('className="object-detail-actions object-files-primary-actions"');
  const descriptionGridIndex = objectDetailSource.indexOf('className="object-description-location-grid"');
  const lotsIndex = objectDetailSource.indexOf('<ObjectFeedUnitsSection accessToken={accessToken}');
  const contentIndex = objectDetailSource.indexOf('id="object-content-sections-title"');
  const mapIndex = objectDetailSource.indexOf('id="object-map-title"');

  for (const [name, index] of Object.entries({ heroIndex, carouselIndex, parametersIndex, filesIndex, actionsIndex, descriptionGridIndex, lotsIndex, contentIndex, mapIndex })) {
    assert.notEqual(index, -1, `${name} should exist`);
  }

  assert.ok(heroIndex < carouselIndex && carouselIndex < parametersIndex);
  assert.ok(parametersIndex < filesIndex && filesIndex < actionsIndex);
  assert.ok(actionsIndex < descriptionGridIndex && descriptionGridIndex < lotsIndex);
  assert.ok(lotsIndex < contentIndex && contentIndex < mapIndex);

  assert.match(objectDetailSource, /<p className="eyebrow" id="object-parameters-title">\s*Стоимость\s*<\/p>/);
  assert.match(objectDetailSource, /formatPriceFrom\(object\.feedPriceFrom \?\? object\.priceFrom\)/);
  assert.match(objectDetailSource, /function getObjectSummaryFacts\(object: RealEstateObjectDetail, rows: Array<\{ label: string; value: string \}>\)/);
  assert.match(objectDetailSource, /onClick=\{\(\) => scrollToSection\('object-lots'\)\}/);
  assert.match(objectDetailSource, /onClick=\{\(\) => scrollToSection\('object-map'\)\}/);

  assert.match(styles, /\.object-detail-hero \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) 410px;[\s\S]*?gap: 16px;/);
  assert.match(styles, /\.object-detail-page \.object-image-carousel :is\(\.carousel-section-filters, \.carousel-thumbnails\) \{[\s\S]*?position: static;[\s\S]*?opacity: 1;/);
  assert.match(styles, /\.object-detail-hero \.object-parameters-grid dt::after \{\s*content: " ·";/);
  assert.match(styles, /\.object-detail-summary-cta \{[\s\S]*?margin-top: auto;/);
  assert.match(styles, /@media \(max-width: 1100px\) \{\s*\.object-detail-hero \{\s*grid-template-columns: 1fr;/);
});

test('object files stay in the summary with primary actions and optional additional files', () => {
  assert.match(
    objectDetailSource,
    /<section className="object-files-section" aria-labelledby="object-files-title">[\s\S]*?<h3 className="sr-only" id="object-files-title">\s*Файлы и документы\s*<\/h3>/,
  );
  assert.match(objectDetailSource, /<FileActionLabel>Презентация<\/FileActionLabel>/);
  assert.match(objectDetailSource, /<FileActionLabel>Аэротур<\/FileActionLabel>/);
  assert.match(objectDetailSource, /<FileActionLabel>Планировки<\/FileActionLabel>/);
  assert.match(objectDetailSource, /const aerotourUrl = getExternalObjectUrl\(object\.aerotourUrl\);/);
  assert.match(
    objectDetailSource,
    /function getExternalObjectUrl\(value: string \| null\) \{[\s\S]*?const trimmedValue = value\?\.trim\(\);[\s\S]*?if \(!trimmedValue\) \{[\s\S]*?return null;[\s\S]*?url\.protocol === 'http:' \|\| url\.protocol === 'https:' \? trimmedValue : null;[\s\S]*?\}/,
  );
  assert.match(objectDetailSource, /import \{ getLinkedFileTitle \} from '\.\.\/files\/fileDisplay';/);
  assert.match(objectDetailSource, /const primaryPresentationFile = object\.files\.find\(\(file\) => file\.type === 'PRESENTATION'\) \?\? null;/);
  assert.match(objectDetailSource, /const listedFiles = object\.files\.filter\(\(file\) => file\.id !== primaryPresentationFile\?\.id\);/);
  assert.match(objectDetailSource, /listedFiles\.length > 0 \? \(\s*<FileList accessToken=\{accessToken\} files=\{listedFiles\} title="Дополнительные файлы" \/>\s*\) : null/);
  assert.match(objectDetailSource, /const displayTitle = getLinkedFileTitle\(file, fileTypeLabels\);/);
  assert.match(
    objectDetailSource,
    /className="object-detail-action-button object-detail-action-button--disabled object-detail-action-button--missing"/,
  );
  assert.doesNotMatch(objectDetailSource, /value="Отсутствует"|value="Открыть цены"|value="Отсутствуют"/);

  assert.match(styles, /\.object-detail-hero \.object-files-section \.object-files-primary-actions \{[\s\S]*?grid-template-columns: repeat\(auto-fit, minmax\(110px, 1fr\)\);/);
  assert.match(styles, /\.object-detail-hero \.object-files-section \.object-detail-action-button \{[\s\S]*?min-height: 44px;[\s\S]*?border-radius: 13px;/);
  assert.match(
    appThemeStyles,
    /html\[data-app-theme\] \.object-files-section \.object-detail-action-button\s*\{[\s\S]*?border-color:\s*var\(--app-theme-border-soft\);[\s\S]*?background:\s*var\(--app-theme-surface-soft\);[\s\S]*?\}/,
  );
  assert.match(styles, /\.detail-file-list li > div\s*\{[\s\S]*?flex:\s*1 1 auto;[\s\S]*?min-width:\s*0;[\s\S]*?\}/);
});

test('object description and location share a desktop row in two equal columns', () => {
  const descriptionGridIndex = objectDetailSource.indexOf('className="object-description-location-grid"');
  const descriptionIndex = objectDetailSource.indexOf('id="object-description-title"');
  const locationIndex = objectDetailSource.indexOf('id="object-location-title"');
  const contentIndex = objectDetailSource.indexOf('id="object-content-sections-title"');

  assert.ok(descriptionGridIndex !== -1 && descriptionGridIndex < descriptionIndex);
  assert.ok(descriptionIndex < locationIndex);
  assert.ok(locationIndex < contentIndex);
  assert.match(objectDetailSource, /isDescriptionExpanded \? 'Свернуть' : 'Читать полностью'/);
  assert.match(objectDetailSource, /className="object-developer-row"/);
  assert.match(objectDetailSource, /navigate\(`\/catalog\?developerId=\$\{object\.developer\?\.id \?\? ''\}`\)/);

  assert.match(
    styles,
    /\.object-description-location-grid\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);[\s\S]*?gap:\s*16px;[\s\S]*?align-items:\s*stretch;[\s\S]*?\}/,
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
    /\.object-map-section \.platform-map-shell,\s*\.object-map-section \.platform-map-canvas,\s*\.object-map-section \.map-fallback\s*\{[\s\S]*?height:\s*70svh;[\s\S]*?min-height:\s*520px;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*?\.object-map-section \.platform-map-shell,\s*[\s\S]*?\.object-map-section \.platform-map-canvas,\s*[\s\S]*?\.object-map-section \.map-fallback\s*\{[\s\S]*?min-height:\s*420px;[\s\S]*?\}/,
  );
});
