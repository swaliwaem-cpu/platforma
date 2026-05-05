# Стек и план реализации закрытой внутренней платформы недвижимости

## 0. Контекст проекта

Проект — закрытая внутренняя платформа для работы с объектами недвижимости.

На текущем этапе нужны:

- личный кабинет;
- роли `admin`, `editor`, `user`;
- каталог объектов недвижимости;
- фильтры;
- карточки объектов;
- детальная страница объекта;
- Яндекс.Карта с геометкой конкретного объекта;
- режим карты для каталога;
- админка для управления объектами;
- админка для управления пользователями;
- импорт объектов с текущего сайта на WordPress через прямой доступ к базе данных WordPress.

SEO, публичная индексация, sitemap, OpenGraph, старые URL и 301-редиректы не нужны, потому что платформа закрытая и внутренняя.

Будущие CRM, обучение, тесты, курсы и прочие расширения на данном этапе не реализуются. Архитектуру стоит держать аккуратной, но не надо строить лишние модули заранее.

---

# 1. Рекомендуемый стек

## 1.1. Итоговый стек

```txt
Frontend:
React + TypeScript + Vite

Backend:
NestJS + TypeScript

Database:
PostgreSQL + PostGIS

ORM:
Prisma

Cache / background jobs:
Redis + BullMQ

Maps:
Yandex Maps JS API

Storage:
S3-compatible storage или локальное файловое хранилище на первом этапе

Admin:
Встроенная админка на React

Auth:
JWT access token + refresh token в httpOnly cookies

Infrastructure:
Docker + Docker Compose

Local development:
macOS + VS Code + Codex + Node.js + pnpm + Docker Desktop
```

## 1.2. Почему React + Vite, а не Next.js

Так как платформа закрытая и внутренняя, SEO и серверный рендеринг не являются приоритетом.

Для этого проекта лучше подходит:

```txt
React + Vite
```

Плюсы:

- проще структура;
- быстрее разработка;
- проще деплой как SPA;
- меньше фреймворк-магии;
- отлично подходит для кабинетов, админок и внутренних систем;
- хорошо работает с API backend.

Next.js можно не брать на старте. Он полезнее для публичных сайтов, где важны SEO, SSR, индексация и метаданные.

---

# 2. Архитектурный подход

## 2.1. Модульный монолит

Рекомендуемый подход:

```txt
Модульный монолит
```

Это значит:

- один backend-проект;
- одна база данных;
- модули внутри backend разделены по зонам ответственности;
- без микросервисов;
- без преждевременного усложнения.

Почему так лучше:

- быстрее разработка;
- проще отладка;
- проще деплой;
- проще миграция данных;
- проще поддерживать одному разработчику;
- достаточно для текущей задачи.

---

# 3. Структура проекта

Рекомендуется монорепозиторий:

```txt
real-estate-platform/
  apps/
    web/
      src/
    api/
      src/

  packages/
    shared/
      src/

  tools/
    wp-import/
      src/

  docker-compose.yml
  package.json
  pnpm-workspace.yaml
  README.md
```

## 3.1. apps/web

Frontend-приложение:

```txt
apps/web/
  src/
    app/
      App.tsx
      router.tsx
      providers.tsx

    pages/
      LoginPage/
      CatalogPage/
      MapPage/
      ObjectDetailsPage/
      CabinetPage/
      AdminDashboardPage/
      AdminObjectsPage/
      AdminObjectEditPage/
      AdminUsersPage/
      AdminImportPage/

    entities/
      object/
      user/
      developer/
      location/
      metro/

    features/
      auth/
      object-filters/
      object-card/
      object-map/
      object-gallery/
      admin-object-form/
      admin-user-form/
      wordpress-import/

    shared/
      api/
      config/
      lib/
      ui/
      types/
```

## 3.2. apps/api

Backend-приложение:

```txt
apps/api/
  src/
    main.ts

    modules/
      auth/
      users/
      roles/
      permissions/
      objects/
      developers/
      locations/
      metro/
      media/
      files/
      maps/
      wordpress-import/
      audit-log/

    common/
      guards/
      decorators/
      filters/
      pipes/
      interceptors/

    config/
      app.config.ts
      db.config.ts
      auth.config.ts
      storage.config.ts
```

## 3.3. tools/wp-import

Отдельный инструмент для импорта из базы WordPress:

```txt
tools/wp-import/
  src/
    index.ts
    config.ts

    clients/
      wordpress-db.client.ts

    mappers/
      object.mapper.ts
      developer.mapper.ts
      location.mapper.ts
      metro.mapper.ts
      media.mapper.ts

    services/
      import-preview.service.ts
      import-commit.service.ts
      media-import.service.ts
      validation.service.ts

    reports/
      import-report.json
```

---

# 4. Frontend-стек

## 4.1. Основные библиотеки

```txt
react
react-dom
typescript
vite
react-router-dom
@tanstack/react-query
zustand
react-hook-form
zod
@hookform/resolvers
tailwindcss
shadcn/ui
lucide-react
axios
```

## 4.2. Для карты

```txt
Yandex Maps JS API
```

Варианты подключения:

- через официальный JS API;
- через собственный wrapper-компонент;
- не тащить карту в основной bundle, грузить лениво.

## 4.3. Для таблиц в админке

Рекомендуется:

```txt
@tanstack/react-table
```

Нужно для:

- списка объектов;
- списка пользователей;
- списка импортированных записей;
- фильтрации;
- сортировки;
- пагинации.

## 4.4. Для галереи

Можно использовать:

```txt
embla-carousel-react
```

или более простой вариант на первом этапе — собственный компонент галереи.

---

# 5. Backend-стек

## 5.1. Основные библиотеки

```txt
@nestjs/core
@nestjs/common
@nestjs/config
@nestjs/jwt
@nestjs/passport
passport
passport-jwt
prisma
@prisma/client
argon2
cookie-parser
class-validator
class-transformer
multer
bullmq
ioredis
```

## 5.2. Почему NestJS

NestJS хорошо подходит для этого проекта, потому что нужны:

- роли;
- guards;
- permissions;
- модули;
- понятная структура;
- админские endpoints;
- импорт;
- загрузка файлов;
- работа с базой;
- фоновая обработка медиа.

Express тоже можно использовать, но NestJS лучше удержит проект в нормальной архитектуре.

---

# 6. База данных

## 6.1. Основная база

```txt
PostgreSQL + PostGIS
```

PostgreSQL нужен для основных данных.

PostGIS нужен для координат и будущих геозапросов внутри текущей задачи:

- объект на карте;
- объекты в видимой области карты;
- поиск объектов рядом с точкой;
- фильтрация по координатам.

---

# 7. Основные сущности текущего этапа

## 7.1. User

```txt
id
email
passwordHash
firstName
lastName
phone
avatarFileId
roleId
status
createdAt
updatedAt
```

Статусы:

```txt
active
blocked
invited
```

## 7.2. Role

```txt
id
name
code
createdAt
updatedAt
```

Роли:

```txt
admin
editor
user
```

## 7.3. Permission

```txt
id
code
description
createdAt
updatedAt
```

Примеры permissions:

```txt
objects.read
objects.create
objects.update
objects.delete
objects.publish

users.read
users.create
users.update
users.delete

import.wordpress.preview
import.wordpress.run

audit.read
```

## 7.4. RolePermission

```txt
roleId
permissionId
```

## 7.5. RealEstateObject

```txt
id
slug
title
status

developerId
locationId

address
latitude
longitude

description
features

completionQuarter
completionYear

priceFrom
pricePerMeterFrom

presentationFileId

createdById
updatedById

createdAt
updatedAt
publishedAt
```

Статусы:

```txt
draft
published
archived
```

## 7.6. Developer

```txt
id
name
slug
description
logoFileId
createdAt
updatedAt
```

