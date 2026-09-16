# 06: 200-case eval и Release Candidate gate

**Parent spec:** `docs/helpar/fix-zaebal.md`

**What to build:** Один bounded runner создаёт ровно 200 свежих persisted runs через тот же authenticated product path, что и UI, и передаёт их существующему evaluator. Release Candidate считается доказанным только после зелёной полной baseline, десяти adversarial UI-кейсов, feed/source/geo canaries, health checks и read-only rollout preflight; ticket не выполняет deploy и не переводит rollout в PILOT/ALL.

**Blocked by:** 01: Canonical geo и единый product submission path; 02: Безопасные предложения застройщиков; 03: Grounded-факты и сравнение ЖК; 04: Fail-closed Internet и Web Search accounting; 05: Реальное гео POINT, LINE и AREA.

**Status:** ready-for-agent

- [ ] До реализации добавлены RED-тесты bounded runner на exact count, product orchestration, idempotency, caps, critical stop, manifest и cleanup.
- [ ] Runner загружает frozen dataset, создаёт одну isolated conversation на case, использует unique idempotency key и проходит Place Resolver/message/run lifecycle как UI.
- [ ] Runner имеет явные RPM, daily request и USD caps, fail-closed при critical violation, не пишет credentials и выдаёт sanitized manifest ровно из 200 unique `caseId → runId`.
- [ ] Existing manifest/evaluator остаётся authority для dataset SHA, persisted evidence и verdicts; runner не рассчитывает и не переопределяет оценки.
- [ ] Полностью зелёны обязательные feed, FIX-GEO1 targeted/PostgreSQL, T03 PostgreSQL, T07 E2E, PIDAFIX3 baseline, workspace test/build и diff-check gates из parent spec.
- [ ] Все 10 adversarial запросов проходят через authenticated UI с ожидаемым contract и нулём silent hard-filter drops, invented facts/links и stale-current claims.
- [ ] Feed gate подтверждает preview всех active feeds, классификацию PARTIAL, отсутствие неожиданного `SUCCESS + 0 units` и хотя бы один real-feed download → disposable apply → assistant card.
- [ ] Source canary запускается только после новой явной команды с точным cost cap и доказывает: один Responses request, ровно один Web Search call, `reserve >= charge`, ноль RESERVED attempts, успешные registration и indexing.
- [ ] Geo canary запускается только после новой явной команды с cap не более 8 LocationIQ + 3 Overpass attempts и доказывает 5/5 RESOLVED с `cacheHit=false`, полное settlement и ноль новых calls при browser reuse.
- [ ] Eval содержит ровно 200 unique COMPLETED runs младше 24 часов: overall ≥ 90%, каждая category ≥ 80%, average quality ≥ 85%, p95 ≤ 15 s, attempts ≤ 1.1, tokens ≤ 2500, geo calls ≤ 0.25.
- [ ] Zero tolerance соблюдён для auth/hard-filter/source-priority violations, invented price/availability, unsupported links и evidence leakage.
- [ ] Каждый active knowledge source имеет успешные fetch/indexing младше 36 часов без error; feed health и zero-unit conditions проверены отдельно.
- [ ] Read-only rollout preflight зелёный; cohort/append-only sequence `ADMINS → PILOT → ALL` валидированы, но rollout event, deploy и environment mutation не выполняются.
- [ ] Каждый real provider gate использует отдельную свежую авторизацию; при первом failure повторный платный вызов не делается автоматически.
- [ ] Evidence bundle очищен от секретов и raw payloads, содержит run/revision/receipt/quality provenance и точный отчёт об очищенных disposable resources.
- [ ] Ticket завершается только когда все live gates реально разрешены и зелёные; без отдельной авторизации он останавливается на соответствующем acceptance gate и не выдаётся за release-ready.
- [ ] Unrelated dirty/untracked-файлы сохранены, изменения runner/evidence оформлены одним scoped local commit без push/deploy/rollout advance.
