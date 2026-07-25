# Checklist реализации модуля обучения

Дата актуализации: 2026-07-25.

Источник этапов: `docs/training/prompts/00_audit.md` …
`10_security_deploy_pilot.md`.

## Правила ведения

- Выполнять только явно запрошенный prompt-stage.
- Перед каждым этапом проверять `on-ser` и `git status --short`.
- Не перезаписывать чужие modified/untracked-файлы.
- Отмечать пункт только после реализации и релевантных build/tests.
- После отчёта останавливаться.
- Общая спецификация содержит stages 0–12, но prompts агрегируют их в этапы
  0–10; этот checklist следует prompts.

## Сводка

| Этап | Prompt | Статус |
| --- | --- | --- |
| 0 | `00_audit.md` | Выполнен по явному списку prompt |
| 1 | `01_foundation_rbac.md` | Выполнен |
| 2 | `02_prisma_schema.md` | Не начат |
| 3 | `03_content_backend.md` | Не начат |
| 4 | `04_content_ui_documents.md` | Не начат |
| 5 | `05_attempt_engine_fake.md` | Не начат |
| 6 | `06_telegram.md` | Не начат |
| 7 | `07_audio_worker.md` | Не начат |
| 8 | `08_openai_scoring_review.md` | Не начат |
| 9 | `09_results_ui_rating.md` | Не начат |
| 10 | `10_security_deploy_pilot.md` | Не начат |

## Этап 0. Аудит и архитектурные документы

- [x] Проверена ветка `on-ser`.
- [x] Зафиксирован исходный `git status --short`.
- [x] Проверены stack, auth/RBAC, Prisma, storage, workers, routing, tests,
  Docker/deploy.
- [x] Drift подтверждён по реальному коду, без изменения production-кода.
- [x] Создан `docs/training/00-repository-audit.md`.
- [x] Создан `docs/training/01-architecture-decision.md`.
- [x] Создан `docs/training/02-implementation-checklist.md`.
- [x] `pnpm build` прошёл.
- [x] `pnpm test` прошёл: 600/600.
- [x] Новые migrations отсутствуют.
- [x] Новые dependencies отсутствуют.
- [x] Production-код, Prisma schema и deploy не изменены.
- [x] Этап 1 не начинался.

Примечание: `spec/04_stages_tests_acceptance.md` дополнительно упоминает
`docs/training/03-security-and-data-flow.md`, но `00_audit.md` не включает его
в явный список. Файл не создан до отдельного решения пользователя.

## Этап 1. Foundation, feature flag, routing и RBAC

- [x] Создать `TrainingModule` и config/health shell.
- [x] Добавить безопасный `TRAINING_MODULE_ENABLED`.
- [x] Создать `packages/shared/src/training.ts` и re-export.
- [x] Добавить утверждённые training permissions и роль `training_admin`
  idempotent seed.
- [x] Сохранить полный training access для `admin`.
- [x] Добавить protected shells `/training` и `/admin/training`.
- [x] Не мигрировать Platforma на React Router.
- [x] Добавить permission contract и frontend route/navigation tests.
- [x] Запустить релевантные build/tests.

Проверки этапа 1:

- `pnpm build` — passed;
- `pnpm --filter @platforma/api test` — 241/241;
- `pnpm --filter @platforma/web test` — 280/280;
- `pnpm test` — 608/608.

Новые Prisma models/migrations и dependencies отсутствуют. Этап 2 не начинался.

## Этап 2. Prisma schema и additive migration

- [ ] Переиспользовать `User`; не создавать `Employee`.
- [ ] Добавить nullable relation к `RealEstateObject`.
- [ ] Разделить draft и immutable published version.
- [ ] Pin attempt к version и выбранным questions.
- [ ] Добавить content, Telegram, attempt, answer/segment, review и job models.
- [ ] Добавить indexes/unique constraints для integrity/idempotency.
- [ ] Создать additive migration без seed реальных проектов.
- [ ] Сгенерировать Prisma Client.
- [ ] Добавить schema/contract tests и запустить build/tests.

## Этап 3. Backend учебного контента

- [ ] Реализовать admin CRUD проектов/drafts/versions.
- [ ] Реализовать questions, facts, criteria и attempt settings.
- [ ] Валидировать ровно 1 main + 10 follow-up.
- [ ] Валидировать веса main 55 и follow-up 15.
- [ ] Валидировать pass score, limits, timer, cooldown и availability.
- [ ] Публиковать immutable version.
- [ ] Ограничить delete неиспользованным draft; остальное архивировать.
- [ ] Писать privileged actions в `AuditLog`.
- [ ] Добавить unit/integration tests и запустить build/tests.

## Этап 4. Admin UI и document ingestion

- [ ] Реализовать список/создание/редактирование training projects.
- [ ] Добавить утверждённые вкладки content editor.
- [ ] Поддержать nullable link к `RealEstateObject`.
- [ ] Реализовать private upload PDF/DOCX/PPTX/XLSX.
- [ ] Обосновать и согласовать минимальные parser dependencies.
- [ ] Добавить async extraction status и source locators.
- [ ] Добавить size/MIME/magic-byte/zip-bomb/text limits.
- [ ] Поддержать `NEEDS_MANUAL_TEXT`; OCR не добавлять.
- [ ] Допускать в scoring только подтверждённые facts.
- [ ] Добавить frontend/backend tests и запустить build/tests.

