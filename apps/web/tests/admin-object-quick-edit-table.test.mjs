import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const pageSource = readFileSync(resolve(currentDir, '../src/admin/ObjectsAdminPage.tsx'), 'utf8');
const tableSource = readFileSync(resolve(currentDir, '../src/admin/ObjectQuickEditTable.tsx'), 'utf8');
const stylesSource = readFileSync(resolve(currentDir, '../src/styles.css'), 'utf8');
const appThemeSource = readFileSync(resolve(currentDir, '../src/app-theme.css'), 'utf8');
const transformsPath = resolve(currentDir, '../src/admin/objectQuickEditTransforms.ts');
const transformsSource = existsSync(transformsPath) ? readFileSync(transformsPath, 'utf8') : '';
const persistencePath = resolve(currentDir, '../src/admin/objectQuickEditPersistence.ts');
const persistenceSource = existsSync(persistencePath) ? readFileSync(persistencePath, 'utf8') : '';
const sharedPackagePath = resolve(currentDir, '../../../packages/shared/package.json');
const sharedPackage = JSON.parse(readFileSync(sharedPackagePath, 'utf8'));
const sharedSearchEsmPath = resolve(currentDir, '../../../packages/shared/src/search-normalization.mjs');
const sharedSearchEsmSource = existsSync(sharedSearchEsmPath) ? readFileSync(sharedSearchEsmPath, 'utf8') : '';

test('objects admin list renders through ObjectQuickEditTable component', () => {
  assert.match(pageSource, /import \{[\s\S]*ObjectQuickEditTable,[\s\S]*objectStatusLabels,[\s\S]*type SortDirection,[\s\S]*type SortField,[\s\S]*\} from '\.\/ObjectQuickEditTable';/);
  assert.match(pageSource, /<ObjectQuickEditTable[\s\S]*objects=\{objects\}[\s\S]*onOpenObject=\{\(objectId\) => navigate\(`\/admin\/objects\/\$\{objectId\}\/edit`\)\}/);
  assert.doesNotMatch(pageSource, /from '@\/components\/ui\/table'/);

  assert.match(tableSource, /export function ObjectQuickEditTable/);
  assert.match(tableSource, /export const objectStatusLabels/);
  assert.match(tableSource, /type ObjectQuickEditTableProps/);
  assert.match(tableSource, /<Table className="admin-table compact-table object-quick-edit-table">/);
  assert.match(tableSource, /function SortButton/);
});

test('quick edit table defines the fifteen object columns in mockup order', () => {
  const configSource = tableSource.match(/export const objectQuickEditColumns = \[[\s\S]*?\] as const/)?.[0] ?? '';
  const labels = [...configSource.matchAll(/label: '([^']+)'/g)].map((match) => match[1]);

  assert.deepEqual(labels, [
    'Название',
    'Статус',
    'Цена от',
    'За метр от',
    'Застройщик',
    'КРТ',
    'Срок сдачи',
    'Метро',
    'Класс',
    'Количество квартир',
    'Площадь квартир',
    'Высота потолков',
    'Этажность',
    'Координаты',
    'Имя карты',
  ]);
});

test('quick edit title cell opens details from title text and edits title through icon button', () => {
  assert.match(tableSource, /PencilIcon/);
  assert.match(tableSource, /\{ key: 'title', label: 'Название', editor: 'text', sortField: 'title' \}/);
  assert.match(tableSource, /className="object-title-cell"/);
  assert.match(tableSource, /className="object-title-open"/);
  assert.match(tableSource, /onClick=\{\(\) => onOpenObject\(item\.id\)\}/);
  assert.doesNotMatch(tableSource, /<code>\{item\.slug\}<\/code>/);
  assert.match(tableSource, /aria-label=\{`Редактировать название: \$\{item\.title\}`\}/);
  assert.match(tableSource, /className="object-title-edit-button"/);
  assert.match(tableSource, /onClick=\{onStartEditing\}/);
  assert.match(tableSource, /case 'title':\s*return object\.title;/);
  assert.match(persistenceSource, /'title'/);
});

