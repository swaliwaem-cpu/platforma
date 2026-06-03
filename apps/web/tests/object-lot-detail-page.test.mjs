import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(resolve(currentDir, '../src/App.tsx'), 'utf8');
const objectDetailSource = readFileSync(resolve(currentDir, '../src/objects/ObjectDetailPage.tsx'), 'utf8');
const styles = readFileSync(resolve(currentDir, '../src/styles.css'), 'utf8');
const objectLotMediaCarouselSource =
  objectDetailSource.match(/function ObjectLotMediaCarousel[\s\S]*?\nfunction hasFeedMediaFile/)?.[0] ?? '';

test('app routes object lot URLs to lot detail page', () => {
  assert.match(appSource, /import \{ ObjectDetailPage, ObjectLotDetailPage \} from '\.\/objects\/ObjectDetailPage';/);
  assert.match(appSource, /const objectLotRoute = parseObjectLotRoute\(pathname\);/);
  assert.match(appSource, /function parseObjectLotRoute\(pathname: string\)/);
  assert.match(appSource, /\^\\\/objects\\\/\(\[\^\/\]\+\)\\\/lots\\\/\(\[\^\/\]\+\)\\\/\?\$/);
  assert.match(appSource, /<ObjectLotDetailPage[\s\S]*?slug=\{objectLotRoute\.slug\}[\s\S]*?unitId=\{objectLotRoute\.unitId\}/);
  assert.match(appSource, /onBack=\{\(\) => navigate\(`\/objects\/\$\{encodeURIComponent\(objectLotRoute\.slug\)\}`\)\}/);
});