## 7.7. Location

```txt
id
name
slug
type
description
createdAt
updatedAt
```

Типы:

```txt
district
krt
area
custom
```

## 7.8. MetroStation

```txt
id
name
line
latitude
longitude
createdAt
updatedAt
```

## 7.9. ObjectMetroStation

```txt
objectId
metroStationId
distanceMinutes
transportType
```

Типы транспорта:

```txt
walk
car
public_transport
```

## 7.10. File

```txt
id
storageKey
url
mimeType
size
originalName
createdById
createdAt
```

## 7.11. ObjectImage

```txt
id
objectId
fileId
alt
sortOrder
isCover
createdAt
```

## 7.12. ObjectFile

```txt
id
objectId
fileId
type
title
sortOrder
createdAt
```

Типы:

```txt
presentation
price_list
floor_plan
document
```

## 7.13. AuditLog

```txt
id
userId
action
entityType
entityId
beforeJson
afterJson
createdAt
```

## 7.14. ImportReport

```txt
id
mode
status
totalObjects
importedObjects
skippedObjects
failedObjects
warningsJson
errorsJson
createdAt
finishedAt
```

---

# 8. Роли и права

## 8.1. Матрица доступа

| Действие | User | Editor | Admin |
|---|---:|---:|---:|
| Вход в личный кабинет | Да | Да | Да |
| Смотреть каталог | Да | Да | Да |
| Смотреть страницу объекта | Да | Да | Да |
| Смотреть карту | Да | Да | Да |
| Смотреть админку | Нет | Да | Да |
| Создавать объект | Нет | Да | Да |
| Редактировать объект | Нет | Да | Да |
| Архивировать объект | Нет | Нет/по разрешению | Да |
| Публиковать объект | Нет | По разрешению | Да |
| Смотреть пользователей | Нет | Нет | Да |
| Создавать пользователей | Нет | Нет | Да |
| Менять роли | Нет | Нет | Да |
| Запускать импорт | Нет | Нет | Да |
| Смотреть audit log | Нет | Нет | Да |

## 8.2. Важный принцип

Frontend может скрывать кнопки, но безопасность должна быть на backend.

То есть нельзя полагаться только на:

```txt
if role === "admin"
```

в React.

Каждый защищённый endpoint должен проверять права на backend.

---

# 9. Авторизация

## 9.1. Схема

```txt
access token: короткий срок жизни
refresh token: httpOnly cookie
```

## 9.2. Endpoints

```txt
POST /auth/login
POST /auth/logout
POST /auth/refresh
GET /auth/me
```

## 9.3. Безопасность

Обязательно:

- хешировать пароли через Argon2id;
- хранить refresh token в httpOnly cookie;
- не хранить access/refresh token в localStorage;
- включить rate limit на login;
- валидировать входящие данные;
- логировать действия admin/editor;
- проверять permissions на backend;
- закрыть API от внешнего публичного доступа, если платформа полностью внутренняя.

---

# 10. API текущего этапа

## 10.1. Auth

```txt
POST /auth/login
POST /auth/logout
POST /auth/refresh
GET /auth/me
```

## 10.2. Objects

```txt
GET /objects
GET /objects/:id
GET /objects/slug/:slug
POST /objects
PATCH /objects/:id
DELETE /objects/:id
POST /objects/:id/publish
POST /objects/:id/archive
```

## 10.3. Filters dictionaries

```txt
GET /developers
GET /locations
GET /metro
```

## 10.4. Map

```txt
GET /map/objects
GET /map/objects/:id
```

## 10.5. Users

```txt
GET /users
GET /users/:id
POST /users
PATCH /users/:id
DELETE /users/:id
PATCH /users/:id/role
PATCH /users/:id/status
```

## 10.6. Files

```txt
POST /files/upload
GET /files/:id
DELETE /files/:id
```

## 10.7. WordPress import

```txt
GET /wordpress-import/preview
POST /wordpress-import/run
GET /wordpress-import/reports
GET /wordpress-import/reports/:id
```

