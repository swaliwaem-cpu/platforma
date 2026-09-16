# PIDAFIX2: Безопасный локальный Geo Provider smoke

**What to build:** устранить ложноположительный FIX-GEO1 smoke и на local stubs
доказать hard caps, provider provenance и fail-closed обработку Садового кольца,
ТТК, МКАД и района Арбат. Фактические LocationIQ/Overpass calls принадлежат только
отдельно разрешаемому PIDAFIX3.

**Blocked by:** [FIX-GEO1](./fix-geo1.md).

**Status:** ready-for-agent

## Границы

- [ ] Ticket не подключается к production, не меняет production config и не
  запускает реальные provider calls во время реализации.
- [ ] Автотесты используют local HTTP stubs и disposable PostgreSQL/PostGIS.
- [ ] Browser не передаёт arbitrary GeoJSON: ingress остаётся trusted landmark ID
  либо validated manual point.
- [ ] Routing, travel time, directions и расстояние по дорогам остаются вне scope.
- [ ] Новые зависимости не добавляются. Prisma migration не ожидается; если текущая
  schema не может выразить контракт, реализация останавливается для отдельного
  additive migration plan.

## Этап 1 — RED для provider provenance и лимитов

- [ ] Live-smoke не может пройти на существующем fake landmark, старом cache или
  negative cache. Одновременно нужны clean disposable DB, mode `locationiq`,
  включённый Overpass, свежие before/after counters, `cacheHit=false` и доказанные
  `source_provider=locationiq|overpass`; ни один признак отдельно не достаточен.
- [ ] Зафиксировать resolution-wide hard cap для всех физических LocationIQ retries,
  city lookups и Overpass attempts. Превышение блокирует следующий HTTP-вызов.
- [ ] Для smoke `ASSISTANT_GEO_PROVIDER_MAX_RETRIES=0`; один timeout не должен
  превращаться в скрытую серию запросов.
- [ ] API enforce-ит
  `ASSISTANT_GEO_MAX_LOCATIONIQ_ATTEMPTS_PER_RESOLVE=2` и
  `ASSISTANT_GEO_MAX_OVERPASS_ATTEMPTS_PER_RESOLVE=1`. Reservation выполняется
  перед каждым physical fetch; попытка `N+1` не отправляется.
- [ ] Batch CLI требует
  `--max-locationiq-attempts 7 --max-overpass-attempts 3 --max-total-attempts 10`.
  Road case допускает максимум 2 LocationIQ + 1 Overpass, AREA — 1 LocationIQ;
  четыре user cases не могут развернуться в десятки вызовов.
- [ ] Overpass получает отдельные atomic RPM/day reservations и persisted outcome;
  одного in-memory RPS/circuit breaker недостаточно для hard ceiling.

## Этап 2 — ТТК, МКАД и bounded aliases

- [ ] Ввести версионированный фиксированный alias set. Для `ТТК`: UI label `ТТК`,
  canonical/`normalized_query` `третье транспортное кольцо`, aliases `ттк` и
  `третье транспортное кольцо`, точные tag values `ТТК` и
  `Третье транспортное кольцо`. Для `МКАД`: UI label `МКАД`, canonical query
  `московская кольцевая автодорога`, aliases `мкад`,
  `московская кольцевая автодорога`, `московская кольцевая автомобильная дорога`,
  и соответствующие exact tag values после case/`ё` normalization.
- [ ] Resolver отделяет пользовательский label от canonical provider query и сохраняет
  UI label, canonical `normalized_query`, user alias, canonical aliases и provider
  query раздельно для повторного deterministic lookup.
- [ ] Inflections полного названия, аббревиатура и canonical form дают одну identity,
  но не расширяют поиск до unrelated sibling names или другого города.
- [ ] Overpass query проверяет точные allowlisted `name`, `official_name`,
  `short_name`, `alt_name` или `ref`; произвольное совпадение текста не принимается.

## Этап 3 — Fail-closed полнота Overpass

- [ ] Для кольцевых дорог принимается только road/route relation с ожидаемыми tags,
  всеми way members и geometry каждого member. Ways-only и unrelated relation
  отклоняются.
