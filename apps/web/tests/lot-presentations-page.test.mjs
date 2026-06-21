import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(resolve(currentDir, '../src/App.tsx'), 'utf8');
const objectDetailSource = readFileSync(resolve(currentDir, '../src/objects/ObjectDetailPage.tsx'), 'utf8');
const pageSource = readFileSync(resolve(currentDir, '../src/presentations/LotPresentationsPage.tsx'), 'utf8');
const actionSource = readFileSync(resolve(currentDir, '../src/presentations/LotCollectionAction.tsx'), 'utf8');
const styles = readFileSync(resolve(currentDir, '../src/styles.css'), 'utf8');

test('lot presentations route is available from sidebar and cabinet navigation', () => {
  assert.match(appSource, /import \{ LotPresentationsPage \} from '\.\/presentations\/LotPresentationsPage';/);
  assert.match(appSource, /type AppSection = 'cabinet' \| 'catalog' \| 'presentations' \| 'admin';/);
  assert.match(appSource, /id:\s*'presentations'[\s\S]*label:\s*'Подборки'[\s\S]*path:\s*'\/presentations'[\s\S]*requiredPermissions:\s*\[\]/);
  assert.match(appSource, /id:\s*'presentations'[\s\S]*label:\s*'Подборки лотов'[\s\S]*group:\s*'Презентации'[\s\S]*path:\s*'\/presentations'[\s\S]*requiredPermissions:\s*\[\]/);
  assert.match(appSource, /pathname\.startsWith\('\/presentations'\)[\s\S]*\? 'presentations'/);
  assert.match(appSource, /pathname\.startsWith\('\/presentations\/'\)/);
  assert.match(appSource, /<LotPresentationsPage navigate=\{navigate\} \/>/);
});

test('cabinet profile stores broker contacts used by PDFs', () => {
  assert.match(appSource, /const \[brokerPhone,\s*setBrokerPhone\] = useState\(''\);/);
  assert.match(appSource, /const \[brokerEmail,\s*setBrokerEmail\] = useState\(''\);/);
  assert.match(appSource, /body: JSON\.stringify\(\{[\s\S]*name: profileName,[\s\S]*brokerPhone,[\s\S]*brokerEmail,[\s\S]*\}\)/);
  assert.match(appSource, /name="brokerPhone"[\s\S]*value=\{brokerPhone\}/);
  assert.match(appSource, /name="brokerEmail"[\s\S]*value=\{brokerEmail\}/);
  assert.match(appSource, /<dt>Телефон брокера<\/dt>[\s\S]*<dd>\{user\.brokerPhone \?\? 'Не заполнен'\}<\/dd>/);
  assert.match(appSource, /<dt>Почта брокера<\/dt>[\s\S]*<dd>\{user\.brokerEmail \?\? 'Не заполнена'\}<\/dd>/);
});