## 10.8. Audit

```txt
GET /audit-log
```

---

# 11. Frontend-страницы

## 11.1. Auth

```txt
/login
```

## 11.2. Пользовательская часть

```txt
/
/catalog
/catalog/map
/objects/:slug
/cabinet
```

## 11.3. Админка

```txt
/admin
/admin/objects
/admin/objects/new
/admin/objects/:id/edit
/admin/users
/admin/users/:id
/admin/import
/admin/audit-log
```

---

# 12. Каталог и фильтры

## 12.1. Фильтры MVP

Нужны:

- поиск по названию;
- застройщик;
- район/локация;
- метро;
- срок сдачи;
- цена от;
- цена за м²;
- статус;
- наличие презентации;
- наличие координат.

## 12.2. Где хранить состояние фильтров

Фильтры лучше хранить в URL query params:

```txt
/catalog?q=мастерс&developer=capital-group&metro=aeroport
```

Плюсы:

- можно обновить страницу без потери фильтров;
- можно отправить ссылку другому пользователю;
- проще отлаживать.

## 12.3. Где фильтровать

Фильтрация должна выполняться на backend.

Frontend только отправляет параметры:

```txt
GET /objects?q=мастерс&developerId=1&metroId=4&status=published
```

Backend:

- валидирует query;
- применяет фильтры;
- возвращает пагинированный список.

---

# 13. Яндекс.Карта

## 13.1. Что нужно реализовать

### На странице объекта

- карта;
- одна геометка объекта;
- подпись/балун;
- fallback, если координат нет.

### В каталоге

- карта всех объектов;
- геометки объектов;
- карточка объекта при клике на marker;
- переход на страницу объекта;
- кластеризация, если объектов много.

## 13.2. Как хранить координаты

В объекте:

```txt
latitude
longitude
address
```

Дополнительно можно использовать PostGIS field:

```txt
coordinates geometry(Point, 4326)
```

## 13.3. Производительность

Карту не нужно грузить сразу вместе со всем приложением.

Лучше:

- lazy load компонента карты;
- отдельный chunk;
- skeleton/loading state;
- не грузить карту на страницах, где она не нужна.

---

# 14. Админка

## 14.1. Минимальная админка

Нужно реализовать:

- вход;
- dashboard;
- список объектов;
- создание объекта;
- редактирование объекта;
- публикация объекта;
- архивация объекта;
- загрузка изображений;
- сортировка галереи;
- загрузка презентации;
- список пользователей;
- создание пользователя;
- смена роли;
- блокировка пользователя;
- просмотр import preview;
- запуск импорта;
- просмотр import report;
- audit log.

## 14.2. Форма объекта

Поля:

- название;
- slug;
- статус;
- застройщик;
- район/локация;
- адрес;
- координаты;
- метро;
- срок сдачи;
- цена от;
- цена за метр;
- описание;
- особенности;
- обложка;
- галерея;
- презентация;
- планировки/файлы.

## 14.3. UX в админке

Нужно предусмотреть:

- черновик;
- публикация;
- архив;
- обязательные поля;
- предпросмотр карточки;
- предпросмотр страницы объекта;
- drag-and-drop сортировку изображений;
- поиск по объектам;
- фильтр по статусу;
- лог ошибок импорта.

---

# 15. Медиа и файлы

## 15.1. Рекомендуемый подход

На первом этапе можно выбрать один из двух вариантов.

### Вариант A: S3-compatible storage

Лучше для production.

Подходит:

```txt
Yandex Object Storage
Selectel S3
AWS S3
MinIO
```

### Вариант B: локальное файловое хранилище

Можно использовать на самом старте, если платформа будет запускаться локально или на одном сервере.

Минус: потом миграция в S3 всё равно понадобится.

## 15.2. Что хранить

- изображения объектов;
- обложки;
- презентации;
- планировки;
- прайс-листы;
- документы;
- аватары пользователей.

