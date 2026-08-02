# Current Stage: Stage 5 Part 1 — Results, Audio, Review

## Статус

Stage 4 и Stage 4.5 приняты пользователем. Текущая разрешённая граница — только
первая из четырёх последовательных частей Stage 5. Следующие части не начинаются
без отдельного задания.

## Входит

- Employee: доступные проекты показывают лучший и последний подтверждённый
  результат, остаток попыток и pending review; собственная история сохраняет
  immutable project title, status, duration, безопасный breakdown и точное
  сообщение для pending/technical результата.
- `REQUIRES_REVIEW` не показывает provisional score/pass. `TECHNICAL_FAILED` не
  является результатом, не расходует попытку и не показывает pass/fail.
- Admin: отдельный `GET /training/admin/results` с server pagination, bounded
  filters, total и детерминированной сортировкой; list не возвращает transcript,
  evaluation или storage metadata.
- Admin detail: immutable snapshot, current access/assignment как отдельное
  текущее состояние, duration, answer source, request IDs, evaluation evidence,
  review actor и безопасный признак доступности audio.
- Protected audio: отдельный permission `training:audio:read`, backend-mediated
  `GET /training/admin/answers/:answerId/audio`, safe 404, private no-store,
  проверка ownership/key/bucket/MIME/size/checksum/RIFF-WAVE и bounded AuditLog.
- Review: существующий одноразовый POST; UI сначала фиксирует успешный response,
  затем отдельно обновляет detail. Ошибка refresh не предлагает повторять POST.
- Existing NestJS/Prisma, manual routing, `AdminUi`, shadcn primitives и shared
  contracts; без новых зависимостей и без новой Prisma migration.

## Не входит

- Ranking/leaderboard и любые сравнительные места сотрудников.
- CSV/export и массовые выгрузки.
- Production hardening, operations, deployment, pilot и calibration.
- Общий end-to-end Stage 5; выполняются только targeted fake/local сценарии
  Part 1.
- Новая review history table, изменение scoring, provider calls и Telegram flow.
- Commit и production deploy.

## Последовательность Stage 5

1. Part 1: employee/admin results, protected audio и review integration.
2. Part 2: ranking — только по отдельному разрешению.
3. Part 3: CSV/export — только по отдельному разрешению.
4. Part 4: production hardening и общий E2E — только по отдельному разрешению.

## Stop conditions

- Требуется начать Part 2–4, production deploy или реальный provider call.
- Employee DTO раскрывает transcript, evaluation, provider/storage metadata,
  provisional review score или internal error.
- Audio выдаётся через public/presigned URL, без отдельного permission, проверки
  целостности или audit.
- Current assignment/access подменяет immutable attempt snapshot либо revoke
  удаляет исторический результат.
- Успешный review POST может быть повторён только из-за сбоя последующего GET.
