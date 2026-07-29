# Этапы реализации, тесты и критерии готовности

> Источник: финальный мастер-план от 25.07.2026. Этот файл является частью разбитой спецификации.

# 15. Пошаговая реализация

## Этап 0. Актуализация аудита и документы

Создать:

- `docs/training/00-repository-audit.md`;
- `docs/training/01-architecture-decision.md`;
- `docs/training/02-implementation-checklist.md`;
- `docs/training/03-security-and-data-flow.md`.

Проверить drift ветки `on-ser`, текущие модели, routes, storage, Docker и tests. Production-код не менять.

**Готово:** точные пути и зависимости подтверждены, никаких догадок о коде.

## Этап 1. Каркас, routing, feature flag и RBAC

- `TrainingModule`;
- config validation;
- permissions и role `training_admin`;
- shared contracts skeleton;
- аккуратная подготовка routes/navigation;
- пустые permission-protected pages;
- contract tests.

**Готово:** приложение собирается, старые routes работают, доступы корректны.

## Этап 2. Prisma schema и миграции

- все content/version/Telegram/attempt/answer/review/job models;
- indexes/unique constraints;
- migration;
- seed permissions/role;
- serialization helpers;
- schema tests.

**Готово:** migration up на чистой и существующей БД, build/tests green.

## Этап 3. Проекты, версии и админка контента

- CRUD project/draft;
- optional RealEstateObject link;
- questions/facts/criteria;
- settings;
- validation 1+10, 55/15;
- publish immutable version;
- open/close/order/deadline;
- audit log;
- admin UI.

**Готово:** admin вручную создаёт и публикует полностью валидный проект.

## Этап 4. Документы

- private training upload;
- PDF/DOCX/PPTX/XLSX adapters;
- extraction jobs;
- source locators;
- `NEEDS_MANUAL_TEXT`;
- security limits;
- tests fixtures.

**Готово:** каждый формат извлекается, факты подтверждаются вручную.

## Этап 5. Attempt engine с fake providers

- start checks;
- immediate consumption;
- cooldown/deadline/retake rules;
- secure random 3/10 selection;
- state machine;
- multi-segment answer domain;
- timer and grace;
- deterministic fake transcript/evaluation;
- server scoring;
- unit/integration tests.

**Готово:** полный fake-flow 1+3 завершается без Telegram/OpenAI.

## Этап 6. Telegram link и webhook

- token hash/TTL;
- connect/reconnect/revoke;
- webhook secret;
- update idempotency;
- private chat only;
- inline buttons;
- voice-only validation;
- multi-part UX;
- start warning;
- timer notifications.

**Готово:** fake Telegram fixtures проходят весь сценарий.

## Этап 7. Private audio + ffmpeg + worker

- separate worker entrypoint/container;
- PostgreSQL jobs;
- Telegram download;
- original private storage;
- ffmpeg/ffprobe;
- WAV assembly;
- acoustic metrics;
- protected playback;
- cleanup temp files;
- retries/recovery.

**Готово:** несколько voice объединяются, аудио доступно только по permission.

## Этап 8. Real OpenAI providers

- transcription provider;
- evaluation provider;
- strict schema;
- `store:false`;
- usage/latency/request IDs;
- fallback review model;
- prompt injection defense;
- provider fixture tests.

**Готово:** opt-in real smoke test и полный fake CI suite.

## Этап 9. Review, finalization и employee result

- unsupported claim review;
- AI/server/admin/final score;
- pass/fail/pending review;
- Telegram concise result;
- employee Platforma breakdown;
- best score;
- remaining attempts;
- technical failure refund.

**Готово:** visibility rules не дают сотруднику transcript/errors.

## Этап 10. Admin results и ranking

- filters;
- audio/transcript/evidence;
- manual override;
- ranking formula;
- CSV export;
- audit;
- pagination/performance.

**Готово:** admin видит все обязательные колонки, user — нет.

## Этап 11. Security, observability и deploy

- consent;
- private bucket;
- audit of audio access;
- rate limiting;
- data delete/anonymize;
- structured logs;
- worker health/readiness;
- Compose/Docker/Nginx/webhook docs;
- backup/rollback;
- feature flag rollout.

**Готово:** production checklist и rollback проверены.

## Этап 12. Pilot и calibration

Пилотный проект — `ЖК Шагал`, когда предоставлены утверждённые материалы и вопросы.

- загрузить 1+10;
- 20–30 примеров voice: плохие/средние/хорошие;
- expert scores;
- сравнить AI vs expert;
- настроить prompt/rubric;
- проверить false penalties и unsupported claims;
- запуск на небольшой группе;
- затем остальные проекты через админку.

**Готово:** согласованные acceptance thresholds и реальный E2E.

## Этап 13. PDF связанного ЖК и персональные назначения

- additive audience/assignment/provenance migration;
- legacy `ALL_ELIGIBLE`, default для новых проектов `ASSIGNED_ONLY`;
- M:N selector eligible users и optimistic `audienceRevision`;
- единый assignment gate в Platforma, Telegram, deep-link и transactional
  attempt start;
- явный attach выбранных `ObjectFile/File` PDF связанного ЖК;
- extraction → explicit fact suggestions → human-approved facts без
  автоматического OpenAI;
- provenance snapshot и перенос в следующую рабочую версию;
- manual upload/official URL остаются без изменения.

