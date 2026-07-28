# Training stage 9: result API, DTO и permissions

Дата актуализации: 2026-07-28.

Документ описывает только employee/admin results UI, review UX, ranking и CSV.
Этап 10, production deploy/migrations и реальные Telegram/OpenAI вызовы сюда
не входят.

## Employee API

| Method | Path | Permission | Response boundary |
| --- | --- | --- | --- |
| `GET` | `/training/projects` | `training:take` | Открытые проекты, optional object summary, лимиты/retake, best/last score, active attempt, Telegram state и backend eligibility |
| `GET` | `/training/projects/:projectId` | `training:take` | Один доступный проект или `404` |
| `GET` | `/training/admin/config` | `training:projects:manage` | Feature-flag status для административной навигации без employee-права `training:take` |
| `GET` | `/training/attempts` | `training:own-results:read` | Только JWT owner, filters `projectId/status`, bounded pagination |
| `GET` | `/training/attempts/:attemptId` | `training:own-results:read` | Только JWT owner; разрешённые критерии, без transcript/errors/audio |
| `GET` | `/training/telegram/account` | `training:take` | Только display metadata без Telegram/platform account IDs |
| `POST` | `/training/telegram/link-tokens` | `training:take` | Одноразовый deep link |
| `DELETE` | `/training/telegram/account` | `training:take` | Idempotent unlink |
| `POST` | `/training/projects/:projectId/start-link` | `training:take` | Одноразовый project-scoped deep link |

Employee attempt никогда не принимает `userId` от клиента. `PENDING` review
скрывает `finalScore` и весь breakdown. В DTO никогда нет AI/server/admin
score как отдельных полей, AI summary, transcript, acoustic metrics, error
fields, audio URL/bytes, voice segments, provider runs, review history,
ranking и storage/Telegram metadata.
История принимает `projectId/status/dateFrom/dateTo` и `pageSize` либо
совместимый `limit`; максимальный размер страницы — `100`.

### Employee visibility matrix

| Persisted state | `finalScore` | `breakdownStatus` | Question/criterion breakdown |
| --- | --- | --- | --- |
| `NOT_REQUIRED`, `finalScore = serverScore`, суммы persisted evaluation согласованы | Да | `AVAILABLE` | Да |
| `APPROVED` без изменения score и с согласованными суммами | Да | `AVAILABLE` | Да |
| `OVERRIDDEN` | Да, только итог | `MANUALLY_ADJUSTED_BREAKDOWN_UNAVAILABLE` | `null` |
| Review применил factual/manual adjustment и `finalScore != serverScore` | Да, только итог | `MANUALLY_ADJUSTED_BREAKDOWN_UNAVAILABLE` | `null` |
| Финальный результат есть, но persisted breakdown не сходится с итогом | Да, только итог | `BREAKDOWN_UNAVAILABLE` | `null` |
| `reviewStatus=PENDING` / unresolved `REQUIRES_REVIEW` | Нет | `PENDING_REVIEW` | `null` |

Backend не распределяет post-review разницу по вопросам задним числом.
Employee UI для manual adjustment показывает: «Итоговая оценка
скорректирована после проверки. Детализация по вопросам недоступна». Admin DTO
не урезан и по-прежнему содержит AI/server/admin/final levels и immutable
evaluation/review history.

## Admin API

| Method | Path | Permission | Назначение |
| --- | --- | --- | --- |
| `GET` | `/training/admin/results` | `training:results:read` | Лёгкий список с filters/sort/pagination |
| `GET` | `/training/admin/results/:attemptId` | `training:results:read` | Тяжёлый detail: timeline, questions, transcript, evidence, provider metadata, review/job history |
| `POST` | `/training/admin/results/:attemptId/review` | `training:results:review` | `APPROVED/OVERRIDDEN`, обязательный comment и `Idempotency-Key` |
| `POST` | `/training/admin/answers/:answerId/reprocess-transcription` | `training:results:review` | Explicit immutable transcription reprocessing |
| `POST` | `/training/admin/answers/:answerId/reprocess-evaluation` | `training:results:review` | Explicit immutable evaluation reprocessing |
| `GET` | `/training/admin/answers/:answerId/audio` | `training:audio:read` | Private bytes; service дополнительно проверяет administrative results scope/ownership |
| `GET` | `/training/admin/ranking` | `training:results:read` | Derived ranking с backend pagination/filtering |
| `GET` | `/training/admin/ranking/export.csv` | `training:results:read` | Safe UTF-8 CSV тех же derived данных |

List endpoint не выбирает transcript, audio bytes/segments, provider payloads
или review body. Detail использует explicit selects и намеренно не выбирает
`File.bucket/key`, Telegram IDs/file IDs, provider input hash/metadata, raw
request payload, auth secrets и storage credentials.

## Filters и pagination

`GET /training/admin/results`:

- `page=1..10000`, `pageSize/limit=1..100`;
- `user` по имени/email и exact `userId`;
- `projectId`, optional `projectVersionId`;
- `status`, `reviewStatus`, `passStatus`;
- `requiresReview=true|false`;
- `dateFrom`, `dateTo`;
- `minScore/maxScore` или `finalScoreFrom/finalScoreTo`;
- `sort=newest|oldest|score_desc|score_asc`.
- либо `sortField=startedAt|completedAt|finalScore` и
  `sortDirection=asc|desc`.

