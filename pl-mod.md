# Пошаговый План Реализации Модалки Галереи

## Summary

- В админке объекта заменить текущую inline-загрузку медиа на модальное окно управления изображениями.
- В модалке показывать изображения визуальной сеткой крупных плиток, примерно как Windows Explorer в режиме "крупные значки".
- Поддержать массовый выбор файлов, локальные превью до загрузки, drag/drop порядка, отдельный слот `Обложка`, удаление изображений и сохранение.
- Новые зависимости не добавлять.

## Уточнения

- Модалка управляет всей галереей объекта целиком: существующие изображения + новые выбранные файлы.
- На странице создания объекта модалка тоже доступна: сохранение модалки создаёт объект, затем загружает изображения.
- Обложка находится в отдельном поле модалки, и туда можно перетащить изображение.
- Загрузка файлов выполняется последовательно через существующие upload endpoints.
- Существующие изображения можно удалять прямо в модалке.
- Превью должны быть крупными визуальными плитками, а не строками списка.

## API / Backend

- [x] Добавить endpoint `PATCH /objects/:id/gallery/layout` в `apps/api/src/objects/objects.controller.ts`.
- [x] Назначить endpoint permission `objects:update`.
- [x] Принимать body:

  ```ts
  {
    imageIds: string[];
    coverImageId: string | null;
  }
  ```

- [x] Добавить метод `updateGalleryLayout` в `apps/api/src/objects/objects.service.ts`.
- [x] Проверять, что `imageIds` полностью совпадает с текущими изображениями объекта.
- [x] Проверять, что `coverImageId`, если задан, входит в `imageIds`.
- [x] В transaction обновлять:
  - [x] `sortOrder` по порядку `imageIds`;
  - [x] `isCover = image.id === coverImageId`.
- [x] Вернуть обновлённый `ObjectResponse`.
- [x] Добавить audit log action `object.gallery.layout`.
- [x] Не ломать существующие endpoints:
  - [x] `POST /objects/:id/cover`;
  - [x] `POST /objects/:id/gallery`;
  - [x] `PATCH /objects/:id/gallery/sort`;
  - [x] `DELETE /objects/:id/gallery/:imageId`.

## Frontend State

- [x] В `apps/web/src/admin/ObjectsAdminPage.tsx` убрать старую модель одиночного `galleryFile` для галереи.
- [x] Оставить загрузку cover/gallery через старые endpoints только как внутренний механизм сохранения.
- [x] Добавить состояние модалки:

  ```ts
  isGalleryModalOpen: boolean;
  galleryDraftItems: GalleryDraftItem[];
  galleryCoverDraftId: string | null;
  galleryDeletedImageIds: string[];
  galleryModalError: string | null;
  galleryModalProgress: string | null;
  ```

- [x] Добавить тип draft-элемента:

  ```ts
  type GalleryDraftItem = {
    draftId: string;
    kind: 'existing' | 'new';
    imageId: string | null;
    file: File | null;
    previewUrl: string;
    name: string;
    isUploading?: boolean;
  };
  ```

- [x] При открытии модалки строить draft из `object.images`.
- [x] Для новых файлов создавать `previewUrl` через `URL.createObjectURL`.
- [x] Освобождать object URLs через `URL.revokeObjectURL` при удалении файла, закрытии модалки и размонтировании.

## UI Модалки

- [x] В блоке "Медиа" заменить две строки `Обложка` / `Галерея` на одну кнопку, например `Управлять галереей`.
- [x] Показать счётчик текущих изображений как сейчас: `N фото`.
- [x] Создать компонент/секцию модалки внутри `ObjectsAdminPage.tsx`, без новых библиотек.
- [x] Модалка должна иметь:
  - [x] заголовок `Обложка и галерея`;
  - [x] кнопку закрытия;
  - [x] отдельный крупный slot `Обложка`;
  - [x] кнопку/зону `Добавить изображения`;
  - [x] сетку крупных плиток изображений;
  - [x] кнопку `Отмена`;
  - [x] кнопку `Сохранить`.
- [x] Input файлов сделать `multiple`.
- [x] Accept оставить `image/jpeg,image/png,image/webp`.
- [x] Плитки изображений сделать крупными, визуальными:
  - [x] превью примерно `120-160px` по ширине;
  - [x] изображение сверху;
  - [x] короткое имя файла снизу;
  - [x] отдельный визуальный статус для новых файлов до сохранения.
- [x] Сетка должна адаптироваться под ширину модалки и мобильные экраны.
- [x] Не использовать декоративный hero/gradient/glassmorphism.

## Drag / Drop

- [x] Реализовать drag/drop без новых зависимостей через HTML Drag and Drop.
- [x] Разрешить перетаскивать плитки внутри сетки для изменения порядка.
- [x] Разрешить перетаскивать плитку в slot `Обложка`.
- [x] Если плитку перетащили в `Обложка`, она становится cover draft.
- [x] В сетке визуально показывать drag state и drop target.
- [x] Для доступности оставить кнопки `Выше` / `Ниже` или компактные icon buttons у плиток.
- [x] Не сохранять изменения на сервер при каждом drag/drop, только по кнопке `Сохранить`.

## Удаление

- [x] У каждой плитки добавить действие удаления.
- [x] Если удаляется новый файл, убрать его из draft и освободить `previewUrl`.
- [x] Если удаляется существующее изображение, добавить его `imageId` в `galleryDeletedImageIds`.
- [x] Если удалённое изображение было обложкой, очистить `galleryCoverDraftId`.
- [x] До нажатия `Сохранить` фактические серверные данные не менять.
- [x] При `Отмена` закрыть модалку и сбросить draft без серверных изменений.

