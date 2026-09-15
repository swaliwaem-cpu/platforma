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
  assert.doesNotMatch(appSource, /import \{ ObjectDetailPage, ObjectLotDetailPage \} from '\.\/objects\/ObjectDetailPage';/);
  assert.match(
    appSource,
    /const ObjectDetailPage = lazy\([\s\S]*?import\('\.\/objects\/ObjectDetailPage'\)[\s\S]*?default: module\.ObjectDetailPage/,
  );
  assert.match(
    appSource,
    /const ObjectLotDetailPage = lazy\([\s\S]*?import\('\.\/objects\/ObjectDetailPage'\)[\s\S]*?default: module\.ObjectLotDetailPage/,
  );
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

test('lot detail page follows the object page layout: floor plans beside the price summary', () => {
  assert.match(objectDetailSource, /className="object-detail-page object-lot-page"/);
  assert.match(objectDetailSource, /className="text-button object-detail-back"[\s\S]*?Вернуться к объекту/);
  assert.match(objectDetailSource, /const headerLine = getObjectLotHeaderLine\(object, unit\);/);
  assert.match(
    objectDetailSource,
    /<section className="object-detail-hero object-lot-hero"[\s\S]*?<ObjectLotMediaCarousel[\s\S]*?<aside className="detail-section object-parameters-section object-lot-summary">/,
  );
  assert.match(objectDetailSource, /<strong className="object-detail-summary-price">\{priceSummary\.primaryPrice\}<\/strong>/);
  assert.match(objectDetailSource, /formatComputedFeedUnitPricePerMeter\(unit\)/);
  assert.match(objectDetailSource, /className="object-parameters-grid object-lot-facts"/);
  assert.match(objectDetailSource, /className="object-lot-summary-action"[\s\S]*?<LotCollectionAction loadStateOnMount navigate=\{navigate\} unitId=\{unit\.id\} \/>/);
  assert.doesNotMatch(objectDetailSource, /object-lot-split-card|object-lot-fact-line|Параметры лота/);
  assert.match(styles, /\.object-lot-hero \.object-lot-media-carousel\s*\{[\s\S]*?grid-template-rows:\s*minmax\(470px,\s*1fr\) auto;[\s\S]*?place-items:\s*stretch;[\s\S]*?\}/);
  assert.match(styles, /\.object-detail-hero \.object-lot-facts \.object-lot-fact--wide\s*\{[\s\S]*?grid-column:\s*1 \/ -1;[\s\S]*?\}/);
});

test('lot summary plaques show filled values including living and kitchen areas', () => {
  const factsSource = objectDetailSource.match(/function getObjectLotSummaryFacts[\s\S]*?\n}\n/)?.[0] ?? '';

  for (const label of ['Тип', 'Площадь', 'Жилая', 'Кухня', 'Потолки', 'Мощность', 'Вход', 'Этаж', 'Срок']) {
    assert.match(factsSource, new RegExp(`label: '${label}'`));
  }
  assert.match(factsSource, /unit\.residentialDetails\?\.livingArea/);
  assert.match(factsSource, /unit\.residentialDetails\?\.kitchenArea/);
  assert.match(factsSource, /fact\.value \? \[/);
  assert.match(objectDetailSource, /function formatObjectLotArea\(value: string \| null\)[\s\S]*?maximumFractionDigits: 1/);
  assert.match(objectDetailSource, /return `\$\{unit\.completionQuarter\} кв\. \$\{unit\.completionYear\}`;/);
});

test('lot page shows the house and the closest lots of the same rooms in it', () => {
  assert.match(
    objectDetailSource,
    /className="object-description-location-grid object-lot-context-grid"[\s\S]*?<ObjectLotHouseSection[\s\S]*?<ObjectLotSimilarSection/,
  );
  assert.match(objectDetailSource, /function ObjectLotHouseSection[\s\S]*?<MetroStationItem[\s\S]*?Открыть объект/);
  const similarSource = objectDetailSource.match(/function ObjectLotSimilarSection[\s\S]*?\n}\n/)?.[0] ?? '';
  assert.match(similarSource, /apiRequest<FeedUnitGroupsResponse>\(`\/objects\/\$\{object\.id\}\/feed-units\/groups\?\$\{params\.toString\(\)\}`/);
  assert.match(similarSource, /params\.set\('type', unit\.type\);/);
  assert.match(similarSource, /params\.set\('rooms', String\(unit\.rooms\)\);/);
  assert.match(similarSource, /pickSimilarObjectLots\(units, unit, objectLotSimilarLimit\)/);
  assert.match(similarSource, /Ещё в этом доме/);
  assert.match(objectDetailSource, /function pickSimilarObjectLots[\s\S]*?candidate\.id !== currentUnit\.id[\s\S]*?\.slice\(0, limit\)/);
  assert.match(objectDetailSource, /function buildObjectLotsPath[\s\S]*?\?lotRooms=\$\{unit\.rooms\}[\s\S]*?#object-lots/);
  assert.match(objectDetailSource, /window\.location\.hash !== '#object-lots'/);
  assert.match(styles, /\.object-lot-context-grid > :only-child\s*\{[\s\S]*?grid-column:\s*1 \/ -1;[\s\S]*?\}/);
});

test('lot header downloads the floor plan when the lot has media', () => {
  assert.match(objectDetailSource, /function getObjectLotLayoutMedia\(unit: FeedUnit\)[\s\S]*?media\.label === 'layout-photo'/);
  assert.match(
    objectDetailSource,
    /className="object-detail-edit-link object-lot-download-link"[\s\S]*?download=\{getFeedMediaDownloadFileName\(layoutMedia\)\}[\s\S]*?href=\{buildMediaFileContentUrl\(layoutMedia\.file\.id, \{ download: true \}\)\}[\s\S]*?Скачать планировку/,
  );
});

test('lot detail page shows aerotour icon link only when object aerotour url is valid', () => {
  assert.match(objectDetailSource, /import aerotourIconUrl from '\.\.\/\.\.\/\.\.\/\.\.\/aerotour-icon\.png';/);
  assert.match(objectDetailSource, /const aerotourUrl = getExternalObjectUrl\(object\.aerotourUrl\);/);
  assert.match(
    objectDetailSource,
    /aerotourUrl \? \([\s\S]*className="object-lot-aerotour-link"[\s\S]*href=\{aerotourUrl\}[\s\S]*aria-label="Открыть аэротур"[\s\S]*target="_blank"[\s\S]*<img[\s\S]*className="object-lot-aerotour-icon"[\s\S]*src=\{aerotourIconUrl\}/,
  );
  assert.doesNotMatch(objectDetailSource, /object\.aerotourUrl \? \([\s\S]*className="object-lot-aerotour-link"/);
  assert.match(
    styles,
    /\.object-lot-aerotour-link\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?width:\s*48px;[\s\S]*?height:\s*36px;[\s\S]*?border-radius:\s*999px;[\s\S]*?background:\s*var\(--object-lot-aerotour-bg\);[\s\S]*?\}/,
  );
  assert.match(
    styles,
    /\.object-lot-aerotour-icon\s*\{[\s\S]*?width:\s*16px;[\s\S]*?height:\s*16px;[\s\S]*?filter:\s*var\(--object-lot-aerotour-icon-filter\);[\s\S]*?object-fit:\s*contain;[\s\S]*?\}/,
  );
});

test('lot detail price summary shows discount only when discount price is lower', () => {
  assert.match(objectDetailSource, /function hasFeedUnitRealDiscount\(unit: FeedUnit\)/);
  assert.match(
    objectDetailSource,
    /const price = Number\(unit\.price\);[\s\S]*?const discountPrice = Number\(unit\.discountPrice\);[\s\S]*?discountPrice < price/,
  );
  assert.match(objectDetailSource, /function getObjectLotPriceSummary\(unit: FeedUnit\)/);
  assert.match(objectDetailSource, /const hasRealDiscount = hasFeedUnitRealDiscount\(unit\);/);
  assert.match(objectDetailSource, /label: hasRealDiscount \? 'Цена со скидкой' : 'Стоимость'/);
  assert.match(objectDetailSource, /secondaryPrice: hasRealDiscount \? formatFeedUnitPrice\(unit\.price, unit\.currency\) : null/);
  assert.match(objectDetailSource, /secondaryPricePerMeter: hasRealDiscount \? formatFeedUnitBasePricePerMeter\(unit\) : null/);
  assert.match(objectDetailSource, /priceSummary\.secondaryPricePerMeter \? ` · \$\{priceSummary\.secondaryPricePerMeter\}\/м²` : ''/);
  assert.match(objectDetailSource, /function getFeedUnitBasePricePerMeterValue\(unit: FeedUnit\)/);
  assert.match(objectDetailSource, /const pricePerMeter = parseNullableNumber\(unit\.pricePerMeter\);[\s\S]*?return pricePerMeter;/);
  assert.match(
    objectDetailSource,
    /const price = parseNullableNumber\(unit\.price\);[\s\S]*?const area = parseNullableNumber\(unit\.area\);[\s\S]*?return price \/ area;/,
  );
});

test('lot detail media carousel fits media without cropping', () => {
  assert.match(objectDetailSource, /className="media-gallery-frame object-lot-media-carousel"/);
  assert.match(objectDetailSource, /className="media-gallery-stage object-lot-media-stage"/);
  assert.match(objectDetailSource, /className="media-gallery-button object-lot-media-button"/);
  assert.match(objectDetailSource, /className="media-gallery-image object-lot-media-image"/);

  assert.match(
    styles,
    /\.object-lot-page \.object-lot-hero \.object-lot-media-stage\s*\{[\s\S]*?border-radius:\s*18px;[\s\S]*?background:\s*#ffffff;[\s\S]*?\}/,
  );
  assert.match(
    styles,
    /\.object-lot-media-carousel \.object-lot-media-image\s*\{[^}]*inset:\s*26px 40px;[^}]*width:\s*calc\(100% - 80px\);[^}]*height:\s*calc\(100% - 52px\);[^}]*object-fit:\s*contain;[^}]*\}/,
  );
});