test('quick edit table removes the separate open action column', () => {
  assert.doesNotMatch(tableSource, /object-action-column/);
  assert.doesNotMatch(tableSource, />\s*Открыть\s*</);
  assert.match(tableSource, /colSpan=\{objectQuickEditColumns\.length\}/);
});

test('quick edit table exposes inline editors for text, status, class, developer and metro cells', () => {
  assert.match(tableSource, /editor:\s*'text'/);
  assert.match(tableSource, /editor:\s*'status'/);
  assert.match(tableSource, /editor:\s*'class'/);
  assert.match(tableSource, /editor:\s*'developer'/);
  assert.match(tableSource, /editor:\s*'metro'/);
  assert.match(tableSource, /const statusQuickEditOptions = \[[\s\S]*label: 'Опубликован'[\s\S]*label: 'Архив'/);
  assert.match(tableSource, /const propertyClassOptions = \[[\s\S]*Комфорт-класс[\s\S]*Бизнес-класс[\s\S]*Премиум-класс[\s\S]*Делюкс/);
  assert.match(tableSource, /function EditableTextCell/);
  assert.match(tableSource, /function StatusSelectEditor/);
  assert.match(tableSource, /function PropertyClassSelectEditor/);
  assert.match(tableSource, /function DeveloperSearchEditor/);
  assert.match(tableSource, /function MetroMultiSelectEditor/);
  assert.match(tableSource, /onKeyDown=\{handleEditorKeyDown/);
  assert.match(tableSource, /onBlur=\{handleEditorBlur/);
});

test('quick edit transform helpers normalize search, completion and apartment area drafts', async () => {
  assert.equal(existsSync(transformsPath), true);

  const searchHelpers = await import('@platforma/shared/search-normalization');
  const helpers = await import(pathToFileURL(transformsPath).href);

  assert.equal(searchHelpers.createSearchVariants('Shagal').includes('шагал'), true);
  assert.equal(searchHelpers.createSearchVariants('Ifufk').includes('шагал'), true);
  assert.equal(searchHelpers.matchesSearchVariants('Ifufk', ['Шагал']), true);
  assert.equal(helpers.normalizeQuickEditSearchTerm(' Ж.К.  Ария '), 'жк ария');
  assert.equal(helpers.matchesQuickEditSearch('жк ар', ['Ж.К. Ария', 'ariya']), true);
  assert.equal(helpers.matchesQuickEditSearch('Shagal', ['Шагал']), true);
  assert.equal(helpers.matchesQuickEditSearch('Ifufk', ['Шагал']), true);
  assert.equal(helpers.matchesQuickEditSearch('nov', ['Новая линия', 'new-line']), true);
  assert.equal(helpers.matchesQuickEditSearch('west', ['Новая линия', 'new-line']), false);
  assert.deepEqual(helpers.parseQuickEditCompletion('2 кв 2029'), {
    completionQuarter: '2',
    completionYear: '2029',
  });
  assert.deepEqual(helpers.parseQuickEditCompletion(''), {
    completionQuarter: null,
    completionYear: null,
  });
  assert.equal(helpers.normalizeApartmentAreaRange('44-170'), '44-170 м²');
  assert.equal(helpers.normalizeApartmentAreaRange('44-170 м²'), '44-170 м²');
  assert.equal(helpers.normalizeObjectPriceValue('от 12 000 000 ₽'), '12000000');
  assert.equal(helpers.normalizeObjectPriceValue('350 000 ₽/м²'), '350000');
  assert.equal(helpers.normalizeObjectPriceValue('350000,50'), '350000.50');
  assert.equal(helpers.normalizeCeilingHeight('3,1 метра'), 'от 3,1 м');
  assert.equal(helpers.normalizeCeilingHeight('от 3,1 м'), 'от 3,1 м');
  assert.equal(helpers.normalizeCeilingHeight(''), '');
});

test('shared search normalization exposes browser-safe named ESM exports', () => {
  assert.equal(sharedPackage.exports['./search-normalization'].import, './src/search-normalization.mjs');
  assert.equal(sharedPackage.exports['./search-normalization'].require, './src/search-normalization.cjs');
  assert.match(sharedSearchEsmSource, /export const matchesSearchVariants/);
  assert.match(sharedSearchEsmSource, /export const normalizeSearchText/);
  assert.doesNotMatch(sharedSearchEsmSource, /search-normalization\.cjs/);
});

test('quick edit table uses normalized search and draft transforms before commit', () => {
  assert.match(transformsSource, /from '@platforma\/shared\/search-normalization'/);
  assert.match(transformsSource, /export function normalizeQuickEditSearchTerm/);
  assert.match(transformsSource, /normalizeSearchText\(value\)/);
  assert.match(transformsSource, /matchesSearchVariants\(query,\s*values\)/);
  assert.match(transformsSource, /export function parseQuickEditCompletion/);
  assert.match(transformsSource, /export function normalizeApartmentAreaRange/);
  assert.match(transformsSource, /export function normalizeObjectPriceValue/);
  assert.match(transformsSource, /export function normalizeCeilingHeight/);

  assert.match(tableSource, /matchesQuickEditSearch\(draftValue,\s*\[developer\.name,\s*developer\.slug\]\)/);
  assert.match(tableSource, /matchesQuickEditSearch\(query,\s*\[station\.name,\s*station\.slug,\s*station\.lineName\]\)/);
  assert.match(tableSource, /parseQuickEditCompletion\(value\)/);
  assert.match(tableSource, /normalizeApartmentAreaRange\(value\)/);
  assert.match(tableSource, /normalizeObjectPriceValue\(value\)/);
  assert.match(tableSource, /normalizeCeilingHeight\(value\)/);
  assert.match(tableSource, /case 'mapName':\s*return object\.mapName;/);
  assert.match(tableSource, /case 'mapName':\s*return object\.mapName \?\? '';/);
  assert.match(tableSource, /maxLength=\{getTextCellMaxLength\(column\.key\)\}/);
  assert.match(tableSource, /case 'mapName':\s*return 16;/);
  assert.match(pageSource, /priceFrom:\s*emptyToNull\(normalizeObjectPriceValue\(form\.priceFrom\)\)/);
  assert.match(pageSource, /pricePerMeterFrom:\s*emptyToNull\(normalizeObjectPriceValue\(form\.pricePerMeterFrom\)\)/);
  assert.match(pageSource, /ceilingHeight:\s*emptyToNull\(normalizeCeilingHeight\(form\.ceilingHeight\)\)/);
});

test('objects admin list exposes expandable location filters and sends API params', () => {
  const listToolbarSource =
    pageSource.match(/<section className="toolbar" aria-label="Фильтры объектов">[\s\S]*?<\/section>/)?.[0] ?? '';

  assert.notEqual(listToolbarSource, '');
  assert.match(pageSource, /const \[isObjectFiltersExpanded,\s*setIsObjectFiltersExpanded\] = useState\(false\)/);
  assert.match(pageSource, /const \[districtSearch,\s*setDistrictSearch\] = useState\(''\)/);
  assert.match(pageSource, /const \[areaSearch,\s*setAreaSearch\] = useState\(''\)/);
  assert.match(pageSource, /const \[metroSearch,\s*setMetroSearch\] = useState\(''\)/);
  assert.match(pageSource, /districtSearch\.trim\(\)/);
  assert.match(pageSource, /params\.set\('districtSearch',\s*districtSearch\.trim\(\)\)/);
  assert.match(pageSource, /params\.set\('areaSearch',\s*areaSearch\.trim\(\)\)/);
  assert.match(pageSource, /params\.set\('metroSearch',\s*metroSearch\.trim\(\)\)/);
  assert.match(pageSource, /setDistrictSearch\(''\)/);
  assert.match(pageSource, /setAreaSearch\(''\)/);
  assert.match(pageSource, /setMetroSearch\(''\)/);
  assert.match(listToolbarSource, />\s*\+ Фильтры\s*</);
  assert.match(listToolbarSource, />\s*Районы\s*</);
  assert.match(listToolbarSource, />\s*Окружение\s*</);
  assert.match(listToolbarSource, />\s*Метро\s*</);
  assert.doesNotMatch(listToolbarSource, />\s*Основной район\s*</);
});

test('quick edit persistence helpers build minimal PATCH requests for edited cells', async () => {
  assert.equal(existsSync(persistencePath), true);

  const helpers = await import(pathToFileURL(persistencePath).href);
  const developers = [
    {
      id: 'developer-1',
      name: 'Ж.К. Ария',
      slug: 'zhk-ariya',
    },
  ];
  const parseCoordinates = (value) => {
    assert.equal(value, '55.75, 37.61');

    return {
      latitude: '55.75',
      longitude: '37.61',
      error: null,
    };
  };

  assert.deepEqual(
    helpers.createObjectQuickEditRequest({
      objectId: 'object-1',
      columnKey: 'status',
      value: 'ARCHIVED',
      developers,
      parseCoordinates,
    }),
    {
      method: 'PATCH',
      path: '/objects/object-1/status',
      payload: { status: 'ARCHIVED' },
    },
  );
  assert.deepEqual(
    helpers.createObjectQuickEditRequest({
      objectId: 'object-1',
      columnKey: 'metro',
      value: ['metro-1', 'metro-2'],
      developers,
      parseCoordinates,
    }).payload,
    { metroStationIds: ['metro-1', 'metro-2'] },
  );
  assert.deepEqual(
    helpers.createObjectQuickEditRequest({
      objectId: 'object-1',
      columnKey: 'completion',
      value: { completionQuarter: '2', completionYear: '2029' },
      developers,
      parseCoordinates,
    }).payload,
    { completionQuarter: '2', completionYear: '2029' },
  );
  assert.deepEqual(
    helpers.createObjectQuickEditRequest({
      objectId: 'object-1',
      columnKey: 'developer',
      value: 'жк ария',
      developers,
      parseCoordinates,
    }).payload,
    { developerId: 'developer-1' },
  );
  assert.deepEqual(
    helpers.createObjectQuickEditRequest({
      objectId: 'object-1',
      columnKey: 'coordinates',
      value: '55.75, 37.61',
      developers,
      parseCoordinates,
    }).payload,
    { latitude: '55.75', longitude: '37.61' },
  );
  assert.deepEqual(
    helpers.createObjectQuickEditRequest({
      objectId: 'object-1',
      columnKey: 'title',
      value: 'ЖК Ария',
      developers,
      parseCoordinates,
    }).payload,
    { title: 'ЖК Ария' },
  );
  assert.deepEqual(
    helpers.createObjectQuickEditRequest({
      objectId: 'object-1',
      columnKey: 'apartmentAreaRange',
      value: '44-170 м²',
      developers,
      parseCoordinates,
    }).payload,
    { apartmentAreaRange: '44-170 м²' },
  );
  assert.deepEqual(
    helpers.createObjectQuickEditRequest({
      objectId: 'object-1',
      columnKey: 'mapName',
      value: ' Ария ',
      developers,
      parseCoordinates,
    }).payload,
    { mapName: 'Ария' },
  );
  assert.deepEqual(
    helpers.createObjectQuickEditRequest({
      objectId: 'object-1',
      columnKey: 'mapName',
      value: '',
      developers,
      parseCoordinates,
    }).payload,
    { mapName: null },
  );
});

test('quick edit persistence helpers update local rows and remove status mismatches', async () => {
  assert.equal(existsSync(persistencePath), true);

  const helpers = await import(pathToFileURL(persistencePath).href);
  const currentRow = {
    id: 'object-1',
    status: 'PUBLISHED',
    title: 'Old title',
    coverImage: null,
    presentationFile: null,
  };
  const updatedObject = {
    id: 'object-1',
    status: 'ARCHIVED',
    title: 'New title',
    images: [{ id: 'image-1', isCover: true }],
    files: [{ id: 'file-1', type: 'PRESENTATION' }],
  };

  assert.deepEqual(helpers.updateObjectQuickEditRows([currentRow], updatedObject, 'PUBLISHED'), []);
  assert.equal(helpers.shouldRemoveObjectQuickEditRow([currentRow], updatedObject, 'PUBLISHED'), true);

  const updatedRows = helpers.updateObjectQuickEditRows([currentRow], updatedObject, '');

  assert.equal(updatedRows.length, 1);
  assert.equal(updatedRows[0].title, 'New title');
  assert.equal(updatedRows[0].status, 'ARCHIVED');
  assert.equal(updatedRows[0].coverImage.id, 'image-1');
  assert.equal(updatedRows[0].presentationFile.id, 'file-1');
});

test('objects admin page wires inline edit saves through API and local row state', () => {
  assert.match(persistenceSource, /export function createObjectQuickEditRequest/);
  assert.match(persistenceSource, /path:\s*`\/objects\/\$\{objectId\}\/status`/);
  assert.match(persistenceSource, /payload:\s*\{\s*metroStationIds:/);
  assert.match(persistenceSource, /payload:\s*\{\s*latitude:\s*coordinates\.latitude,\s*longitude:\s*coordinates\.longitude\s*\}/);
  assert.match(pageSource, /async function handleInlineEditCommit/);
  assert.match(pageSource, /createObjectQuickEditRequest\(\{[\s\S]*parseCoordinates:\s*parseCoordinatePair/);
  assert.match(pageSource, /apiRequest<ObjectResponse>\(request\.path,\s*accessToken,\s*\{[\s\S]*method:\s*request\.method/);
  assert.match(pageSource, /setObjects\(\(currentObjects\)\s*=>\s*updateObjectQuickEditRows\(currentObjects,\s*data\.object,\s*statusFilter\)\)/);
  assert.match(pageSource, /onInlineEditCommit=\{handleInlineEditCommit\}/);
});

test('objects quick edit panel uses ninety viewport width without widening the whole admin page', () => {
  assert.match(pageSource, /<AdminPanel className="table-panel object-table-panel" role="region" aria-label="Список объектов">/);
  assert.match(stylesSource, /\.admin-objects \.object-table-panel\s*\{[\s\S]*width:\s*90vw;[\s\S]*max-width:\s*90vw;[\s\S]*justify-self:\s*start;[\s\S]*margin-inline:\s*calc\(50% - 45vw\);/);
  assert.doesNotMatch(stylesSource, /\.admin-objects \.object-table-panel\s*\{[\s\S]*transform:\s*translateX\(-50%\);/);
  assert.match(stylesSource, /\.admin-objects\s*\{[\s\S]*width:\s*min\(100%, 1320px\);[\s\S]*max-width:\s*1320px;/);
});

test('quick edit compact CSS keeps fifteen columns dense and scrolls only on narrow screens', () => {
  assert.match(stylesSource, /\.compact-table\s*\{[\s\S]*table-layout:\s*fixed;[\s\S]*min-width:\s*1260px;/);
  assert.match(stylesSource, /\.compact-table :is\(\[data-slot="table-head"\], \[data-slot="table-cell"\]\)\s*\{[\s\S]*padding:/);
  assert.match(stylesSource, /\.object-quick-edit-table/);
  assert.match(stylesSource, /\.object-quick-column--title/);
  assert.match(stylesSource, /\.object-title-open/);
  assert.match(stylesSource, /\.object-title-edit-button/);
  assert.match(stylesSource, /\.quick-edit-input:focus-visible/);
  assert.match(appThemeSource, /html\[data-app-theme\] \.compact-table/);
  assert.match(appThemeSource, /html\[data-app-theme\] :is\(\.quick-edit-cell-button:hover, \.quick-edit-cell-button:focus-visible, \.object-title-open:hover, \.object-title-open:focus-visible, \.object-title-edit-button:hover, \.object-title-edit-button:focus-visible\)/);
});

test('quick edit columns are distributed for the wider object panel', () => {
  assert.match(stylesSource, /\.object-quick-column--title\s*\{[\s\S]*width:\s*11%;/);
  assert.match(stylesSource, /\.object-quick-column--developer\s*\{[\s\S]*width:\s*9%;/);
  assert.match(stylesSource, /\.object-quick-column--metro\s*\{[\s\S]*width:\s*12%;/);
  assert.match(stylesSource, /\.object-quick-column--coordinates\s*\{[\s\S]*width:\s*8%;/);
  assert.match(stylesSource, /\.object-quick-column--krtName\s*\{[\s\S]*width:\s*5%;/);
  assert.match(stylesSource, /\.object-quick-column--mapName\s*\{[\s\S]*width:\s*6%;/);
});

test('quick edit compact CSS keeps headers and tags small enough for dense table', () => {
  assert.match(stylesSource, /\.admin-table\.compact-table \[data-slot="table-head"\]\s*\{[\s\S]*font-size:\s*10px;[\s\S]*font-weight:\s*800;[\s\S]*white-space:\s*normal;/);
  assert.match(stylesSource, /\.compact-table \.table-sort-button\s*\{[\s\S]*font-size:\s*10px;[\s\S]*font-weight:\s*800;[\s\S]*white-space:\s*normal;/);
  assert.match(stylesSource, /\.compact-table \.table-sort-button svg\s*\{[\s\S]*width:\s*11px;[\s\S]*height:\s*11px;/);
  assert.match(stylesSource, /\.compact-table \.status-pill\s*\{[\s\S]*min-height:\s*22px;[\s\S]*padding:\s*2px 7px;[\s\S]*font-size:\s*10px;/);
  assert.doesNotMatch(stylesSource, /\.object-title-cell code/);
});

test('quick edit table uses dash for empty display values', () => {
  assert.match(tableSource, /displayValue \?\? '—'/);
  assert.doesNotMatch(tableSource, /Не указано/);
});

test('quick edit table keeps editor open and renders inline error when commit fails', () => {
  assert.match(tableSource, /onInlineEditCommit\?: \(params: \{[\s\S]*\}\) => void \| Promise<void>;/);
  assert.match(tableSource, /const \[editingError,\s*setEditingError\] = useState<string \| null>\(null\);/);
  assert.match(tableSource, /async function commitInlineEdit/);
  assert.match(tableSource, /await onInlineEditCommit\?\.\(\{ objectId, columnKey, value \}\);/);
  assert.match(tableSource, /closeEditor\(\);/);
  assert.match(tableSource, /catch \(caughtError\)/);
  assert.match(tableSource, /setEditingError\(caughtError instanceof Error \? caughtError\.message : 'Не удалось сохранить ячейку'\);/);
  assert.match(tableSource, /<p className="quick-edit-error" role="alert">/);
  assert.match(tableSource, /editingError:\s*editingCell\?\.objectId === item\.id && editingCell\.columnKey === column\.key \? editingError : null/);
});

test('objects admin page keeps AdminAlert and rethrows inline edit errors for the table', () => {
  assert.match(pageSource, /const inlineEditErrorMessage = caughtError instanceof Error \? caughtError\.message : 'Не удалось сохранить ячейку';/);
  assert.match(pageSource, /setError\(inlineEditErrorMessage\);/);
  assert.match(pageSource, /throw new Error\(inlineEditErrorMessage\);/);
  assert.match(pageSource, /onInlineEditCommit=\{handleInlineEditCommit\}/);
});
