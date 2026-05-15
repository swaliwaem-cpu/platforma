import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(currentDir, '../src/admin/ObjectsAdminPage.tsx'), 'utf8');

test('object editor stores gallery changes in modal draft state', () => {
  assert.match(source, /type GalleryDraftItem\s*=\s*\{[\s\S]*?draftId:\s*string;[\s\S]*?kind:\s*'existing' \| 'new';[\s\S]*?imageId:\s*string \| null;[\s\S]*?file:\s*File \| null;[\s\S]*?previewUrl:\s*string;[\s\S]*?name:\s*string;[\s\S]*?section:\s*ObjectImageSection \| null;[\s\S]*?isUploading\?:\s*boolean;[\s\S]*?\};/);

  assert.match(source, /const \[isGalleryModalOpen,\s*setIsGalleryModalOpen\] = useState\(false\);/);
  assert.match(source, /const \[galleryDraftItems,\s*setGalleryDraftItems\] = useState<GalleryDraftItem\[\]>\(\[\]\);/);
  assert.match(source, /const \[galleryCoverDraftId,\s*setGalleryCoverDraftId\] = useState<string \| null>\(null\);/);
  assert.match(source, /const \[galleryDeletedImageIds,\s*setGalleryDeletedImageIds\] = useState<string\[\]>\(\[\]\);/);
  assert.match(source, /const \[galleryModalError,\s*setGalleryModalError\] = useState<string \| null>\(null\);/);
  assert.match(source, /const \[galleryModalProgress,\s*setGalleryModalProgress\] = useState<string \| null>\(null\);/);

  assert.doesNotMatch(source, /const \[galleryFile,\s*setGalleryFile\] = useState<File \| null>\(null\);/);
});

test('gallery modal draft lifecycle creates and revokes local preview URLs', () => {
  assert.match(source, /function openGalleryModal\(\)[\s\S]*?createGalleryDraftItems\(object\?\.images \?\? \[\]\)/);
  assert.match(source, /function createGalleryDraftItems\(images: ObjectImage\[\]\)[\s\S]*?images\.map\(\(image\) => \(\{[\s\S]*?kind:\s*'existing'[\s\S]*?section:\s*image\.section/);
  assert.match(source, /function createNewGalleryDraftItems\(files: FileList \| File\[\]\)[\s\S]*?URL\.createObjectURL\(file\)[\s\S]*?section:\s*null/);
  assert.match(source, /function removeGalleryDraftItem\(draftId: string\)[\s\S]*?revokeGalleryDraftPreviewUrl\(removedItem\)/);
  assert.match(source, /function closeGalleryModal\(\)[\s\S]*?resetGalleryModalDraft\(\)/);
  assert.match(source, /useEffect\(\(\) => \(\) => \{[\s\S]*?revokeGalleryDraftPreviewUrls\(galleryDraftItemsRef\.current\);[\s\S]*?\}, \[\]\);/);
  assert.match(source, /function revokeGalleryDraftPreviewUrl\(item: GalleryDraftItem\)[\s\S]*?URL\.revokeObjectURL\(item\.previewUrl\)/);
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

test('gallery management modal supports thematic section assignment', () => {
  assert.match(source, /ObjectImageSection/);
  assert.match(source, /const gallerySectionOptions:\s*\{[\s\S]*?value:\s*ObjectImageSection;[\s\S]*?label:\s*string;[\s\S]*?\}\[\]\s*=\s*\[[\s\S]*?ARCHITECTURE[\s\S]*?Архитектура[\s\S]*?INTERIORS[\s\S]*?Интерьеры[\s\S]*?FILLING[\s\S]*?Наполнение/);
  assert.match(source, /function assignGalleryDraftSection\(draftId: string,\s*section: ObjectImageSection \| null\)/);
  assert.match(source, /onGalleryDraftSectionChange=\{assignGalleryDraftSection\}/);
  assert.match(source, /onSectionChange: \(draftId: string,\s*section: ObjectImageSection \| null\) => void;/);
  assert.match(source, /className="gallery-section-slots"/);
  assert.match(source, /className=\{sectionSlotClassName\}/);
  assert.match(source, /onDrop=\{\(event\) => handleSectionSlotDrop\(event,\s*option\.value\)\}/);
  assert.match(source, /onSectionChange\(nextDraggedDraftId,\s*section\)/);
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
  assert.match(source, /setGalleryModalProgress\('Удаление изображений'/);
  assert.match(source, /for \(const imageId of galleryDeletedImageIds\)/);
  assert.match(source, /apiRequest<ObjectResponse>\(`\/objects\/\$\{objectId\}\/gallery\/\$\{imageId\}`,\s*accessToken,\s*\{[\s\S]*?method:\s*'DELETE'/);
  assert.match(source, /setGalleryModalProgress\('Загрузка обложки'/);
  assert.match(source, /uploadObjectMedia\(objectId,\s*'cover',\s*coverDraftItem\.file\)/);
  assert.match(source, /setGalleryModalProgress\('Загрузка изображений'/);
  assert.match(source, /uploadObjectMedia\(objectId,\s*'gallery',\s*item\.file\)/);
  assert.match(source, /setGalleryModalProgress\('Сохранение порядка'/);
  assert.match(source, /const imageSections = draftItems\.reduce<Record<string,\s*ObjectImageSection \| null>>/);
  assert.match(source, /imageSections\[imageId\] = item\.section;/);
  assert.match(source, /apiRequest<ObjectResponse>\(`\/objects\/\$\{objectId\}\/gallery\/layout`,\s*accessToken,\s*\{[\s\S]*?method:\s*'PATCH'[\s\S]*?body:\s*JSON\.stringify\(\{[\s\S]*?imageIds[\s\S]*?coverImageId[\s\S]*?imageSections/);
  assert.match(source, /setObject\(layoutData\.object\)/);
  assert.match(source, /resetGalleryModalDraft\(\)/);
  assert.match(source, /setNotice\('Галерея сохранена'\)/);
});

test('gallery modal save flow creates new object before uploading draft media', () => {
  assert.match(source, /if \(isCreateRoute\) \{[\s\S]*?const validationError = validateObjectForm\(form\);[\s\S]*?setGalleryModalError\(validationError\);[\s\S]*?return;/);
  assert.match(source, /if \(isCreateRoute\) \{[\s\S]*?const payload = createPayloadFromForm\(form\);[\s\S]*?apiRequest<ObjectResponse>\('\/objects',\s*accessToken,\s*\{[\s\S]*?method:\s*'POST'[\s\S]*?body:\s*JSON\.stringify\(payload\)/);
  assert.match(source, /setGalleryModalProgress\('Создание объекта'\)/);
  assert.match(source, /persistGalleryDraftForObject\(createData\.object\.id,\s*createData\.object\.images\)/);
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

test('gallery modal save button is enabled and disabled while saving', () => {
  assert.match(source, /onGalleryModalSave=\{\(\) => void saveGalleryModalChanges\(\)\}/);
  assert.match(source, /onSave=\{props\.onGalleryModalSave\}/);
  assert.match(source, /isSaving=\{Boolean\(props\.galleryModalProgress\)\}/);
  assert.match(source, /onSave: \(\) => void;/);
  assert.match(source, /isSaving: boolean;/);
  assert.match(source, /<AdminButton[\s\S]*?disabled=\{isSaving\}[\s\S]*?onClick=\{onSave\}[\s\S]*?>[\s\S]*?Сохранить/);
  assert.doesNotMatch(source, /disabled=\{true\}[\s\S]*?Сохранить/);
});
