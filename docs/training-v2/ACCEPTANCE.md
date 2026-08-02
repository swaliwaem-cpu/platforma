# Acceptance: Stage 5 Part 2 — Ranking, Coverage, CSV

## Критерии готовности

- Ranking использует max confirmed counting `finalScore` на employee/project;
  best может отличаться от latest, historical `isPassed` сохраняется.
- Pending review, `TECHNICAL_FAILED` и non-counting attempts не ухудшают metrics.
  Timeout и resolved override покрыты как подтверждённые historical results.
- Revoke сохраняет historical average/result и изменяет только current coverage.
- Coverage соответствует Stage 4.5 policy для ALL/ASSIGNED, active permissioned
  users и open/published projects; zero denominator даёт `null`.
- Server-side filters применяются до aggregation/`COUNT(*) OVER()`/pagination;
  page 1/2 не пересекаются и имеют stable exact order.
- `AVG(finalScore::numeric)` сортируется до округления; display использует
  `ROUND_HALF_UP` до двух знаков.
- List query не читает heavy answer/evaluation/audio payload; detail query
  ограничен user IDs текущей страницы; DB query count bounded.
- Deterministic summary не использует OpenAI и не делает психологических выводов.
- Ranking и CSV защищены `training:results:read`, имеют 401/403/200 coverage и
  explicit safe DTO/columns.
- CSV совпадает с API policy/order/filters, идёт батчами по 100, имеет UTF-8 BOM,
  корректное quoting и защиту `= + - @ tab CR LF` после leading whitespace.
- Admin UI сохраняет backend order и покрывает filters/pagination/coverage/
  breakdown/summary/download/loading/empty/error/mobile/permission states.
- Новые tables/materialized results, production hardening/deploy, Part 3, commit
  и реальные Telegram/OpenAI calls отсутствуют.

## Automated fake/local acceptance

1. Shared/API/web builds и `prisma validate`; migration status/upgrade только
   если query-plan evidence потребовал additive index.
2. Unit/domain: query bounds, historical eligibility/best/ties/nulls, Decimal
   rounding, coverage, deterministic summary и CSV security.
3. Isolated PostgreSQL synthetic dataset: минимум 100 users, 10 projects,
   mixed ALL/ASSIGNED/overlaps/revokes, attempts/reviews/technical failures;
   exact order, pages, filters, bounded query count и `EXPLAIN`.
4. HTTP/RBAC: ranking/CSV 401/403/200, filters, safe allowlist, CSV headers/BOM/
   formula protection и API/CSV parity.
5. Frontend source и targeted browser: permission route/navigation, filters,
   pagination, current coverage, unchanged backend order, CSV download,
   loading/empty/error/mobile и обе поддерживаемые themes.
6. Full API/web/root tests and workspace builds, `git diff --check`, `.only`/
   `.skip`, secret/real-call/excluded-scope scans и cleanup resources.

## Локальная ручная приёмка

1. Под admin открыть `/admin/training/ranking`, применить project/access/current
   filters и сравнить две страницы с backend order.
2. После revoke сравнить неизменный historical best/average и изменившийся
   current coverage; отдельно проверить ALL и ASSIGNED проекты.
3. Сверить project breakdown, timeout, resolved override и «Недостаточно данных».
4. Скачать CSV с теми же filters, открыть в spreadsheet и проверить UTF-8,
   русские имена, commas/quotes/newlines и formula-like cells.
5. Под ролью только с `training:results:read` проверить ranking/CSV; employee и
   роль без permission не должны видеть route и получают 403 API.
6. Проверить desktop/mobile, `minimal-luxury` и `dark-premium`, loading/empty/
   error/focus/reduced-motion states.

## Definition of Done

Part 2 готов к ручной локальной приёмке только при зелёных automated gates и
query-plan evidence. Part 3–4, production deploy и commit остаются отдельными
не начатыми задачами.
