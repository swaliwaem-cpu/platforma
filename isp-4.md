# План реализации полей Архитектура, Инфраструктура и Наполнение

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** разделить импортированный текст объекта на основное `Описание` и три отдельные поля карточки: `Архитектура`, `Инфраструктура`, `Наполнение`.

**Architecture:** добавить first-class nullable text-поля в Prisma/API/shared, вывести их в админке сразу после `Описание`, на публичной карточке показать отдельным блоком сразу после секции описания. WordPress import заполняет поля позиционно: `opisanie_3`, `opisanie_4_1`, `opisanie_4_2`.

**Tech Stack:** NestJS, Prisma, React, Vite, shared TypeScript types, `tools/wp-import`.

---

## Правило выполнения

- Каждый пункт выполнения отмечается чекбоксом.
- Невыполненный пункт: `[ ]`.
- Выполненный пункт: `[x]`.
- По мере выполнения нужно обновлять этот файл и менять `[ ]` на `[x]`.
- Изменения делать небольшими блоками: сначала контракт данных, затем API, затем импорт, затем админка, затем публичная карточка, затем проверки.
- Не добавлять новые библиотеки, зависимости, сборщики или фреймворки.
- Не откатывать существующие изменения в рабочем дереве, если они не относятся к этой задаче.

## Важно

- [x] Создать файл `isp-4.md` с этим планом.
- [x] Перед правками проверить `git status --short`; рабочее дерево уже содержит изменения по карточке, админке и импорту, их не откатывать.
- [x] Перед началом реализации ещё раз проверить `git status --short`, если между сохранением плана и выполнением будут новые изменения.
- [x] Не добавлять новые библиотеки, зависимости, сборщики или фреймворки.

## Решения

- [x] Использовать фиксированный маппинг WordPress:
  - `description` <- `opisanie_2`, fallback только `post_content`;
  - `architectureDescription` <- `opisanie_3`;
  - `infrastructureDescription` <- `opisanie_4_1`;
  - `fillingDescription` <- `opisanie_4_2`.
- [x] Не использовать `korotkoe_opisanie` для публичного описания и новых полей.
- [x] Не делать SQL backfill из старого `featuresJson.textSections`, чтобы не ошибиться при пустых исходных секциях; существующие объекты обновлять через повторный WordPress import.
- [x] В публичной карточке показывать все три поля после описания; пустое значение отображать как `Не заполнено`.

## Implementation Checklist

### Этап 1. Контракт БД и API

- [x] Добавить в `apps/api/prisma/schema.prisma` поля `RealEstateObject`:
  - `architectureDescription String? @map("architecture_description")`;
  - `infrastructureDescription String? @map("infrastructure_description")`;
  - `fillingDescription String? @map("filling_description")`.
- [x] Создать миграцию `apps/api/prisma/migrations/20260511130000_add_object_content_sections/migration.sql` с тремя nullable `TEXT` колонками без backfill.
- [x] Запустить `pnpm db:generate`.
- [x] В `packages/shared/src/index.ts` добавить эти три поля в `RealEstateObjectBase` как `string | null`.

### Этап 2. `ObjectsService`

- [x] В `CreateObjectBody` и `UpdateObjectBody` добавить:
  - `architectureDescription?: unknown`;
  - `infrastructureDescription?: unknown`;
  - `fillingDescription?: unknown`.
- [x] В `create()` парсить поля через `parseNullableText(..., 10000)` и сохранять в `realEstateObject.create`.
- [x] В `update()` обрабатывать очистку пустой строки в `null`, сравнение с текущим значением, `changes` и `hasScalarChanges`.
- [x] В `serializeObjectBase()` вернуть три новых поля в API response.
- [x] В `toAuditSnapshot()` добавить три новых поля.
- [x] Не добавлять новые поля в publish requirements.

### Этап 3. WordPress Import

- [x] В `tools/wp-import/src/types.ts` добавить поля в `MappedObject`:
  - `architectureDescription: string | null`;
  - `infrastructureDescription: string | null`;
  - `fillingDescription: string | null`.
- [x] В `tools/wp-import/src/mapper.ts` изменить `buildDescription()`:
  - сначала `firstLongText(meta, 'opisanie_2')`;
  - затем `normalizeText(stripHtml(post.post_content))`;
  - не склеивать `opisanie_3`, `opisanie_4_1`, `opisanie_4_2`, `opisanie_5`.
