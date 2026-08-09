# 10. Reconciliation и GC аудиохранилища

Статус: предложение к реализации  
Приоритет: P3  
Область: `files`, private MinIO, orphan cleanup

## Проблема

В production обнаружены неиспользуемые file records для training audio. Нельзя автоматически считать, что соответствующие MinIO objects существуют или безопасно удаляются: сначала требуется сверка ссылок, audit cleanup manifests и фактического storage.

Затрагиваемые участки:

- `training-audio.service.ts`;
- `training-project.service.ts`;
- `training-project-cleanup.ts`;
- `files` и private audio bucket.

## Целевое решение

Добавить read-only reconciliation job/report, который классифицирует:

- DB row и object существуют, ссылка активна;
- DB row существует, object отсутствует;
- object существует, DB row отсутствует;
- DB row не используется ни answer, ни segment;
- cleanup manifest остаётся PENDING;
- object моложе safety window.

Удаление выполняется отдельной явно подтверждённой операцией после safety window. Желателен режим quarantine либо как минимум сформированный manifest с checksum, bucket, key и причиной удаления.

## Политика хранения

Перед реализацией нужно утвердить:

- срок хранения аудио завершённых попыток;
- поведение после удаления проекта;
- хранение failed/technical attempts;
- требования к аудиту прослушивания;
- возможность legal hold.

## Границы

- Первый запуск только report-only.
- Не удалять по одному лишь отсутствию Prisma relation без проверки всех consumers.
- Не использовать broad recursive bucket deletion.
- Не удалять объект младше safety window.

## Критерии приёмки

- Отчёт повторяем и не изменяет данные.
- Shared file никогда не попадает в delete manifest.
- Повторное удаление идемпотентно.
- Частичный сбой оставляет PENDING manifest для retry.
- После cleanup отсутствуют dangling references и недоступные active audio.
