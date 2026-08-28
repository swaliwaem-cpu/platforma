# T07: manual QA и bounded provider smoke

Этот runbook дополняет автоматические проверки T07. Он не является командой на
production deployment, покупку provider plan, создание credentials или применение
production migrations.

## Автоматический baseline

Перед ручной приёмкой должны пройти:

```bash
pnpm test:assistant:t07:domain
pnpm test:assistant:t07:targeted
pnpm test:assistant:t07:e2e
pnpm test
pnpm build
```

`test:assistant:t07:e2e` сам создаёт disposable PostgreSQL/PostGIS, применяет
migrations на чистую базу и в upgrade-сценарии, поднимает реальный Nest application,
индексирует локальный HTTP source stub, собирает web и использует локальный
детерминированный MapLibre style. Контейнер, Docker network и временные Prisma-файлы
удаляются в `finally`. Скрипт не использует project volumes и не обращается к OpenAI,
LocationIQ, OpenFreeMap tiles, OpenRouteService или Yandex.

## Фактическая приёмка 26.08.2026

Приёмка выполнена в disposable fake-контуре на desktop `1440×960` и mobile
`390×844`. E2E завершился `ASSISTANT_T07_E2E_OK`, после чего вручную просмотрены
контрольные screenshots `desktop-assistant-geo`, `desktop-assistant-geo-alternatives`,
`desktop-catalog-map`, `desktop-admin-source-health`, `desktop-map-style-degradation`,
`desktop-map-tile-degradation` и `mobile-assistant`.

Подтверждены русские labels, `Павелецкая Плаза · 2 км`, стилизованная локальная
картография Москвы с attribution, различимые primary/alternative markers, selected
object/list state, source health, рабочий список при style/tile outages и полноэкранный
mobile assistant без горизонтального scroll. Тот же authenticated browser run
подтвердил сложную рассрочку, cancel/move/confirm semantics, geocoder degradation,
desktop/mobile touch targets и отсутствие Yandex/provider requests. Реальные
providers не включались; их bounded smoke остаётся отдельным разрешаемым gate ниже.

## Фактическая приёмка PIDAFIX3 29.08.2026

Свежий isolated run `platforma-pidafix3-65223eca` выполнен из HEAD
`491e21dacd1b4e5c1d4e62cbcd6cf7280ddc2201` с task-specific diff SHA-256
`cafe2f892604df899bcbdd7ddd8bdafcaf854bced8577aa5f9aa60d98ddd11b1`.
PostgreSQL/PostGIS, API и web были пересобраны из текущего worktree. Основная база и
четыре отдельные gate-базы прошли полный migration replay и `prisma migrate status`.
Readiness подтвердил PostGIS 3.5, таблицу `assistant_geo_landmarks`, пустой assistant
backlog, HTTP `200/401/200` для health, unauthenticated и authenticated assistant
config, а также минимальный RBAC без общего `db:seed`. Использован локальный Docker
target `desktop-linux` через Unix socket (`docker-desktop` 29.4.1).

| Gate | Exit | Tests | Duration |
| --- | ---: | ---: | ---: |
| `t07-domain` | 0 | 11 | 7 461 ms |
| `t07-targeted` | 0 | 60 | 11 959 ms |
| `t07-connected-e2e` | 0 | 1 suite | 273 252 ms |
| `fix-token-unit` | 0 | 59 | 997 ms |
| `t03-discovery-unit` | 0 | 75 | 495 ms |
| `t03-connector-unit` | 0 | 12 | 1 452 ms |
| `fix-token-postgres` | 0 | 15 | 10 613 ms |
| `t03-postgres` | 0 | 2 | 7 176 ms |
| `t03-browser` | 0 | 1 suite | 8 198 ms |
| `fix-geo1-targeted` | 0 | 86 | 15 004 ms |
| `fix-geo1-postgres` | 0 | 18 | 12 070 ms |
| `fix-geo1-browser` | 0 | 1 suite | 9 352 ms |
| `pnpm test` | 0 | 1 190 | 16 832 ms |
| `pnpm build` | 0 | n/a | 10 229 ms |
| task diff check | 0 | n/a | 17 ms |

Connected E2E завершился `ASSISTANT_T07_E2E_OK`. На desktop `1440×960` проверены
POINT и LINE, на mobile `390×844` — AREA. LINE прошёл через resolver, persisted
landmark, run/message и `ST_DWithin`; AREA — через persisted polygon и `ST_Covers`.
Подтверждены default 5 км, explicit 1 км, hard filters, inclusion/exclusion на границе,
полные reference/search geometry, отсутствие centroid anchor, предел `3 primary +
2 alternative`, отдельный LINE alternative при пустом exact set, attribution и отсутствие
horizontal overflow.

