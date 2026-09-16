# 02: Безопасные предложения застройщиков

**Parent spec:** `docs/helpar/fix-zaebal.md`

**What to build:** Студии из поддерживаемых developer feeds нормализуются в `rooms=0` и становятся доступными в поиске помощника. Пустой или сломанный feed никогда не получает ложный `SUCCESS`, не архивирует существующие лоты и не сдвигает время последнего успешного импорта. Успешный импорт можно доказать карточкой актуального предложения в помощнике.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] До реализации добавлены RED-тесты для exact studio normalization и preview/run с нулём routed units.
- [ ] Только точные нормализованные маркеры `Студия` и `studio` дают `rooms=0` без `INVALID_INTEGER`; fuzzy matching произвольных строк не добавлен.
- [ ] Существующие numeric room formats и остальные поддерживаемые feed dialects не регрессируют.
- [ ] Preview при нуле routed units возвращает FAILED с `FEED_IMPORT_ZERO_UNITS`.
- [ ] Run при нуле routed units завершается FAILED до построения archive plan.
- [ ] Zero-unit failure не меняет существующие units, archive state и source success timestamp.
- [ ] `SUCCESS` возможен только когда хотя бы один unit прошёл routing; PARTIAL остаётся диагностируемым отдельным состоянием.
- [ ] Chat request не запускает синхронный destructive feed import; цена и availability в карточке остаются feed-backed и показывают freshness.
- [ ] Интеграционный сценарий доказывает путь download/parse → preview → disposable apply → assistant search → studio card.
- [ ] Parser/import-engine, feed API/search и authenticated browser tests покрывают успешный и fail-closed пути.
- [ ] Targeted feed suites, затронутый workspace build, затем релевантные full gates и `git diff --check` проходят без ослабления проверок.
- [ ] Реальный feed используется только в отдельно разрешённом acceptance gate; автоматические тесты работают со stub/fixture и disposable PostgreSQL.
- [ ] Disposable-ресурсы очищены, unrelated dirty/untracked-файлы сохранены, изменения оформлены одним scoped local commit без push/deploy.

