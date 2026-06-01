# Backend-правила

- Сохраняй модульную структуру NestJS в `apps/api/src`.
- Общие контракты между frontend и backend выноси или обновляй в `packages/shared`, если они действительно используются обеими сторонами.
- Не меняй Prisma-схему, миграции, seed-данные, роли, permissions или auth/RBAC поведение без явного понимания последствий.
- Любые изменения WordPress import проверяй на preview/run сценариях и не смешивай repair-логику с основным импортом без необходимости.
- Любые изменения feed import проверяй на analyze/preview/run/stop сценариях и сверяй API `/feeds/*` с CLI в `tools/feed-import`.
