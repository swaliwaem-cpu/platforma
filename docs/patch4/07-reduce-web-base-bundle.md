# Этап 7. Уменьшить базовый web bundle

Приоритет: P3

Тип работы: измеряемая frontend-оптимизация

Production: запрещён

## Промт этапа

```text
Цель: уменьшить первоначально загружаемый базовый JavaScript bundle после уже выполненного lazy split модуля обучения, не ломая маршруты, auth/RBAC и fail-closed конфигурацию.

Исходные измерения предыдущего аудита, которые нужно перепроверить свежей сборкой:

- training route chunks уже были разделены примерно на `TrainingEmployeeRoutes` 14.38 kB и `TrainingAdminRoutes` 132.96 kB minified;
- базовый production `index` оставался около 647,039 raw bytes / 172,685 gzip;
- автоматически загружаемый `modulepreload` добавлял ещё около 58,738 raw / 18,466 gzip, то есть initial JavaScript был около 705,777 raw / 191,151 gzip;
- initial CSS был около 301,526 raw / 48,580 gzip;
- Vite предупреждал о chunk больше 500 kB;
- размеры могли измениться после следующих коммитов, поэтому они не являются текущим результатом без повторного build.

Порядок работы:

1. Один read-only субагент анализирует import graph базового chunk, второй проверяет route/auth/config gates и существующие browser tests.
2. Главный агент выполняет fresh baseline из текущего worktree через `pnpm build:web`, ничего не очищая и не откатывая. Сохрани raw bytes minified production assets и gzip; brotli измеряй только доступной локальной утилитой без новой зависимости. Учти entry, все его `modulepreload`, суммарный initial JavaScript/CSS, initial request count и динамические route chunks.
3. Найди фактических крупнейших участников base chunk. В предыдущем аудите кандидатами были синхронные imports `ObjectsAdminPage`, `ObjectDetailPage`, `FeedsAdminPage`, `CatalogPage`, `LotPresentationsPage` и `ProjectPresentationEditorPage`, но перепроверь текущий import graph и не делай вывод только по source/package size.
4. Сначала рассмотри route-level dynamic imports крупных самостоятельных страниц в `apps/web/src/App.tsx` после существующих RBAC/feature gates. Не начинай с `manualChunks`: он может только переразложить те же initial bytes. Не добавляй зависимости и новый router.
5. Если выбор границы затрагивает несколько самостоятельных product-модулей или меняет loading UX, до правок покажи измерения и задай один конкретный вопрос.
6. В разрешённом scope сначала выноси только доказанно не initial код в стабильные route-level chunks. `vendor`/`manualChunks` допустимы лишь после доказательства, что уменьшают суммарные entry + `modulepreload` bytes и не создают duplication. Не создавай множество мелких chunks без измеримого выигрыша.
7. Сохрани fail-closed поведение `GET /training/config`, permission gates, direct deep links, back/forward и chunk-error UX.
8. После правок повтори те же измерения на тех же условиях и сравни initial waterfall, minified и compressed sizes.
9. Read-only субагент проверяет итоговый diff на eager imports, циклы, duplicate vendor chunks и изменение auth/RBAC поведения.

Границы:

- не менять public routes и API contracts;
- не добавлять библиотеку анализа/runtime dependency без разрешения;
- не подгонять результат изменением одного `chunkSizeWarningLimit`;
- не считать успехом перенос байтов из одного initial chunk в другой initial chunk;
- не выполнять широкий рефакторинг компонентов;
- не ухудшать employee/admin training split.

Критерии приёмки:

- base `index` измеримо меньше baseline; целевой ориентир — ниже предупреждения 500 kB в minified production output Vite, если это достижимо без широкого рефакторинга;
- суммарный автоматически загружаемый JavaScript измеримо уменьшается относительно свежего baseline; initial request count и CSS не ухудшаются без объяснённого trade-off;
- training chunks не загружаются до входа в соответствующий модуль;
- employee не загружает admin training chunk;
- после bundle audit зафиксировано, какие необязательные chunks всё ещё грузятся на `/cabinet` и запрашивает ли denied deep link запрещённый chunk; расширение split на несколько product-модулей требует отдельного подтверждения;
- auth/config/permission gates и deep links проходят проверки;
- отчёт содержит таблицу before/after.

Stop condition: если снижение ниже 500 kB или дальнейшее измеримое уменьшение initial JavaScript требует новой зависимости, изменения архитектуры маршрутов или широкого product refactor, не расширяй scope. Зафиксируй безопасно достигнутый результат либо остановись с bundle evidence и предложением отдельного этапа.

Минимальные проверки:

- `pnpm build:web` до и после;
- `pnpm --filter @platforma/web test`;
- локальный `vite preview` на свободном порту и `TRAINING_WEB_TEST_URL=<local preview URL> node apps/web/tests/training-code-splitting.browser.mjs`;
- добавить или расширить детерминированный browser fixture с barrier для non-training route chunks: `/cabinet`, обычный route, employee/admin training deep links, denied route, fail-closed config и chunk loading/error;
- `git diff --check`.

Критерий завершения: оптимизация подтверждена сопоставимыми измерениями, initial load реально уменьшен, регрессионные проверки зелёные, production не затронут.
```
