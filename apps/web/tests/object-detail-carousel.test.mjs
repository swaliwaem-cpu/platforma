import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(currentDir, '../src/objects/ObjectDetailPage.tsx'), 'utf8');
const objectImageCarouselSource =
  source.match(/function ObjectImageCarousel[\s\S]*?\nfunction ObjectFeedUnitsSection/)?.[0] ?? '';

test('object detail carousel opens a dialog lightbox from the main image', () => {
  assert.match(source, /const \[lightboxIndex,\s*setLightboxIndex\] = useState<number \| null>\(null\);/);
  assert.match(source, /function openLightbox\(\)\s*\{[\s\S]*?setLightboxIndex\(activeIndex\);[\s\S]*?\}/);
  assert.match(source, /className="media-gallery-button object-carousel-media-button"[\s\S]*?onClick=\{openLightbox\}/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
});

test('object detail carousel uses original images for main photo and lightbox', () => {
  assert.match(objectImageCarouselSource, /className="media-gallery-image object-carousel-image"[\s\S]*?variant="original"/);
  assert.match(objectImageCarouselSource, /className="carousel-modal-image"[\s\S]*?variant="original"/);
  assert.match(objectImageCarouselSource, /variant="thumbnail"/);
  assert.match(source, /function closeLightbox\(\)\s*\{[\s\S]*?setLightboxIndex\(null\);[\s\S]*?\}/);
  assert.match(source, /event\.key === 'Escape'/);
  assert.match(source, /className="carousel-modal-backdrop"/);
  assert.match(source, /className="carousel-modal-image"/);
});

test('object detail carousel lightbox offers original image download', () => {
  assert.match(source, /DownloadIcon/);
  assert.match(
    objectImageCarouselSource,
    /className="carousel-modal-download"[\s\S]*?href=\{buildMediaFileContentUrl\(lightboxImage\.file\.id,\s*\{ download: true \}\)\}/,
  );
  assert.match(objectImageCarouselSource, /download=\{getImageDownloadFileName\(lightboxImage,\s*objectTitle\)\}/);
  assert.match(objectImageCarouselSource, /Скачать оригинал/);
});

test('object detail carousel lightbox supports keyboard arrow navigation', () => {
  assert.match(objectImageCarouselSource, /event\.key === 'ArrowLeft'[\s\S]*?showPreviousLightboxImage\(\);/);
  assert.match(objectImageCarouselSource, /event\.key === 'ArrowRight'[\s\S]*?showNextLightboxImage\(\);/);
  assert.match(objectImageCarouselSource, /event\.preventDefault\(\);/);
});

test('object detail carousel filters images by thematic section', () => {
  assert.match(source, /ObjectImageSection/);
  assert.match(source, /const \[activeSection,\s*setActiveSection\] = useState<ObjectImageSection \| null>\(null\);/);
  assert.match(source, /const filteredImages = useMemo\(\(\) => \{[\s\S]*?if \(!activeSection\) \{[\s\S]*?return images;[\s\S]*?\}[\s\S]*?return images\.filter\(\(image\) => image\.section === activeSection\);[\s\S]*?\}, \[activeSection,\s*images\]\);/);
  assert.match(source, /const activeImage = filteredImages\[activeIndex\] \?\? null;/);
  assert.match(source, /const lightboxImage = lightboxIndex === null \? null : filteredImages\[lightboxIndex\] \?\? null;/);
  assert.match(source, /function selectSection\(section: ObjectImageSection \| null\) \{\s*setActiveSection\(section\);/);
  assert.match(source, /setActiveIndex\(0\);/);
  assert.match(source, /setLightboxIndex\(null\);/);
  assert.match(source, /filteredImages\.length/);
});

test('object detail carousel renders an «Все» tab and only sections that have photos', () => {
  assert.match(
    objectImageCarouselSource,
    /const sectionTabs = useMemo\(\s*\(\) => sectionOptions\.filter\(\(option\) => images\.some\(\(image\) => image\.section === option\.value\)\),\s*\[images\],\s*\);/,
  );
  assert.match(objectImageCarouselSource, /const hasSectionFilters = sectionTabs\.length > 0;/);
  assert.match(objectImageCarouselSource, /className="carousel-section-filters"/);
  assert.match(objectImageCarouselSource, /\[\{ value: null, label: 'Все' \}, \.\.\.sectionTabs\]\.map\(\(option\) => \(/);
  assert.match(objectImageCarouselSource, /aria-pressed=\{activeSection === option\.value\}/);
  assert.match(objectImageCarouselSource, /onClick=\{\(\) => selectSection\(option\.value\)\}/);
  // A tab never turns into a dead, disabled pill.
  assert.doesNotMatch(objectImageCarouselSource, /carousel-section-filter[\s\S]{0,200}disabled=/);
});

test('object detail lightbox is portaled into the body above the passport and the menu', () => {
  assert.match(source, /import \{ createPortal \} from 'react-dom';/);
  assert.match(objectImageCarouselSource, /\{lightboxImage \? createPortal\(\s*<div className="carousel-modal-backdrop" onClick=\{closeLightbox\}>[\s\S]*?<\/div>,\s*document\.body,\s*\) : null\}/);
});