## 15.3. В базе хранить только metadata

Файлы не хранить в PostgreSQL.

В базе:

```txt
url
storageKey
mimeType
size
originalName
```

---

# 16. Импорт из WordPress через прямой доступ к базе

## 16.1. Источник данных

Миграция выполняется через прямой read-only доступ к базе WordPress.

Обычно WordPress использует MySQL/MariaDB.

Нужны таблицы:

```txt
wp_posts
wp_postmeta
wp_terms
wp_term_taxonomy
wp_term_relationships
wp_options
```

Также могут быть нужны таблицы плагинов, если объекты и поля хранятся нестандартно.

---

## 16.2. Что нужно узнать до импорта

Перед написанием миграции нужно провести аудит WordPress-базы:

- какой post type у объектов;
- где лежат названия;
- где лежат описания;
- где лежат slug;
- где лежит статус публикации;
- где лежит застройщик;
- где лежит район/локация;
- где лежит метро;
- где лежит цена;
- где лежит срок сдачи;
- где лежит адрес;
- где лежат координаты;
- где лежит обложка;
- где лежит галерея;
- где лежит презентация;
- используются ли ACF-поля;
- какие meta_key отвечают за нужные данные;
- как связаны attachments с объектами.

---

## 16.3. Режимы импорта

Нужно сделать два режима:

```txt
1. Preview / dry-run
2. Commit / actual import
```

### Preview / dry-run

Скрипт подключается к WordPress-базе, читает данные и формирует отчёт.

В новую базу ничего не записывает.

Отчёт должен показывать:

- сколько объектов найдено;
- сколько объектов распознано корректно;
- сколько объектов без названия;
- сколько объектов без slug;
- сколько объектов без координат;
- сколько объектов без изображений;
- сколько объектов без застройщика;
- сколько объектов без цены;
- какие meta_key не распознаны;
- какие attachments не найдены;
- какие файлы недоступны.

### Commit / actual import

Скрипт:

- создаёт застройщиков;
- создаёт локации;
- создаёт метро;
- создаёт объекты;
- переносит координаты;
- переносит цены;
- переносит описания;
- переносит изображения;
- переносит презентации;
- создаёт связи;
- сохраняет import report;
- пишет audit log.

---

## 16.4. Подключение к WordPress-базе

Для импорта нужен отдельный read-only пользователь MySQL.

Пример env:

```env
WP_DB_HOST=127.0.0.1
WP_DB_PORT=3306
WP_DB_USER=wp_readonly
WP_DB_PASSWORD=password
WP_DB_NAME=wordpress
WP_TABLE_PREFIX=wp_
```

Важно:

- не использовать root-пользователя;
- не писать в WordPress-базу;
- сначала делать import preview;
- commit запускать только после проверки отчёта.

---

## 16.5. Базовый SQL для поиска объектов

Примерный запрос:

```sql
SELECT
  ID,
  post_title,
  post_name,
  post_content,
  post_status,
  post_type,
  post_date,
  post_modified
FROM wp_posts
WHERE post_type = 'estate_object'
  AND post_status IN ('publish', 'draft');
```

`estate_object` здесь условный post type. Его нужно заменить на реальный post type из WordPress.

---

## 16.6. Базовый SQL для meta-полей

```sql
SELECT
  post_id,
  meta_key,
  meta_value
FROM wp_postmeta
WHERE post_id IN (...);
```

ACF обычно хранит значения в `wp_postmeta`, а названия полей — через `meta_key`.

Пример:

```txt
price_from
developer
metro
latitude
longitude
gallery
presentation
```

Реальные ключи нужно определить во время аудита.

---

## 16.7. Маппинг WordPress → новая база