Вручную просмотрены свежие screenshots `desktop-assistant-geo`,
`desktop-assistant-geo-alternatives`, `desktop-assistant-geo-line`,
`desktop-assistant-geo-line-alternative`, `desktop-catalog-map`, `desktop-admin-source-health`,
`desktop-map-style-degradation`, `desktop-map-tile-degradation`, `mobile-assistant`
и `mobile-assistant-geo-area`.

Интерактивная browser-приёмка того же product worktree подтвердила:

| Case | Result |
| --- | --- |
| launcher, close/open, history и новый разговор | PASS |
| принудительный `503`, видимый retry и успешное повторение | PASS |
| POINT, LINE exact/alternative и AREA | PASS |
| Escape/cancel без изменения geo context; confirm создаёт новый run | PASS |
| geocoder, style и tile degradation с сохранённым списком | PASS |
| desktop и mobile `390×844` без horizontal overflow | PASS |
| обычная роль: audit UI закрыт сообщением «Недостаточно прав»; API gate — `403` | PASS |

Перед финальным run дополнительно проверены безопасный storage env для полного test suite,
abort-aware readiness и bounded `SIGTERM` → `SIGKILL` cleanup process group, включая потомка,
игнорирующего `SIGTERM`. Cleanup standalone T07 удаляет все containers текущего run по точному
ownership label и повторяет sweep после signal cleanup, поэтому migration container не может
удержать временную network.
Финальный run прошёл все connected browser journeys; новые screenshots просмотрены уже из него.
Backend transport evidence и outbound deny hook
подтвердили `0` OpenAI, `0` LocationIQ и `0` Overpass calls, `0` persisted provider attempts
и `0` denied remote requests; browser Network — `0` OpenFreeMap/Yandex/provider requests.
Стоимость run — `$0` на fake modes без provider credentials.

OpenAI и Geo Provider smoke намеренно не запускались: для каждого требуется новая
явная команда с отдельными caps. Cleanup удалил только ticket containers, network,
volume и три точных ticket image tag; residual containers/networks/volumes/nested
resources/images отсутствуют, исходные шесть local containers сохранены. Production
не использовался. Машиночитаемый отчёт:
`/var/folders/jg/7zrmwgln1n37nv0260tjyt2w0000gn/T/platforma-pidafix3-qa-65223eca-p0vwq3/pidafix3-baseline-report.json`.

## Ручная приёмка fake-контура

Проверять на desktop `1440×960` и mobile `390×844` с fake AI/embedding/geo,
external source worker выключен.

Worker внешних источников не входит в default Compose graph. Для отдельного
разрешённого запуска одновременно нужны `ASSISTANT_EXTERNAL_CONNECTORS_ENABLED=true`
и opt-in profile: `docker compose --profile assistant-external up -d assistant-source-worker`.

1. Войти обычным пользователем с `objects:read` и открыть помощника.
2. Проверить русские progress labels, clarification, retry, history и dislike feedback.
3. Запросить двушку до 25 млн в Хамовниках у метро Спортивная от тестового
   застройщика: цены, stale label и PDF должны быть видимы; evidence trail — нет.
4. В новом разговоре запросить заведомо слишком низкий бюджет: показать не более
   двух alternatives с явными отклонениями.
5. На странице ЖК проверить factual answer и официальный external lot; ссылка должна
   вести только на подтверждённый HTTPS URL.
6. Проверить `Павелецкая Плаза`, радиус 2 км и карту Москвы: расстояния по прямой,
   radius hard filter, не более трёх primary и двух alternative markers.
7. Проверить ambiguity, ручную точку, смену anchor/radius и degraded geocoder.
   Движение карты и cancel не должны запускать поиск; только confirm создаёт run.
8. В каталоге проверить сохранение filters, marker/list synchronization, selected state,
   fullscreen, attribution и карту detail-page. В Network не должно быть Yandex requests.
9. На mobile проверить полноэкранный assistant, отсутствие горизонтального scroll и
   touch targets не меньше `44×44`.
10. Под администратором проверить review queue, Candidate set, Ranking decisions,
    Evidence revisions, Provider attempts, source health, targeted refresh, Geo operations
    и сохранение internal alias. Обычный пользователь должен получать `403` на audit API.
11. Отдельно проверить сложную ипотеку/рассрочку: ответ содержит только подтверждённые
    условия, даты и source link; неподтверждённая ставка или доступность не появляются.