## Этап 5. Attempt engine с fake providers

- [ ] Реализовать transactional start с немедленным списанием.
- [ ] Реализовать limit/cooldown/window/pass/retake rules.
- [ ] Случайно выбирать 3 разных follow-up из 10 на backend.
- [ ] Реализовать state machine 1 main + 3 follow-up.
- [ ] Поддержать multi-segment answers и idempotent finish.
- [ ] Реализовать общий timer, warnings, grace и timeout skip = 0.
- [ ] Добавить fake transcription/evaluation providers.
- [ ] Детерминированно считать 55 + 15 + 15 + 15, penalties и review.
- [ ] Проверить concurrency, retries и fourth-attempt blocking.
- [ ] Запустить исчерпывающие unit/integration tests.

## Этап 6. Telegram linking и webhook

- [ ] Реализовать opaque one-time link token; хранить только hash.
- [ ] Обеспечить связь user ↔ Telegram account один-к-одному.
- [ ] Проверять webhook secret и private chat.
- [ ] Обеспечить idempotency updates/messages/callbacks.
- [ ] Принимать только `message.voice` как ответ.
- [ ] Реализовать multi-part voice UX и кнопку finish.
- [ ] Запрашивать подтверждение до списания attempt.
- [ ] Быстро ACK webhook; тяжёлую работу отправлять в jobs.
- [ ] Использовать fetch provider + fake fixtures без SDK по умолчанию.
- [ ] Добавить contract/integration tests.

## Этап 7. Private audio и отдельный worker

- [ ] Реализовать private bucket/multi-bucket storage без public URL.
- [ ] Скачать и проверить Telegram voice server-side.
- [ ] Сохранить каждый voice segment.
- [ ] Добавить безопасный ffmpeg/ffprobe pipeline с limits/timeouts/cleanup.
- [ ] Извлечь утверждённые объективные audio metrics.
- [ ] Реализовать PostgreSQL claim/heartbeat/retry/stale recovery.
- [ ] Добавить `training-worker.main.ts`, package script и Compose service.
- [ ] Добавить protected audio streaming с `training:audio:read` и audit.
- [ ] Оставить transcription fake.
- [ ] Добавить restart/retry/duplicate/cleanup fixtures/tests.

## Этап 8. OpenAI providers, scoring и review

- [ ] Реализовать server-side fetch providers для transcription/evaluation.
- [ ] Использовать Audio Transcriptions API.
- [ ] Использовать Responses API + strict Structured Outputs.
- [ ] Брать model IDs из env и использовать `store: false`, где применимо.
- [ ] Считать transcript недоверенными данными.
- [ ] Валидировать schema/IDs/evidence на backend.
- [ ] Считать final score только на backend.
- [ ] Реализовать incorrect fact/duplicate/unsupported claim rules.
- [ ] Реализовать admin review/override с reason и audit.
- [ ] Сохранять model/prompt/schema version, usage, latency, request ID.
- [ ] Добавить fixture tests и opt-in smoke command; не вызывать real API в CI.

## Этап 9. Employee/Admin results UI и rating

- [ ] Реализовать employee `/training` и Telegram connection state.
- [ ] Показывать employee только разрешённый собственный результат.
- [ ] Не показывать employee transcript/errors/audio/rating.
- [ ] Оставить Telegram result кратким.
- [ ] Реализовать admin filters/detail/timeline/audio/transcript/evidence.
- [ ] Реализовать review/override UX с обязательной причиной.
- [ ] Реализовать утверждённую rating formula и columns.
- [ ] Использовать best reviewed final score.
- [ ] Исключить storage keys/audio URLs из exports.
- [ ] Добавить ownership/IDOR и frontend tests; запустить build/tests.

## Этап 10. Security, deploy и pilot preparation

- [ ] Реализовать consent/notification.
- [ ] Добавить webhook hardening, rate/input limits и prompt-injection guards.
- [ ] Проверить private audio и privileged access audit.
- [ ] Добавить structured logs/counters без secrets/audio/transcript.
- [ ] Добавить worker health/readiness.
- [ ] Добавить полный fake E2E утверждённого сценария.
- [ ] Создать обезличенный eval dataset scaffold без raw personal audio.
- [ ] Обновить env/migration/worker/ffmpeg/webhook/backup/rollback docs.
- [ ] Подготовить pilot checklist для ЖК «Шагал» без реальных материалов.
- [ ] Выполнить финальные `pnpm build` и все tests.
- [ ] Не выполнять production deploy без отдельного запроса.

## Следующий этап

Точный следующий этап: `docs/training/prompts/01_foundation_rbac.md`.

Он не начат и не должен выполняться автоматически. Перед ним нужно:

1. получить отдельный запрос пользователя;
2. решить расхождение по `03-security-and-data-flow.md`;
3. повторно проверить branch/status и сохранить чужие изменения.