| WordPress | Новая база |
|---|---|
| `wp_posts.post_title` | `RealEstateObject.title` |
| `wp_posts.post_name` | `RealEstateObject.slug` |
| `wp_posts.post_content` | `RealEstateObject.description` |
| `wp_posts.post_status` | `RealEstateObject.status` |
| `wp_postmeta.price_from` | `RealEstateObject.priceFrom` |
| `wp_postmeta.price_meter_from` | `RealEstateObject.pricePerMeterFrom` |
| `wp_postmeta.completion_quarter` | `RealEstateObject.completionQuarter` |
| `wp_postmeta.completion_year` | `RealEstateObject.completionYear` |
| `wp_postmeta.latitude` | `RealEstateObject.latitude` |
| `wp_postmeta.longitude` | `RealEstateObject.longitude` |
| developer taxonomy/meta | `Developer` |
| location taxonomy/meta | `Location` |
| metro taxonomy/meta | `MetroStation` + `ObjectMetroStation` |
| featured image attachment | `ObjectImage.isCover` |
| gallery meta/attachments | `ObjectImage[]` |
| presentation attachment | `ObjectFile type=presentation` |

---

## 16.8. Импорт attachments и медиа

WordPress attachments обычно лежат в `wp_posts` с:

```txt
post_type = attachment
```

URL часто собирается через:

```txt
wp-content/uploads/...
```

Алгоритм:

```txt
1. Найти attachment ID
2. Получить путь файла из wp_postmeta, например _wp_attached_file
3. Собрать полный URL или путь к файлу
4. Скачать или скопировать файл
5. Проверить MIME type
6. Загрузить в новое хранилище
7. Создать запись File
8. Связать File с объектом
```

## 16.9. Отчёт импорта

Каждый запуск импорта должен создавать отчёт:

```txt
ImportReport
  id
  mode
  status
  totalObjects
  importedObjects
  skippedObjects
  failedObjects
  warningsJson
  errorsJson
  createdAt
  finishedAt
```

Файл отчёта:

```txt
tools/wp-import/reports/import-YYYY-MM-DD-HH-mm.json
```

## 16.10. Повторяемость импорта

Импорт должен быть идемпотентным.

То есть повторный запуск не должен создавать дубликаты.

Нужно использовать ключи:

```txt
wpPostId
slug
```

Можно добавить поля:

```txt
RealEstateObject.wpPostId
File.wpAttachmentId
Developer.wpTermId
Location.wpTermId
MetroStation.wpTermId
```

После финального импорта эти поля можно оставить как технические.

---

# 17. Пошаговый план реализации

## Этап 0. Подготовка окружения

Задачи:

- установить инструменты на macOS;
- создать репозиторий;
- настроить VS Code;
- настроить Codex;
- проверить Node.js, pnpm, Docker;
- подготовить `.env.example`.

Результат:

```txt
локальная среда готова к разработке
```

---

## Этап 1. Аудит WordPress-базы

Задачи:

- получить read-only доступ к MySQL/MariaDB WordPress;
- определить post type объектов;
- выгрузить список meta_key;
- определить поля объектов;
- найти связи с таксономиями;
- понять структуру attachments;
- найти координаты;
- найти презентации и галереи;
- составить mapping WordPress → новая БД.

Результат:

```txt
готов документ mapping.md
понятно, какие данные и откуда импортировать
```

---

## Этап 2. Настройка проекта

Задачи:

- создать monorepo;
- создать `apps/web` на Vite;
- создать `apps/api` на NestJS;
- подключить PostgreSQL;
- подключить Redis;
- подключить Prisma;
- настроить Docker Compose;
- настроить ESLint и Prettier;
- сделать healthcheck backend;
- сделать базовый API client на frontend.

Результат:

```txt
frontend и backend запускаются локально
backend подключен к базе
```

---

## Этап 3. Модель базы данных

Задачи:

- описать Prisma schema;
- добавить User;
- добавить Role;
- добавить Permission;
- добавить RolePermission;
- добавить RealEstateObject;
- добавить Developer;
- добавить Location;
- добавить MetroStation;
- добавить ObjectMetroStation;
- добавить File;
- добавить ObjectImage;
- добавить ObjectFile;
- добавить AuditLog;
- добавить ImportReport;
- выполнить первую миграцию;
- сделать seed admin-пользователя.

