# Project Context

## Назначение

Platforma — закрытая внутренняя платформа
для брокеров недвижимости.

Основные сценарии:

- авторизация и кабинет пользователя;
- каталог объектов;
- карта объектов;
- карточка объекта;
- административное управление объектами и пользователями;
- импорт данных и медиа.

## Структура репозитория

Проект является `pnpm`-монорепозиторием.

Основные области:

- `apps/web` — frontend;
- `apps/api` — backend API;
- `packages/shared` — контракты и код,
  реально используемый несколькими workspace;
- `tools/wp-import` — импорт и repair данных WordPress;
- `tools/feed-import` — анализ и импорт feed/XML-источников;
- `apps/api/prisma` — Prisma schema, migrations и seed;
- `docker-compose.yml` и Dockerfiles —
  локальная инфраструктура и сборка.

Перед работой всегда сверяй фактическую структуру
с текущей веткой.

## Технологический стек

Frontend:

- React;
- TypeScript;
- Vite;
- существующие UI и CSS-примитивы проекта.

Backend:

- NestJS;
- TypeScript;
- Prisma;
- PostgreSQL/PostGIS;
- JWT/cookie auth;
- server-side RBAC.

Storage:

- S3-compatible storage / MinIO;
- защищённая выдача файлов через backend
  там, где требуется авторизация.

Инфраструктура:

- Docker;
- Docker Compose;
- `pnpm` workspaces.

Точные версии определяются текущими `package.json`,
а не этим документом.

## Источники истины

Фактическое поведение определяется:

1. текущим кодом;
2. `apps/api/prisma/schema.prisma`;
3. существующими migrations;
4. package scripts;
5. актуальными тестами;
6. runtime-конфигурацией.

Этот документ является краткой картой,
а не заменой кода.

## Архитектурные границы

### Frontend

- Frontend использует существующий app shell,
  auth state и API client.
- Не подключай новый router, state manager или UI framework
  без отдельного решения.
- Изменения маршрутов должны учитывать текущий routing
  и permission gates.

### Backend

- Backend сохраняет модульную структуру NestJS.
- Controllers отвечают за HTTP boundary.
- Business logic находится в предметных services.
- Persistence и внешние интеграции
  не смешиваются с presentation logic.

### Shared

Код переносится в `packages/shared`
только если он действительно используется
минимум двумя workspace.

Не переносить в shared:

- Prisma logic;
- server-side authorization;
- secrets и config;
- provider credentials;
- storage implementation;
- audit logic.

### Data

- Prisma schema и migrations являются критической зоной.
- Роли и permissions проверяются backend-ом.
- Исторические данные не удаляются каскадно
  без явного решения.
- API не должна возвращать Prisma entities напрямую,
  если требуется ограниченный публичный контракт.

### Imports

WordPress и feed import являются отдельными областями.

Изменения import-кода проверяются
на analyze или preview перед run.

## Актуальность

Обновляй этот документ только
при изменении общей архитектуры проекта.

Не добавляй сюда:

- историю исправлений;
- временные планы;
- описание отдельной текущей задачи;
- отчёты Codex;
- отменённые решения.
