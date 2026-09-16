# PIDAFIX3: Сквозная локальная приёмка и bounded live-smoke

**What to build:** собрать свежий локальный Nest + PostgreSQL/PostGIS + web/browser
контур, доказать POINT/LINE/AREA journey на fake providers, а затем описать и
выполнить только по отдельному разрешению два независимых bounded smoke: OpenAI и
Geo Provider.

**Blocked by:** [PIDAFIX1](./pidafix1.md) и [PIDAFIX2](./pidafix2.md).

**Status:** ready-for-agent

## Границы

- [ ] Production полностью вне scope: без SSH, deploy, production DB, env, containers,
  credentials и HTTP smoke.
- [ ] Реальные OpenAI и Geo Provider никогда не включаются одновременно в первом
  canary. Каждый внешний boundary проверяется отдельно с собственным бюджетом.
- [ ] Реальные вызовы требуют новой команды пользователя после зелёного fake baseline;
  реализация harness и автоматические тесты сами их не запускают.
- [ ] Используются только disposable/local data и временные process-scoped credentials,
  которые не сохраняются в файлы, shell history, screenshots или logs.
- [ ] Telegram, Training AI/voice, feed/material jobs, embeddings и external source
  worker остаются fake/disabled, если конкретный шаг не разрешает иное.

## Этап 1 — Синхронизация T07-контракта

- [ ] Обновить два executable assertion в `assistant-t07-e2e.cjs`:
  `Павелецкая Плаза · до 2 км` вместо старого chip без «до».
- [ ] Обновить aria-label assertion на `Изменить точку и расстояние`.
- [ ] Историческую запись фактической приёмки 26.08.2026 в
  `t07-manual-qa.md` задним числом не переписывать; новый результат добавить отдельно
  только после фактического rerun.
- [ ] RED должен воспроизводить именно stale public copy, а GREEN — текущий FIX-GEO1
  контракт без ослабления ожиданий.

## Этап 2 — Настоящий LINE/AREA connected E2E

- [ ] Расширить `assistant-t07-e2e.cjs` поверх реального Nest application,
  disposable PostgreSQL/PostGIS и browser, а не mocked assistant routes.
- [ ] LINE journey: русская phrase → resolver → persisted landmark → run/message →
  `ST_DWithin` → реальные exact/alternative results → line и buffer на карте.
- [ ] AREA journey: phrase `внутри района` → resolver → persisted area →
  `ST_Covers` → polygon map на mobile.
- [ ] LINE fixture содержит объекты возле двух удалённых сегментов и объект сразу
  снаружи buffer; AREA fixture — объект внутри далеко от centroid и объект сразу
  за boundary. Проверяются inclusion/exclusion, `referenceGeometry`, `searchArea`
  и отсутствие anchor-marker, чтобы centroid fallback не мог дать ложный GREEN.
- [ ] Проверить сохранение комнатности, бюджета и прочих hard filters; default 5 км,
  explicit distance override и отсутствие radius dialog.
- [ ] UI показывает reference geometry, search area, не более 3 primary + 2 alternative
  markers, attribution, desktop `1440×960` и mobile `390×844` без horizontal scroll.
- [ ] Provider, tiles и source boundaries в автоматическом E2E являются local stubs.
  Backend transport counters/outbound deny hook отдельно доказывают ноль OpenAI,
  LocationIQ и Overpass calls; browser Network доказывает ноль OpenFreeMap/Yandex.

## Этап 3 — Свежий изолированный local runtime

- [ ] Запускать отдельный Compose project/disposable stack, не переиспользуя старые
  API/web images, project volumes или локальную БД с неизвестным cache/provenance.
- [ ] Поднимать только необходимые PostgreSQL/PostGIS, API и web services; остальные
  workers отключены.
- [ ] С чистого состояния выполнить все migrations и подтвердить `prisma migrate status`,
  PostGIS и наличие `assistant_geo_landmarks`.
- [ ] Перед canary подтвердить отсутствие `PENDING/RUNNING` assistant backlog и
  достаточные local RBAC permissions тестового пользователя без общего `db:seed`.
- [ ] Rebuild API/web выполняется из текущего worktree; в отчёте фиксируются HEAD и
  SHA-256 task-specific diff. Health 200 не считается доказательством readiness без
  route, migration и browser checks; scoped commit не создаётся без отдельной команды.