test('lot detail page loads object and one feed unit', () => {
  assert.match(objectDetailSource, /FeedUnitResponse/);
  assert.match(objectDetailSource, /export function ObjectLotDetailPage/);
  assert.match(objectDetailSource, /apiRequest<ObjectResponse>\(`\/objects\/slug\/\$\{encodeURIComponent\(slug\)\}`/);
  assert.match(
    objectDetailSource,
    /apiRequest<FeedUnitResponse>\([\s\S]*?`\/objects\/\$\{objectData\.object\.id\}\/feed-units\/\$\{encodeURIComponent\(unitId\)\}`/,
  );
  assert.match(objectDetailSource, /setObject\(objectData\.object\);/);
  assert.match(objectDetailSource, /setUnit\(unitData\.unit\);/);
});

test('lot detail page renders media carousel and required fact cards', () => {
  assert.match(objectDetailSource, /className="object-detail-page object-lot-page"/);
  assert.match(objectDetailSource, /className="object-lot-split-card"/);
  assert.match(objectDetailSource, /className="object-lot-media-panel"/);
  assert.match(objectDetailSource, /className="object-lot-info-panel"/);
  assert.match(objectDetailSource, /className="object-lot-price-summary"/);
  assert.match(objectDetailSource, /function ObjectLotMediaCarousel/);
  assert.match(objectDetailSource, /className="media-gallery-frame object-lot-media-carousel"/);
  assert.match(objectDetailSource, /className="media-gallery-stage object-lot-media-stage"/);
  assert.match(objectDetailSource, /className="media-gallery-image object-lot-media-image"/);
  assert.match(objectDetailSource, /function getObjectLotFactRows\(unit: FeedUnit\)/);
  assert.match(objectDetailSource, /className="object-lot-fact-row"/);
  assert.match(objectDetailSource, /className="object-lot-fact-line"/);
  assert.match(objectDetailSource, /formatComputedFeedUnitPricePerMeter\(unit\)/);
  assert.match(objectDetailSource, /label: 'Цена за м²'/);
  assert.match(objectDetailSource, /label: 'Площадь'/);
  assert.match(objectDetailSource, /label: 'Тип лота'/);
  assert.match(objectDetailSource, /label: 'Этаж'/);
  assert.match(objectDetailSource, /label: 'Корпус\/секция'/);
  assert.match(objectDetailSource, /label: 'Срок сдачи'[\s\S]*?formatFeedUnitCompletion\(unit\)/);
  assert.match(objectDetailSource, /label: 'Адрес'/);
  assert.match(objectDetailSource, /label: 'Статус'/);
  assert.match(styles, /\.object-lot-page\s*\{/);
  assert.match(styles, /\.object-lot-split-card\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\);[\s\S]*?\}/);
  assert.match(styles, /\.object-lot-info-panel\s*\{/);
  assert.match(styles, /\.object-lot-price-summary\s*\{/);
  assert.match(styles, /\.object-lot-fact-row\s*\{/);
  assert.match(styles, /\.object-lot-fact-line\s*\{/);
  assert.match(styles, /@media \(max-width:\s*1100px\)\s*\{[\s\S]*?\.object-lot-split-card\s*\{[\s\S]*?grid-template-columns:\s*1fr;[\s\S]*?\}/);
  assert.match(styles, /\.object-lot-media-carousel\s*\{/);
  assert.match(styles, /\.object-lot-facts\s*\{/);
});

test('lot detail price summary shows discount only when discount price is lower', () => {
  assert.match(objectDetailSource, /function hasFeedUnitRealDiscount\(unit: FeedUnit\)/);
  assert.match(
    objectDetailSource,
    /const price = Number\(unit\.price\);[\s\S]*?const discountPrice = Number\(unit\.discountPrice\);[\s\S]*?discountPrice < price/,
  );
  assert.match(objectDetailSource, /function getObjectLotPriceSummary\(unit: FeedUnit\)/);
  assert.match(objectDetailSource, /const hasRealDiscount = hasFeedUnitRealDiscount\(unit\);/);
  assert.match(objectDetailSource, /label: hasRealDiscount \? 'Цена со скидкой' : 'Цена'/);
  assert.match(objectDetailSource, /secondaryPrice: hasRealDiscount \? formatFeedUnitPrice\(unit\.price, unit\.currency\) : null/);
});

test('lot detail media carousel fits media without cropping', () => {
  assert.match(objectDetailSource, /className="media-gallery-frame object-lot-media-carousel"/);
  assert.match(objectDetailSource, /className="media-gallery-stage object-lot-media-stage"/);
  assert.match(objectDetailSource, /className="media-gallery-button object-lot-media-button"/);
  assert.match(objectDetailSource, /className="media-gallery-image object-lot-media-image"/);

  assert.match(
    styles,
    /\.media-gallery-frame\s*\{[\s\S]*?aspect-ratio:\s*16 \/ 9;[\s\S]*?overflow:\s*hidden;[\s\S]*?\}/,
  );
  assert.match(
    styles,
    /\.media-gallery-button\s*\{[\s\S]*?position:\s*relative;[\s\S]*?display:\s*grid;[\s\S]*?overflow:\s*hidden;[\s\S]*?\}/,
  );
  assert.match(
    styles,
    /\.media-gallery-image\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?inset:\s*0;[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%;[\s\S]*?object-fit:\s*cover;[\s\S]*?object-position:\s*center center;[\s\S]*?\}/,
  );
  assert.match(styles, /\.object-lot-media-carousel\s+\.object-lot-media-image\s*\{[^}]*object-fit:\s*contain;[^}]*\}/);
});

test('lot detail fullscreen media supports arrow buttons and keyboard navigation', () => {
  assert.match(objectLotMediaCarouselSource, /function showPreviousFullscreenMedia\(\)/);
  assert.match(objectLotMediaCarouselSource, /function showNextFullscreenMedia\(\)/);
  assert.match(
    objectLotMediaCarouselSource,
    /event\.key === 'ArrowLeft'[\s\S]*?fullscreenMedia[\s\S]*?showPreviousFullscreenMedia\(\);[\s\S]*?showPreviousMedia\(\);/,
  );
  assert.match(
    objectLotMediaCarouselSource,
    /event\.key === 'ArrowRight'[\s\S]*?fullscreenMedia[\s\S]*?showNextFullscreenMedia\(\);[\s\S]*?showNextMedia\(\);/,
  );
  assert.match(
    objectLotMediaCarouselSource,
    /aria-label="Предыдущее полноэкранное медиа лота"[\s\S]*?className="object-feed-media-fullscreen-nav object-feed-media-fullscreen-nav--previous"/,
  );
  assert.match(
    objectLotMediaCarouselSource,
    /aria-label="Следующее полноэкранное медиа лота"[\s\S]*?className="object-feed-media-fullscreen-nav object-feed-media-fullscreen-nav--next"/,
  );
  assert.match(
    objectLotMediaCarouselSource,
    /aria-label="Скачать оригинал полноэкранного медиа"[\s\S]*?download=\{getFeedMediaDownloadFileName\(fullscreenMedia\)\}[\s\S]*?href=\{buildMediaFileContentUrl\(fullscreenMedia\.file\.id,\s*\{ download: true \}\)\}[\s\S]*?Скачать оригинал/,
  );

  const fullscreenNavBlock = styles.match(/\.object-feed-media-fullscreen-nav\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(fullscreenNavBlock, /position:\s*fixed;/);
  assert.match(fullscreenNavBlock, /top:\s*50%;/);
  assert.match(fullscreenNavBlock, /border-radius:\s*999px;/);
  assert.match(fullscreenNavBlock, /transform:\s*translateY\(-50%\);/);
});