test('lot pages and feed rows expose add to collection actions', () => {
  assert.match(objectDetailSource, /import \{ LotCollectionAction \} from '\.\.\/presentations\/LotCollectionAction';/);
  assert.match(objectDetailSource, /export function ObjectLotDetailPage\(\{ navigate, slug, unitId, onBack \}: ObjectLotDetailPageProps\)/);
  assert.match(objectDetailSource, /className="object-lot-header-actions"[\s\S]*<LotCollectionAction[\s\S]*loadStateOnMount[\s\S]*navigate=\{navigate\}[\s\S]*unitId=\{unit\.id\}/);
  assert.match(objectDetailSource, /const feedUnitsTableColumnCount = 11;/);
  assert.match(objectDetailSource, /<TableHead aria-label="Подборка" \/>/);
  assert.match(objectDetailSource, /<LotCollectionAction mode="icon" navigate=\{navigate\} unitId=\{unit\.id\} \/>/);
  assert.match(styles, /\.object-lot-header-actions\s*\{/);
  assert.match(styles, /\.lot-collection-icon-button\s*\{/);
});

test('lot collection action creates named collections and turns into a collection link after adding', () => {
  assert.match(actionSource, /\/lot-presentations\/collections\?unitId=\$\{encodeURIComponent\(unitId\)\}/);
  assert.match(actionSource, /\/lot-presentations\/collections\/\$\{encodeURIComponent\(collectionId\)\}\/items/);
  assert.match(actionSource, /body: JSON\.stringify\(\{ unitId \}\)/);
  assert.match(actionSource, /const name = newCollectionName\.trim\(\) \|\| 'Новая подборка';/);
  assert.match(actionSource, /body: JSON\.stringify\(\{ name \}\)/);
  assert.match(actionSource, /navigate\(`\/presentations\?collectionId=\$\{encodeURIComponent\(addedCollectionId\)\}`\)/);
  assert.match(actionSource, /aria-label=\{isAdded \? 'Перейти в подборку' : 'Добавить в подборку'\}/);
  assert.match(actionSource, /isAdded \? \([\s\S]*'Перейти в подборку'[\s\S]*\) : \([\s\S]*'Добавить в подборку'[\s\S]*\)/);
});

test('lot collection modal uses app theme colors instead of a light fallback', () => {
  const modalRule = styles.match(/\.lot-collection-modal\s*\{[^}]*\}/)?.[0] ?? '';
  const closeRule = styles.match(/\.lot-collection-modal-close\s*\{[^}]*\}/)?.[0] ?? '';
  const inputRule = styles.match(/\.lot-collection-create-form input\s*\{[^}]*\}/)?.[0] ?? '';

  assert.match(modalRule, /background:\s*var\(--app-theme-surface, #ffffff\);/);
  assert.match(modalRule, /color:\s*var\(--app-theme-ink-900, #18202a\);/);
  assert.doesNotMatch(modalRule, /--app-theme-panel/);
  assert.match(closeRule, /background:\s*var\(--app-theme-control, #ffffff\);/);
  assert.match(closeRule, /color:\s*var\(--app-theme-ink-800, #303b47\);/);
  assert.match(inputRule, /background:\s*var\(--app-theme-control, #ffffff\);/);
  assert.match(inputRule, /color:\s*var\(--app-theme-ink-900, #18202a\);/);
});

test('lot presentations page manages selections, downloads and validation warnings', () => {
  assert.match(pageSource, /apiRequest<LotPresentationCollectionsResponse>\('\/lot-presentations\/collections'/);
  assert.match(pageSource, /apiRequest<LotPresentationLotsResponse>\(`\/lot-presentations\/lots\?\$\{params\.toString\(\)\}`/);
  assert.match(pageSource, /apiRequest<LotPresentationDocumentsResponse>\('\/lot-presentations\/documents\?limit=12'/);
  assert.match(pageSource, /apiRequest<LotPresentationDocumentResponse>\('\/lot-presentations\/documents'/);
  assert.match(pageSource, /collectionId: selectedCollection\.id/);
  assert.match(pageSource, /unitIds: checkedLots\.map\(\(lot\) => lot\.id\)/);
  assert.match(pageSource, /unitIds: \[item\.unitId\]/);
  assert.match(pageSource, /if \(!user\?\.brokerPhone \|\| !user\.brokerEmail\)/);
  assert.match(pageSource, /Заполните телефон и почту брокера в профиле/);
  assert.match(pageSource, /Планировка отсутствует в лоте/);
  assert.match(pageSource, /downloadDocument\(data\.document, accessToken\)/);
  assert.match(styles, /\.lot-presentations-layout\s*\{/);
  assert.match(styles, /\.lot-presentations-lot-row\s*\{/);
});

test('lot presentations page uses the approved two-column layout', () => {
  assert.doesNotMatch(pageSource, /Контакты брокера/);
  assert.match(pageSource, /setIsDocumentsPanelOpen\(true\)[\s\S]*Созданные PDF/);
  assert.match(pageSource, /className="lot-presentations-create-inline"[\s\S]*aria-label="Создать подборку"[\s\S]*<PlusIcon aria-hidden="true" \/>/);
  assert.match(pageSource, /import \{[\s\S]*CheckIcon,[\s\S]*\} from 'lucide-react';/);
  assert.match(pageSource, /className="icon-action-button"[\s\S]*aria-label="Сохранить название подборки"[\s\S]*type="submit"[\s\S]*<CheckIcon aria-hidden="true" \/>/);
  assert.doesNotMatch(pageSource, /<button className="secondary-button secondary-button--fit" disabled=\{isSubmitting\} type="submit">\s*OK\s*<\/button>/);
  assert.match(pageSource, /className="content-panel lot-presentations-sidebar"[\s\S]*className="content-panel lot-presentations-main"/);
  assert.doesNotMatch(pageSource, /content-panel lot-presentations-aside/);
  assert.match(pageSource, /const shouldShowProjectSearchResults = projectSearch\.trim\(\)\.length > 0;/);
  assert.match(pageSource, /className="lot-presentations-search-popover"/);
  assert.match(pageSource, /className="secondary-button secondary-button--fit lot-presentations-documents-trigger"/);
  assert.match(styles, /\.lot-presentations-layout\s*\{[\s\S]*?grid-template-columns:\s*minmax\(220px, 300px\) minmax\(0, 1fr\);/);
  assert.match(styles, /\.lot-presentations-documents-trigger\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?min-height:\s*44px;[\s\S]*?white-space:\s*nowrap;/);
  assert.match(styles, /\.lot-presentations-workbar\s*\{[\s\S]*?grid-template-columns:\s*minmax\(480px, 1fr\) max-content;/);
  assert.match(styles, /\.lot-presentations-actions\s*\{[\s\S]*?flex-wrap:\s*nowrap;[\s\S]*?align-items:\s*stretch;/);
  assert.match(styles, /\.lot-presentations-actions \.primary-button,\s*\.lot-presentations-actions \.secondary-button\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?min-height:\s*44px;/);
  assert.match(styles, /\.lot-presentations-search-popover\s*\{/);
  assert.match(styles, /\.lot-presentations-documents-backdrop\s*\{/);
});

test('lot presentations creates collections through the compact modal', () => {
  assert.match(pageSource, /type FormEvent,[\s\S]*useEffect/);
  assert.match(pageSource, /const \[isCreateCollectionModalOpen,\s*setIsCreateCollectionModalOpen\] = useState\(false\);/);
  assert.match(pageSource, /const \[newCollectionName,\s*setNewCollectionName\] = useState\(''\);/);
  assert.match(pageSource, /const \[createCollectionError,\s*setCreateCollectionError\] = useState<string \| null>\(null\);/);
  assert.match(pageSource, /function openCreateCollectionModal\(\)[\s\S]*setNewCollectionName\(''\);[\s\S]*setIsCreateCollectionModalOpen\(true\);/);
  assert.match(pageSource, /async function handleCreateCollection\(event: FormEvent<HTMLFormElement>\)/);
  assert.match(pageSource, /const name = newCollectionName\.trim\(\);/);
  assert.match(pageSource, /if \(!name\) \{[\s\S]*setCreateCollectionError\('Введите название подборки'\);/);
  assert.match(pageSource, /body: JSON\.stringify\(\{ name \}\)/);
  assert.match(pageSource, /setIsCreateCollectionModalOpen\(false\);/);
  assert.match(pageSource, /aria-labelledby="lot-presentations-create-modal-title"[\s\S]*aria-modal="true"[\s\S]*className="lot-presentations-create-modal"[\s\S]*role="dialog"/);
  assert.match(pageSource, /id="lot-presentations-create-modal-title"[\s\S]*Новая подборка/);
  assert.match(pageSource, /Название подборки[\s\S]*value=\{newCollectionName\}[\s\S]*onChange=\{\(event\) => setNewCollectionName\(event\.currentTarget\.value\)\}/);
  assert.match(pageSource, /createCollectionError \? <p className="form-error lot-presentations-create-modal-error">\{createCollectionError\}<\/p> : null/);
  assert.match(pageSource, /className="lot-presentations-create-modal-actions"[\s\S]*Отмена[\s\S]*<CheckIcon aria-hidden="true" \/>[\s\S]*Создать/);
  assert.doesNotMatch(pageSource, /onClick=\{\(\) => void handleCreateCollection\(\)\}/);
  assert.doesNotMatch(pageSource, /function getNewCollectionName/);
  assert.match(styles, /\.lot-presentations-create-modal-backdrop\s*\{/);
  assert.match(styles, /\.lot-presentations-create-modal\s*\{[\s\S]*?width:\s*min\(380px, calc\(100vw - 40px\)\);/);
  assert.match(styles, /\.lot-presentations-create-modal-actions\s*\{[\s\S]*?justify-content:\s*flex-end;/);
  assert.match(styles, /\.lot-presentations-create-modal-button\s*\{[\s\S]*?min-height:\s*38px;/);
});

test('lot presentations search opens a project lots modal instead of adding individual search lots', () => {
  assert.match(pageSource, /const \[projectSearch,\s*setProjectSearch\] = useState\(''\);/);
  assert.match(pageSource, /const \[projectResults,\s*setProjectResults\] = useState<LotPresentationProjectResult\[\]>\(\[\]\);/);
  assert.match(pageSource, /const \[selectedProject,\s*setSelectedProject\] = useState<LotPresentationProjectResult \| null>\(null\);/);
  assert.match(pageSource, /apiRequest<LotPresentationLotsResponse>\(`\/lot-presentations\/lots\?\$\{params\.toString\(\)\}`/);
  assert.match(pageSource, /params\.set\('objectId', project\.id\);/);
  assert.match(pageSource, /placeholder="Найти ЖК и открыть лоты"/);
  assert.match(pageSource, /className="lot-presentations-search-project"/);
  assert.doesNotMatch(pageSource, /className="lot-presentations-search-lot"/);
  assert.doesNotMatch(pageSource, /alreadyInSelected \? 'Лот уже в подборке' : 'Добавить лот'/);
  assert.match(pageSource, /aria-labelledby="lot-presentations-project-modal-title"[\s\S]*aria-modal="true"[\s\S]*className="lot-presentations-project-modal"[\s\S]*role="dialog"/);
  assert.match(pageSource, /id="lot-presentations-project-modal-title">Лоты ЖК/);
  assert.match(pageSource, /className="lot-presentations-project-modal-close"[\s\S]*aria-label="Закрыть лоты ЖК"/);
  assert.match(pageSource, /className="object-feed-groups lot-presentations-project-groups"/);
  assert.match(pageSource, /className="object-feed-completion-group lot-presentations-project-completion-group"/);
  assert.match(pageSource, /className="object-feed-room-group lot-presentations-project-room-group"/);
  assert.match(pageSource, /icon-action-button lot-presentations-project-add-button/);
  assert.match(styles, /\.lot-presentations-project-modal-backdrop\s*\{/);
  assert.match(styles, /\.lot-presentations-project-modal\s*\{/);
  assert.match(styles, /\.lot-presentations-search-project\s*\{/);
  assert.match(styles, /\.lot-presentations-project-groups\s*\{/);
});