List DTO включает version, AI/server/admin/final score, answer/error counts,
attempts used, requires-review flag и короткий admin summary, но не загружает
полный transcript, segments или provider payload.

`GET /training/admin/ranking`:

- `page=1..10000`, `pageSize=1..100`;
- `user` по имени/email;
- optional `projectId`.

Invalid enum/UUID/date/range получает `400`. Все list endpoints возвращают
`pagination: { page, pageSize, total, totalPages }`.

## Ranking

Основные строки рейтинга вычисляются одним parameterized `Prisma.sql` query:
`eligible_users` применяет search до pagination; `eligible_attempts` применяет
eligibility и optional project filter; `ROW_NUMBER()` выбирает лучший
user/project; `AVG(numeric)` и агрегаты считаются в CTE; `ROW_NUMBER()` и
`COUNT(*) OVER()` формируют position/total; `LIMIT/OFFSET` ограничивает
реальную SQL-страницу. После этого fixed-size Prisma queries загружают
breakdown только для `userId` текущей страницы. N+1, `$queryRawUnsafe` и
интерполяция пользовательских строк отсутствуют.

Для каждого active non-deleted пользователя с `training:take`:

1. учитываются только consumed attempts со статусом `COMPLETED` либо
   завершённым manual review, с non-null `finalScore/completedAt`;
2. `reviewStatus=PENDING`, `passStatus=PENDING`, `TECHNICAL_FAILURE` и
   refunded `isConsumed=false` не участвуют;
3. на проект выбирается максимальный historical `finalScore`; tie-break —
   более ранний `completedAt`, затем стабильный `attempt.id`;
4. `averageBestScore` считается PostgreSQL `numeric AVG` только по завершённым
   проектам; пустые проекты не превращаются в нули;
5. сортировка в PostgreSQL: passed projects DESC, completed projects DESC,
   точный неокруглённый average DESC, last completed ASC, затем стабильный
   user ID;
6. display value — `ROUND(numeric, 2)` как decimal string; frontend порядок
   backend не пересортировывает.

Narrative строится детерминированным backend-кодом. При менее чем двух
завершённых проектах возвращается только сообщение о недостаточности данных;
иначе добавляются strongest/weakest criteria, error/unsupported counts и
средняя динамика от первой до лучшей попытки для проектов с повторными
финализированными попытками. Психологические/личностные выводы и AI generation
отсутствуют. Project breakdown содержит `attemptId` для перехода к detail,
attempt number, attempts used, summary, дату и score delta.

## CSV

CSV содержит position, Platforma user ID/name/email, агрегаты ranking,
duration/last completion, safe narrative, counts ошибок/unsupported claims и
лучший score/pass status по проекту.

Export последовательно читает страницы по `100` строк через тот же ranking
core, поэтому eligibility, exact-average order и best reviewed result
совпадают с API. Transcript/audio/provider payload не выбираются.

- UTF-8 BOM добавлен для предсказуемого открытия русских данных в Excel.
- Разделитель — comma, строки — CRLF, quotes удваиваются.
- После trim-start значения, начинающиеся с `=`, `+`, `-`, `@`, а также
  leading tab/CR/LF, получают apostrophe prefix.
- Transcript, audio, storage keys/URLs, Telegram IDs, provider input/usage и
  credentials не экспортируются.
- Response: `private, no-store`, `nosniff`, attachment filename.

## Автоматические доказательства

- `apps/api/tests/training-results.test.cjs`: formula injection/Unicode,
  deterministic narrative, controller permissions и employee reconciliation.
- `apps/api/tests/training-results-db.integration.cjs`: real PostgreSQL +
  ephemeral Nest HTTP, `401/403/404`, все employee visibility states, admin
  score levels, 41 ranking users/10 projects, page isolation, exact averages
  `85.001/85.004/85.005`, search/project filter, eligibility, safe CSV и
  `EXPLAIN (ANALYZE, BUFFERS)`.
- `apps/web/tests/training-results.test.mjs`: pending masking, stable labels,
  object URL manager и review operation state machine.
- `apps/web/tests-browser/training-results.spec.ts`: 8 headless Chromium
  behavioral сценариев: committed POST с failed refresh, ambiguous retry,
  duplicate click/new action, audio abort/generation/revoke/401 refresh,
  employee manual adjustment и loading/empty/error states.
- Browser command:
  `pnpm --filter @platforma/web test:training:browser`.

`EXPLAIN` на PostgreSQL fixture подтвердил корневой `Limit` и чтение только
`users`, `roles/permissions` и `training_attempts`; relations transcript,
answers, evaluations, score components, voice segments и provider runs в main
plan отсутствуют. На этой cardinality PostgreSQL обоснованно выбирает
последовательные scans, поэтому доказанной пользы нового индекса нет и
migration не добавлялась. Перед pilot остаётся повторить план на фактической
cardinality; существующие indexes: `user/status`, `project/status`,
`completedAt`, `reviewStatus/completedAt` и relation indexes.
