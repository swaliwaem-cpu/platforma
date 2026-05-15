# Метки изображений галереи объекта

## Summary

Добавить к изображениям объекта один тематический раздел: `ARCHITECTURE`, `INTERIORS`, `FILLING` или `null`. `Обложка` остается отдельным флагом `isCover` и может сочетаться с любым разделом. В админке появятся три drop-зоны “Архитектура”, “Интерьеры”, “Наполнение”; в публичной галерее объекта появятся три hover-овала для фильтрации фото по этим разделам.

Изменение затронет БД, API-контракт, shared-типы, админскую модалку медиа и публичную галерею объекта. Новые библиотеки не добавлять.

## Public API / Types

- [x] Добавить в `apps/api/prisma/schema.prisma` enum `ObjectImageSection`:
  `ARCHITECTURE`, `INTERIORS`, `FILLING` с DB-values `architecture`, `interiors`, `filling`.
- [x] Добавить в `ObjectImage` поле `section ObjectImageSection? @map("section")`.
- [x] Создать миграцию `apps/api/prisma/migrations/20260515120000_add_object_image_sections/migration.sql`:
  `CREATE TYPE`, `ALTER TABLE object_images ADD COLUMN section`, индекс `object_images_object_id_section_idx`.
- [x] Обновить `packages/shared/src/index.ts`:
  `export type ObjectImageSection = 'ARCHITECTURE' | 'INTERIORS' | 'FILLING';`
  и `ObjectImage.section: ObjectImageSection | null`.
- [x] В `ObjectsService` и `MapService` сериализовать `section` во всех местах, где возвращается `ObjectImage`.
- [x] Расширить `PATCH /objects/:id/gallery/layout`: принимать опциональное `imageSections: Record<imageId, ObjectImageSection | null>`.
- [x] Если `imageSections` не передан, сохранять существующие разделы без изменений.
- [x] Если `imageSections` передан, требовать, чтобы ключи точно совпадали с `imageIds`; невалидные значения отклонять `BadRequestException`.

## Implementation Checklist

### Backend

- [x] Обновить Prisma schema и добавить SQL-миграцию.
- [x] Выполнить `pnpm db:generate` после изменения Prisma schema.
- [x] Добавить парсер `imageSections` в `ObjectsService`: только объект, только UUID-ключи из текущей галереи, значения `ARCHITECTURE | INTERIORS | FILLING | null`.
- [x] В `updateGalleryLayout` вычислять `hasSectionChanges` вместе с order/cover changes.
- [x] В транзакции `updateGalleryLayout` обновлять `section` только когда `imageSections` передан.
- [x] В audit metadata для `object.gallery.layout` добавить `imageSections` в `before` и `after`, когда разделы менялись.
- [x] Не менять upload endpoints: новые изображения сначала грузятся без раздела, затем получают раздел через layout patch.
- [x] Не менять WordPress-import поведение: импортированные и старые изображения остаются с `section = null`.

### Admin UI

- [x] В `ObjectsAdminPage.tsx` импортировать `ObjectImageSection`.
- [x] Добавить константу `gallerySectionOptions` с labels:
  `Архитектура`, `Интерьеры`, `Наполнение`.
- [x] Расширить `GalleryDraftItem`: `section: ObjectImageSection | null`.
- [x] В `createGalleryDraftItems` брать `section` из `image.section`; в `createNewGalleryDraftItems` ставить `section: null`.
- [x] Добавить обработчик `assignGalleryDraftSection(draftId, section)`; при выборе нового раздела он заменяет старый, при очистке ставит `null`.
- [x] Передать `onGalleryDraftSectionChange` в `GalleryManagementModal`.
- [x] В модалке оставить существующий cover-slot сверху.
- [x] Ниже cover-slot добавить три `gallery-section-slot` drop-зоны: “Архитектура”, “Интерьеры”, “Наполнение”.
- [x] Каждая section-зона показывает count назначенных фото и компактный список/миниатюры первых фото; пустая зона показывает спокойный placeholder.
- [x] Drag tile на section-зону назначает фото в этот раздел, не меняя порядок и не влияя на `isCover`.
- [x] В карточке фото показывать статус-чип выбранного раздела рядом с `Новое` и `Обложка`.
- [x] Добавить компактный `select` “Раздел” на карточке фото для клавиатурного/без-drag управления: `Без раздела`, `Архитектура`, `Интерьеры`, `Наполнение`.
- [x] При сохранении галереи отправлять в layout patch:
  `imageIds`, `coverImageId`, `imageSections`.
