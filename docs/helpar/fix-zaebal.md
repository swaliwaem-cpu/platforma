# FIX-ZAEBAL: доведение ИИ-помощника до релизной готовности

Статус: `ready-for-agent`

## Problem Statement

Platforma готовится к релизу ИИ-помощника для брокеров недвижимости, но текущий
production-like прогон показал разрыв между зелёной локальной инфраструктурой и
реальной пользовательской полезностью.

Все 10 запросов технически завершились, однако продуктовая оценка составила
3 PASS, 2 PARTIAL и 5 FAIL. Надёжно работают обычный структурированный поиск по
уже импортированным предложениям, корректные уточнения для явно неполного запроса
и безопасная юридическая граница. Ненадёжно работают составные геоусловия,
реальная геометрия, сравнение ЖК, актуальность официальных фактов, студии в части
фидов и контроль стоимости Web Search.

Проверка также выявила дефект самого live-harness: сообщения отправлялись прямо в
message endpoint без предварительного вызова Place Resolver, который выполняет
обычный UI. Поэтому часть геоусловий была потеряна до запуска planner. Это не
оправдывает backend: прямой API-клиент не должен иметь возможность незаметно
обойти обязательное geo-resolution и получить выдачу без пользовательского hard
filter.

Подтверждённые проблемы:

- запрос с обычными фильтрами нашёл 81 точное предложение и корректно отрисовал
  карточки, но сложные геоусловия терялись или превращались в `district`/`metro`;
- `у воды` было молча отброшено вместо обязательного уточнения;
- `COMPARE` распознал оба ЖК, но вернул общую отписку вместо сравнения;
- официальный TATE успешно перепроверился без изменения checksum, однако ответ
  продолжил считать факты устаревшими и добавил нерелевантный контент;
- КОРТРОС/TATE отдал студии строкой `Студия`, что привело к `INVALID_INTEGER` и
  потере `rooms=0`;
- один фид получил `SUCCESS` при нуле распознанных лотов;
- один Responses-запрос с `max_tool_calls=1` вернул два `web_search_call`, из-за
  чего фактическое списание превысило резерв;
- реальный LocationIQ не дал ни одной доверенной итоговой геометрии для
  Белорусского вокзала, Арбата, ТТК, МКАД и Садового кольца; Overpass не был
  достигнут;
- существующий eval manifest умеет собирать готовые runs, но отсутствует bounded
  runner, создающий ровно 200 свежих persisted runs через настоящий продуктовый
  путь.

Помощник нельзя переводить в `ALL`, пока он способен молча терять hard filters,
называть старые сведения актуальными или выходить за зарезервированный бюджет.

## Solution

Довести помощника до релизной готовности пятью последовательными вертикальными
этапами:

1. Закрыть обход geo-resolution и гарантировать, что каждое пользовательское
   условие либо становится canonical hard filter, либо вызывает явное уточнение.
2. Исправить предложения застройщиков, freshness официальных источников и
   отдельный grounded-ответ для сравнения ЖК.
3. Оставить planner парсером, а интернет реализовать через bounded refresh
   зарегистрированных официальных источников и безопасный background discovery с
   корректным reserve/settlement.
4. Исправить реальные POINT/LINE/AREA запросы LocationIQ/Overpass, не ослабляя
   identity и полноту геометрии.
5. Добавить bounded 200-case runner и выпускать строго
   `ADMINS → PILOT → ALL` через существующий fail-closed preflight.

Пока этапы не завершены, rollout остаётся `ADMINS`, real geo и live source
discovery выключены. Первый внутренний release candidate допускается после первых
трёх этапов с честно недоступным geo. Полноценный pilot с заявленной картой
допускается только после зелёного реального geo-canary и 200-case eval.

## User Stories

