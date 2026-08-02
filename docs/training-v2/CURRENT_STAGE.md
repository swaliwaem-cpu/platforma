# Current Stage: Stage 5 Part 2 — Ranking, Coverage, CSV

## Статус

Stage 4, Stage 4.5 и Stage 5 Part 1 приняты пользователем. Текущая разрешённая
граница — только вторая из четырёх частей Stage 5. Part 3–4 не начинаются без
отдельного задания.

## Входит

- `GET /training/admin/ranking` с permission `training:results:read`, bounded
  server pagination/search/project/access/current filters и stable exact order.
- Historical best по employee/project сохраняется после revoke; pending review,
  technical и non-counting attempts исключаются, historical pass не
  пересчитывается по live project settings.
- Current eligible/completed/passed coverage считается отдельно по единой Stage
  4.5 access policy; denominator zero даёт `null` percent.
- Exact PostgreSQL numeric average сортируется до `ROUND_HALF_UP` display
  rounding. Project breakdown и deterministic factual summary загружаются
  только для current page users.
- `GET /training/admin/ranking/export.csv` использует тот же core, filters и
  order батчами по 100, UTF-8 BOM, quoting и formula-injection protection.
- `/admin/training/ranking`: permission-gated navigation, table, filters, server
  pagination, historical/current metrics, breakdown, summary, CSV и responsive
  loading/empty/error states.
- Existing NestJS/Prisma, manual routing, `AdminUi`, shadcn primitives и shared
  contracts; без новых dependencies, ranking tables и migration без
  доказанного query-plan основания.

## Не входит

- Production hardening, operations, deployment, pilot и calibration.
- Connected общий end-to-end Stage 5; выполняются targeted fake/local Part 2
  browser/PostgreSQL/HTTP/performance проверки.
- Изменение Part 1 results/review/audio, Stage 4 materials/generation и Stage
  4.5 assignment lifecycle без доказанного blocker.
- Новые product features Part 3, feature flag, webhook tooling, real provider
  calls, commit и production deploy.

## Последовательность Stage 5

1. Part 1: employee/admin results, protected audio и review integration.
2. Part 2: ranking, current coverage и связанный CSV export.
3. Part 3: следующие product surfaces — только по отдельному разрешению.
4. Part 4: production hardening — только по отдельному разрешению.

## Stop conditions

- Требуется начать Part 3–4, production deploy или реальный provider call.
- Ranking/CSV раскрывает transcript, evidence, audio/storage/source excerpts,
  provider/request IDs, review comments, Telegram IDs или secrets.
- Historical score/pass зависит от current assignment/access/passScore либо
  revoke удаляет historical row.
- Pagination/order/average выполняются в Node после загрузки всех users/attempts.
- CSV использует отличную от ranking API policy либо небезопасен для spreadsheet
  formulas.
