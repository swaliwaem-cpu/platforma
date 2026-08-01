# Current Stage: Stage 1 — Web Fake Vertical Slice

## Цель

За один web-сеанс доказать полный путь: Admin создаёт, публикует и открывает
проект; Employee проходит попытку 1+3 с общим timer; deterministic fake evaluator
сохраняет итог, доступный Employee и Admin.

Текущая работа — только проектирование. Реализация начинается после отдельного
разрешения и закрытия применимых вопросов из `DECISIONS.md#needs_decision`.

## Входит

- Один admin aggregate с optional `RealEstateObject`, order и настройками.
- Ручной ввод ровно одного главного и десяти дополнительных вопросов.
- Draft, publish, global open/close.
- Общий список открытых проектов для eligible-сотрудников.
- Явное подтверждение start, attempt limit и server-side timer.
- Immutable snapshot 1+10 при старте.
- Main text answer, затем backend selection трёх разных дополнительных.
- Три additional text answers и синхронная fake evaluation.
- Сохранённые `PASSED`, `FAILED` и `REQUIRES_REVIEW` результаты.
- Used/remaining, best/last confirmed и минимальная собственная history.
- Минимальный Admin project/attempt view.
- Существующие auth, RBAC, API client, app shell, routing и UI primitives.

## Не входит

- Telegram, webhook, voice/audio, multi-segment answers и finish voice action.
- S3/MinIO, `ffmpeg`, OpenAI, transcription и реальные providers.
- Worker, queue, outbox, job/provider/evaluation run tables и retries.
- Upload/parsing PDF, DOCX, PPTX, XLSX, facts, aliases и criteria.
- Manual review, full results dashboard, ranking, CSV и audio playback.
- Policy acceptance, notifications, analytics, teams/departments, assignments.
- Operations, staging, production deploy, pilot и calibration.

## Последовательность реализации

1. Закрыть только применимые Stage 1 пункты `NEEDS_DECISION`.
2. Утвердить additive schema из пяти моделей и одну migration.
3. Добавить idempotent permissions seed и backend RBAC contract.
4. Реализовать project aggregate, publish/open и explicit serializers.
5. Реализовать start transaction, 1+10 snapshot и attempt-limit race guard.
6. Реализовать answer progression, random 3, timer и fake evaluator boundary.
7. Добавить shared DTO, employee/admin API contract и ownership checks.
8. Подключить пять manual routes и предметные страницы без нового router.
9. Запустить targeted PostgreSQL/HTTP/web tests, workspace builds и full checks.
10. Пройти один ручной E2E и остановиться с отчётом; Stage 2 не начинать.

## Ожидаемые файлы реализации

Точный набор сверяется перед кодом; ожидаемый scope:

- `apps/api/prisma/schema.prisma`, одна новая additive migration,
  `apps/api/src/prisma/seed.ts`;
- небольшое подключение `TrainingModule` в `apps/api/src/app.module.ts`;
- предметные файлы под `apps/api/src/training/`: module, два controllers,
  project service, attempt service, evaluator/fake evaluator и serializers;
- `packages/shared/src/training.ts` и минимальный re-export;
- минимальное route/navigation wiring в `apps/web/src/App.tsx`;
- предметные API/pages/styles под `apps/web/src/training/`;
- targeted API/PostgreSQL и web behavior tests в существующих test areas.

Новые обязанности не добавляются в крупные `ObjectsService`, `UsersService` или
общий `App.tsx`; в `App.tsx` остаётся только его существующая routing composition.

## Ограничения diff

- Ровно пять основных Training-моделей; шестая требует stop-and-rescope.
- Не более 13 предложенных public endpoints и пяти frontend routes.
- Ориентир — не более 22 затронутых production-файлов и примерно 2500 новых
  non-generated production lines; превышение требует нового согласования.
- Новый production-файл желательно до 300–500 строк; более 500 требует
  объяснения, более 700 запрещено без отдельного решения.
- Одна additive migration; applied migrations не изменяются.
- Dependencies, lockfile, env и Docker не меняются.
- Никакого попутного рефакторинга и инфраструктуры Stage 2+.

## Автоматические проверки реализации

- Pure evaluator/selection tests.
- HTTP contract/RBAC tests с реальным Nest application.
- Attempt start, concurrency, snapshot и history tests на изолированном
  PostgreSQL, не на fake repository.
- Web behavior tests: routes, permission gates, confirmation, sequence, timer,
  result/history, errors и duplicate submit.
- Targeted API/web tests, затем `pnpm --filter @platforma/api test`,
  `pnpm --filter @platforma/web test`, `pnpm build`, `pnpm test` и
  `git diff --check`.

## Ручная приёмка

1. Admin создаёт проект с limit `3` и `allowRetakeAfterPass=true`.
2. Добавляет 1 главный и 10 дополнительных вопросов.
3. Публикует и открывает проект.
4. Employee видит проект.
5. Подтверждает старт; попытка расходуется и timer начинается.
6. Employee отвечает на главный вопрос текстом.
7. Backend выбирает 3 разных дополнительных snapshot-вопроса.
8. Employee отвечает на них.
9. Fake evaluator формирует и сохраняет итог.
10. Employee видит итог и собственную history.
11. Admin видит попытку.
12. Вторая попытка сохраняется отдельно.
13. Изменение проекта не меняет первую попытку.

## Stop conditions

Реализация останавливается, если:

- не закрыта применимая timer/abandon/role semantics;
- требуется шестая модель, четырнадцатый endpoint или шестой route;
- historical integrity зависит от frontend или текущего project row;
- attempt limit не защищён от concurrent start;
- timer или ownership проверяются только frontend-ом;
- evaluator требует network, worker, queue или provider-run infrastructure;
- Employee DTO раскрывает запрещённые данные;
- нужен новый dependency/env/Docker scope;
- PostgreSQL/HTTP/web проверки или ручной E2E не проходят;
- для продолжения требуется начать Stage 2.
