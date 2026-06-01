# Docs Inventory

Дата первичной инициализации: 2026-06-01.

Инвентаризация основана на команде:

```sh
find . -name "*.md" -not -path "./node_modules/*" -not -path "./dist/*"
```

Статусы: `active`, `generated`, `checklist`, `broken-reference`, `unclear`.
Аудитория: `always`, `frontend`, `backend`, `import`, `QA`, `deploy`.

## Markdown-файлы

| Файл | Назначение | Актуальность | Читать |
| --- | --- | --- | --- |
| `AGENTS.md` | Главная точка входа для правил Codex в проекте. | `active` | `always` |
| `rules/communication.md` | Правила языка общения и именования сущностей. | `active` | `always` |
| `rules/workflow.md` | Правила начала работы, ветки и согласований. | `active` | `always` |
| `rules/code-style.md` | Общий стиль работы и ограничения на изменения. | `active` | `always` |
| `rules/project.md` | Краткий контекст проекта, workspace-зоны и актуальная документация. | `active` | `always` |
| `rules/commands.md` | Основные команды build/dev/test и правила dev server. | `active` | `always` |
| `rules/frontend.md` | Frontend-ограничения, UX-правила и защищенная модель карты/каталога. | `active` | `frontend` |
| `rules/backend.md` | Backend-ограничения для NestJS, shared-контрактов, Prisma и импорта. | `active` | `backend` |
| `rules/files-and-secrets.md` | Ограничения на generated-файлы, lockfile и секреты. | `active` | `always` |
| `rules/final-response.md` | Обязательная структура финального ответа пользователю. | `active` | `always` |
| `docs/DOCS_INVENTORY.md` | Текущий индекс markdown-документации и найденных проблем ссылок. | `active` | `always` |
| `docs/CODEX_LOG.md` | Журнал изменений документации, выполненных Codex. | `active` | `always` |
| `docs/CODEX_TASK_PROTOCOL.md` | Постоянный рабочий протокол Codex перед задачами, изменениями и финальным отчетом. | `active` | `always` |
| `docs/PROJECT_INDEX.md` | Главный инженерный индекс проекта для Codex: назначение, стек, зоны, документы и команды. | `active` | `always` |
| `docs/PROJECT_STRUCTURE.md` | Карта структуры monorepo, entry points, env examples, Prisma, tests и docker/config. | `active` | `always` |
| `docs/PAGES_AND_ROUTES.md` | Карта frontend routes, компонентов, permissions, API consumers, states и route-рисков. | `active` | `frontend` |
| `docs/FEATURE_MAP.md` | Карта основных фич по frontend/backend/shared/Prisma/API/tests/docs/рискам. | `active` | `frontend`, `backend`, `import` |
| `docs/API_AND_DATA.md` | Карта API, данных, RealEstateObject lifecycle и response/data flow. | `active` | `backend`, `frontend` |
| `docs/STATE_AND_LOGIC.md` | Карта frontend/backend state, query params, form/import/map/file flows и хрупких связей. | `active` | `frontend`, `backend` |
| `docs/RISK_ZONES.md` | Опасные зоны проекта, причины риска и обязательные проверки. | `active` | `always` |
| `docs/IMPORT_INDEX.md` | Карта WordPress import, repair и feed import: команды, API/UI, данные, риски. | `active` | `import` |
| `docs/PRODUCT_AND_UI_CONTEXT.md` | Компактный продуктовый и UI-контекст для frontend/UI-задач. | `active` | `frontend` |
| `docs/manual-qa-checklist.md` | Ручной QA-чеклист для живого окружения после запуска сервисов. | `checklist` | `QA` |
| `docs/staging-production-env-checklist.md` | Чеклист переменных окружения и deployment-проверок для staging/production. | `checklist` | `deploy` |
| `docs/superpowers/plans/2026-05-25-admin-object-location-filters-implementation.md` | Сгенерированный план реализации фильтров локаций в админке. | `generated` | `frontend`, `backend` |
| `docs/superpowers/plans/2026-05-25-lot-filters-implementation.md` | Сгенерированный план реализации фильтров лотов. | `generated` | `frontend`, `backend` |
| `docs/superpowers/plans/2026-05-25-unified-search-normalization-implementation.md` | Сгенерированный план нормализации поиска в shared/frontend/backend. | `generated` | `frontend`, `backend` |
| `docs/superpowers/plans/2026-05-27-avito-feed-import.md` | Сгенерированный план поддержки Avito feed import. | `generated` | `import` |
| `docs/superpowers/plans/2026-05-27-etalon-cian-feed-import-implementation.md` | Сгенерированный план Etalon CIAN feed import. | `generated` | `import` |
| `docs/superpowers/plans/2026-05-27-unified-feed-index-import-implementation.md` | Сгенерированный план unified feed index import. | `generated` | `import` |
| `docs/superpowers/plans/2026-05-29-map-pin-labels-implementation.md` | Сгенерированный план подписей пинов на карте. | `generated` | `frontend`, `backend` |
| `docs/superpowers/specs/2026-05-25-lot-filters-design.md` | Сгенерированная design-spec для фильтров лотов. | `generated` | `frontend`, `backend` |
| `docs/superpowers/specs/2026-05-25-unified-search-normalization-design.md` | Сгенерированная design-spec для нормализации поиска. | `generated` | `frontend`, `backend` |
| `docs/superpowers/specs/2026-05-27-etalon-cian-feed-import-design.md` | Сгенерированная design-spec для Etalon CIAN feed import. | `generated` | `import` |
| `docs/superpowers/specs/2026-05-27-unified-feed-index-import-design.md` | Сгенерированная design-spec для unified feed index import. | `generated` | `import` |
| `docs/superpowers/specs/2026-05-29-map-pin-labels-design.md` | Сгенерированная design-spec для подписей пинов на карте. | `generated` | `frontend`, `backend` |
| `.agents/skills/ui-ux-pro-max/SKILL.md` | Локальная инструкция UI/UX-навыка; не является продуктовой документацией проекта. | `generated` | `frontend` |

## Проверка ссылок

Проверены markdown-ссылки в `AGENTS.md`, `rules/*.md` и active-документах из этого инвентаря.

- `AGENTS.md` ссылается на существующие `rules/*` и актуальные `docs/*.md`.
- `rules/project.md` ссылается только на существующие документы из `docs`.
- Битых markdown-ссылок в active-документах не найдено при последней проверке.
- Устаревшие ссылки на удаленные `PRODUCT.md`, `DESIGN.md`, `plan.md`, `mapping.md`, `plus.md`, `isp-*.md` не используются в навигации.

## Инженерный индекс Codex

Создан полный инженерный индекс проекта:

- `docs/PROJECT_INDEX.md`
- `docs/CODEX_TASK_PROTOCOL.md`
- `docs/PROJECT_STRUCTURE.md`
- `docs/PAGES_AND_ROUTES.md`
- `docs/FEATURE_MAP.md`
- `docs/API_AND_DATA.md`
- `docs/STATE_AND_LOGIC.md`
- `docs/RISK_ZONES.md`
- `docs/IMPORT_INDEX.md`
- `docs/PRODUCT_AND_UI_CONTEXT.md`

Оставшиеся неясные зоны зафиксированы в `docs/RISK_ZONES.md` и `docs/CODEX_LOG.md`.