Результат:

```txt
база готова для основной разработки
есть первый admin
```

---

## Этап 4. Авторизация и роли

Задачи:

- реализовать login;
- реализовать logout;
- реализовать refresh;
- реализовать me;
- реализовать password hashing;
- реализовать guards;
- реализовать permissions;
- закрыть backend endpoints;
- сделать frontend auth provider;
- сделать страницу login;
- сделать protected routes.

Результат:

```txt
пользователь может войти
роли и permissions работают
админка закрыта от обычного пользователя
```

---

## Этап 5. CRUD пользователей

Задачи:

- список пользователей;
- создание пользователя;
- редактирование пользователя;
- смена роли;
- блокировка пользователя;
- удаление/архивация пользователя;
- audit log действий.

Результат:

```txt
admin может управлять пользователями
```

---

## Этап 6. CRUD объектов

Задачи:

- создать API объектов;
- создать список объектов;
- создать детальный endpoint;
- создать создание объекта;
- создать редактирование объекта;
- создать публикацию;
- создать архивацию;
- создать удаление, если нужно;
- добавить связи с застройщиком, локацией, метро;
- добавить работу с координатами.

Результат:

```txt
объектами можно управлять через API
```

---

## Этап 7. Медиа и файлы

Задачи:

- реализовать upload endpoint;
- реализовать File entity;
- реализовать загрузку обложки;
- реализовать загрузку галереи;
- реализовать сортировку галереи;
- реализовать загрузку презентации;
- реализовать удаление файла;
- добавить ограничения на типы и размер файлов.

Результат:

```txt
к объекту можно прикреплять изображения и документы
```

---

## Этап 8. Админка объектов

Задачи:

- список объектов;
- фильтры по статусу;
- поиск;
- форма создания;
- форма редактирования;
- загрузка файлов;
- drag-and-drop сортировка изображений;
- публикация;
- архивация;
- предпросмотр карточки;
- логирование действий.

Результат:

```txt
admin/editor может управлять контентом без прямой работы с базой
```

---

## Этап 9. Каталог

Задачи:

- сверстать страницу каталога;
- сделать карточку объекта;
- подключить список объектов;
- реализовать поиск;
- реализовать фильтры;
- хранить фильтры в URL;
- реализовать пагинацию;
- реализовать loading/error/empty states;
- сделать кнопку перехода на карту.

Результат:

```txt
пользователь видит каталог и может фильтровать объекты
```

---

## Этап 10. Карта каталога и карта объекта

Задачи:

- подключить Yandex Maps JS API;
- сделать базовый компонент карты;
- вывести геометку на странице объекта;
- вывести список геометок в каталоге;
- сделать popup/card при клике;
- сделать переход с карты в объект;
- добавить fallback для объектов без координат;
- добавить кластеризацию при необходимости.

Результат:

```txt
карта работает в каталоге и на странице объекта
```

---

## Этап 11. Детальная страница объекта

Задачи:

- сверстать страницу объекта;
- вывести основные данные;
- вывести галерею;
- вывести презентацию;
- вывести планировки/файлы;
- вывести описание;
- вывести особенности;
- вывести карту;
- добавить кнопку возврата к списку;
- добавить states для отсутствующих данных.

Результат:

```txt
страница объекта полностью работает внутри закрытой платформы
```

---

## Этап 12. Импорт из WordPress

Задачи:

- создать подключение к WordPress MySQL;
- реализовать preview/dry-run;
- сформировать отчёт;
- реализовать mapping;
- реализовать импорт застройщиков;
- реализовать импорт локаций;
- реализовать импорт метро;
- реализовать импорт объектов;
- реализовать импорт координат;
- реализовать импорт изображений;
- реализовать импорт презентаций;
- реализовать commit;
- добавить ImportReport в админку;
- сделать повторный запуск без дубликатов.

