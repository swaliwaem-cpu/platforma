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

Эти проверки выполняются только вручную после отдельного разрешения и с уже
настроенными credentials. Они не входят в CI и не должны запускаться этим тикетом.

### OpenAI

- включить реальный AI mode только в disposable/local окружении;
- выполнить один простой structured search и один сложный mortgage/installment query;
- лимит: не более двух пользовательских запросов и не более четырёх model attempts;
- подтвердить telemetry, token budget, fallback и отсутствие invented facts;
- сразу вернуть fake mode и удалить временный credential из окружения процесса.

### LocationIQ

- включить Geo Provider отдельно от assistant и MapLibre renderer;
- выполнить один resolve `Павелецкая Плаза, Москва` с радиусом 2 км;
- лимит: один пользовательский resolve и не более двух HTTP attempts с retry;
- подтвердить provider call counter, cache и degraded state при искусственном timeout;
- сразу вернуть fake mode.

### OpenFreeMap

- включить renderer с утверждённым style URL без изменения Geo Provider flag;
- открыть один catalog map и одну object detail map;
- подтвердить Moscow tiles, attribution, marker/list sync и отсутствие Yandex requests;
- не выполнять crawl, tile prefetch или нагрузочный тест.

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
