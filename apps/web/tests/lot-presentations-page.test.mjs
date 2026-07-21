import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(resolve(currentDir, '../src/App.tsx'), 'utf8');
const objectDetailSource = readFileSync(resolve(currentDir, '../src/objects/ObjectDetailPage.tsx'), 'utf8');
const accessSource = readFileSync(resolve(currentDir, '../src/presentations/presentationAccess.ts'), 'utf8');
const pageSource = readFileSync(resolve(currentDir, '../src/presentations/LotPresentationsPage.tsx'), 'utf8');
const actionSource = readFileSync(resolve(currentDir, '../src/presentations/LotCollectionAction.tsx'), 'utf8');
const finishModalSource = readFileSync(resolve(currentDir, '../src/presentations/LotFinishSelectionModal.tsx'), 'utf8');
const dialogSource = readFileSync(resolve(currentDir, '../src/components/ui/dialog.tsx'), 'utf8');
const radioGroupSource = readFileSync(resolve(currentDir, '../src/components/ui/radio-group.tsx'), 'utf8');
const styles = readFileSync(resolve(currentDir, '../src/styles.css'), 'utf8');

test('lot presentations route is available from sidebar and cabinet navigation', () => {
  assert.match(appSource, /import \{ LotPresentationsPage \} from '\.\/presentations\/LotPresentationsPage';/);
  assert.match(appSource, /import \{ MAIN_LOT_PRESENTATIONS_ADMIN_EMAIL, canAccessLotPresentations \} from '\.\/presentations\/presentationAccess';/);
  assert.match(appSource, /type AppSection = 'cabinet' \| 'catalog' \| 'presentations' \| 'admin';/);
  assert.match(accessSource, /export const MAIN_LOT_PRESENTATIONS_ADMIN_EMAIL = 'admin@fluffywhite\.moscow';/);
  assert.match(accessSource, /const localHostnames = new Set\(\['localhost', '127\.0\.0\.1', '::1', '\[::1\]'\]\);/);
  assert.match(accessSource, /export function canAccessLotPresentations\([\s\S]*hostname = window\.location\.hostname/);
  assert.match(accessSource, /if \(!user\) \{[\s\S]*return false;/);
  assert.match(accessSource, /import\.meta\.env\.DEV \|\|[\s\S]*localHostnames\.has\(hostname\.trim\(\)\.toLowerCase\(\)\)[\s\S]*user\.email\.trim\(\)\.toLowerCase\(\) === MAIN_LOT_PRESENTATIONS_ADMIN_EMAIL/);
  assert.match(appSource, /id:\s*'presentations'[\s\S]*label:\s*'Подборки'[\s\S]*path:\s*'\/presentations'[\s\S]*requiredPermissions:\s*\[\][\s\S]*requiredUserEmail:\s*MAIN_LOT_PRESENTATIONS_ADMIN_EMAIL/);
  assert.match(appSource, /id:\s*'presentations'[\s\S]*label:\s*'Подборки лотов'[\s\S]*group:\s*'Презентации'[\s\S]*path:\s*'\/presentations'[\s\S]*requiredPermissions:\s*\[\][\s\S]*requiredUserEmail:\s*MAIN_LOT_PRESENTATIONS_ADMIN_EMAIL/);
  assert.match(appSource, /pathname\.startsWith\('\/presentations'\)[\s\S]*\? 'presentations'/);
  assert.match(appSource, /pathname\.startsWith\('\/presentations\/'\)/);
  assert.match(appSource, /activeSection === 'presentations' \? \([\s\S]*canAccessLotPresentations\(user\) \? \([\s\S]*<LotPresentationsPage navigate=\{navigate\} \/>[\s\S]*\) : \([\s\S]*<AccessDenied \/>/);
  assert.match(appSource, /navItems\.filter\(\(item\) => canAccessNavigationItem\(user, hasPermission, item\)\)/);
  assert.match(appSource, /return cabinetSections\.filter\(\(section\) => canAccessCabinetSection\(user, section\)\);/);
  assert.match(appSource, /requiredUserEmail === MAIN_LOT_PRESENTATIONS_ADMIN_EMAIL[\s\S]*return canAccessLotPresentations\(user\);/);
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

test('lot pages and feed rows expose add to workspace actions', () => {
  assert.match(objectDetailSource, /import \{ LotCollectionAction \} from '\.\.\/presentations\/LotCollectionAction';/);
  assert.match(objectDetailSource, /export function ObjectLotDetailPage\(\{ navigate, slug, unitId, onBack \}: ObjectLotDetailPageProps\)/);
  assert.match(objectDetailSource, /className="object-lot-header-actions"[\s\S]*<LotCollectionAction[\s\S]*loadStateOnMount[\s\S]*navigate=\{navigate\}[\s\S]*unitId=\{unit\.id\}/);
  assert.match(objectDetailSource, /const feedUnitsTableColumnCount = 11;/);
  assert.match(objectDetailSource, /<TableHead aria-label="В работе" \/>/);
  assert.match(objectDetailSource, /<LotCollectionAction mode="icon" navigate=\{navigate\} unitId=\{unit\.id\} \/>/);
  assert.match(styles, /\.object-lot-header-actions\s*\{/);
  assert.match(styles, /\.lot-collection-icon-button\s*\{/);
});

test('lot workspace action adds lots directly to the saved workspace', () => {
  assert.match(actionSource, /export function LotCollectionAction/);
  assert.match(actionSource, /import \{ canAccessLotPresentations \} from '\.\/presentationAccess';/);
  assert.match(actionSource, /const \{ accessToken, user \} = useAuth\(\);/);
  assert.match(actionSource, /if \(!canAccessLotPresentations\(user\)\) \{[\s\S]*return null;[\s\S]*\}/);
  assert.match(actionSource, /\/lot-presentations\/workspace\/items/);
  assert.match(actionSource, /body: JSON\.stringify\(\{ unitId \}\)/);
  assert.match(actionSource, /navigate\('\/presentations'\)/);
  assert.match(actionSource, /aria-label=\{isAdded \? 'Перейти в работу' : 'Добавить в работу'\}/);
  assert.match(actionSource, /isAdded \? \([\s\S]*'В работе'[\s\S]*\) : \([\s\S]*'Добавить в работу'[\s\S]*\)/);
  assert.doesNotMatch(actionSource, /\/lot-presentations\/collections\?unitId=/);
  assert.doesNotMatch(actionSource, /lot-collection-modal/);
  assert.doesNotMatch(actionSource, /Создать и добавить/);
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

test('lot presentations page manages workspace, downloads and validation warnings', () => {
  assert.match(pageSource, /apiRequest<LotPresentationWorkspaceResponse>\('\/lot-presentations\/workspace'/);
  assert.match(pageSource, /apiRequest<LotPresentationCollectionsResponse>\('\/lot-presentations\/collections'/);
  assert.match(pageSource, /apiRequest<LotPresentationLotsResponse>\(`\/lot-presentations\/lots\?\$\{params\.toString\(\)\}`/);
  assert.match(pageSource, /apiRequest<LotPresentationDocumentsResponse>\('\/lot-presentations\/documents\?limit=12'/);
  assert.match(pageSource, /apiRequest<LotPresentationDocumentResponse>\('\/lot-presentations\/documents'/);
  assert.match(pageSource, /title: 'В работе'/);
  assert.match(pageSource, /unitIds: workspaceItems\.map\(\(item\) => item\.unitId\)/);
  assert.match(pageSource, /unitIds: \[item\.unitId\]/);
  assert.match(pageSource, /if \(!user\?\.brokerPhone \|\| !user\.brokerEmail\)/);
  assert.match(pageSource, /Заполните телефон и почту брокера в профиле/);
  assert.match(pageSource, /Планировка отсутствует в лоте/);
  assert.match(pageSource, /downloadDocument\(data\.document, accessToken\)/);
  assert.match(styles, /\.lot-presentations-grid\s*\{/);
  assert.match(styles, /\.lot-presentations-lot-tile\s*\{/);
});

test('PDF creation requests a separate finish for every residential lot', () => {
  const requestDocumentBody = pageSource.match(
    /function requestDocumentCreation\([\s\S]*?\n  function closeFinishSelectionModal/,
  )?.[0] ?? '';

  assert.match(pageSource, /import \{ LotFinishSelectionModal \} from '\.\/LotFinishSelectionModal';/);
  assert.match(requestDocumentBody, /ensureCanDownload\(user, lotsForCheck, setError\)/);
  assert.match(requestDocumentBody, /lotsForCheck\.filter\(\(lot\) => lot\.type === 'RESIDENTIAL'\)/);
  assert.match(requestDocumentBody, /setPendingFinishSelection\([\s\S]*lots: residentialLots/);
  assert.match(requestDocumentBody, /createAndDownloadDocument\(\{ \.\.\.input, unitFinishes: \[\] \}\)/);
  assert.match(pageSource, /unitIds: workspaceItems\.map\(\(item\) => item\.unitId\)/);
  assert.match(pageSource, /unitIds: \[item\.unitId\]/);
  assert.match(pageSource, /collectionId: selectedCollection\.id,[\s\S]*unitIds: selectedCollection\.items\.map\(\(item\) => item\.unitId\)/);
  assert.match(pageSource, /<LotFinishSelectionModal[\s\S]*pendingFinishSelection\.lots\.map[\s\S]*onSubmit=\{\(unitFinishes\)/);
  assert.match(pageSource, /\.\.\.pendingFinishSelection\.input,[\s\S]*unitFinishes/);
  assert.match(pageSource, /documents\.map[\s\S]*downloadDocument\(document, accessToken\)/);
});

test('finish modal is required, accessible and responsive without image previews', () => {
  assert.match(finishModalSource, /LOT_PRESENTATION_FINISH_TYPES/);
  assert.match(finishModalSource, /LOT_PRESENTATION_FINISH_LABELS/);
  assert.match(finishModalSource, /useState<Record<string, LotPresentationFinishType>>\(\{\}\)/);
  assert.match(finishModalSource, /<Dialog[\s\S]*open[\s\S]*onOpenChange=/);
  assert.match(finishModalSource, /<DialogContent[\s\S]*overlayClassName="lot-finish-modal-backdrop"[\s\S]*showCloseButton=\{false\}/);
  assert.match(finishModalSource, /<FieldSet className="lot-finish-modal-lot"/);
  assert.match(finishModalSource, /<FieldLegend className="lot-finish-modal-lot-heading" variant="label">/);
  assert.match(finishModalSource, /<RadioGroup[\s\S]*value=\{selectedFinishes\[lot\.id\]\}[\s\S]*onValueChange=/);
  assert.match(finishModalSource, /<RadioGroupItem[\s\S]*value=\{finishType\}/);
  assert.match(finishModalSource, /<FieldTitle className="lot-finish-modal-option-title">/);
  assert.match(finishModalSource, /Укажите отделку в лоте/);
  assert.match(finishModalSource, /\{selectedCount\} из \{lots\.length\}/);
  assert.match(finishModalSource, /disabled=\{!isComplete \|\| isLoading\}/);
  assert.match(finishModalSource, /onEscapeKeyDown=\{\(event\) => \{[\s\S]*isLoading[\s\S]*event\.preventDefault\(\)/);
  assert.match(finishModalSource, /onPointerDownOutside=\{\(event\) => \{[\s\S]*isLoading[\s\S]*event\.preventDefault\(\)/);
  assert.match(finishModalSource, /onOpenAutoFocus=\{\(event\) => \{[\s\S]*firstOptionRef\.current\?\.focus\(\)/);
  assert.match(finishModalSource, /aria-live="polite"/);
  assert.match(finishModalSource, /aria-busy=\{isLoading\}/);
  assert.match(dialogSource, /DialogPrimitive\.Root/);
  assert.match(dialogSource, /DialogPrimitive\.Content/);
  assert.match(dialogSource, /DialogPrimitive\.Overlay/);
  assert.match(radioGroupSource, /RadioGroupPrimitive\.Root/);
  assert.match(radioGroupSource, /RadioGroupPrimitive\.Item/);
  assert.match(radioGroupSource, /RadioGroupPrimitive\.Indicator/);
  assert.doesNotMatch(finishModalSource, /Применить ко всем/);
  assert.doesNotMatch(finishModalSource, /<img|SecureImage/);
  assert.doesNotMatch(finishModalSource, /focusableElementSelector|document\.body\.style\.overflow|type="radio"/);
  assert.match(styles, /\.lot-finish-modal\s*\{[\s\S]*?width:\s*min\(920px, calc\(100vw - 40px\)\);[\s\S]*?overflow:\s*hidden;/);
  assert.match(styles, /\.lot-finish-modal-list\s*\{[\s\S]*?overflow-y:\s*auto;/);
  assert.match(styles, /\.lot-finish-modal-lot:not\(:last-child\)\s*\{[\s\S]*?border-bottom:/);
  assert.match(styles, /\.lot-finish-modal-option\s*\{[\s\S]*?min-height:\s*66px;/);
  assert.match(styles, /\.lot-finish-modal-option:has\(\[data-slot='radio-group-item'\]\[data-state='checked'\]\)\s*\{[\s\S]*?background:\s*var\(--app-theme-primary-soft/);
  assert.match(styles, /\.lot-finish-modal-option \[data-slot='radio-group-item'\]\s*\{[\s\S]*?width:\s*20px;[\s\S]*?height:\s*20px;/);
  assert.match(styles, /\.lot-finish-modal-option \[data-slot='radio-group-item'\]\[data-state='checked'\]\s*\{[\s\S]*?background:\s*var\(--app-theme-primary/);
  assert.match(styles, /\.lot-finish-modal-option-title\s*\{[\s\S]*?font-size:\s*13px;[\s\S]*?font-weight:\s*750;/);
  assert.doesNotMatch(styles, /\.lot-finish-modal-option input\[type='radio'\]/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.lot-finish-modal,[\s\S]*?\.lot-finish-modal-backdrop[\s\S]*?animation:\s*none;/);
  assert.match(styles, /@media \(max-width: 560px\)[\s\S]*?\.lot-finish-modal\s*\{[\s\S]*?width:\s*calc\(100vw - 24px\);/);
});

test('lot presentations page has workspace and collection tabs with compact lot tiles', () => {
  const initialTabEffect = pageSource.match(
    /useEffect\(\(\) => \{[\s\S]*?window\.addEventListener\('popstate', handlePopState\);[\s\S]*?\}, \[\]\);/,
  )?.[0] ?? '';
  const workspaceToolbarRule = styles.match(/\.lot-presentations-workspace-toolbar\s*\{[^}]*\}/)?.[0] ?? '';
  const workspaceToolbarButtonRule =
    styles.match(/\.lot-presentations-workspace-toolbar \.primary-button,\s*\.lot-presentations-workspace-toolbar \.secondary-button\s*\{[^}]*\}/)?.[0] ?? '';

  assert.doesNotMatch(pageSource, /Контакты брокера/);
  assert.match(pageSource, /setIsDocumentsPanelOpen\(true\)[\s\S]*Созданные PDF/);
  assert.match(pageSource, /Building2Icon/);
  assert.match(pageSource, /navigate\('\/presentations\/projects'\)[\s\S]*Презентации ЖК/);
  assert.match(pageSource, /const \[activeTab,\s*setActiveTab\] = useState<'workspace' \| 'collections'>\('workspace'\);/);
  assert.doesNotMatch(initialTabEffect, /if \(selectedCollectionId\)/);
  assert.match(pageSource, /В работе/);
  assert.match(pageSource, /Мои подборки/);
  assert.match(pageSource, /role="tablist"/);
  assert.match(pageSource, /className="lot-presentations-grid"/);
  assert.match(pageSource, /function LotPresentationLotTile/);
  assert.match(pageSource, /onDownloadOne/);
  assert.match(pageSource, /onOpenCollectionPicker/);
  assert.match(pageSource, /onOpenComment/);
  assert.match(pageSource, /onRemove/);
  assert.match(pageSource, /className="lot-presentations-create-inline"[\s\S]*aria-label="Создать подборку"[\s\S]*<PlusIcon aria-hidden="true" \/>/);
  assert.match(pageSource, /import \{[\s\S]*CheckIcon,[\s\S]*\} from 'lucide-react';/);
  assert.match(pageSource, /className="icon-action-button"[\s\S]*aria-label="Сохранить название подборки"[\s\S]*type="submit"[\s\S]*<CheckIcon aria-hidden="true" \/>/);
  assert.doesNotMatch(pageSource, /<button className="secondary-button secondary-button--fit" disabled=\{isSubmitting\} type="submit">\s*OK\s*<\/button>/);
  assert.match(pageSource, /className="content-panel lot-presentations-main"[\s\S]*className="content-panel lot-presentations-sidebar"/);
  assert.doesNotMatch(pageSource, /content-panel lot-presentations-aside/);
  assert.match(pageSource, /const shouldShowProjectSearchResults = projectSearch\.trim\(\)\.length > 0;/);
  assert.match(pageSource, /className="lot-presentations-search-popover"/);
  assert.match(pageSource, /className="secondary-button secondary-button--fit lot-presentations-header-trigger lot-presentations-documents-trigger"/);
  assert.match(pageSource, /className="primary-button primary-button--fit lot-presentations-header-trigger lot-presentations-projects-trigger"/);
  assert.match(styles, /\.lot-presentations-header-actions\s*\{[\s\S]*?display:\s*grid;[\s\S]*?width:\s*min\(280px, 100%\);/);
  assert.match(styles, /\.lot-presentations-tabs\s*\{/);
  assert.match(workspaceToolbarRule, /justify-self:\s*end;/);
  assert.match(workspaceToolbarRule, /align-items:\s*center;/);
  assert.match(workspaceToolbarButtonRule, /width:\s*auto;/);
  assert.match(workspaceToolbarButtonRule, /flex:\s*0 0 auto;/);
  assert.match(styles, /\.lot-presentations-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(5, minmax\(0, 1fr\)\);/);
  assert.match(styles, /\.lot-presentations-comment-modal\s*\{/);
  assert.match(styles, /\.lot-presentations-header-trigger\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?min-height:\s*44px;[\s\S]*?white-space:\s*nowrap;/);
  assert.match(styles, /\.lot-presentations-actions\s*\{[\s\S]*?flex-wrap:\s*nowrap;[\s\S]*?align-items:\s*stretch;/);
  assert.match(styles, /\.lot-presentations-actions \.primary-button,\s*\.lot-presentations-actions \.secondary-button\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?min-height:\s*44px;/);
  assert.match(styles, /\.lot-presentations-search-popover\s*\{/);
  assert.match(styles, /\.lot-presentations-documents-backdrop\s*\{/);
});

test('workspace actions download all, clear workspace and keep collections separate', () => {
  assert.match(pageSource, /function getWorkspaceLots\(/);
  assert.match(pageSource, /DELETE'[\s\S]*\/lot-presentations\/workspace\/items/);
  assert.match(pageSource, /Очистить всё/);
  assert.match(pageSource, /Скачать все/);
  assert.match(pageSource, /disabled=\{!hasBrokerContacts \|\| workspaceItems\.length === 0 \|\| isSubmitting\}/);
});

test('workspace collection picker updates locally after adding a lot', () => {
  const addLotToCollectionBody = pageSource.match(
    /async function addLotToCollection\(collectionId: string, unitId: string\)[\s\S]*?\n  async function createCollectionAndAddPickerLot/,
  )?.[0] ?? '';
  const createFormSource = pageSource.match(
    /className="lot-collection-create-form"[\s\S]*?<\/form>/,
  )?.[0] ?? '';
  const createFormRule = styles.match(/\.lot-collection-create-form\s*\{[^}]*\}/)?.[0] ?? '';
  const createActionsRule = styles.match(/\.lot-collection-create-actions\s*\{[^}]*\}/)?.[0] ?? '';

  assert.match(addLotToCollectionBody, /const data = await apiRequest<LotPresentationCollectionResponse>/);
  assert.match(addLotToCollectionBody, /upsertCollection\(data\.collection\);/);
  assert.match(addLotToCollectionBody, /markLotAddedToCollection\(unitId, collectionId\);/);
  assert.doesNotMatch(addLotToCollectionBody, /await loadCollections\(\);/);
  assert.doesNotMatch(addLotToCollectionBody, /await loadWorkspace\(\);/);
  assert.match(pageSource, /function sortCollectionsByLatestChange/);
  assert.match(pageSource, /\[\.\.\.nextCollections\]\.sort\(sortCollectionsByLatestChange\)/);
  assert.match(createFormSource, /Новая подборка/);
  assert.match(createFormSource, /ОК/);
  assert.match(createFormSource, /Отмена/);
  assert.doesNotMatch(createFormSource, /Создать и добавить/);
  assert.match(createFormRule, /display:\s*grid;/);
  assert.match(createActionsRule, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/);
});

test('workspace lot add-to-collection button shows delayed collection names tooltip', () => {
  const tileSource = pageSource.match(/function LotPresentationLotTile[\s\S]*?function LotThumb/)?.[0] ?? '';
  const tooltipRule = styles.match(/\.lot-presentations-collection-tooltip\s*\{[^}]*\}/)?.[0] ?? '';
  const tooltipHoverRule =
    styles.match(
      /\.lot-presentations-collection-action:hover \.lot-presentations-collection-tooltip,\s*\.lot-presentations-collection-action:focus-within \.lot-presentations-collection-tooltip\s*\{[^}]*\}/,
    )?.[0] ?? '';

  assert.match(pageSource, /const collectionNameById = useMemo/);
  assert.match(pageSource, /collectionNames=\{getLotCollectionNames\(item\.unit\.collectionIds, collectionNameById\)\}/);
  assert.doesNotMatch(pageSource, /collectionNames=\{collectionTooltipNames\}/);
  assert.match(tileSource, /collectionNames/);
  assert.match(tileSource, /const collectionTooltipId = `lot-collection-tooltip-\$\{lot\.id\}`;/);
  assert.match(tileSource, /aria-describedby=\{hasCollectionTooltip \? collectionTooltipId : undefined\}/);
  assert.match(tileSource, /role="tooltip"/);
  assert.match(tileSource, /Подборка:/);
  assert.match(tileSource, /collectionNames\.map/);
  assert.match(tooltipRule, /position:\s*absolute;/);
  assert.match(tooltipRule, /visibility:\s*hidden;/);
  assert.match(tooltipHoverRule, /transition-delay:\s*0\.5s,\s*0\.5s,\s*0s;/);
});

test('presentation comments are contextual and limited to 1000 characters', () => {
  assert.match(pageSource, /const commentMaxLength = 1000;/);
  assert.match(pageSource, /commentDraft\.length > commentMaxLength/);
  assert.match(pageSource, /\/lot-presentations\/workspace\/items\/\$\{encodeURIComponent\(activeCommentTarget\.unitId\)\}/);
  assert.match(pageSource, /\/lot-presentations\/collections\/\$\{encodeURIComponent\(activeCommentTarget\.collectionId\)\}\/items\/\$\{encodeURIComponent\(activeCommentTarget\.unitId\)\}/);
  assert.match(pageSource, /Комментарий сохранён/);
  assert.match(pageSource, /lot-presentations-comment-action is-active/);
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