1. As a broker, I want every distance and location condition to remain a hard filter, so that the assistant never shows properties outside my request silently.
2. As a broker, I want a query near Belorussky railway station to preserve the explicit 900-metre distance, so that proximity is measured rather than treated as a metro name.
3. As a broker, I want TTK and Moscow City to remain two independent geo constraints, so that both conditions are applied together.
4. As a broker, I want `inside Arbat` to use the verified district polygon, so that results are actually inside the requested area.
5. As a broker, I want `near water` to require a concrete landmark or manual selection, so that the assistant does not invent or drop an ambiguous constraint.
6. As an API consumer, I want a geo-bearing message without canonical geo context to fail explicitly, so that bypassing the UI cannot weaken the request.
7. As a broker, I want studio values from developer feeds to be normalized to zero rooms, so that studio inventory remains searchable.
8. As a broker, I want live developer inventory to be imported safely, so that current price and availability cards come from grounded feed units.
9. As an operator, I want an empty feed to fail without archiving existing inventory, so that a broken upstream response cannot remove valid offers.
10. As an operator, I want `SUCCESS` to mean that at least one unit passed routing, so that source-health dashboards cannot be falsely green.
11. As a broker, I want unchanged official pages to record a fresh verification time, so that a successful recheck is not presented as stale content.
12. As a broker, I want stale official information to be labelled honestly, so that old purchase terms are never described as current.
13. As a broker, I want installment questions to return installment facts rather than architecture or marketing text, so that the answer addresses my decision.
14. As a broker, I want every current-condition answer to name and link its official source, so that I can verify the claim.
15. As a broker, I want conflicting Platforma and official-source data to be resolved by an explicit source-priority rule, so that I know which terms to trust.
16. As a broker, I want two residential developments to be compared in separate grounded groups, so that missing data for one does not hide valid data for the other.
17. As a broker, I want comparison summaries to include confirmed price, completion and metro data, so that the result is useful without opening every card.
18. As a broker, I want an exact registered source to be refreshed for questions containing `сейчас` or `актуально`, so that time-sensitive answers use a recent check.
19. As a broker, I want a clear `source not connected` answer when no trusted source exists, so that arbitrary web content is not presented as official evidence.
20. As an administrator, I want discovery of new official sites to remain an admin/background operation, so that chat requests cannot expand the trust perimeter.
21. As a finance owner, I want every physical model and Web Search attempt reserved before HTTP, so that provider spending cannot exceed configured budgets silently.
22. As a finance owner, I want responses exceeding the Web Search tool-call contract to be settled and rejected, so that usage remains attributable without accepting unsafe output.
23. As an operator, I want retries and fallback disabled after a tool-call contract violation, so that one malformed response cannot multiply cost.
24. As a broker, I want Belorussky railway station to resolve to a verified point in Moscow, so that point-radius search works with natural Russian cases.
25. As a broker, I want TTK, MKAD and the Garden Ring to resolve to complete road geometry, so that distance is measured to the road rather than an arbitrary point.
26. As a broker, I want Arbat to resolve to a verified area geometry, so that `INSIDE` uses `ST_Covers` rather than a radius approximation.
27. As an operator, I want geo-provider rejection reasons to be safely classified, so that identity, scope, shape and response-size failures can be diagnosed without storing raw payloads.
28. As an operator, I want corrected geo identities to use a new cache version, so that old negative cache entries cannot mask a fix.
29. As a product owner, I want the original ten adversarial queries to run through the authenticated UI, so that acceptance covers the same path brokers use.
30. As a product owner, I want exactly 200 fresh frozen eval cases to be executed by a bounded runner, so that rollout does not depend on manually assembled runs.
31. As a product owner, I want rollout thresholds and zero-tolerance violations enforced automatically, so that schedule pressure cannot bypass quality gates.
32. As a pilot user, I want the assistant enabled only for the approved cohort, so that defects are contained before general availability.
33. As an auditor, I want every run, evidence revision, provider attempt and quality flag persisted, so that release decisions are reproducible.
34. As an operator, I want disposable tests and canaries to clean up their exact resources, so that verification does not damage or pollute the ordinary local environment.
35. As a project maintainer, I want unrelated dirty and untracked files preserved, so that assistant work does not overwrite user-owned changes.

## Implementation Decisions

### 1. Execution order and rollout state

- Implement the five stages in order. Each stage begins with failing regression
  tests, ends with targeted verification and receives its own scoped local commit.
- Keep the assistant on `ADMINS` until every stage is green. Do not record a PILOT
  or ALL rollout event as part of implementation.
- Real provider calls are not ordinary test steps. Each OpenAI/Web Search or Geo
  canary requires a new explicit command with exact caps even if earlier calls were
  authorized in another conversation.
- A failed acceptance gate stops the sequence. Do not weaken tests, switch to fake
  evidence or continue to the next stage.

