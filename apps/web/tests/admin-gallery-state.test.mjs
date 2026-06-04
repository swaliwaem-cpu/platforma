import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(currentDir, '../src/admin/ObjectsAdminPage.tsx'), 'utf8');

test('object editor stores gallery changes in modal draft state', () => {
  assert.match(source, /type GalleryDraftItem\s*=\s*\{[\s\S]*?draftId:\s*string;[\s\S]*?kind:\s*'existing' \| 'new' \| 'staged';[\s\S]*?imageId:\s*string \| null;[\s\S]*?stagedFileId\?:\s*string \| null;[\s\S]*?file:\s*File \| null;[\s\S]*?previewUrl:\s*string \| null;[\s\S]*?name:\s*string;[\s\S]*?section:\s*ObjectImageSection \| null;[\s\S]*?isUploading\?:\s*boolean;[\s\S]*?\};/);

  assert.match(source, /const \[isGalleryModalOpen,\s*setIsGalleryModalOpen\] = useState\(false\);/);
  assert.match(source, /const \[galleryDraftItems,\s*setGalleryDraftItems\] = useState<GalleryDraftItem\[\]>\(\[\]\);/);
  assert.match(source, /const \[galleryCoverDraftId,\s*setGalleryCoverDraftId\] = useState<string \| null>\(null\);/);
  assert.match(source, /const \[galleryDeletedImageIds,\s*setGalleryDeletedImageIds\] = useState<string\[\]>\(\[\]\);/);
  assert.match(source, /const \[galleryModalError,\s*setGalleryModalError\] = useState<string \| null>\(null\);/);
  assert.match(source, /const \[galleryModalProgress,\s*setGalleryModalProgress\] = useState<string \| null>\(null\);/);
  assert.match(source, /const \[galleryModalProgressPercent,\s*setGalleryModalProgressPercent\] = useState<number \| null>\(null\);/);

  assert.doesNotMatch(source, /const \[galleryFile,\s*setGalleryFile\] = useState<File \| null>\(null\);/);
});