- [x] Обновить CSS модалки: сетка из 3 section-зон на desktop, одна колонка на mobile, focus/drop states в стиле текущего cover-slot.

### Public Object Gallery

- [x] В `ObjectImageCarousel` добавить state `activeSection: ObjectImageSection | null`.
- [x] Добавить `sectionOptions` с теми же тремя labels.
- [x] Считать `filteredImages`: без фильтра все фото, с фильтром только фото с выбранным `section`.
- [x] Повторный клик по активному овалу сбрасывает фильтр.
- [x] При смене фильтра сбрасывать `activeIndex` и `lightboxIndex` в безопасное состояние.
- [x] Counter, стрелки, thumbnails и lightbox должны работать внутри текущего набора `filteredImages`.
- [x] В зоне над thumbnails добавить `carousel-section-filters` с тремя pill-кнопками.
- [x] Кнопки изначально `opacity: 0; pointer-events: none`, появляются на hover/focus той же нижней control-zone, что и thumbnails.
- [x] На touch-устройствах сделать section-фильтры видимыми всегда, как текущие thumbnails.
- [x] Если у объекта нет ни одного фото с разделом, section-фильтры не рендерить.
- [x] Если у конкретного раздела нет фото, соответствующий овал показывать disabled.

## Test Plan

- [x] API schema test: enum, column, индекс и миграция для `object_image_section`.
- [x] API service tests:
  layout сохраняет порядок, обложку и `section`;
  layout сохраняет старые sections, если `imageSections` не передан;
  layout отклоняет неизвестный image id или невалидный section.
- [x] API contract test: `updateGalleryLayout` принимает тело с `imageSections`.
- [x] Web admin tests:
  draft state хранит `section`;
  модалка содержит три section drop-зоны;
  save payload содержит `imageSections`;
  tile показывает section label.
- [x] Web style tests:
  section-зоны модалки адаптивны;
  gallery filter pills скрыты до hover/focus и видимы на touch.
- [x] Object detail tests:
  есть `activeSection`;
  повторный click сбрасывает фильтр;
  thumbnails/counter работают по `filteredImages`.
- [x] Проверить командами:
  `pnpm --filter @platforma/api test`,
  `pnpm --filter @platforma/web test`,
  `pnpm build:api`,
  `pnpm build:web`.

## Manual QA

- [ ] В админке открыть объект, загрузить несколько фото, назначить часть в “Архитектура”, “Интерьеры”, “Наполнение”.
- [ ] Проверить, что одно фото не может быть сразу в двух тематических разделах.
- [ ] Проверить, что фото может быть одновременно `Обложка` и, например, `Архитектура`.
- [ ] Сохранить, закрыть и снова открыть модалку: ярлыки должны сохраниться.
- [ ] На странице объекта проверить hover-овалы над thumbnails.
- [ ] Клик по “Архитектура” показывает только архитектурные фото; повторный клик возвращает всю галерею.
- [ ] Проверить desktop и mobile/touch поведение.

## Assumptions

- Фото имеет максимум один тематический раздел; это подтверждено.
- Старые и импортированные фото получают `section = null`.
- Три овала в публичной галерее показываются только если у объекта есть хотя бы одно размеченное фото.
- Пустые разделы в публичной галерее отображаются disabled, чтобы не открывать пустую подборку.
- Первый backend/API блок реализован. Спорное место одно: disabled-поведение пустых овалов можно поменять перед реализацией публичной галереи.
