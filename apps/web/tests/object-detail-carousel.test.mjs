import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(currentDir, '../src/objects/ObjectDetailPage.tsx'), 'utf8');

test('object detail carousel opens a dialog lightbox from the main image', () => {
  assert.match(source, /const \[lightboxIndex,\s*setLightboxIndex\] = useState<number \| null>\(null\);/);
  assert.match(source, /function openLightbox\(\)\s*\{[\s\S]*?setLightboxIndex\(activeIndex\);[\s\S]*?\}/);
  assert.match(source, /className="object-carousel-media-button"[\s\S]*?onClick=\{openLightbox\}/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
});

test('object detail carousel lightbox uses original image variant and keyboard close', () => {
  assert.match(source, /variant="original"/);
  assert.match(source, /function closeLightbox\(\)\s*\{[\s\S]*?setLightboxIndex\(null\);[\s\S]*?\}/);
  assert.match(source, /event\.key === 'Escape'/);
  assert.match(source, /className="carousel-modal-backdrop"/);
  assert.match(source, /className="carousel-modal-image"/);
});
