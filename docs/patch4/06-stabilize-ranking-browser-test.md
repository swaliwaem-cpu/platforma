# Этап 6. Сделать loading-state тест рейтинга детерминированным

Приоритет: P2

Тип работы: точечное исправление browser fixture

Production: запрещён

## Промт этапа

```text
Цель: стабильно проверять loading state страницы рейтинга без гонки между `React.StrictMode`, abort первого запроса и ответом route fixture.

Наблюдения предыдущего аудита, которые нужно перепроверить:

- `apps/web/tests/training-v2-stage5-part2.browser.mjs` ожидает `getByLabel('Загрузка рейтинга')`;
- сценарий мог стабильно падать по timeout, потому что фиксированная задержка расходовалась на отменённый первый StrictMode-запрос, а следующий ответ приходил до assertion;
- остальные части сценария — filters, pagination, CSV, error state и mobile layout — проходили при исключении только этого transient assertion;
- loading coverage удалять нельзя.

Порядок работы:

1. Read-only субагент проверяет компонент, ownership запросов/`AbortController`, StrictMode setup и route fixture.
2. Главный агент воспроизводит текущий тест и фиксирует реальную последовательность запросов/abort/DOM states.
3. В `apps/web/tests/training-v2-stage5-part2.browser.mjs` замени `initialDelay`/`setTimeout(150)` на управляемый promise barrier: route handler сообщает о получении ranking request и удерживает все стартовые ranking-ответы до явного release либо явно обрабатывает abort первого StrictMode-запроса.
4. Barrier должен иметь bounded timeout, а release выполняться в `finally`, чтобы при падении теста не зависали route promises, preview или browser process.
5. Не меняй production UI, если он корректно показывает loading при реально pending запросе.
6. Сохрани проверки filters, pagination, CSV, error state и mobile layout.
7. После правки read-only субагент проверяет отсутствие скрытых sleeps, незавершённых route promises и ослабленных assertions.

Границы:

- не удалять loading assertion;
- не увеличивать общий timeout как единственное исправление;
- не отключать `StrictMode` ради теста;
- не добавлять test-only behavior в production component;
- не обращаться к реальному API.
- не менять другие файлы, пока удерживаемый запрос не докажет production lifecycle defect.

Минимальные проверки:

- `pnpm build:web`, затем локальный `vite preview` на свободном порту;
- `TRAINING_WEB_TEST_URL=<preview-url> node apps/web/tests/training-v2-stage5-part2.browser.mjs` ровно три последовательных прогона;
- web unit tests, если затронут общий helper;
- `pnpm --filter @platforma/web test`;
- проверка завершения preview/browser процессов;
- `git diff --check`.

Критерий завершения: loading state проверяется в управляемом pending-состоянии, все остальные assertions сохранены, а ограниченная серия прогонов стабильна.

Если компонент действительно не показывает loading для активного запроса, остановись и сначала докажи production-дефект; не маскируй его одной правкой fixture.

Если после barrier падают CSV, filtering или responsive assertions, не исправляй их попутно: зафиксируй отдельный дефект.
```
