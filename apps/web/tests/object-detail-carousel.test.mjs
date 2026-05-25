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
  assert.match(source, /className="object-carousel-media-button"[\s\S]*?onClick=\{openLightbox\}/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
});

test('object detail carousel uses original images for main photo and lightbox', () => {
  assert.match(objectImageCarouselSource, /className="object-carousel-image"[\s\S]*?variant="original"/);
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
  assert.match(source, /setActiveSection\(\(currentSection\) => \(currentSection === section \? null : section\)\);/);
  assert.match(source, /setActiveIndex\(0\);/);
  assert.match(source, /setLightboxIndex\(null\);/);
  assert.match(source, /filteredImages\.length/);
});

test('object detail carousel renders section filter pills above thumbnails', () => {
  assert.match(source, /const hasSectionFilters = images\.some\(\(image\) => image\.section !== null\);/);
  assert.match(source, /className="carousel-section-filters"/);
  assert.match(source, /sectionOptions\.map\(\(option\) => \{/);
  assert.match(source, /const sectionImageCount = images\.filter\(\(image\) => image\.section === option\.value\)\.length;/);
  assert.match(source, /className=\{sectionButtonClassName\}/);
  assert.match(source, /disabled=\{sectionImageCount === 0\}/);
  assert.match(source, /onClick=\{\(\) => toggleSectionFilter\(option\.value\)\}/);
});