## Save Flow: Редактирование Объекта

- [x] При `Сохранить` проверить, что если в draft есть изображения, выбран cover.
- [x] Заблокировать кнопки и показать прогресс.
- [x] Удалить существующие изображения из `galleryDeletedImageIds` через `DELETE /objects/:id/gallery/:imageId`.
- [x] Если cover draft является новым файлом, загрузить его через `POST /objects/:id/cover`.
- [x] Новые gallery-файлы загрузить последовательно через `POST /objects/:id/gallery`.
- [x] Собрать итоговый список `imageIds` в порядке draft.
- [x] Вызвать `PATCH /objects/:id/gallery/layout` с:

  ```ts
  {
    imageIds,
    coverImageId
  }
  ```

- [x] Обновить `object` из ответа API.
- [x] Закрыть модалку.
- [x] Показать notice `Галерея сохранена`.

## Save Flow: Создание Объекта

- [x] На странице `/admin/objects/new` кнопка `Управлять галереей` открывает модалку до создания объекта.
- [x] При `Сохранить` в модалке сначала выполнить текущую валидацию формы объекта.
- [x] Если форма невалидна, показать ошибку и не создавать объект.
- [x] Если форма валидна, создать объект через текущий `POST /objects`.
- [x] После успешного создания загрузить медиа по тому же flow, что в редактировании.
- [x] Перевести пользователя на `/admin/objects/:id/edit`.
- [x] Если объект создался, но часть медиа не загрузилась, оставить пользователя на созданном объекте и показать ошибку по медиа.

## CSS

- [x] В `apps/web/src/styles.css` добавить стили:
  - [x] `.gallery-modal-backdrop`;
  - [x] `.gallery-modal`;
  - [x] `.gallery-modal-header`;
  - [x] `.gallery-cover-slot`;
  - [x] `.gallery-cover-slot--active`;
  - [x] `.gallery-upload-dropzone`;
  - [x] `.gallery-tile-grid`;
  - [x] `.gallery-tile`;
  - [x] `.gallery-tile--dragging`;
  - [x] `.gallery-tile--cover`;
  - [x] `.gallery-tile-preview`;
  - [x] `.gallery-tile-name`;
  - [x] `.gallery-modal-actions`.
- [x] Размеры плиток сделать стабильными, чтобы текст и hover states не ломали layout.
- [x] На мобильных экранах плитки должны перестраиваться без горизонтального скролла страницы.
- [x] Проверить, что текст имени файла переносится и не вылезает из плитки.

## Tests

- [x] Обновить `apps/api/tests/api-contract.test.cjs`:
  - [x] permission для нового endpoint;
  - [x] delegation controller -> service.
- [x] Добавить tests в `apps/api/tests/services.test.cjs`:
  - [x] layout назначает cover и порядок;
  - [x] layout отклоняет неполный `imageIds`;
  - [x] layout отклоняет лишний `imageIds`;
  - [x] layout отклоняет `coverImageId`, которого нет в списке.
- [x] Добавить/обновить web static tests:
  - [x] в `ObjectsAdminPage.tsx` есть `multiple` file input для галереи;
  - [x] есть `URL.createObjectURL` и `URL.revokeObjectURL`;
  - [x] есть request на `/gallery/layout`;
  - [x] есть отдельный cover slot.
- [x] Добавить/обновить CSS tests:
  - [x] есть крупная grid-сетка плиток;
  - [x] есть стили cover slot;
  - [x] есть drag state для плиток.
- [x] Запустить:

  - [x] `pnpm --filter @platforma/api test`
  - [x] `pnpm --filter @platforma/web test`
  - [x] `pnpm build:web`
  - [x] `pnpm build:api`

## Manual QA

- [ ] Создать новый объект, открыть модалку, выбрать много изображений, назначить обложку, сохранить.
- [ ] Проверить, что объект создался и изображения загрузились в нужном порядке.
- [ ] Открыть существующий объект, добавить 20+ изображений, перетасовать плитки, сохранить.
- [ ] Перетащить существующее изображение в слот `Обложка`, сохранить и обновить страницу.
- [ ] Удалить несколько существующих изображений в модалке, сохранить и проверить, что они исчезли.
- [ ] Проверить отмену: изменения в модалке не должны применяться.
- [ ] Проверить неподдерживаемый формат файла.
- [ ] Проверить мобильную ширину модалки.
- [ ] Проверить пользователя без `files:upload` / `objects:update`.

## Assumptions

- Работа выполняется в ветке `on-ser`.
- Новые npm-зависимости не добавляются.
- Prisma schema и миграции не нужны.
- Обложка хранится как `ObjectImage.isCover`.
- В модалке обложка отображается отдельным slot, а сетка показывает остальные изображения крупными плитками.
- Точный размер плиток подбирается в CSS, ориентир: режим "крупные значки" в Windows Explorer.

## Статус Сейчас

- Backend-блок `API / Backend` выполнен.
- API contract/service tests для backend-блока добавлены.
- Проверки `pnpm --filter @platforma/api test` и `pnpm build:api` проходят.
- Frontend State выполнен.
- UI Модалки и CSS выполнены.
- Drag/drop выполнен.
- Удаление выполнено.
- Save Flow редактирования объекта выполнен.
- Save Flow создания объекта выполнен.
- Manual QA пока не выполнен.
