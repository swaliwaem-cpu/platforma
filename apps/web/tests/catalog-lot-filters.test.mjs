import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(currentDir, '../src/catalog/CatalogPage.tsx'), 'utf8');
const stylesSource = readFileSync(resolve(currentDir, '../src/styles.css'), 'utf8');
const multiSelectSource = readFileSync(resolve(currentDir, '../src/components/MultiSelectDropdown.tsx'), 'utf8');
const catalogLotFilterQuerySource =
  source.match(/function buildCatalogLotFilterQuery[\s\S]*?\nfunction hasActiveCatalogLotFilters/)?.[0] ?? '';

test('catalog global filters include lot price per meter rooms and floor URL and API params', () => {
  assert.match(source, /lotPriceMin:\s*string;/);
  assert.match(source, /lotPriceMax:\s*string;/);
  assert.match(source, /lotPricePerMeterMin:\s*string;/);
  assert.match(source, /lotPricePerMeterMax:\s*string;/);
  assert.doesNotMatch(source, /lotAreaMin:\s*string;/);
  assert.doesNotMatch(source, /lotAreaMax:\s*string;/);
  assert.match(source, /lotRooms:\s*string;/);
  assert.match(source, /lotFloorMin:\s*string;/);
  assert.match(source, /lotFloorMax:\s*string;/);
  assert.match(source, /lotPricePerMeterMin:\s*sanitizeDecimalText\(params\.get\('lotPricePerMeterMin'\) \?\? ''\)/);
  assert.match(source, /lotPricePerMeterMax:\s*sanitizeDecimalText\(params\.get\('lotPricePerMeterMax'\) \?\? ''\)/);
  assert.doesNotMatch(source, /params\.get\('lotAreaMin'\)/);
  assert.doesNotMatch(source, /params\.get\('lotAreaMax'\)/);
  assert.match(source, /lotRooms:\s*parseCatalogRoomsParam\(params\.get\('lotRooms'\)\)/);
  assert.match(source, /function getRoomFilterValues\(value: string\)/);
  assert.match(source, /function formatRoomFilterValues\(values: string\[\]\)/);
  assert.match(source, /setParam\(params,\s*'lotPriceMin',\s*filters\.lotPriceMin\);/);
  assert.match(source, /setParam\(params,\s*'lotPriceMax',\s*filters\.lotPriceMax\);/);
  assert.match(source, /setParam\(params,\s*'lotPricePerMeterMin',\s*filters\.lotPricePerMeterMin\);/);
  assert.match(source, /setParam\(params,\s*'lotPricePerMeterMax',\s*filters\.lotPricePerMeterMax\);/);
  assert.doesNotMatch(source, /setParam\(params,\s*'lotAreaMin'/);
  assert.doesNotMatch(source, /setParam\(params,\s*'lotAreaMax'/);
  assert.match(source, /setParam\(params,\s*'lotRooms',\s*filters\.lotRooms\);/);
  assert.match(source, /setParam\(params,\s*'lotFloorMin',\s*filters\.lotFloorMin\);/);
  assert.match(source, /setParam\(params,\s*'lotFloorMax',\s*filters\.lotFloorMax\);/);
});

test('catalog typed routes map to residential commercial and all object filters', () => {
  assert.match(source, /function getCatalogRouteObjectType\(pathname: string\): RealEstateObjectType \| null/);
  assert.match(source, /pathname === '\/catalog\/life'[\s\S]*return 'RESIDENTIAL';/);
  assert.match(source, /pathname === '\/catalog\/comm'[\s\S]*return 'COMMERCIAL';/);
  assert.match(source, /parseCatalogFilters\(queryString, routeObjectType\)/);
  assert.match(source, /objectType:\s*routeObjectType \?\? parseCatalogObjectType\(params\.get\('type'\)\)/);
  assert.match(source, /function getCatalogListPathname\(objectType: CatalogObjectTypeFilter\)/);
  assert.match(source, /objectType === 'RESIDENTIAL'[\s\S]*return '\/catalog\/life';/);
  assert.match(source, /objectType === 'COMMERCIAL'[\s\S]*return '\/catalog\/comm';/);
  assert.match(source, /return '\/catalog';/);
  assert.match(source, /function shouldOmitCatalogObjectTypeParam\(pathname: string\)/);
  assert.match(source, /pathname === '\/catalog\/life' \|\| pathname === '\/catalog\/comm'/);
});

test('catalog reset keeps the current route section instead of merging everything', () => {
  assert.match(source, /function resetFilters\(\) \{/);
  assert.match(source, /objectType: routeObjectType \?\? filters\.objectType,/);
  assert.match(source, /const nextPathname = getNextCatalogPathname\(pathname, nextFilters\.objectType\);/);
  assert.match(source, /omitObjectType: shouldOmitCatalogObjectTypeParam\(nextPathname\)/);
  assert.match(source, /pushCatalogLocation\(nextPathname, nextSearch\);/);
});

test('catalog map switch preserves the active object section through query params', () => {
  assert.match(source, /onOpenMap=\{\(\) => navigate\(`\/catalog\/map\$\{buildCatalogQuery\(filters, viewMode\)\}`\)\}/);
  assert.match(source, /onOpenCatalog=\{\(\) =>[\s\S]*getCatalogListPathname\(filters\.objectType\)[\s\S]*omitObjectType: filters\.objectType !== 'ALL'/);
  assert.match(source, /function getNextCatalogPathname\(currentPathname: string, objectType: CatalogObjectTypeFilter\)/);
  assert.match(source, /if \(currentPathname === '\/catalog\/map'\) \{[\s\S]*return currentPathname;/);
});

test('catalog page title reflects the active residential commercial or all section', () => {
  assert.match(source, /function getCatalogPageTitle\(objectType: CatalogObjectTypeFilter, isMapView: boolean\)/);
  assert.match(source, /return isMapView \? 'Жилая недвижимость на карте' : 'Жилая недвижимость';/);
  assert.match(source, /return isMapView \? 'Коммерческая недвижимость на карте' : 'Коммерческая недвижимость';/);
  assert.match(source, /return isMapView \? 'Все объекты на карте' : 'Все объекты недвижимости';/);
});

test('catalog global lot filters render controls and count as active advanced filters', () => {
  assert.match(source, /const catalogRoomOptions = \[/);
  assert.match(source, /\{ value:\s*'0',\s*label:\s*'Студия'\s*\}/);
  assert.match(source, /\{ value:\s*'4',\s*label:\s*'4 спальни'\s*\}/);
  assert.match(source, /\{ value:\s*'5',\s*label:\s*'5 спален'\s*\}/);
  assert.match(source, /import \{ MultiSelectDropdown \} from '\.\.\/components\/MultiSelectDropdown';/);
  assert.match(source, /<MultiSelectDropdown[\s\S]*?ariaLabel="Фильтр каталога по комнатам"[\s\S]*?values=\{getRoomFilterValues\(filters\.lotRooms\)\}[\s\S]*?onChange=\{\(values\) => onChange\(\{ lotRooms: formatRoomFilterValues\(values\) \}\)\}/);
  assert.match(multiSelectSource, /aria-multiselectable=\{true\}/);
  assert.match(source, /className="catalog-filter-range" aria-label="Диапазон цены лота"/);
  assert.match(source, />\s*Цена от\s*</);
  assert.match(source, />\s*Цена до\s*</);
  assert.match(source, /className="catalog-filter-range" aria-label="Диапазон цены за метр лота"/);
  assert.match(source, />\s*Цена за метр от\s*</);
  assert.match(source, />\s*Цена за метр до\s*</);
  assert.match(source, />\s*Сколько комнат\s*</);
  assert.doesNotMatch(source, /aria-label="Диапазон площади лота"/);
  assert.doesNotMatch(source, />\s*М2 от\s*</);
  assert.doesNotMatch(source, />\s*М2 до\s*</);
  assert.match(source, /className="catalog-filter-range" aria-label="Диапазон этажа лота"/);
  assert.match(source, />\s*Этаж от\s*</);
  assert.match(source, />\s*Этаж до\s*</);
  assert.match(source, /filters\.lotPriceMin,/);
  assert.match(source, /filters\.lotPriceMax,/);
  assert.match(source, /filters\.lotPricePerMeterMin,/);
  assert.match(source, /filters\.lotPricePerMeterMax,/);
  assert.match(source, /filters\.lotRooms,/);
  assert.match(source, /filters\.lotFloorMin,/);
  assert.match(source, /filters\.lotFloorMax,/);
});

test('catalog reset action is grouped with the filter visibility toggle', () => {
  assert.match(source, /className="catalog-filter-header-actions"/);
  assert.match(
    source,
    /className="catalog-filter-header-actions"[\s\S]*className="catalog-filter-reset"[\s\S]*Сбросить[\s\S]*className="catalog-filter-toggle"/,
  );
  assert.match(
    stylesSource,
    /\.catalog-filter-search-row \{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(0,\s*auto\);[\s\S]*min-width:\s*0;/,
  );
  assert.match(
    stylesSource,
    /\.catalog-filter-header-actions \{[\s\S]*display:\s*flex;[\s\S]*max-width:\s*100%;[\s\S]*min-width:\s*0;[\s\S]*gap:\s*10px;/,
  );
  assert.match(
    stylesSource,
    /\.catalog-filter-toggle,\n\.catalog-filter-reset \{[\s\S]*width:\s*clamp\(140px,\s*13vw,\s*190px\);[\s\S]*flex:\s*0 1 190px;[\s\S]*min-width:\s*0;[\s\S]*max-width:\s*190px;[\s\S]*min-height:\s*44px;/,
  );
  assert.match(
    stylesSource,
    /@media \(max-width:\s*700px\) \{[\s\S]*\.catalog-filter-search-row \{[\s\S]*grid-template-columns:\s*1fr;[\s\S]*\.catalog-filter-header-actions \{[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/,
  );
  assert.doesNotMatch(source, /className="catalog-filter-actions"/);
  assert.doesNotMatch(source, /className="secondary-button secondary-button--fit" type="button" onClick=\{onReset\}/);
});

test('catalog CSS normalizes Safari typography for mixed Cyrillic and Latin labels', () => {
  assert.match(
    stylesSource,
    /@supports \(-webkit-touch-callout:\s*none\) or \(-webkit-hyphens:\s*none\) \{[\s\S]*--platforma-font-sans:\s*-apple-system,\s*BlinkMacSystemFont,\s*"Segoe UI",\s*ui-sans-serif,\s*system-ui,\s*sans-serif;/,
  );
});

test('catalog passes active lot filters through object links', () => {
  assert.match(source, /function buildCatalogObjectHref\(slug: string, filters: CatalogFilters\)/);
  assert.match(source, /function buildCatalogLotFilterQuery\(filters: CatalogFilters\)/);
  assert.match(catalogLotFilterQuerySource, /setParam\(params,\s*'lotPriceMin',\s*filters\.lotPriceMin\);/);
  assert.match(catalogLotFilterQuerySource, /setParam\(params,\s*'lotPriceMax',\s*filters\.lotPriceMax\);/);
  assert.match(catalogLotFilterQuerySource, /setParam\(params,\s*'lotPricePerMeterMin',\s*filters\.lotPricePerMeterMin\);/);
  assert.match(catalogLotFilterQuerySource, /setParam\(params,\s*'lotPricePerMeterMax',\s*filters\.lotPricePerMeterMax\);/);
  assert.match(catalogLotFilterQuerySource, /setParam\(params,\s*'lotRooms',\s*filters\.lotRooms\);/);
  assert.match(catalogLotFilterQuerySource, /setParam\(params,\s*'lotFloorMin',\s*filters\.lotFloorMin\);/);
  assert.match(catalogLotFilterQuerySource, /setParam\(params,\s*'lotFloorMax',\s*filters\.lotFloorMax\);/);
  assert.match(source, /const objectHref = buildCatalogObjectHref\(object\.slug, filters\);/);
  assert.match(source, /<CatalogListItem[\s\S]*?filters=\{filters\}/);
  assert.match(source, /<CatalogCard[\s\S]*?filters=\{filters\}/);
  assert.match(source, /<MapObjectCard[\s\S]*?filters=\{filters\}/);
  assert.match(source, /balloonHtml: buildMapBalloon\(object, filters\)/);
});

test('catalog result cards show matched lot count only for lot-filtered results', () => {
  assert.match(source, /matchedFeedUnitsCount/);
  assert.match(source, /function hasActiveCatalogLotFilters\(filters: CatalogFilters\)/);
  assert.match(source, /function getCatalogMatchedLotsLabel\(object: RealEstateObjectSummary, filters: CatalogFilters\)/);
  assert.match(source, /function getCatalogMatchedLotsCount\(object: RealEstateObjectSummary, filters: CatalogFilters\)/);
  assert.match(source, /typeof object\.matchedFeedUnitsCount !== 'number'/);
  assert.match(source, /Найдено лотов: \$\{formatNumber\(matchedLotsCount\)\}/);
  assert.match(source, /className="catalog-matched-lots-badge"/);
  assert.match(source, /className="catalog-card-matched-lots-badge"/);
  assert.match(source, /const matchedLotsLabel = getCatalogMatchedLotsLabel\(object, filters\);/);
  assert.match(source, /const matchedLotsCount = getCatalogMatchedLotsCount\(object, filters\);/);
});
