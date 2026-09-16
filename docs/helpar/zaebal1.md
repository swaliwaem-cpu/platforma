# 01: Canonical geo и единый product submission path

**Parent spec:** `docs/helpar/fix-zaebal.md`

**What to build:** Любой запрос с геоусловием проходит тот же deterministic Place Resolver flow, что и обычный UI. Подтверждённые расстояния, составные условия и области доходят до поиска как canonical hard filters; неоднозначность требует явного выбора. Прямой вызов message API без canonical geo завершается fail-closed до создания run и до любых planner/provider-вызовов.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] До реализации добавлены RED-регрессии для прямого API bypass, 900 м от Белорусского вокзала, ТТК + Москва-Сити, МКАД, `INSIDE Арбат` и неоднозначного условия `у воды`.
- [ ] Существует один server-side deterministic seam для распознавания geo-bearing input; Place Resolver и message boundary используют его без дублирования грамматики.
- [ ] Geo-bearing message без canonical geo возвращает HTTP 400 `ASSISTANT_GEO_CONTEXT_REQUIRED` и не создаёт message, run, planner attempt или provider receipt.
- [ ] Обычный UI сначала вызывает Place Resolver, показывает ambiguity/manual-choice state и отправляет сообщение только с подтверждённым canonical geo.
- [ ] Неоднозначный `WATER` всегда даёт `REFINE_REQUIRED`; условие нельзя отбросить или превратить в неограниченный поиск.
- [ ] Составные условия сохраняют `operator=ALL`, независимые distance values и стабильные slot identities.
- [ ] Canonical geo source spans исключаются из повторного извлечения как `metro` или `district`; отдельно указанный административный район остаётся hard filter.
- [ ] Live/eval client переиспользует product orchestration UI и больше не отправляет raw message в обход Place Resolver.
- [ ] Authenticated browser E2E доказывает полный путь UI → resolver → message/run → search → cards/map для POINT и composite geo.
- [ ] API contract test доказывает fail-closed boundary и отсутствие побочных записей/вызовов при bypass.
- [ ] Targeted geo/API/browser suites, затронутый workspace build, затем релевантные full gates и `git diff --check` проходят без `.only`/`.skip`.
- [ ] Disposable-ресурсы очищены, unrelated dirty/untracked-файлы сохранены, изменения оформлены одним scoped local commit без push/deploy.

