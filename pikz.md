# План исправления лагов из-за тяжелых картинок

## Доступ к production

- Server IP: `193.168.48.214`
- SSH user: `root`
- SSH password: не хранить в репозитории; использовать защищенный канал или `/root/platforma-credentials.txt`
- SSH port: `22`
- Project path: `/opt/platforma`
- Frontend: `https://broker.fluffywhite.moscow`
- API: `https://api.broker.fluffywhite.moscow`
- Compose file: `/opt/platforma/docker-compose.prod.yml`
- Env file: `/opt/platforma/.env`
- Credentials file: `/root/platforma-credentials.txt`

**Goal:** убрать долгую загрузку карты, каталога и карточек объектов за счет thumbnails, lazy-load и прекращения массовой загрузки оригинальных изображений.

**Architecture:** оригиналы остаются в MinIO как сейчас, рядом создаются WebP-варианты `thumbnail`, `card`, `detail`. Frontend запрашивает нужный вариант через `/files/:id/content?variant=...`; карта не грузит картинки всех объектов сразу, а только выбранную карточку.

**Tech Stack:** NestJS, Prisma/Postgres, MinIO S3-compatible storage, React/Vite, `sharp`.

---

## 1. Схема и типы

- [x] Добавить зависимость `sharp` в `apps/api/package.json` и `tools/wp-import/package.json`.
- [x] Добавить Prisma enum `FileVariantKind`: `THUMBNAIL`, `CARD`, `DETAIL`.
- [x] Добавить Prisma model `FileVariant` с полями `fileId`, `variant`, `storage`, `bucket`, `key`, `url`, `mimeType`, `width`, `height`, `sizeBytes`, `checksum`, `createdAt`, `updatedAt`.
- [x] Добавить `File.variants FileVariant[]`.
- [x] Создать миграцию `add_file_variants`.
- [x] В `packages/shared/src/index.ts` добавить тип `FileVariant = 'THUMBNAIL' | 'CARD' | 'DETAIL'`.
- [x] Не менять основной shape объектов каталога: frontend будет запрашивать variant через query param.

## 2. Генерация variants

- [x] Создать backend helper `apps/api/src/files/image-variants.ts`.
- [x] Зафиксировать размеры:
  - `THUMBNAIL`: width `240`, WebP quality `68`
  - `CARD`: width `640`, WebP quality `72`
  - `DETAIL`: width `1440`, WebP quality `78`
- [x] Для каждого image-файла генерировать WebP через `sharp`.
- [x] Variant key строить от original key: `wordpress/123/photo.jpg` -> `wordpress/123/photo.card.webp`.
- [x] В `FilesService.uploadFile` после загрузки original image создавать все variants и строки `file_variants`.
- [x] В `FilesService.delete` удалять variants из MinIO перед удалением original.
- [x] В `tools/wp-import` добавить такую же генерацию для новых импортируемых image-вложений.
- [x] Если импорт видит existing image без variants, он должен дозаполнить variants.

## 3. API чтения файлов

- [x] Обновить `FilesController.getContent`: принимать query `variant`.
- [x] Поддержать значения: пусто/`original`, `thumbnail`, `card`, `detail`.
- [x] Если variant отсутствует, вернуть original как fallback и header `X-Platforma-File-Variant: original-fallback`.
- [x] Если variant существует, вернуть header `X-Platforma-File-Variant`.
- [x] Для image responses выставлять `Cache-Control: private, max-age=86400`.
- [x] Для PDF/прочих файлов оставить текущее поведение.

## 4. Backfill существующих медиа

- [x] Создать script `apps/api/src/files/backfill-image-variants.ts`.
- [x] Добавить script `media:variants:backfill`.
- [x] Скрипт должен находить image-файлы, пропускать уже готовые, генерировать недостающие variants и логировать `processed`, `created`, `skipped`, `failed`.
- [x] Скрипт должен завершаться с non-zero exit code, если есть failed файлы.

## 5. Frontend

- [x] Вынести общий `SecureImage` helper/hook с параметром `variant`.
- [x] В каталоге использовать `variant="card"` и lazy-load через `IntersectionObserver`.
- [x] На карте удалить массовый preload всех обложек; грузить `variant="card"` только для выбранного объекта.
- [x] В detail main image грузить `variant="detail"`, thumbnails грузить `variant="thumbnail"`.
- [x] В admin preview/gallery использовать `thumbnail` или `card`; PDF/download flows не менять.

## 6. Тесты и rollout

- [x] Добавить API tests для генерации variants и `/files/:id/content?variant=card`.
- [x] Добавить import tests для создания и дозаполнения variants.
- [x] Добавить web tests: карта не preloads все images, catalog использует `variant=card`, detail thumbnails используют `variant=thumbnail`.
- [x] Запустить `pnpm --filter @platforma/api test`, `pnpm --filter @platforma/wp-import test`, `pnpm --filter @platforma/web test`, `pnpm build`.
- [ ] На prod применить миграцию и запустить `pnpm --filter @platforma/api media:variants:backfill`.
- [ ] Проверить DevTools Network: карта не грузит сотни `/files/:id/content`, выбранный объект грузит один `variant=card`.

## Assumptions

- `sharp` разрешен как новая зависимость.
- Первый этап делаем как полный v1.
- Authenticated file access сохраняется через `/files/:id/content`.
- Public CDN/signed public URLs в этот этап не входят.
- `pikz.md` лежит в корне репозитория.
- Root-пароль нельзя хранить в `pikz.md` и коммитить в Git.