test('lot detail media thumbnails sit below the active media stage', () => {
  assert.match(objectDetailSource, /className="carousel-thumbnail-zone object-lot-thumbnail-zone"/);
  assert.match(objectDetailSource, /className="carousel-thumbnails object-lot-thumbnails"/);

  assert.match(
    styles,
    /\.object-lot-media-carousel\s*>\s*\.object-lot-thumbnail-zone\s*\{[\s\S]*?position:\s*static;[\s\S]*?height:\s*auto;[\s\S]*?pointer-events:\s*auto;[\s\S]*?\}/,
  );
  assert.match(styles, /\.object-lot-media-carousel\s*>\s*\.object-lot-thumbnail-zone::before\s*\{[\s\S]*?display:\s*none;[\s\S]*?\}/);
  assert.match(
    styles,
    /\.object-lot-media-carousel\s*>\s*\.object-lot-thumbnail-zone \.carousel-thumbnails,\s*\.object-lot-media-carousel\s*>\s*\.object-lot-thumbnail-zone:hover \.carousel-thumbnails,\s*\.object-lot-media-carousel\s*>\s*\.object-lot-thumbnail-zone:focus-within \.carousel-thumbnails\s*\{[\s\S]*?position:\s*static;[\s\S]*?justify-content:\s*flex-start;[\s\S]*?opacity:\s*1;[\s\S]*?transform:\s*none;[\s\S]*?\}/,
  );
  assert.match(styles, /\.object-lot-page \.object-lot-media-carousel \.carousel-thumbnail\s*\{[\s\S]*?width:\s*112px;[\s\S]*?height:\s*74px;[\s\S]*?\}/);
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