### 2. Canonical geo at the message boundary

- Extract the existing deterministic geo-input inspection into one server-side
  seam shared by Place Resolver and message creation. Do not duplicate the grammar
  in controller, UI and planner.
- Before persisting a user message, inspect its content without calling an external
  provider. If it contains a geo constraint and canonical geo is absent, return
  HTTP 400 with `ASSISTANT_GEO_CONTEXT_REQUIRED`; do not create a conversation run
  or invoke the planner.
- The normal UI continues to call Place Resolver, display ambiguity/manual-choice
  UI and submit only confirmed canonical geo.
- Canonical geo source spans are unavailable to the model as candidate
  `metro`/`district` text. A distinct explicit administrative district remains a
  normal hard filter.
- Composite constraints retain `operator=ALL`, independent distance values and
  stable slot identities. An unresolved `WATER` category is `REFINE_REQUIRED` and
  cannot degrade to an unbounded search.
- The live/eval client must reuse the same orchestration as the UI instead of
  posting raw messages directly.

### 3. Developer inventory, facts and comparison

- Recognize only exact normalized studio markers such as `Студия` and `studio` as
  `rooms=0`; do not add fuzzy matching for arbitrary room strings.
- Treat zero routed units as `FEED_IMPORT_ZERO_UNITS`. Preview returns FAILED. Run
  returns FAILED before building an archive plan, does not alter existing units and
  does not update source success time.
- Current developer offers remain feed-backed. Chat requests never execute a
  destructive feed import synchronously. Price and availability always show feed
  freshness.
- Define `verifiedAt` for knowledge evidence as the latest successful source check,
  while preserving the immutable revision timestamp separately. An unchanged
  checksum can therefore be freshly verified without creating a duplicate revision.
- Freshness labels and `isStale` use `verifiedAt`. If verification is stale, the
  answer cannot use unconditional current-tense wording.
- Retrieval uses query/intent relevance before authority ranking. Installment
  questions select promotion/purchase-condition facts and exclude unrelated
  architecture or marketing facts.
- Official project source wins a current-condition conflict, followed by official
  developer/bank sources and then deterministic internal data. The response states
  the conflict and priority rather than hiding it.
- Add `COMPARISON_RESULTS` to the shared answer contract. It contains one group per
  exact target with target name, `MATCHED`/`NO_MATCH`, total exact count, grounded
  cards and a summary of confirmed minimum price, completion values and metros.
- If one target is matched, render its data and a specific no-data state for the
  other. Generic refusal is forbidden when any target has evidence. Desktop uses
  two labelled groups; mobile stacks the same groups without changing semantics.
- Knowledge fact cards expose `sourceLabel`, canonical HTTPS `sourceUrl` and
  `verifiedAt`. No Prisma migration is required because the source and timestamps
  already exist.

### 4. Bounded internet and spend accounting

- Planner remains a structured intent parser and receives no arbitrary web tool.
- For `FACT` queries explicitly requiring current conditions, or when selected
  evidence is stale, enqueue one idempotent targeted refresh of the already
  registered exact-host source. Wait only within the existing assistant-run
  deadline, then repeat retrieval from persisted facts.
- If refresh fails or misses the deadline, return a grounded inability to confirm
  current conditions. Never answer from raw connector or model text.
- If no trusted source is registered, return `SOURCE_NOT_CONNECTED`; discovery is
  queued for the admin/background lane and does not affect the current answer.
- Keep request `max_tool_calls=1`, but reserve the cost of two Web Search calls until
  provider behaviour is proven stable because two calls were observed in one
  response.
- Count all returned `web_search_call` items. Settle actual known usage first. When
  the count is not exactly one, reject the candidate with
  `ASSISTANT_SOURCE_DISCOVERY_TOOL_CALL_LIMIT_EXCEEDED`, skip retry/Terra, skip
  checkpoint mutation and skip source registration.
- Add `PROVIDER_BUDGET_CONTRACT_VIOLATION` as a critical rollout condition when
  charge exceeds reserve, an attempt remains RESERVED, or persisted physical-call
  receipts disagree with reported usage.
- Discovery remains disabled until one separately authorized canary proves one
  Responses request, one Web Search call, `reserve >= charge`, zero outstanding
  reservations and successful source registration/indexing.

### 5. Real POINT, LINE and AREA geometry