- [ ] Cleanup в `finally` удаляет только созданные ticket containers, network, volumes,
  temp env и временные screenshots. QA screenshots сохраняются вне disposable stack
  до ручной проверки и отчёта; существующий local stack не затрагивается.

## Этап 4 — Бесплатный baseline

- [ ] Последовательно запустить:
  `pnpm test:assistant:t07:domain`, `pnpm test:assistant:t07:targeted`,
  `pnpm test:assistant:t07:e2e`, FIX-TK1 targeted gates,
  `pnpm test:assistant:fix-geo1:targeted`, `pnpm test` и `pnpm build`.
- [ ] Harness создаёт отдельный disposable URL для каждого PostgreSQL gate и запускает
  его с точным env: `ASSISTANT_FIX_TOKEN_TEST_DATABASE_URL`,
  `ASSISTANT_T03_TEST_DATABASE_URL`, `ASSISTANT_T05_TEST_DATABASE_URL`.
- [ ] Для FIX-GEO1 browser gate harness поднимает свежий web и передаёт
  `ASSISTANT_T05_WEB_TEST_URL=http://127.0.0.1:<port>`; readiness проверяется до
  старта browser test, server закрывается в `finally`.
- [ ] Выполнить полный migration replay/status и cleanup-аудит disposable resources.
- [ ] Запустить browser manual QA на fake AI/embedding/geo: launcher, history, retry,
  POINT/LINE/AREA, cancel/confirm, tile/geocoder degradation, desktop/mobile и RBAC.
- [ ] Зафиксировать точные exit codes, test counts, durations, screenshots и все
  намеренно не запущенные внешние проверки.

## Этап 5 — Отдельно разрешаемый OpenAI smoke

- [ ] Перед запуском получить новую явную команду пользователя с caps:
  2 user requests, 4 model attempts, `$0.50` total.
- [ ] Использовать CLI из PIDAFIX1 на loopback/disposable stack; embeddings fake/disabled,
  Geo Provider, Overpass, connectors и source worker выключены.
- [ ] Проверить простой structured search и сложный mortgage/installment query,
  отсутствие invented facts и Web Search, Luna/Terra decision и persisted telemetry.
- [ ] Сверить ledger: attempts, tokens, reserved/charged USD, settlement и stop reason.
  Raw prompts/responses и credentials в отчёт не попадают.
- [ ] Независимо от результата немедленно вернуть AI mode в fake и удалить временный
  credential из окружения процесса.

## Этап 6 — Отдельно разрешаемый Geo Provider smoke

- [ ] Перед запуском получить новую явную команду пользователя с отдельными
  LocationIQ/Overpass request caps; OpenAI и embeddings остаются fake/disabled.
- [ ] Использовать clean disposable DB и provenance proof,
  `ASSISTANT_GEO_PROVIDER_MAX_RETRIES=0`, запретить
  `ASSISTANT_FIX_GEO1_LIVE_ALLOW_REMOTE` и принимать только loopback API. Cases идут
  последовательно: POINT, Садовое кольцо, ТТК, МКАД, `INSIDE` района Арбат.
- [ ] Для каждого case проверить provider counters, `cacheHit=false`, canonical identity,
  kind/mode, полную reference geometry и безопасный отказ при недоказанной полноте.
- [ ] Browser переиспользует уже сохранённые `landmarkId`/geometry и не вызывает
  providers повторно: counters до/после browser совпадают. Style/tiles остаются
  local stubs; подтверждаются line/area layers, buffer/polygon, filters, markers,
  attribution и ноль OpenFreeMap/Yandex requests.
- [ ] При исчерпании любого cap следующие HTTP-запросы не выполняются. После smoke
  Geo Provider и Overpass возвращаются в disabled/fake state.

## Definition of Done

- [ ] T07 E2E зелёный с актуальным public copy и реальными connected LINE/AREA paths.
- [ ] Свежий local stack воспроизводимо собирается, мигрируется, проверяется и полностью
  очищается без изменения существующих данных пользователя.
- [ ] Полный fake baseline зелёный до первого реального provider call.
- [ ] OpenAI и Geo smoke разделены, fail-closed и не могут превысить утверждённые caps.
- [ ] Итоговый отчёт перечисляет точные вызовы/стоимость, cleanup, ручные проверки,
  skipped external gates и остаточные риски без секретов.
- [ ] Production остаётся полностью нетронутым.