Результат:

```txt
объекты из WordPress перенесены в новую систему
есть отчёт по миграции
дубликаты не создаются при повторном запуске
```

---

## Этап 13. Личный кабинет

Задачи:

- сделать базовый layout кабинета;
- вывести профиль пользователя;
- вывести роль;
- вывести доступные разделы;
- скрыть разделы по permissions;
- сделать страницу настроек профиля, если нужно.

Результат:

```txt
у пользователя есть закрытый кабинет
```

---

## Этап 14. Стабилизация перед первым запуском

Задачи:

- проверить роли;
- проверить импорт;
- проверить карточки объектов;
- проверить карту;
- проверить загрузку файлов;
- проверить создание пользователей;
- проверить публикацию объектов;
- проверить архивирование;
- проверить работу фильтров;
- проверить адаптив;
- проверить ошибки API;
- проверить `.env` для production/staging.

Результат:

```txt
платформа готова к первому внутреннему использованию
```

---

# 18. Локальный запуск

## 18.1. Сервисы в Docker Compose

```txt
postgres
redis
minio или локальный storage
api
web
```

## 18.2. Команды проекта

Примерные команды:

```bash
pnpm install

pnpm dev:web
pnpm dev:api

pnpm db:migrate
pnpm db:seed

pnpm wp-import:preview
pnpm wp-import:run
```

---

# 19. Что не реализовывать на текущем этапе

Не реализовывать сейчас:

- SEO;
- sitemap;
- OpenGraph;
- 301 redirects;
- публичные страницы для индексации;
- CRM;
- сделки;
- задачи менеджеров;
- обучение;
- курсы;
- уроки;
- тесты/квизы;
- сертификаты;
- платёжку;
- уведомления;
- сложную аналитику;
- микросервисы.

Важно: не путать “заложить нормальную структуру” и “реализовывать всё заранее”. Сейчас нужна рабочая закрытая платформа по объектам недвижимости.

---

# 20. Главные риски

| Риск | Почему опасно | Что сделать |
|---|---|---|
| Непонятная структура WordPress | Импорт может затянуться | Начать с аудита базы и списка meta_key |
| ACF-поля хранятся нестандартно | Можно потерять данные | Сделать dry-run и отчёт |
| Медиа в WordPress лежат хаотично | Могут не перенестись изображения | Отдельный media import report |
| Нет координат | Карта будет неполной | Выявить на preview и дозаполнить вручную |
| Слабая модель ролей | Потом придётся переписывать доступы | Сразу Role + Permission |
| Админка недоделана | Контент придётся править руками | Админку включить в MVP |
| Нет audit log | Неясно, кто что изменил | Логировать действия admin/editor |
| Слишком много лишних модулей | Проект распухнет | Не делать CRM/LMS/тесты сейчас |

---

# 21. Приоритет реализации

## Сначала

```txt
1. WordPress DB audit
2. База новой платформы
3. Auth + roles
4. CRUD объектов
5. Админка объектов
6. Import preview
```

## Потом

```txt
7. Import commit
8. Каталог
9. Детальная страница
10. Яндекс.Карта
11. Управление пользователями
12. Личный кабинет
```

## В конце

```txt
13. Audit log
14. Полировка UX
15. Production/staging env
16. Первый внутренний запуск
```

---

# 22. Итоговая рекомендация

Финальный стек для текущей задачи:

```txt
React + TypeScript + Vite
NestJS + TypeScript
PostgreSQL + PostGIS
Prisma
Redis + BullMQ
Yandex Maps JS API
S3-compatible storage или локальное хранилище на старте
Docker + Docker Compose
pnpm workspace
```

Главный технический приоритет:

```txt
Сначала разобраться со структурой WordPress-базы и сделать import preview.
```

Без этого можно потратить время на новую платформу, а потом упереться в грязные данные, неизвестные ACF-поля, потерянные attachment-ы и неочевидные связи между объектами.
