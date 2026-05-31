import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(currentDir, '../src/objects/ObjectDetailPage.tsx'), 'utf8');
const multiSelectSource = readFileSync(resolve(currentDir, '../src/components/MultiSelectDropdown.tsx'), 'utf8');
const styles = readFileSync(resolve(currentDir, '../src/styles.css'), 'utf8');
const objectFeedMediaCarouselSource =
  source.match(/function ObjectFeedMediaCarousel[\s\S]*?\nfunction ObjectLotMediaCarousel/)?.[0] ?? '';

test('object detail page loads active feed units with public filters', () => {
  assert.match(source, /FeedUnitsResponse/);
  assert.match(source, /const publicFeedUnitStatuses: FeedUnitStatus\[\] = \[\s*'AVAILABLE',\s*'BOOKED',\s*'RESERVED',\s*\];/);
  assert.match(source, /params\.set\('status', publicFeedUnitStatuses\.join\(','\)\);/);
  assert.match(source, /apiRequest<FeedUnitsResponse>\(`\/objects\/\$\{object\.id\}\/feed-units\?\$\{params\.toString\(\)\}`/);
  assert.match(source, /aria-label="Фильтр лотов по статусу"/);
  assert.match(source, /aria-label="Фильтр лотов по типу"/);
  assert.match(source, /feedUnitStatusFilterOptions/);
  assert.match(source, /AVAILABLE: 'Доступен'/);
  assert.match(source, /RESERVED: 'Резерв'/);
  assert.doesNotMatch(source, /feedUnitStatusFilterOptions[\s\S]*?ARCHIVED/);
});

test('object detail feed units expose detailed lot filters in API request and reset', () => {
  assert.match(source, /const feedUnitRoomFilterOptions = \[/);
  assert.match(source, /\{ value:\s*'0',\s*label:\s*'Студия'\s*\}/);
  assert.match(source, /\{ value:\s*'4',\s*label:\s*'4 спальни'\s*\}/);
  assert.match(source, /\{ value:\s*'5',\s*label:\s*'5 спален'\s*\}/);
  assert.match(source, /import \{ MultiSelectDropdown \} from '\.\.\/components\/MultiSelectDropdown';/);
  assert.match(source, /<MultiSelectDropdown[\s\S]*?ariaLabel="Фильтр лотов по комнатам"[\s\S]*?values=\{getFeedUnitRoomFilterValues\(roomFilter\)\}[\s\S]*?onChange=\{\(values\) => \{[\s\S]*?setRoomFilter\(formatFeedUnitRoomFilterValues\(values\)\);/);
  assert.match(multiSelectSource, /aria-multiselectable=\{true\}/);
  assert.match(source, /const \[pricePerMeterMinFilter,\s*setPricePerMeterMinFilter\] = useState\(''\);/);
  assert.match(source, /const \[pricePerMeterMaxFilter,\s*setPricePerMeterMaxFilter\] = useState\(''\);/);
  assert.match(source, /const \[areaMinFilter,\s*setAreaMinFilter\] = useState\(''\);/);
  assert.match(source, /const \[areaMaxFilter,\s*setAreaMaxFilter\] = useState\(''\);/);
  assert.match(source, /const \[completionYearFilter,\s*setCompletionYearFilter\] = useState\(''\);/);
  assert.match(source, /const \[completionQuarterFilter,\s*setCompletionQuarterFilter\] = useState\(''\);/);
  assert.match(source, /setOptionalParam\(params,\s*'priceMin',\s*priceMinFilter\);/);
  assert.match(source, /setOptionalParam\(params,\s*'priceMax',\s*priceMaxFilter\);/);
  assert.match(source, /setOptionalParam\(params,\s*'pricePerMeterMin',\s*pricePerMeterMinFilter\);/);
  assert.match(source, /setOptionalParam\(params,\s*'pricePerMeterMax',\s*pricePerMeterMaxFilter\);/);
  assert.match(source, /setOptionalParam\(params,\s*'areaMin',\s*areaMinFilter\);/);
  assert.match(source, /setOptionalParam\(params,\s*'areaMax',\s*areaMaxFilter\);/);
  assert.match(source, /setOptionalParam\(params,\s*'rooms',\s*roomFilter\);/);
  assert.match(source, /setOptionalParam\(params,\s*'floorMin',\s*floorMinFilter\);/);
  assert.match(source, /setOptionalParam\(params,\s*'floorMax',\s*floorMaxFilter\);/);
  assert.match(source, /setOptionalParam\(params,\s*'completionYear',\s*completionYearFilter\);/);
  assert.match(source, /setOptionalParam\(params,\s*'completionQuarter',\s*completionQuarterFilter\);/);
  assert.match(source, />\s*Цена от\s*</);
  assert.match(source, />\s*Цена до\s*</);
  assert.match(source, />\s*Цена за метр от\s*</);
  assert.match(source, />\s*Цена за метр до\s*</);
  assert.match(source, />\s*Площадь от\s*</);
  assert.match(source, />\s*Площадь до\s*</);
  assert.match(source, />\s*Комнаты\s*</);
  assert.match(source, />\s*Этаж от\s*</);
  assert.match(source, />\s*Этаж до\s*</);
  assert.match(source, />\s*Год сдачи\s*</);
  assert.match(source, />\s*Квартал\s*</);
  assert.match(source, /setPriceMinFilter\(''\);/);
  assert.match(source, /setCompletionQuarterFilter\(''\);/);
});

test('object detail feed units initialize from catalog lot filters in URL', () => {
  assert.match(source, /type InitialObjectFeedUnitFilters = \{/);
  assert.match(source, /function getInitialObjectFeedUnitFiltersFromLocation\(\): InitialObjectFeedUnitFilters/);
  assert.match(source, /params\.get\('lotPriceMin'\)/);
  assert.match(source, /params\.get\('lotPriceMax'\)/);
  assert.match(source, /params\.get\('lotRooms'\)/);
  assert.match(source, /params\.get\('lotFloorMin'\)/);
  assert.match(source, /params\.get\('lotFloorMax'\)/);
  assert.match(source, /const initialFilters = useMemo\(\(\) => getInitialObjectFeedUnitFiltersFromLocation\(\), \[\]\);/);
  assert.match(source, /const \[priceMinFilter,\s*setPriceMinFilter\] = useState\(initialFilters\.priceMin\);/);
  assert.match(source, /const \[priceMaxFilter,\s*setPriceMaxFilter\] = useState\(initialFilters\.priceMax\);/);
  assert.match(source, /const \[roomFilter,\s*setRoomFilter\] = useState\(initialFilters\.rooms\);/);
  assert.match(source, /function getFeedUnitRoomFilterValues\(value: string\)/);
  assert.match(source, /function formatFeedUnitRoomFilterValues\(values: string\[\]\)/);
  assert.match(source, /const \[floorMinFilter,\s*setFloorMinFilter\] = useState\(initialFilters\.floorMin\);/);
  assert.match(source, /const \[floorMaxFilter,\s*setFloorMaxFilter\] = useState\(initialFilters\.floorMax\);/);
});

test('object detail feed units block renders expected columns and media thumbnails', () => {
  assert.match(source, /<section className="detail-section object-feed-units-section"/);
  assert.match(source, /id="object-feed-units-title">Лоты<\/h3>/);
  assert.match(source, /const hasDiscountPrices = units\.some\(\(unit\) => Boolean\(unit\.discountPrice\)\);/);
  assert.match(source, /\{hasDiscountPrices \? \([\s\S]*?<ObjectFeedSortableHead[\s\S]*?field="price"[\s\S]*?>\s*Цена со скидкой\s*<\/ObjectFeedSortableHead>[\s\S]*?\) : null\}/);
  assert.match(source, /field="pricePerMeter"[\s\S]*?>\s*Цена за м²\s*<\/ObjectFeedSortableHead>/);
  assert.match(source, /showDiscountPrice=\{hasDiscountPrices\}/);
  assert.match(source, /showDiscountPrice: boolean;/);
  assert.match(source, /\{showDiscountPrice \? <TableCell>\{formatFeedUnitPrice\(unit\.discountPrice, unit\.currency\)\}<\/TableCell> : null\}/);
  assert.match(source, /<TableCell>\{formatFeedUnitPricePerMeter\(unit\)\}<\/TableCell>/);
  assert.match(source, /<TableHead>Медиа<\/TableHead>/);
  assert.doesNotMatch(source, /<span>ID \{unit\.externalId\}<\/span>/);
  assert.doesNotMatch(source, /<strong>\{unit\.title \|\| unit\.externalId\}<\/strong>/);
  assert.match(source, /function getFeedUnitTitle\(unit: FeedUnit\)/);
  assert.match(source, /function isSeparateRoomsStudio\(unit: FeedUnit\)/);
  assert.match(source, /unit\.rooms === 0 \|\| \(unit\.rooms === null && isSeparateRoomsStudio\(unit\)\)[\s\S]*?return 'Студия';/);
  assert.match(source, /className="object-feed-media-button"/);
  assert.match(source, /onClick=\{\(event\) => \{[\s\S]*?event\.stopPropagation\(\);[\s\S]*?onOpenMedia\(unit\);[\s\S]*?\}\}/);
  assert.match(source, /<SecureImage[\s\S]*?className="object-feed-media-image"[\s\S]*?fileId=\{primaryMedia\.file\.id\}[\s\S]*?variant="thumbnail"/);
  assert.match(source, /Лоты не найдены/);
  assert.match(source, /Загрузка лотов/);
  assert.match(source, /Не удалось загрузить лоты/);

  assert.match(styles, /\.object-feed-units-section\s*\{/);
  assert.match(styles, /\.object-feed-units-toolbar\s*\{/);
  assert.match(styles, /\.object-feed-media-button\s*\{/);
  assert.match(styles, /\.object-feed-media-button:hover\s+\.object-feed-media-preview/);
  assert.match(styles, /\.object-feed-media-button:focus-visible\s*\{/);
  assert.match(styles, /\.object-feed-media-preview\s*\{/);
  assert.match(styles, /\.object-feed-units-table\s*\{/);
});

test('object detail feed unit rows open lot cards in a new tab', () => {
  assert.match(source, /function buildObjectLotPath\(objectSlug: string, unitId: string\)/);
  assert.match(source, /const lotHref = buildObjectLotPath\(objectSlug, unit\.id\);/);
  assert.match(source, /window\.open\(lotHref, '_blank', 'noopener,noreferrer'\);/);
  assert.match(source, /className="object-feed-unit-row"/);
  assert.match(source, /role="link"/);
  assert.match(source, /tabIndex=\{0\}/);
  assert.match(source, /href=\{lotHref\}/);
  assert.match(source, /target="_blank"/);
  assert.match(source, /rel="noopener noreferrer"/);
  assert.match(source, /objectSlug=\{object\.slug\}/);
  assert.match(styles, /\.object-feed-unit-row\s*\{/);
  assert.match(styles, /\.object-feed-unit-link\s*\{/);
});

test('object detail feed units support server sorting from sortable headers', () => {
  assert.match(source, /type ObjectFeedUnitSortBy = 'title' \| 'status' \| 'price' \| 'pricePerMeter' \| 'area' \| 'rooms' \| 'floor' \| 'building';/);
  assert.match(source, /type ObjectFeedUnitSortDirection = 'asc' \| 'desc';/);
  assert.match(source, /const \[sortBy,\s*setSortBy\] = useState<ObjectFeedUnitSortBy>\('price'\);/);
  assert.match(source, /const \[sortDirection,\s*setSortDirection\] = useState<ObjectFeedUnitSortDirection>\('asc'\);/);
  assert.match(source, /params\.set\('sortBy', sortBy\);/);
  assert.match(source, /params\.set\('sortDirection', sortDirection\);/);
  assert.match(source, /function handleSort\(field: ObjectFeedUnitSortBy\)/);
  assert.match(source, /const nextDirection: ObjectFeedUnitSortDirection = sortBy === field && sortDirection === 'desc' \? 'asc' : 'desc';/);
  assert.match(source, /<ObjectFeedSortableHead[\s\S]*?field="title"[\s\S]*?>\s*Лот\s*<\/ObjectFeedSortableHead>/);
  assert.match(source, /<ObjectFeedSortableHead[\s\S]*?field="status"[\s\S]*?>\s*Статус\s*<\/ObjectFeedSortableHead>/);
  assert.match(source, /<ObjectFeedSortableHead[\s\S]*?field="price"[\s\S]*?>\s*Цена\s*<\/ObjectFeedSortableHead>/);
  assert.match(source, /<ObjectFeedSortableHead[\s\S]*?field="price"[\s\S]*?>\s*Цена со скидкой\s*<\/ObjectFeedSortableHead>/);
  assert.match(source, /<ObjectFeedSortableHead[\s\S]*?field="pricePerMeter"[\s\S]*?>\s*Цена за м²\s*<\/ObjectFeedSortableHead>/);
  assert.match(source, /<ObjectFeedSortableHead[\s\S]*?field="area"[\s\S]*?>\s*Площадь\s*<\/ObjectFeedSortableHead>/);
  assert.match(source, /<ObjectFeedSortableHead[\s\S]*?field="rooms"[\s\S]*?>\s*Комнаты\/тип\s*<\/ObjectFeedSortableHead>/);
  assert.match(source, /<ObjectFeedSortableHead[\s\S]*?field="floor"[\s\S]*?>\s*Этаж\s*<\/ObjectFeedSortableHead>/);
  assert.match(source, /<ObjectFeedSortableHead[\s\S]*?field="building"[\s\S]*?>\s*Корпус\/секция\s*<\/ObjectFeedSortableHead>/);
  assert.match(styles, /\.object-feed-sort-button\s*\{/);
  assert.match(styles, /\.object-feed-sort-button\.is-active\s*\{/);
});

test('object detail feed unit sorting keeps existing rows visible while reloading', () => {
  assert.match(source, /const showFeedUnitsSkeleton = isLoading && units\.length === 0;/);
  assert.match(source, /const sortedUnits = useMemo\(/);
  assert.match(source, /sortFeedUnitsForDisplay\(units, sortBy, sortDirection\)/);
  assert.match(source, /\{showFeedUnitsSkeleton \? <ObjectFeedUnitsTableSkeleton columnsCount=\{feedUnitsTableColumnCount\} \/> : null\}/);
  assert.match(source, /!\s*error[\s\S]*?\? sortedUnits\.map\(\(unit\) =>/);
  assert.doesNotMatch(source, /isLoading \? <ObjectFeedUnitsTableSkeleton \/> : null/);
  assert.doesNotMatch(source, /!isLoading && !error[\s\S]*?\? units\.map\(\(unit\) =>/);
});

test('object detail feed units use effective prices for sorting and price per meter', () => {
  assert.match(source, /function getEffectiveFeedUnitPrice\(unit: FeedUnit\)/);
  assert.match(source, /return parseNullableNumber\(unit\.effectivePrice\) \?\? parseNullableNumber\(unit\.discountPrice\) \?\? parseNullableNumber\(unit\.price\);/);
  assert.match(source, /compareNullableNumber\(getEffectiveFeedUnitPrice\(leftUnit\), getEffectiveFeedUnitPrice\(rightUnit\)\)/);
  assert.match(source, /parseNullableNumber\(unit\.effectivePricePerMeter\)/);
});

test('object detail feed media opens lot files in a carousel with fullscreen preview', () => {
  assert.match(source, /const \[mediaCarouselUnit,\s*setMediaCarouselUnit\] = useState<FeedUnit \| null>\(null\);/);
  assert.match(source, /<ObjectFeedMediaCarousel[\s\S]*?accessToken=\{accessToken\}[\s\S]*?unit=\{mediaCarouselUnit\}[\s\S]*?onClose=\{\(\) => setMediaCarouselUnit\(null\)\}/);
  assert.match(source, /function ObjectFeedMediaCarousel/);
  assert.match(source, /const \[activeIndex,\s*setActiveIndex\] = useState\(0\);/);
  assert.match(source, /const \[fullscreenMedia,\s*setFullscreenMedia\] = useState<FeedUnit\['media'\]\[number\] \| null>\(null\);/);
  assert.match(source, /className="object-feed-media-carousel"/);
  assert.match(source, /className="object-feed-media-carousel-stage"/);
  assert.match(source, /className="object-feed-media-carousel-image-button"/);
  assert.match(source, /onClick=\{\(\) => setFullscreenMedia\(activeMedia\)\}/);
  assert.match(source, /className="object-feed-media-fullscreen"/);
  assert.match(source, /className="object-feed-media-carousel-image"[\s\S]*?variant="original"/);
  assert.match(source, /className="object-feed-media-fullscreen-image"[\s\S]*?variant="original"/);
  assert.match(source, /unit\.media\.map\(\(media\) =>/);
  assert.match(source, /function getFeedMediaDownloadFileName\(media: FeedUnit\['media'\]\[number\]\)/);
  assert.match(source, /download=\{getFeedMediaDownloadFileName\(fullscreenMedia\)\}/);
  assert.match(source, /href=\{buildMediaFileContentUrl\(fullscreenMedia\.file\.id,\s*\{ download: true \}\)\}/);
  assert.match(source, /Скачать оригинал/);
  assert.doesNotMatch(source, /Открыть оригинал/);
  assert.doesNotMatch(source, /function ObjectFeedMediaModal/);
  assert.doesNotMatch(source, /object-feed-media-modal/);
  assert.match(styles, /\.object-feed-media-carousel-backdrop\s*\{/);
  assert.match(styles, /\.object-feed-media-carousel-thumbs\s*\{/);
  const carouselBlock = styles.match(/\.object-feed-media-carousel\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(carouselBlock, /width:\s*min\(1040px,\s*calc\(100vw - 48px\)\);/);
  assert.match(carouselBlock, /height:\s*min\(820px,\s*calc\(100dvh - 48px\)\);/);
  assert.match(carouselBlock, /overflow:\s*hidden;/);
  const carouselStageBlock = styles.match(/\.object-feed-media-carousel-stage\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(carouselStageBlock, /height:\s*100%;/);
  assert.match(carouselStageBlock, /min-height:\s*0;/);
  assert.match(carouselStageBlock, /overflow:\s*hidden;/);
  const imageButtonBlock = styles.match(/\.object-feed-media-carousel-image-button\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(imageButtonBlock, /position:\s*relative;/);
  assert.match(imageButtonBlock, /\n\s*width:\s*100%;/);
  assert.match(imageButtonBlock, /max-width:\s*860px;/);
  assert.match(imageButtonBlock, /\n\s*height:\s*100%;/);
  assert.match(imageButtonBlock, /max-height:\s*100%;/);
  assert.match(imageButtonBlock, /min-width:\s*0;/);
  assert.match(imageButtonBlock, /min-height:\s*0;/);
  assert.match(imageButtonBlock, /overflow:\s*hidden;/);
  const carouselImageBlock = styles.match(/\.object-feed-media-carousel-image\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(carouselImageBlock, /position:\s*absolute;/);
  assert.match(carouselImageBlock, /inset:\s*0;/);
  assert.match(carouselImageBlock, /\n\s*width:\s*100%;/);
  assert.match(carouselImageBlock, /\n\s*height:\s*100%;/);
  assert.match(carouselImageBlock, /object-fit:\s*contain;/);
  const carouselThumbBlock = styles.match(/\.object-feed-media-carousel-thumb\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(carouselThumbBlock, /position:\s*relative;/);
  const carouselThumbImageBlock = styles.match(/\.object-feed-media-carousel-thumb-image\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(carouselThumbImageBlock, /position:\s*absolute;/);
  assert.match(carouselThumbImageBlock, /inset:\s*0;/);
  assert.match(carouselThumbImageBlock, /object-fit:\s*contain;/);
  const fullscreenBlock = styles.match(/\.object-feed-media-fullscreen\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(fullscreenBlock, /overflow:\s*hidden;/);
  const fullscreenImageButtonBlock = styles.match(/\.object-feed-media-fullscreen-image-button\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(fullscreenImageButtonBlock, /position:\s*relative;/);
  assert.match(fullscreenImageButtonBlock, /min-width:\s*0;/);
  assert.match(fullscreenImageButtonBlock, /min-height:\s*0;/);
  assert.match(fullscreenImageButtonBlock, /overflow:\s*hidden;/);
  const fullscreenImageBlock = styles.match(/\.object-feed-media-fullscreen-image\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(fullscreenImageBlock, /position:\s*absolute;/);
  assert.match(fullscreenImageBlock, /inset:\s*0;/);
  assert.match(fullscreenImageBlock, /\n\s*width:\s*100%;/);
  assert.match(fullscreenImageBlock, /\n\s*height:\s*100%;/);
  assert.match(fullscreenImageBlock, /max-width:\s*100%;/);
  assert.match(fullscreenImageBlock, /max-height:\s*100%;/);
  assert.match(fullscreenImageBlock, /object-fit:\s*contain;/);
  assert.doesNotMatch(styles, /\.object-feed-media-modal\s*\{/);
});

test('object detail feed media fullscreen supports arrow buttons and keyboard navigation', () => {
  assert.match(objectFeedMediaCarouselSource, /function showPreviousFullscreenMedia\(\)/);
  assert.match(objectFeedMediaCarouselSource, /function showNextFullscreenMedia\(\)/);
  assert.match(
    objectFeedMediaCarouselSource,
    /event\.key === 'ArrowLeft'[\s\S]*?fullscreenMedia[\s\S]*?showPreviousFullscreenMedia\(\);[\s\S]*?showPreviousMedia\(\);/,
  );
  assert.match(
    objectFeedMediaCarouselSource,
    /event\.key === 'ArrowRight'[\s\S]*?fullscreenMedia[\s\S]*?showNextFullscreenMedia\(\);[\s\S]*?showNextMedia\(\);/,
  );
  assert.match(
    objectFeedMediaCarouselSource,
    /aria-label="Предыдущее полноэкранное медиа лота"[\s\S]*?className="object-feed-media-fullscreen-nav object-feed-media-fullscreen-nav--previous"/,
  );
  assert.match(
    objectFeedMediaCarouselSource,
    /aria-label="Следующее полноэкранное медиа лота"[\s\S]*?className="object-feed-media-fullscreen-nav object-feed-media-fullscreen-nav--next"/,
  );

  const fullscreenNavBlock = styles.match(/\.object-feed-media-fullscreen-nav\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(fullscreenNavBlock, /position:\s*fixed;/);
  assert.match(fullscreenNavBlock, /top:\s*50%;/);
  assert.match(fullscreenNavBlock, /border-radius:\s*999px;/);
  assert.match(fullscreenNavBlock, /transform:\s*translateY\(-50%\);/);
  assert.match(styles, /\.object-feed-media-fullscreen-nav--previous\s*\{[\s\S]*?left:\s*32px;[\s\S]*?\}/);
  assert.match(styles, /\.object-feed-media-fullscreen-nav--next\s*\{[\s\S]*?right:\s*32px;[\s\S]*?\}/);
});