12. Повторить map и geo flows при недоступном style endpoint и geocoder: список,
    ручная точка и безопасные fallback labels остаются рабочими.

## Bounded smoke реальных providers

Эти две проверки выполняются только после новой явной команды пользователя с
указанными caps. Они не входят в baseline/CI, не запускаются друг с другом и по
умолчанию оба работают как dry-run без внешних вызовов. Credentials передаются только
через окружение процесса: не в CLI arguments, env-файле, screenshots или report.

### OpenAI

После свежего fake baseline и отдельного разрешения запустить PIDAFIX1 CLI с точными
пределами `2` user requests, `4` model attempts и `$0.50`. Geo/Overpass, embeddings,
connectors и source worker в этом runtime выключены. Результат принимается только после
сверки structured search, mortgage/installment, отсутствия invented facts/Web Search и
persisted ledger. После любого исхода runtime сразу возвращается в fake mode.

### Geo Provider

Харнес запускается только после новой команды с точными caps `8 LocationIQ + 3 Overpass = 11`
и ссылкой на свежий `pidafix3-baseline-report.json` того же HEAD/diff:

```bash
pnpm smoke:assistant:pidafix3:geo -- \
  --run-live-geo \
  --max-locationiq-attempts 8 \
  --max-overpass-attempts 3 \
  --max-total-attempts 11 \
  --baseline-report /absolute/path/pidafix3-baseline-report.json
```

Runner сам создаёт clean Compose/PostGIS runtime, требует `MAX_RETRIES=0`, отклоняет legacy
`ASSISTANT_FIX_GEO1_LIVE_ALLOW_REMOTE` и идёт строго последовательно: POINT Белорусского вокзала,
Садовое кольцо, ТТК, МКАД и `INSIDE` района Арбат. Для каждого case сверяются receipts,
canonical identity, `cacheHit=false` и digest полной PostGIS geometry. Browser затем переиспользует
saved LINE/AREA landmark; provider counters до/после обязаны совпасть. Style остаётся local stub,
любой OpenFreeMap/Yandex/provider request из browser делает gate красным. Реальный Geo smoke в этом
выполнении не запускался.

## Rollout gate

Eval запускается только с полным persisted-run manifest для frozen dataset
`assistant-eval-v1`:

```bash
pnpm eval:assistant:manifest > /secure/path/assistant-eval-results.json
pnpm eval:assistant -- --results /absolute/path/to/assistant-eval-results.json
```

Artifact должен содержать актуальные `datasetVersion`, `datasetSha256`,
`evaluatorVersion`, `evaluatedAt` не старше 24 часов и ровно 200 уникальных связок
`caseId → persisted AssistantRun.id`. Готовые observations, digests и verdicts извне
не принимаются. CLI сам загружает из указанной PostgreSQL database завершённые runs,
проверяет query, owner/conversation boundary и временное окно, вычисляет SHA-256
answer/evidence, инварианты, quality score и zero-tolerance violations из frozen
expectations. Отсутствующий, старый, незавершённый или повторно использованный run
делает gate красным.

Переход между стадиями всегда последовательный (`ADMINS → PILOT → ALL`) и проверяется
read-only preflight против указанной базы:

```bash
ASSISTANT_ROLLOUT_TARGET_STAGE=PILOT \
ASSISTANT_EVAL_RESULTS_PATH=/absolute/path/to/assistant-eval-results.json \
pnpm assistant:rollout:preflight
```

Для `PILOT` allowlist содержит 8–12 уникальных UUID существующих активных обычных
пользователей с `objects:read`, без `admin:access`, `assistant:audit:read` и
`assistant:sources:manage`. Preflight должен пройти eval, health всех active sources,
явные model/geo budgets, показать ноль critical errors и хотя бы один run в окне
наблюдения предыдущей стадии. Перед переходом из `PILOT` каждый участник allowlist
должен иметь run в этом окне. Будущая дата начала и пустое окно fail closed. Сам
preflight берёт начало окна из append-only `assistant_rollout_events`, а не из
операторского timestamp. API не создаёт stage event и отказывается стартовать, если
для configured stage нет заранее записанного approval event. После зелёного read-only
preflight отдельная явно разрешённая команда `pnpm assistant:rollout:advance` повторяет
те же gates и только затем добавляет immutable event target-stage с каноническим
approval artifact и его SHA-256 digest. Database trigger проверяет последовательность
стадий и обязательные approval-поля, а API fail closed валидирует всю цепочку при
старте; лишь после этого можно отдельно менять feature flag. Preflight ничего не
переключает и не деплоит.
Изменение production flags, migrations или containers требует отдельной команды
пользователя.