- Add the missing required geo cache TTL to the live runtime contract and its
  configuration test.
- Add a provider request purpose: `FULL_GEOMETRY`, `METADATA` or `BOUNDS`.
  LocationIQ requests polygon GeoJSON only for AREA full geometry. POINT, LINE
  identity and Moscow bbox lookup do not request polygon data. Keep the existing
  response-size limit; do not hide oversized responses by increasing it.
- Canonicalize Belorussky railway station to nominative Russian with explicit Moscow
  and RU scope while retaining inflected user aliases.
- Known ring-road identities require exact allowlisted name/OSM identity, highway
  class and RU scope. Missing `candidate.city` alone does not reject a ring road;
  explicit wrong country or identity still does.
- Use the expected Moscow scope for the bbox and require a complete exact-tag
  Overpass relation with all members and closed/valid geometry. Do not accept
  centroids, fragments, ways-only or approximate point fallbacks.
- Arbat accepts only bounded exact names/namedetails and allowlisted OSM identity.
  Missing `address.city` may pass when canonical Moscow scope and identity match;
  explicit other-city, wrong class/type, way/centroid or ambiguity remains rejected.
- Persist safe internal rejection categories for identity, scope, shape and size;
  never persist raw provider payloads.
- Bump the geo identity/cache version so earlier negative cache entries are not
  reused. No Prisma migration is required.

### 6. Eval runner and release gates

- Add a bounded `eval:assistant:run` command that loads the frozen dataset, creates
  one isolated conversation per case, uses unique idempotency keys, executes the
  same geo-resolution/message flow as the UI and waits for terminal persisted runs.
- The runner has explicit RPM, daily request and USD caps, stops on a critical
  violation, writes no credentials and emits a sanitized manifest of exactly 200
  unique `caseId → runId` mappings.
- Existing manifest/evaluator remain the authority for dataset SHA, persisted
  evidence and scoring. The new runner produces inputs; it does not calculate or
  override verdicts.
- Rollout remains append-only and sequential `ADMINS → PILOT → ALL`. PILOT contains
  8–12 active ordinary users with `objects:read` and without administrative
  permissions.
- Production deployment, environment mutation and recording a rollout stage require
  separate operator authorization after a green read-only preflight.

## Testing Decisions

### Test seams

- The primary acceptance seam is one authenticated connected browser journey through
  the real UI, Place Resolver, message/run lifecycle, PostgreSQL/PostGIS, search,
  grounded answer and MapLibre rendering. This is the highest existing seam and
  prevents another false result caused by bypassing geo-resolution.
- Add an API contract test only for the security/consistency boundary that a direct
  geo-bearing message without canonical geo fails before run creation.
- Use provider stubs plus disposable PostgreSQL for request parameters, identity,
  receipts, reserve/settlement, cache and archive invariants that browser tests
  cannot prove atomically.
- Use feed-import parser/import-engine tests for normalization and zero-unit safety.
- Real providers are covered only by separate capped canaries after the complete fake
  baseline is green.

### Required regression scenarios

- The ten adversarial queries from the diagnostic run become named regression cases:
  structured search, point distance, composite road/landmark, MKAD commercial,
  Arbat INSIDE, water refinement, comparison, TATE conflict/freshness, vague-family
  clarification and legal/tax safety boundary.
- Direct API bypass creates no run and makes no planner/provider call.
- Studio text yields `rooms=0` without `INVALID_INTEGER`; numeric room formats and
  other feed dialects do not regress.
- Zero-unit preview/run is FAILED, preserves inventory and success timestamps, and
  cannot trigger archival.
- Unchanged official refresh advances verification time without duplicating a
  revision; stale/failed refresh never claims current conditions.
- Comparison preserves both target identities and renders matched/no-match states
  independently.
- A stub response with two Web Search calls reserves for two, settles two, rejects
  the candidate, performs one HTTP request and performs no fallback.
- AREA requests include polygon geometry; POINT/LINE/BOUNDS requests do not.
- Belorussky resolves from inflected input; known roads without `candidate.city`
  reach Overpass; wrong identity/country does not; Arbat exact identity passes while
  centroid/ambiguous/wrong-area candidates fail closed.
- Cache versioning prevents old negative hits after identity changes.

### Automated gates

Run targeted feed, source, geo, PostgreSQL and browser suites first, then the full
workspace gates:

```bash
pnpm --filter @platforma/feed-import test
pnpm test:assistant:fix-geo1:targeted
pnpm test:assistant:fix-geo1:postgres
pnpm test:assistant:t03:postgres
pnpm test:assistant:t07:e2e
ASSISTANT_PIDAFIX3_MANUAL_QA=true pnpm test:assistant:pidafix3:baseline
pnpm test
pnpm build
git diff --check
```

No test may use `.only`, `.skip`, production data or a real paid provider. Migration
tests, when relevant, use explicit disposable PostgreSQL. This spec does not require
a schema migration.

### Live acceptance gates

- Repeat the ten adversarial cases through the authenticated product UI. All ten must
  meet their expected contract; safe clarification/refusal counts as PASS only where
  the case explicitly expects it. There must be zero silent hard-filter drops,
  invented facts, unsupported links or stale-current claims.
- Feed gate: studios survive, all active feeds are previewed, every PARTIAL is
  classified, and there is no unexpected `SUCCESS + 0 units`. Prove at least one
  complete real-feed `download → apply in disposable DB → assistant card` journey.
- Source canary: one Responses request, exactly one Web Search call, reserve not below
  charge, no RESERVED attempts and successful registration/indexing. The command has
  a newly approved explicit cost cap.
- Geo canary: Belorussky POINT, Arbat AREA and Garden Ring/TTK/MKAD LINE all RESOLVED
  with `cacheHit=false`; no more than 8 LocationIQ + 3 Overpass physical attempts;
  all receipts SETTLED; browser reuse makes no additional provider call.
- Eval gate: exactly 200 unique completed runs not older than 24 hours; overall pass
  at least 90%, every category at least 80%, average quality at least 85%, p95 no more
  than 15 seconds, average model attempts no more than 1.1, average tokens no more
  than 2500 and average geo calls no more than 0.25.
- Zero tolerance: auth violation, hard-filter violation, source-priority violation,
  invented price/availability, unsupported link and evidence leakage.
- Source health: every active knowledge source has successful fetch and indexing no
  older than 36 hours and no error. Feed health and zero-unit conditions are checked
  additionally because the existing rollout preflight does not cover them.

## Out of Scope

- Production deployment, SSH, production migrations, production environment changes
  and recording PILOT/ALL rollout events.
- Broad arbitrary Web Search inside the planner or untrusted raw web text in answers.
- Synchronous destructive feed imports from a user chat request.
- Weakening exact-host trust, geo identity, Overpass completeness, hard caps or
  settlement rules to make a canary green.
- Redesigning the catalog map, replacing MapLibre or changing unrelated catalog and
  object behaviour.
- Embedding benchmark/model migration, Telegram, Training, storage and unrelated
  platform features.
- New third-party dependencies, broad refactors, historical migration edits or
  changes to user-owned unrelated files.
- Publishing this spec to an external issue tracker; the user explicitly requested a
  repository-local document.

## Further Notes

- The diagnostic run was performed on `main` at
  `7a503ac8cbaf0aa331d5ea76cd76af7411a6d60c`. A new implementation window must
  record and validate its current branch/HEAD rather than assuming that anchor is
  still current.
- At spec creation time, `AGENTS.md` was modified and
  `docs/helpar/fix-tk1.md`, `pidafix1.md`, `pidafix2.md` and `pidafix3.md` were
  untracked user-owned files. Preserve them and do not stage them with this work.
- Implementation uses TDD and one scoped local commit per numbered stage. Do not push,
  deploy, apply production migrations or run real providers merely because this spec
  is marked `ready-for-agent`.
- A configured key, HTTP 200, fake/cache success or green unit suite is not release
  evidence. Provider provenance, physical-attempt receipts, fresh data and the
  connected browser path are required.
- If a real canary fails, do not repeat the same paid request automatically. Record the
  first failure, correct code/config under fake/stub coverage, obtain a fresh explicit
  capped command and then run a new canary.
- After every disposable run, verify cleanup of its exact containers, networks,
  volumes and images and preservation of the ordinary local Platforma services.
- Definition of release-ready: all five stages complete; all automated and live gates
  above green; read-only rollout preflight green; no unresolved reservations,
  critical flags, silent filter loss, stale-current claims or unhealthy source/feed
  state.