**Готово:** новый проект нельзя открыть без active eligible assignment;
назначенный пользователь проходит linked-PDF flow, неназначенный не видит и не
может запустить проект ни одним прямым или Telegram-путём.

---

# 16. Обязательные тесты

Unit/integration:

1. Попытка списывается при старте.
2. Брошенная попытка сгорает.
3. Системный сбой можно refund без четвёртой попытки.
4. Limit default 3 и custom limit.
5. Cooldown 1h..24h.
6. Deadline 1..7 days.
7. Retake-after-pass per project.
8. Ровно 3 разных random follow-up из 10.
9. Повтор вопросов между попытками разрешён.
10. Text/audio/document не принимаются как voice.
11. Несколько voice становятся одним answer.
12. Duplicate Telegram update не создаёт segment/job.
13. `Завершить ответ` идемпотентна.
14. Таймер закрывает попытку, unanswered = 0.
15. Grace принимает только последнюю часть текущего ответа.
16. MAIN criteria sum 55, FOLLOW_UP sum 15.
17. Итог 100 и clamp.
18. Каждая distinct incorrect fact = −5.
19. Unsupported claim без штрафа, но обязательный review.
20. Admin override сохраняет AI score.
21. Best result использует final reviewed score.
22. User не получает transcript/errors/audio/ranking.
23. `training:audio:read` позволяет protected playback.
24. Published version immutable.
25. Новая версия не меняет старые attempts.
26. Optional RealEstateObject relation работает с null.
27. PDF/DOCX/PPTX/XLSX extraction fixtures.
28. Zip bomb/oversize/timeouts отклоняются.
29. Worker restart восстанавливает stale job.
30. OpenAI invalid schema/retry/429 fixtures.
31. Clean/upgrade migration сохраняет legacy проекты как `ALL_ELIGIBLE`, а
    новые создаются `ASSIGNED_ONLY`.
32. Empty assignments = nobody; `ASSIGNED_ONLY` нельзя открыть без active
    eligible user.
33. Candidate endpoint исключает inactive/deleted/без `training:take`.
34. Platforma/Telegram/deep-link/start одинаково отклоняют неназначенного
    пользователя; собственная история остаётся доступной после revoke.
35. Реальная PostgreSQL race `revoke ↔ start` даёт только два допустимых
    исхода: revoke запрещает старт либо уже созданная attempt продолжается.
36. Linked PDF принимается только из выбранного ЖК; foreign
    `objectFileId`, non-PDF, oversize и checksum mismatch отклоняются.
37. Повторный attach создаёт один source/job; provenance сохраняется при clone
    version и не меняется при смене ЖК.
38. Выбор ЖК/PDF не вызывает OpenAI; только human-approved linked facts
    участвуют в scoring.

Commands:

```text
pnpm build
pnpm --filter @platforma/api test
pnpm --filter @platforma/web test
pnpm test
```

Не писать «lint пройден», пока отдельного lint script нет.

---

# 17. Definition of Done

- Training встроен в существующую Platforma.
- Пользователь связывает Telegram одноразовой ссылкой.
- Legacy-проекты сохраняют `ALL_ELIGIBLE`; новые проекты используют
  `ASSIGNED_ONLY` и M:N назначения существующих пользователей.
- Пустой assignment set не раскрывает проект; revoke блокирует только новые
  старты, а активная попытка продолжается.
- Проект опционально связан с ЖК.
- Выбранные PDF связанного ЖК подключаются явно с immutable provenance,
  проходят extraction и не становятся scoring facts без решения человека.
- Admin публикует immutable version с 1 main + 10 follow-up.
- Попытка списывается при старте и длится общий configurable 5–7 минут.
- Бот принимает только voice и несколько частей на вопрос.
- Backend случайно выбирает 3 разных follow-up.
- Вопросы никогда не генерируются ИИ.
- Оригинальное аудио приватно хранится бессрочно.
- OGG/Opus безопасно нормализуется через ffmpeg.
- Расшифровка и оценка асинхронны, идемпотентны и переживают restart.
- Main 55 + 3×15 = 100.
- Incorrect facts дают −5, unsupported claims требуют review без автштрафа.
- AI output structured, итог считает backend.
- `admin` и `training_admin` могут проверить/изменить оценку.
- Employee не видит transcript/errors/ranking.
- Telegram показывает только итог/status/attempts left.
- Admin видит обязательный ranking и полный разбор.
- Все tests/build проходят.
- Есть security/deploy/rollback docs.

---

# 18. Формат отчёта Codex после каждого этапа

1. Что проверено и реализовано.
2. Архитектурные решения.
3. Изменённые файлы.
4. Миграции.
5. Новые зависимости и зачем они нужны.
6. Запущенные команды и результаты.
7. Риски/ограничения.
8. Что осталось в checklist.
9. Точный следующий этап — без его автоматического выполнения.

---

# 19. Первый запрос к Codex

После добавления этого файла в репозиторий отправить Codex:

```text
Прочитай целиком файл codex_training_module_final_ru.md.

Выполни только Этап 0: актуализация аудита и архитектурные документы.
Не изменяй production-код, Prisma schema и зависимости.
Не переключай ветку on-ser и не трогай чужие/untracked файлы.

В конце покажи:
1. найденный drift относительно мастер-плана;
2. точные будущие пути файлов;
3. необходимые новые зависимости с обоснованием;
4. риски миграции и интеграции;
5. созданные docs/training файлы;
6. результаты существующих build/tests.

После отчёта остановись и не начинай Этап 1.
```
