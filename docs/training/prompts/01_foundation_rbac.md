# Prompt для Codex

Выполни ТОЛЬКО этап 1 модуля обучения: каркас backend/frontend, feature flag, shared contracts, routing shell и RBAC. Не создавай Prisma-модели предметной области и не начинай Telegram/OpenAI.

Перед началом:
- проверь ветку `on-ser` и `git status --short`;
- прочитай `docs/training/00-repository-audit.md`, `01-architecture-decision.md`, `02-implementation-checklist.md`;
- прочитай только нужные разделы:
  - `spec/00_rules_business.md`: пользователи, роли и доступ;
  - `spec/01_architecture_data_domain.md`: permissions и роли;
  - `spec/03_api_frontend_jobs_env.md`: frontend/API conventions;
  - `spec/04_stages_tests_acceptance.md`: «Этап 1».

Сделай:
1. `TrainingModule` и минимальный health/config shell без бизнес-логики.
2. `TRAINING_MODULE_ENABLED` с безопасным parsing.
3. Shared training contracts в `packages/shared/src/training.ts` и реэкспорт.
4. Permissions из утверждённой спецификации и роль `training_admin` через idempotent seed.
5. Права `admin`, `training_admin`, обычного пользователя строго по бизнес-правилам.
6. Маршрутные заготовки `/training` и `/admin/training`, не мигрируя приложение на React Router.
7. При необходимости аккуратно вынеси конфигурацию навигации из `App.tsx`, не меняя существующие URL/поведение.
8. Permission contract tests и frontend route/navigation tests в текущем стиле проекта.

Не добавляй новые библиотеки. Не делай пустые публичные endpoints без auth/permission contracts.

Запусти релевантные build/tests, обнови checklist, перечисли изменения и ОСТАНОВИСЬ.
