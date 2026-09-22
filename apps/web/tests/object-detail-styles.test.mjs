import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const styles = readFileSync(resolve(currentDir, '../src/styles.css'), 'utf8');
const appThemeStyles = readFileSync(resolve(currentDir, '../src/app-theme.css'), 'utf8');
const fluffyThemeStyles = readFileSync(resolve(currentDir, '../src/fluffy-white-theme.css'), 'utf8');
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
    /\.carousel-modal-backdrop\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?inset:\s*0;[\s\S]*?z-index:\s*1300;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.carousel-modal-image img\s*\{[\s\S]*?max-width:\s*calc\(100vw - 48px\);[\s\S]*?max-height:\s*calc\(100dvh - 112px\);[\s\S]*?object-fit:\s*contain;[\s\S]*?object-position:\s*center center;[\s\S]*?\}/,
  );
});

test('object detail follows variant C: a 16:9 photo with everything else under it, lots right after the specs', () => {
  const carouselIndex = objectDetailSource.indexOf('<ObjectImageCarousel accessToken={accessToken}');
  const passportIndex = objectDetailSource.indexOf('<header className="object-passport" aria-labelledby="object-title">');
  const titleIndex = objectDetailSource.indexOf('<h2 id="object-title">{object.title}</h2>');
  const priceIndex = objectDetailSource.indexOf('id="object-parameters-title"');
  const filesIndex = objectDetailSource.indexOf('id="object-files-title"');
  const actionsIndex = objectDetailSource.indexOf('className="object-detail-actions object-files-primary-actions"');
  const specsIndex = objectDetailSource.indexOf('id="object-specs-title"');
  const lotsIndex = objectDetailSource.indexOf('<ObjectFeedUnitsSection');
  const documentsIndex = objectDetailSource.indexOf('<section className="detail-section object-documents-section"');
  const descriptionGridIndex = objectDetailSource.indexOf('className="object-description-location-grid"');
  const contentIndex = objectDetailSource.indexOf('id="object-content-sections-title"');
  const mapIndex = objectDetailSource.indexOf('id="object-map-title"');
  const positions = { carouselIndex, passportIndex, titleIndex, priceIndex, filesIndex, actionsIndex, specsIndex, lotsIndex, documentsIndex, descriptionGridIndex, contentIndex, mapIndex };

  for (const [name, index] of Object.entries(positions)) {
    assert.notEqual(index, -1, `${name} should exist`);
  }

  const order = Object.values(positions);
  assert.deepEqual([...order].sort((left, right) => left - right), order);
  assert.doesNotMatch(objectDetailSource, /className="object-detail-hero"/);
  assert.doesNotMatch(objectDetailSource, /className="page-header object-detail-header"/);
  assert.doesNotMatch(objectDetailSource, /object-mobile-dock/);

  assert.match(objectDetailSource, /<p className="sr-only" id="object-parameters-title">\s*Стоимость\s*<\/p>/);
  assert.match(objectDetailSource, /const priceLabel = formatPriceFrom\(priceValue\);/);
  assert.match(objectDetailSource, /const priceValue = object\.feedPriceFrom \?\? object\.priceFrom;/);
  assert.match(objectDetailSource, /function getObjectSummaryFacts\(object: RealEstateObjectDetail, rows: Array<\{ label: string; value: string \}>\)/);
  assert.match(objectDetailSource, /\{ label: 'Лотов в продаже', value: formatNumber\(lotsCount\) \}/);
  assert.equal((objectDetailSource.match(/onClick=\{\(\) => scrollToSection\('object-lots'\)\}/g) ?? []).length, 1);
  assert.match(objectDetailSource, /onClick=\{\(\) => scrollToSection\('object-map'\)\}/);

  assert.match(styles, /\.object-detail-page \.object-image-carousel \{[\s\S]*?aspect-ratio: 16 \/ 9;[\s\S]*?padding: 0;/);
  assert.match(styles, /\.object-detail-page \.object-image-carousel \.object-carousel-filmstrip \{[\s\S]*?position: absolute;[\s\S]*?bottom: 16px;/);
  assert.match(styles, /\.object-passport \{[\s\S]*?position: sticky;[\s\S]*?top: 12px;[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto auto;/);
  assert.match(styles, /\.object-specs-grid--split > \.object-specs-section \{\s*grid-column: 1;\s*grid-row: 1;/);
  assert.match(styles, /\.object-specs-grid--split > \.object-documents-section \{\s*grid-column: 2;\s*grid-row: 1;/);
  assert.match(
    styles,
    /@media \(max-width: 1100px\) \{[\s\S]*?\.object-specs-grid--split > :is\(\.object-specs-section, \.object-documents-section\) \{\s*grid-column: 1 \/ -1;\s*grid-row: auto;/,
  );
  assert.match(
    styles,
    /@media \(max-width: 760px\) \{[\s\S]*?\.object-detail-page \.object-image-carousel \{\s*aspect-ratio: 4 \/ 3;[\s\S]*?\.object-passport \{\s*position: static;[\s\S]*?\.object-passport \.object-passport-actions \.object-detail-summary-cta \{\s*order: 1;\s*grid-column: 1 \/ -1;/,
  );
  assert.doesNotMatch(styles, /object-mobile-dock/);
  assert.doesNotMatch(fluffyThemeStyles, /object-mobile-dock|--fw-dock-/);
  assert.match(fluffyThemeStyles, /:root\[data-app-theme\] body \.object-passport \{[\s\S]*?background: var\(--fw-passport-bg\);/);
  assert.match(fluffyThemeStyles, /--fw-passport-bg: rgb\(250 248 245 \/ 86%\);/);
  assert.match(fluffyThemeStyles, /--fw-passport-bg: rgb\(26 27 29 \/ 84%\);/);
});

test('object detail carousel lays its controls over the photo', () => {
  const carousel = objectDetailSource.match(/function ObjectImageCarousel[\s\S]*?\nfunction ObjectFeedUnitsSection/)?.[0] ?? '';

  assert.match(carousel, /<div className="object-carousel-topbar">[\s\S]*?className="carousel-section-filters"[\s\S]*?<div className="object-carousel-corner">[\s\S]*?className="carousel-counter"[\s\S]*?className="object-carousel-expand" type="button" onClick=\{openLightbox\}/);
  assert.match(carousel, /className="carousel-thumbnail-zone object-carousel-filmstrip"[\s\S]*?ref=\{thumbnailsRef\}/);
  assert.match(carousel, /strip\.scrollTo\(\{ left: thumbnail\.offsetLeft - \(strip\.clientWidth - thumbnail\.offsetWidth\) \/ 2, behavior: 'smooth' \}\);/);
  assert.match(carousel, /onTouchEnd=\{handleStageTouchEnd\}/);
  assert.match(carousel, /Math\.abs\(endX - startX\) < 40/);
  assert.match(carousel, /<ChevronLeftIcon aria-hidden="true" \/>/);
  assert.match(fluffyThemeStyles, /@media \(max-width: 760px\) \{\s*:root\[data-app-theme\] body \.object-detail-page \.object-image-carousel \.object-carousel-expand \{\s*display: none;/);
});

test('object files stay in the summary with primary actions and optional additional files', () => {
  assert.match(
    objectDetailSource,
    /<section className="object-files-section object-passport-actions" aria-labelledby="object-files-title">[\s\S]*?<h3 className="sr-only" id="object-files-title">\s*Файлы и документы\s*<\/h3>/,
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
  assert.match(
    objectDetailSource,
    /listedFiles\.length > 0 \? \(\s*<section className="detail-section object-documents-section" aria-label="Документы">\s*<FileList accessToken=\{accessToken\} files=\{listedFiles\} title="Дополнительные файлы" \/>\s*<\/section>\s*\) : null/,
  );
  assert.match(objectDetailSource, /const displayTitle = getLinkedFileTitle\(file, fileTypeLabels\);/);
  assert.match(
    objectDetailSource,
    /className="object-detail-action-button object-detail-action-button--disabled object-detail-action-button--missing"/,
  );
  assert.doesNotMatch(objectDetailSource, /value="Отсутствует"|value="Открыть цены"|value="Отсутствуют"/);

  assert.match(styles, /\.object-passport \.object-files-primary-actions \{\s*display: flex;\s*gap: 8px;/);
  assert.match(styles, /\.object-passport \.object-passport-actions \.object-detail-action-button \{[\s\S]*?min-height: 44px;[\s\S]*?white-space: nowrap;/);
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
