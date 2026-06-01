# Контекст проекта

Platforma - закрытая внутренняя брокерская платформа для работы с объектами недвижимости. Карта и каталог являются равноправными основными сценариями.

Проект является pnpm-монорепозиторием. Основной frontend, API, shared-пакет и import-инструменты живут в отдельных workspace-пакетах.

## Основные зоны

- `apps/web` - Vite + React + Tailwind frontend.
- `apps/api` - NestJS API, Prisma, auth/RBAC, users, objects, files, map, WordPress import.
- `packages/shared` - общие TypeScript-типы и shared-константы.
- `tools/wp-import` - CLI-инструмент импорта и ремонта данных из WordPress.
- `tools/feed-import` - CLI-инструмент анализа и импорта XML/feed-источников.

## Актуальная документация

- [Инвентаризация документации](../docs/DOCS_INVENTORY.md)
- [Журнал Codex](../docs/CODEX_LOG.md)
- [Главный инженерный индекс](../docs/PROJECT_INDEX.md)
- [Структура проекта](../docs/PROJECT_STRUCTURE.md)
- [Страницы и маршруты](../docs/PAGES_AND_ROUTES.md)
- [Карта фич](../docs/FEATURE_MAP.md)
- [API и данные](../docs/API_AND_DATA.md)
- [Состояние и логика](../docs/STATE_AND_LOGIC.md)
- [Зоны риска](../docs/RISK_ZONES.md)
- [Индекс импорта](../docs/IMPORT_INDEX.md)
- [Продуктовый и UI-контекст](../docs/PRODUCT_AND_UI_CONTEXT.md)
- [Manual QA checklist](../docs/manual-qa-checklist.md)
- [Staging / Production Env Checklist](../docs/staging-production-env-checklist.md)