- [ ] Одна complete allowlisted road-route relation имеет приоритет; дублирующие её
  top-level ways игнорируются. Две разные complete relations дают ambiguity, если
  их отсортированный member fingerprint не совпадает.
- [ ] Ring closure проверяется по exact first/last OSM coordinates после dedup:
  каждый connected component не имеет degree-1 endpoints. Никакое snapping или
  произвольная tolerance не достраивают разрыв; несмыкание fail-closed.
- [ ] `remark`, truncation, oversized response, отсутствующий member, invalid point,
  неоднозначные identities и незамкнутая/недоказанная ring geometry возвращают
  `UNAVAILABLE/REFINE`, а не сохранённую `LINE`.
- [ ] Один неполный candidate не маскируется другим fragment и не записывается как
  verified landmark.
- [ ] Provider/geometry failure не превращается в пустой negative cache. Negative
  cache допустим только для доказанного успешного provider response без кандидатов.
- [ ] City area lookup выполняется не более одного раза на resolve; одинаковый
  Overpass collect также memoized/single-flight в пределах операции.
- [ ] AREA принимается только как единственная Moscow/RU identity с
  `boundary=administrative` и валидным Polygon/MultiPolygon. Wrong-area,
  ambiguous-area и centroid-only response отклоняются; centroid fallback запрещён.

## Этап 4 — TTL и audit contract

- [ ] `assistant_geo_cache.expires_at` и `assistant_geo_landmarks.expires_at` для
  LocationIQ используют фактический `ASSISTANT_GEO_CACHE_TTL_SECONDS`; cache expiry
  не позже verified landmark expiry.
- [ ] Verified Overpass geometry получает явно документированный TTL 30 дней;
  `confirmation_state=confirmed` сохраняет `expires_at=NULL` и не истекает.
- [ ] Audit сохраняет безопасные counters, provider, cache hit, outcome и error code,
  но не API key, raw payload или полный query URL.
- [ ] Live-smoke принимает явные максимумы LocationIQ/Overpass attempts, снимает
  before/after counters и падает, если provenance или расход нельзя доказать.
- [ ] Resolution provenance читается из `assistant_geo_operations`, физические
  counters/outcomes — из существующего usage budget. Если существующая schema не
  даёт persisted receipt на каждый attempt, срабатывает migration STOP из границ.
- [ ] Cases можно запускать по одному; общий smoke не продолжает следующие cases
  после исчерпания любого hard budget.

## Этап 5 — Проверки

- [ ] `assistant-fix-geo1-domain.test.cjs`: acronyms, exact aliases/ref,
  partial/unrelated relation rejection, invalid geometry без negative cache,
  duplicate ways, two-relation ambiguity, exact closure, wrong/ambiguous AREA,
  single city lookup, single Overpass collect и hard attempt cap.
- [ ] `assistant-t05-postgres.cjs`: configured cache expiry, confirmed non-expiry,
  atomic LocationIQ/Overpass budgets и отсутствие overspend при race.
- [ ] Тест live-smoke: opt-in, local-only, clean/provenance proof, max calls и остановка
  до перерасхода; все provider endpoints являются local stubs.
- [ ] Запустить `pnpm test:assistant:fix-geo1:targeted`, disposable PostGIS gate,
  `pnpm --filter @platforma/api test`, `pnpm test`, `pnpm build`,
  `docker compose config --quiet` и `git diff --check`.
- [ ] Проверить migration replay/status, отсутствие `.only`/`.skip`, секретов,
  новых зависимостей и оставшихся containers/networks/volumes.

## Definition of Done

- [ ] Fake/cache данные не могут выдать себя за успешный live-provider smoke.
- [ ] ТТК и МКАД разрешаются через bounded canonical identity без raw regex.
- [ ] Неполная или неоднозначная дорога никогда не сохраняется как полная `LINE`.
- [ ] LocationIQ и Overpass имеют единый доказуемый hard ceiling физических attempts.
- [ ] TTL соответствует provider policy, audit безопасен, все fake/PostGIS gates зелёные.
- [ ] Реальный LocationIQ/Overpass smoke остаётся отдельным разрешаемым шагом
  [PIDAFIX3](./pidafix3.md).