- [x] В `mapObject()` заполнить:
  - `architectureDescription: firstLongText(meta, 'opisanie_3')`;
  - `infrastructureDescription: firstLongText(meta, 'opisanie_4_1')`;
  - `fillingDescription: firstLongText(meta, 'opisanie_4_2')`.
- [x] В `tools/wp-import/src/importer.ts` добавить эти поля в `data` для create/update импортируемого объекта.
- [x] Оставить `featuresJson` как технический JSON-след, но frontend больше не должен брать из него описание.

### Этап 4. Админка объекта

- [x] В `apps/web/src/admin/ObjectsAdminPage.tsx` добавить поля в `ObjectFormState`, `emptyForm`, `createFormFromObject()` и `createPayloadFromForm()`.
- [x] В секции `Основные данные` вставить после textarea `Описание` три textarea:
  - `object-architecture-description`, label `Архитектура`;
  - `object-infrastructure-description`, label `Инфраструктура`;
  - `object-filling-description`, label `Наполнение`.
- [x] Поле `Планировки и цены` оставить после новых textarea.
- [x] В `validateObjectForm()` добавить лимит 10000 символов для каждого из трех полей.
- [x] Не менять permissions, publish workflow, загрузку медиа/PDF и JSON-панель.

### Этап 5. Публичная карточка

- [x] В `apps/web/src/objects/objectDetailViewModel.ts` добавить helper `getObjectContentSections(object)` с тремя строками: `Архитектура`, `Инфраструктура`, `Наполнение`.
- [x] В `ObjectDetailPage.tsx` изменить `getDescriptionParagraphs()` так, чтобы он использовал только `object.description`.
- [x] В JSX добавить секцию сразу после `Описание и особенности` и до `Файлы и документы`.
- [x] Для каждого поля показывать label и абзацы текста; если значение пустое, показывать `Не заполнено`.
- [x] В `apps/web/src/styles.css` добавить спокойную responsive-сетку для новых текстовых полей без декоративных hero/card-in-card эффектов.

### Этап 6. Тесты

- [x] Расширить `apps/api/tests/services.test.cjs`:
  - helper `objectRecord()` с новыми `null` полями;
  - create сохраняет и сериализует три поля;
  - update очищает поля в `null`;
  - create отклоняет значение длиннее 10000 символов.
- [x] Обновить `tools/wp-import/tests/mapper.test.cjs`:
  - `description` равен `opisanie_2`;
  - три новых поля равны `opisanie_3`, `opisanie_4_1`, `opisanie_4_2`;
  - `korotkoe_opisanie` не используется.
- [x] Обновить `apps/web/tests/short-description-removal.test.mjs`: публичное описание не должно fallback-иться к `object.shortDescription` или `featuresJson.textSections`.
- [x] Добавить/расширить web static test, который проверяет наличие новых admin ids и публичного блока новых полей.

### Этап 7. Verification

- [x] Запустить `pnpm db:generate`.
- [x] Запустить `pnpm --filter @platforma/api test`.
- [x] Запустить `pnpm --filter @platforma/wp-import test`.
- [x] Запустить `pnpm build:web`.
- [x] Запустить `pnpm wp-import:preview` с локальными WP env и проверить, что новые поля заполняются в preview без неожиданных warnings/errors.
- [x] После подтверждения отдельно выполнить `pnpm wp-import:run`, чтобы существующие импортированные объекты получили новые поля и очищенное `description`.

## Manual QA

- [ ] В `/admin/objects/:id/edit` проверить, что поля стоят сразу после `Описание`.
- [ ] Сохранить объект с заполненными тремя полями и проверить, что они возвращаются после перезагрузки формы.
- [ ] Очистить поля, сохранить и проверить `Не заполнено` на публичной карточке.
- [ ] Открыть импортированный объект и проверить порядок: описание -> архитектура/инфраструктура/наполнение -> файлы.
- [ ] Проверить desktop и mobile: текст не выходит за контейнер, секция не ломает ширину карточки.

## Assumptions

- Новые поля являются длинными текстовыми описаниями, поэтому хранятся как nullable `TEXT`, не `VarChar`.
- Названия в UI фиксированные, исходные `zagolovok_3/4/5` не показываются.
- `opisanie_5` пока не выводится отдельным новым полем; это текст расположения, не часть тройки `Архитектура / Инфраструктура / Наполнение`.