test('gallery modal draft lifecycle creates and revokes local preview URLs', () => {
  assert.match(source, /function openGalleryModal\(\)[\s\S]*?createGalleryDraftItems\(object\?\.images \?\? \[\]\)/);
  assert.match(source, /function createGalleryDraftItems\(images: ObjectImage\[\]\)[\s\S]*?images\.map\(\(image\) => \(\{[\s\S]*?kind:\s*'existing'[\s\S]*?section:\s*image\.section/);
  assert.match(source, /function createNewGalleryDraftItems\(files: FileList \| File\[\]\)[\s\S]*?previewUrl:\s*null[\s\S]*?section:\s*null/);
  assert.match(source, /function removeGalleryDraftItem\(draftId: string\)[\s\S]*?revokeGalleryDraftPreviewUrl\(removedItem\)/);
  assert.match(source, /function closeGalleryModal\(\)[\s\S]*?resetGalleryModalDraft\(\)/);
  assert.match(source, /useEffect\(\(\) => \(\) => \{[\s\S]*?revokeGalleryDraftPreviewUrls\(galleryDraftItemsRef\.current\);[\s\S]*?\}, \[\]\);/);
  assert.match(source, /function revokeGalleryDraftPreviewUrl\(item: GalleryDraftItem\)[\s\S]*?URL\.revokeObjectURL\(item\.previewUrl\)/);
});

test('existing gallery draft items use secure media previews instead of stored public URLs', () => {
  const createDraftItemsSource = extractFunctionSource(source, 'function createGalleryDraftItems');

  assert.match(createDraftItemsSource, /kind:\s*'existing'/);
  assert.match(createDraftItemsSource, /previewUrl:\s*null/);
  assert.doesNotMatch(createDraftItemsSource, /previewUrl:\s*image\.file\.url/);
});

test('object editor opens gallery management modal instead of inline image upload', () => {
  assert.match(source, /<AdminButton[\s\S]*?onClick=\{props\.onGalleryModalOpen\}[\s\S]*?>[\s\S]*?Управлять галереей[\s\S]*?<\/AdminButton>/);
  assert.match(source, /props\.isGalleryModalOpen \? \([\s\S]*?<GalleryManagementModal/);
  assert.match(source, /function GalleryManagementModal\(/);
  assert.doesNotMatch(source, /onUploadCover/);
  assert.doesNotMatch(source, /onCoverFileChange/);
});

test('gallery management modal exposes cover slot, multiple image input and large tile grid', () => {
  assert.match(source, /className="gallery-modal-backdrop"/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /className="gallery-modal-header"/);
  assert.match(source, /Обложка и галерея/);
  assert.match(source, /className="gallery-modal-header-actions"/);
  assert.match(source, /className="gallery-modal-header-save"/);
  assert.match(source, /onClick=\{onSave\}[\s\S]*?<SaveIcon[\s\S]*?Сохранить/);
  assert.match(source, /className=\{coverSlotClassName\}/);
  assert.match(source, /gallery-cover-slot--active/);
  assert.match(source, /className="gallery-upload-dropzone"/);
  assert.match(source, /accept="image\/jpeg,image\/png,image\/webp"/);
  assert.match(source, /multiple/);
  assert.match(source, /className="gallery-tile-grid"/);
  assert.match(source, /className=\{tileClassName\}/);
  assert.match(source, /className="gallery-tile-preview"/);
  assert.match(source, /className="gallery-tile-name"/);
  assert.match(source, /className="gallery-modal-actions"/);
  assert.match(source, /Отмена/);
  assert.match(source, /onClick=\{onSave\}[\s\S]*?Сохранить/);
});

test('gallery management modal confirms close when draft has unsaved changes', () => {
  assert.match(source, /const \[isCloseConfirmOpen,\s*setIsCloseConfirmOpen\] = useState\(false\);/);
  assert.match(source, /const hasUnsavedChanges = useMemo\([\s\S]*?hasGalleryDraftChanges\(draftItems,\s*coverDraftId,\s*existingImages\)/);
  assert.match(source, /function requestGalleryModalClose\(\)[\s\S]*?if \(hasUnsavedChanges\) \{[\s\S]*?setIsCloseConfirmOpen\(true\);[\s\S]*?return;[\s\S]*?\}[\s\S]*?onClose\(\);/);
  assert.match(source, /function confirmGalleryModalClose\(\)[\s\S]*?setIsCloseConfirmOpen\(false\);[\s\S]*?onClose\(\);/);
  assert.match(source, /function cancelGalleryModalClose\(\)[\s\S]*?setIsCloseConfirmOpen\(false\);/);
  assert.match(source, /onClick=\{requestGalleryModalClose\}/);
  assert.match(source, /role="alertdialog"/);
  assert.match(source, /Вы точно хотите закрыть\?/);
  assert.match(source, /Были изменения/);
  assert.match(source, /onClick=\{confirmGalleryModalClose\}[\s\S]*?Да/);
  assert.match(source, /onClick=\{cancelGalleryModalClose\}[\s\S]*?Нет/);
  assert.match(source, /function hasGalleryDraftChanges\([\s\S]*?draftItems: GalleryDraftItem\[\],[\s\S]*?coverDraftId: string \| null,[\s\S]*?existingImages: ObjectImage\[\],[\s\S]*?\)/);
});

test('gallery management modal supports thematic section assignment', () => {
  assert.match(source, /ObjectImageSection/);
  assert.match(source, /const gallerySectionOptions:\s*\{[\s\S]*?value:\s*ObjectImageSection;[\s\S]*?label:\s*string;[\s\S]*?\}\[\]\s*=\s*\[[\s\S]*?ARCHITECTURE[\s\S]*?Архитектура[\s\S]*?INTERIORS[\s\S]*?Интерьеры[\s\S]*?FILLING[\s\S]*?Наполнение/);
  assert.match(source, /function assignGalleryDraftSection\(draftId: string,\s*section: ObjectImageSection \| null\)/);
  assert.match(source, /onGalleryDraftSectionChange=\{assignGalleryDraftSection\}/);
  assert.match(source, /onSectionChange: \(draftId: string,\s*section: ObjectImageSection \| null\) => void;/);
  assert.doesNotMatch(source, /className="gallery-section-slots"/);
  assert.doesNotMatch(source, /className=\{sectionSlotClassName\}/);
  assert.doesNotMatch(source, /handleSectionSlot/);
  assert.doesNotMatch(source, /onSectionChange\(nextDraggedDraftId,\s*section\)/);
  assert.match(source, /className="gallery-tile-section-select"/);
  assert.match(source, /<option value="">Без раздела<\/option>/);
  assert.match(source, /gallerySectionOptions\.map\(\(option\) => \(/);
  assert.match(source, /gallery-tile-status gallery-tile-status--section/);
});

test('gallery management modal supports drag and keyboard-style ordering controls', () => {
  assert.match(source, /function reorderGalleryDraftItem\(draggedDraftId: string,\s*targetDraftId: string\)/);
  assert.match(source, /function moveGalleryDraftItem\(draftId: string,\s*direction: 'up' \| 'down'\)/);
  assert.match(source, /onGalleryDraftReorder=\{reorderGalleryDraftItem\}/);
  assert.match(source, /onGalleryDraftMove=\{moveGalleryDraftItem\}/);

  assert.match(source, /const \[draggedDraftId,\s*setDraggedDraftId\] = useState<string \| null>\(null\);/);
  assert.match(source, /const \[dropTargetDraftId,\s*setDropTargetDraftId\] = useState<string \| null>\(null\);/);
  assert.match(source, /const \[isCoverDropTarget,\s*setIsCoverDropTarget\] = useState\(false\);/);

  assert.match(source, /draggable/);
  assert.match(source, /onDragStart=\{\(event\) => handleTileDragStart\(event,\s*item\.draftId\)\}/);
  assert.match(source, /onDragOver=\{\(event\) => handleTileDragOver\(event,\s*item\.draftId\)\}/);
  assert.match(source, /onDrop=\{\(event\) => handleTileDrop\(event,\s*item\.draftId\)\}/);
  assert.match(source, /onDrop=\{handleCoverSlotDrop\}/);
  assert.match(source, /event\.dataTransfer\.setData\('text\/plain', draftId\)/);
  assert.match(source, /onCoverChange\(nextDraggedDraftId\)/);

  assert.match(source, /aria-label=\{`Поднять \$\{item\.name\}`\}/);
  assert.match(source, /aria-label=\{`Опустить \$\{item\.name\}`\}/);
  assert.match(source, /onClick=\{\(\) => onDraftMove\(item\.draftId, 'up'\)\}/);
  assert.match(source, /onClick=\{\(\) => onDraftMove\(item\.draftId, 'down'\)\}/);
});

test('gallery management modal removes draft items without touching server data', () => {
  assert.match(source, /function removeGalleryDraftItem\(draftId: string\)[\s\S]*?revokeGalleryDraftPreviewUrl\(removedItem\)/);
  assert.match(source, /function removeGalleryDraftItem\(draftId: string\)[\s\S]*?setGalleryDeletedImageIds\(\(currentIds\) =>[\s\S]*?currentIds\.includes\(removedImageId\) \? currentIds : \[\.\.\.currentIds, removedImageId\]/);
  assert.match(source, /function removeGalleryDraftItem\(draftId: string\)[\s\S]*?if \(galleryCoverDraftId === draftId\) \{[\s\S]*?setGalleryCoverDraftId\(null\)/);
  assert.match(source, /function resetGalleryModalDraft\(\)[\s\S]*?setGalleryDeletedImageIds\(\[\]\)/);

  assert.match(source, /onGalleryDraftRemove=\{removeGalleryDraftItem\}/);
  assert.match(source, /onDraftRemove: \(draftId: string\) => void;/);
  assert.match(source, /className="gallery-tile-remove-button"/);
  assert.match(source, /aria-label=\{`Удалить \$\{item\.name\}`\}/);
  assert.match(source, /onClick=\{\(\) => onDraftRemove\(item\.draftId\)\}/);
});

test('gallery modal save flow persists edited object gallery layout', () => {
  assert.match(source, /async function saveGalleryModalChanges\(\)/);
  assert.match(source, /async function persistGalleryDraftForObject\(objectId: string/);
  assert.match(source, /draftItems\.length > 0 && !galleryCoverDraftId/);
  assert.match(source, /setGalleryModalError\('Выберите обложку для галереи'\)/);
  assert.match(source, /const uploadedDraft = await uploadGalleryDraftFiles\(objectId,\s*reconciledDraft\.draftItems\);/);
  assert.match(source, /galleryDraftItemsRef\.current = uploadedDraft\.draftItems;/);
  assert.match(source, /const batchBody = createGalleryBatchBody\(uploadedDraft\.draftItems,\s*reconciledDraft\.coverDraftId\);/);
  assert.match(source, /if \(batchBody\.fileCount !== 0\) \{[\s\S]*?throw new Error\('Не удалось подготовить галерею к сохранению'\);[\s\S]*?\}/);
  assert.match(source, /setGallerySaveProgress\('Сохранение галереи',\s*95\);/);
  assert.match(source, /apiRequest<ObjectResponse>\(`\/objects\/\$\{objectId\}\/gallery\/batch`,\s*accessToken,\s*\{[\s\S]*?method:\s*'PATCH'[\s\S]*?body:\s*batchBody\.formData/);
  assert.doesNotMatch(source, /apiRequest<ObjectResponse>\(`\/objects\/\$\{objectId\}\/gallery\/layout`/);
  assert.doesNotMatch(source, /uploadObjectMedia\(objectId,\s*'cover'/);
  assert.doesNotMatch(source, /uploadObjectMedia\(objectId,\s*'gallery'/);
  assert.match(source, /setObject\(layoutData\.object\)/);
  assert.match(source, /resetGalleryModalDraft\(\)/);
  assert.match(source, /setNotice\('Галерея сохранена'\)/);
});

test('gallery modal uploads new draft files with bounded concurrency before final layout save', () => {
  assert.match(source, /type GalleryStreamUploadResponse = ObjectResponse & \{[\s\S]*?file: ObjectStoredFile;[\s\S]*?\};/);
  assert.match(source, /const galleryUploadConcurrency = 3;/);
  assert.match(source, /async function uploadGalleryDraftFiles\(objectId: string,\s*draftItems: GalleryDraftItem\[\]\)/);
  assert.match(source, /const newItems = draftItems\.filter\(\(item\): item is GalleryDraftItem & \{ kind: 'new'; file: File \} => item\.kind === 'new' && item\.file !== null\);/);
  assert.match(source, /const uploadWorkerCount = Math\.min\(galleryUploadConcurrency,\s*newItems\.length\);/);
  assert.match(source, /await Promise\.all\(Array\.from\(\{ length: uploadWorkerCount \},\s*\(\) => uploadNextItem\(\)\)\);/);
  assert.match(source, /setGallerySaveProgress\(\s*`Загружено изображений \$\{completedUploads\}\/\$\{newItems\.length\}`,\s*calculateGalleryUploadProgressPercent\(completedUploads,\s*newItems\.length\),\s*\);/);
  assert.match(source, /apiRequest<GalleryStreamUploadResponse>\(\s*`\/objects\/\$\{objectId\}\/gallery\/stream`,\s*accessToken,\s*\{[\s\S]*?method:\s*'POST'[\s\S]*?body:\s*item\.file[\s\S]*?headers:\s*\{[\s\S]*?'Content-Type': item\.file\.type \|\| 'application\/octet-stream'[\s\S]*?'X-File-Name': encodeURIComponent\(item\.file\.name \|\| 'image'\)/);
  assert.match(source, /kind:\s*'staged'[\s\S]*?stagedFileId:\s*uploadedFile\.id[\s\S]*?file:\s*item\.file[\s\S]*?section:\s*item\.section/);
  assert.match(source, /function restoreStagedGalleryDraftItems\(draftItems: GalleryDraftItem\[\],\s*stagedFileIds: string\[\]\)/);
  assert.match(source, /async function cleanupStagedGalleryFiles\(fileIds: string\[\]\)/);
  assert.match(source, /apiRequest<void>\(`\/files\/\$\{fileId\}`,\s*accessToken,\s*\{[\s\S]*?method:\s*'DELETE'/);
});

test('gallery modal builds multipart layout payload and keeps file fallback compatibility', () => {
  assert.match(source, /function createGalleryBatchBody\(draftItems: GalleryDraftItem\[\],\s*coverDraftId: string \| null\)/);
  assert.match(source, /const formData = new FormData\(\);/);
  assert.match(source, /const items = draftItems\.map\(\(item\) => \{/);
  assert.match(source, /const fileIndex = files\.length;/);
  assert.match(source, /files\.push\(item\.file\);/);
  assert.match(source, /return \{[\s\S]*?kind:\s*'new'[\s\S]*?fileIndex[\s\S]*?section:\s*item\.section[\s\S]*?\};/);
  assert.match(source, /return \{[\s\S]*?kind:\s*'staged'[\s\S]*?fileId:\s*item\.stagedFileId[\s\S]*?section:\s*item\.section[\s\S]*?\};/);
  assert.match(source, /return \{[\s\S]*?kind:\s*'existing'[\s\S]*?imageId:\s*item\.imageId[\s\S]*?section:\s*item\.section[\s\S]*?\};/);
  assert.match(source, /formData\.append\('layout', JSON\.stringify\(\{[\s\S]*?items[\s\S]*?coverIndex[\s\S]*?\}\)\);/);
  assert.match(source, /files\.forEach\(\(file\) => formData\.append\('files', file\)\);/);
});

test('gallery modal refreshes current gallery before batch save and drops stale existing ids', () => {
  assert.match(source, /const currentData = await apiRequest<ObjectResponse>\(`\/objects\/\$\{objectId\}`,\s*accessToken\);/);
  assert.match(source, /const reconciledDraft = reconcileGalleryDraftItemsWithCurrentGallery\([\s\S]*?galleryDraftItemsRef\.current[\s\S]*?galleryCoverDraftId[\s\S]*?currentData\.object\.images[\s\S]*?\);/);
  assert.match(source, /galleryDraftItemsRef\.current = reconciledDraft\.draftItems;/);
  assert.match(source, /setGalleryDraftItems\(reconciledDraft\.draftItems\);/);
  assert.match(source, /setGalleryCoverDraftId\(reconciledDraft\.coverDraftId\);/);
  assert.match(source, /uploadGalleryDraftFiles\(objectId,\s*reconciledDraft\.draftItems\);/);
  assert.match(source, /createGalleryBatchBody\(uploadedDraft\.draftItems,\s*reconciledDraft\.coverDraftId\);/);
  assert.match(source, /function reconcileGalleryDraftItemsWithCurrentGallery\([\s\S]*?const currentImageIds = new Set\(currentImages\.map\(\(image\) => image\.id\)\);[\s\S]*?\(item\.kind === 'new' \|\| item\.kind === 'staged'\) \|\| \(item\.imageId !== null && currentImageIds\.has\(item\.imageId\)\)/);
});

test('gallery modal blocks duplicate save submissions synchronously', () => {
  assert.match(source, /const galleryModalSaveInFlightRef = useRef\(false\);/);
  assert.match(source, /if \(galleryModalProgress \|\| galleryModalSaveInFlightRef\.current\) \{/);
  assert.match(source, /galleryModalSaveInFlightRef\.current = true;/);
  assert.match(source, /galleryModalSaveInFlightRef\.current = false;/);
});

test('gallery modal previews avoid eager decoding of every thumbnail', () => {
  assert.match(source, /return <img alt=\{item\.name\} decoding="async" loading="lazy" src=\{item\.previewUrl\} \/>;/);
  assert.match(source, /<SecureImage[\s\S]*?decoding="async"[\s\S]*?lazy=\{variant === 'thumbnail'\}[\s\S]*?loading="lazy"[\s\S]*?variant=\{variant\}/);
});

test('gallery modal opens persisted images in full size from tile overlay', () => {
  assert.match(source, /import \{ SecureImage, buildMediaFileContentUrl \} from '\.\.\/files\/SecureImage';/);
  assert.match(source, /const fullSizeHref = getGalleryDraftFullSizeHref\(item,\s*existingImage\);/);
  assert.match(source, /className="gallery-tile-open-original"/);
  assert.match(source, /target="_blank"/);
  assert.match(source, /rel="noreferrer"/);
  assert.match(source, /function getGalleryDraftFullSizeHref\(item: GalleryDraftItem,\s*existingImage: ObjectImage \| null\)[\s\S]*?buildMediaFileContentUrl\(fileId,\s*'original'\)/);
});

test('gallery modal prepares lightweight local previews for new files asynchronously', () => {
  assert.match(source, /function createNewGalleryDraftItems\(files: FileList \| File\[\]\)[\s\S]*?previewUrl:\s*null/);
  assert.doesNotMatch(source, /previewUrl:\s*URL\.createObjectURL\(file\)/);
  assert.match(source, /void hydrateNewGalleryDraftPreviews\(nextNewItems\);/);
  assert.match(source, /async function hydrateNewGalleryDraftPreviews\(items: GalleryDraftItem\[\]\)/);
  assert.match(source, /async function createGalleryPreviewUrl\(file: File\)/);
  assert.match(source, /canvas\.toBlob\([\s\S]*?galleryPreviewMimeType[\s\S]*?galleryPreviewQuality/);
});

test('gallery modal isolates tile rerenders and avoids repeated drag-over state churn', () => {
  assert.match(source, /memo,/);
  assert.match(source, /const GalleryDraftTile = memo\(function GalleryDraftTile/);
  assert.match(source, /<GalleryDraftTile[\s\S]*?item=\{item\}/);
  assert.match(source, /if \(dropTargetDraftId === targetDraftId && !isCoverDropTarget\) \{/);
});

test('gallery modal save flow creates new object before uploading draft media', () => {
  assert.match(source, /if \(isCreateRoute\) \{[\s\S]*?const validationError = validateObjectForm\(form\);[\s\S]*?setGalleryModalError\(validationError\);[\s\S]*?return;/);
  assert.match(source, /if \(isCreateRoute\) \{[\s\S]*?const payload = createPayloadFromForm\(form\);[\s\S]*?apiRequest<ObjectResponse>\('\/objects',\s*accessToken,\s*\{[\s\S]*?method:\s*'POST'[\s\S]*?body:\s*JSON\.stringify\(payload\)/);
  assert.match(source, /setGallerySaveProgress\('Создание объекта',\s*5\)/);
  assert.match(source, /persistGalleryDraftForObject\(createData\.object\.id\)/);
  assert.match(source, /navigate\(`\/admin\/objects\/\$\{layoutData\.object\.id\}\/edit`\)/);
  assert.match(source, /setNotice\('Объект создан, галерея сохранена'\)/);
});

test('create object editor opens gallery modal before object exists', () => {
  assert.match(source, /<AdminPanel className="editor-panel media-panel" role="region" aria-label="Медиа объекта">[\s\S]*?Обложка и галерея[\s\S]*?props\.object\?\.images\.length \?\? props\.galleryDraftItems\.length[\s\S]*?Управлять галереей/);
  assert.doesNotMatch(source, /Файлы появятся после создания/);
  assert.match(source, /existingImages=\{props\.object\?\.images \?\? \[\]\}/);
});

test('object editor preview exposes catalog link for existing object', () => {
  assert.match(source, /const previewCatalogPath = props\.object\s*\?\s*`\/objects\/\$\{encodeURIComponent\(props\.object\.slug\)\}`\s*:\s*null;/);
  assert.match(source, /previewCatalogPath \? \([\s\S]*?<AdminButton[\s\S]*?className="object-preview-catalog-link"[\s\S]*?asChild[\s\S]*?>[\s\S]*?<a[\s\S]*?href=\{previewCatalogPath\}[\s\S]*?>[\s\S]*?В каталоге[\s\S]*?<\/a>[\s\S]*?<\/AdminButton>/);
});

test('object editor header owns status badge and preview duplicates save action', () => {
  assert.match(source, /className="object-editor-kicker"[\s\S]*?<AdminStatusBadge[\s\S]*?object-status--\$\{previewStatus\.toLowerCase\(\)\}/);
  assert.match(source, /<form className="object-form editor-panel" id="object-editor-form" onSubmit=\{props\.onSubmit\}>/);
  assert.match(source, /const saveButtonLabel = props\.isCreateRoute \? 'Создать' : 'Сохранить';/);
  assert.match(source, /const isSaveDisabled = props\.isLoading \|\| props\.isSubmitting/);
  assert.match(source, /className="object-preview-actions"[\s\S]*?<AdminButton disabled=\{isSaveDisabled\} form="object-editor-form" tone="primary" type="submit">[\s\S]*?<SaveIcon[\s\S]*?\{saveButtonLabel\}/);
});

test('gallery modal save button is enabled and disabled while saving', () => {
  assert.match(source, /onGalleryModalSave=\{\(\) => void saveGalleryModalChanges\(\)\}/);
  assert.match(source, /onSave=\{props\.onGalleryModalSave\}/);
  assert.match(source, /isSaving=\{Boolean\(props\.galleryModalProgress\)\}/);
  assert.match(source, /onSave: \(\) => void;/);
  assert.match(source, /isSaving: boolean;/);
  assert.match(source, /<AdminButton[\s\S]*?disabled=\{isSaving\}[\s\S]*?onClick=\{onSave\}[\s\S]*?>[\s\S]*?Сохранить/);
  assert.doesNotMatch(source, /disabled=\{true\}[\s\S]*?Сохранить/);
});

test('gallery modal shows upload progress as accessible percent bar', () => {
  assert.match(source, /galleryModalProgressPercent=\{galleryModalProgressPercent\}/);
  assert.match(source, /progressPercent=\{props\.galleryModalProgressPercent\}/);
  assert.match(source, /progressPercent: number \| null;/);
  assert.match(source, /function setGallerySaveProgress\(message: string,\s*percent: number \| null\)/);
  assert.match(source, /setGalleryModalProgress\(message\);[\s\S]*?setGalleryModalProgressPercent\(percent\);/);
  assert.match(source, /setGalleryModalProgressPercent\(null\);/);
  assert.match(source, /role="progressbar"/);
  assert.match(source, /aria-valuemin=\{0\}/);
  assert.match(source, /aria-valuemax=\{100\}/);
  assert.match(source, /aria-valuenow=\{progressPercent\}/);
  assert.match(source, /className="gallery-modal-progress-fill"[\s\S]*?style=\{\{ width: `\$\{progressPercent\}%` \}\}/);
});

function extractFunctionSource(sourceText, marker) {
  const markerIndex = sourceText.indexOf(marker);

  assert.notEqual(markerIndex, -1, `${marker} should exist`);

  const nextFunctionIndex = sourceText.indexOf('\nfunction ', markerIndex + marker.length);

  return sourceText.slice(markerIndex, nextFunctionIndex === -1 ? sourceText.length : nextFunctionIndex);
}
