# Этап 1. Исправить Nest DI wake-up сервиса в API и worker

Приоритет: P0

Тип работы: локальное исправление runtime-регрессии

Production: запрещён

## Промт этапа

```text
Цель: восстановить корректный запуск Nest `TrainingModule`, HTTP API и отдельного `training-voice-worker` после регрессии dependency injection. `TrainingAttemptStateService` и `TrainingVoiceWorkerService` должны получать один singleton `TrainingVoiceWorkerWakeupService`, сохраняя локальный wake-up после commit и fallback polling.

Известные результаты предыдущего аудита, которые нужно сначала перепроверить:

- в `apps/api/src/training/training-attempt-state.service.ts` параметр конструктора `voiceWorkerWakeup` имеет default `new TrainingVoiceWorkerWakeupService()`, но неявный runtime type;
- свежая сборка определяла пятую зависимость как `Object`, из-за чего Nest падал с `UnknownDependenciesException` на index 4;
- в `apps/api/src/training/training-voice-worker.service.ts` аналогичный параметр конструктора определялся как `Object` на index 6, поэтому исправить только первый сервис недостаточно;
- `TrainingVoiceWorkerWakeupService` уже помечен `@Injectable()` и зарегистрирован в `TrainingModule`;
- часть тестов создаёт оба сервиса напрямую, поэтому исправление не должно случайно сломать их контракт;
- предполагаемая регрессия появилась около коммита `733a344`, но текущий код является источником истины.

Обязательный порядок:

1. Read-only субагент независимо проверяет metadata обоих конструкторов, providers/exports `TrainingModule`, все прямые `new TrainingAttemptStateService(...)` / `new TrainingVoiceWorkerService(...)` и оба entrypoint.
2. Главный агент воспроизводит проблему на свежем локальном build без production env и без внешних вызовов.
3. Подтверди точную причину по runtime metadata/Nest error, а не только по похожему коду.
4. Внеси минимальное исправление DI в обоих consumers. Внутри Nest-графа они должны получать один зарегистрированный singleton; не создавай второй wakeup-service, service locator или обход Nest-контейнера.
5. Сохрани тестируемость прямых инстанцирований осознанно: либо совместимый constructor contract, либо точечное обновление тестовых factories.
6. Добавь или усили регрессионную проверку, которая обнаруживает `Object` в обоих runtime DI slots и реально поднимает `TrainingModule`.
7. Отдельно проверь запуск worker entrypoint хотя бы локальным boot-smoke с fake/stub providers и контролируемым завершением.
8. После правок read-only субагент проверяет diff на дублирование экземпляров, скрытые side effects и потерю wakeup-сигнала.

Границы:

- не менять алгоритм attempts, scoring, review routing, polling и provider calls;
- не менять worker lifecycle, семантику `kick()` и fallback polling;
- не менять Prisma schema/migrations;
- не трогать Docker/Compose, если проблема воспроизводится и исправляется на уровне Nest-кода;
- не маскировать проблему catch-блоком или отключением worker;
- не выполнять production-запуск.

Минимальные проверки:

- наличие и выполнение фактического `pnpm build:api`;
- `node --test apps/api/tests/training-voice-worker-polling.test.cjs`;
- targeted unit/HTTP tests для обоих consumers и `TrainingModule`;
- boot-smoke HTTP API с безопасным test env;
- boot-smoke `training-voice-worker` с fake/stub providers и bounded shutdown;
- `pnpm --filter @platforma/api test`, если он использует только test/fake env;
- `git diff --check`.

Boot-smoke с отсутствующим `TRAINING_TEST_DATABASE_URL`, который фактически выполняет только placeholder, не считать доказательством. Использовать отдельную временную PostgreSQL, `TRAINING_AI_MODE=fake`, `TELEGRAM_TRANSPORT_MODE=fake` и не передавать реальный `OPENAI_API_KEY`.

Критерий завершения: runtime injection token обоих параметров однозначно равен `TrainingVoiceWorkerWakeupService` — через metadata или явный `@Inject`; API и worker разрешают зависимости через Nest, используют общий wake-up singleton, targeted tests зелёные, а внешние вызовы не выполнялись.

Если runtime error не воспроизводится или текущий constructor/module уже отличается от описания, остановись после аудита и покажи доказательства вместо ненужной правки.
```
