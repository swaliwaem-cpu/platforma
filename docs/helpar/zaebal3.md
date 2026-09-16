# 03: Grounded-факты и сравнение ЖК

**Parent spec:** `docs/helpar/fix-zaebal.md`

**What to build:** Запросы про текущие условия используют свежо перепроверенные факты только из доверенных зарегистрированных источников, показывают официальный источник и честную freshness. Сравнение двух ЖК возвращает две независимые grounded-группы с полезным summary; отсутствие данных по одному ЖК не скрывает подтверждённые данные по другому.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] До реализации добавлены RED-регрессии для unchanged refresh, freshness/relevance, source conflict и comparison с данными по обоим/одному/ни одному target.
- [ ] `verifiedAt` означает время последней успешной проверки source; immutable revision timestamp хранит время ревизии отдельно, без новой Prisma migration.
- [ ] Успешный refresh с неизменным checksum двигает `verifiedAt`, не создавая duplicate revision.
- [ ] Freshness label и `isStale` считаются от `verifiedAt`; stale/failed refresh не допускает безусловную формулировку «сейчас» или «актуально».
- [ ] Для current-condition FACT выполняется не более одного idempotent bounded refresh уже зарегистрированного exact-host source, ожидание ограничено deadline текущего run.
- [ ] После refresh retrieval повторяется только по persisted facts; raw connector/model text не попадает в ответ.
- [ ] При отсутствии trusted registered source возвращается `SOURCE_NOT_CONNECTED`; произвольный веб-контент не становится evidence.
- [ ] Retrieval сначала учитывает query/intent relevance: запрос о рассрочке выбирает условия покупки/акции и исключает нерелевантную архитектуру/маркетинг.
- [ ] Конфликт разрешается по правилу official project → official developer/bank → deterministic internal data; ответ явно сообщает о конфликте и выбранном приоритете.
- [ ] Fact cards содержат `sourceLabel`, canonical HTTPS `sourceUrl` и `verifiedAt`.
- [ ] Shared answer contract поддерживает `COMPARISON_RESULTS`: отдельная группа на каждый exact target, `MATCHED`/`NO_MATCH`, exact count, grounded cards, min price, completion и metro summary.
- [ ] При наличии evidence хотя бы по одному target generic refusal запрещён; desktop показывает две подписанные группы, mobile — те же группы в stack без изменения семантики.
- [ ] Source/PostgreSQL/answer-contract и authenticated desktop/mobile browser tests проходят вместе с затронутым build, релевантными full gates и `git diff --check`.
- [ ] Disposable-ресурсы очищены, unrelated dirty/untracked-файлы сохранены, изменения оформлены одним scoped local commit без push/deploy.

