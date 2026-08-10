# 02. Безопасный lifecycle voice worker при деплое

Статус: предложение к реализации
Приоритет: P0
Область: worker lifecycle, deploy, повторные AI-вызовы

## Проблема

Voice worker работает внутри API-контейнера. Production drain сейчас короче реального времени распознавания и оценки. Если API пересоздаётся во время внешнего вызова, ответ может остаться без checkpoint, а новый процесс повторит платную операцию.

Затрагиваемые участки:

- `apps/api/src/training/training-voice-worker.service.ts`;
- `apps/api/src/training/training-openai-client.ts`;
- `apps/api/src/training/training-runtime-config.ts`;
- production Compose и deploy-процедура.

## Целевое решение

Предпочтительный вариант — запускать worker отдельным Compose-сервисом из того же API image с отдельной entrypoint-командой. API обслуживает HTTP, worker выполняет claims. Обычный web/API rollout не должен останавливать активную обработку голосовых ответов.

Дополнительно требуется:

- прекратить новые claims после SIGTERM;
- передавать общий `AbortSignal` во внешние HTTP-вызовы;
- сохранять уже завершённый transcription checkpoint до оценки;
- не освобождать claim как новый, если платная операция уже могла выполниться;
- показывать pre-deploy число активных работ и возраст самой старой;
- блокировать или явно подтверждать deploy при активной сдаче.

## Границы

- Не менять scoring и attempt state machine.
- Не увеличивать timeouts как единственное исправление.
- Не запускать несколько worker до проверки fencing и общей concurrency.
- Не удалять существующие recovery checkpoints.

## Критерии приёмки

- Пересоздание API не прерывает worker.
- SIGTERM до внешнего вызова освобождает claim без списания processing attempt.
- SIGTERM во время внешнего вызова либо дожидается checkpoint, либо корректно отменяет запрос.
- Новый worker не выполняет повторно завершённую транскрипцию.
- После аварийного завершения stale claim восстанавливается одним worker.
- Общая concurrency остаётся ограниченной на уровне всего deployment.

## Проверки

Нужны fake-provider тесты с never-settling promise, SIGTERM между стадиями, два worker-процесса и restart после каждого checkpoint. На production — controlled smoke без реального прерывания пользовательской попытки.
