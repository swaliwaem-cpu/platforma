# Training staging smoke checklist

Дата актуализации: 2026-07-29. Пункты ниже не считаются выполненными без
отдельного staging-прогона.

## Infrastructure

- [ ] Отдельные staging DB/buckets/bot/OpenAI project/users подтверждены.
- [ ] Backup создан и test restore/manifest проверены.
- [ ] Production build и все additive migrations применены через
  `prisma migrate deploy`; status после deploy чистый.
- [ ] HTTPS, exact CORS origin и secure cookies проверены.
- [ ] `GET /health` не раскрывает детали и показывает `ready`.
- [ ] Operations summary доступен только по `training:operations:read`.

## Authoring и рабочая редакция

- [ ] Повторное нажатие `Редактировать` возвращает одну и ту же рабочую
  редакцию; 10–20 конкурентных запросов не создают вторую.
- [ ] Опубликованная версия и попытки, закреплённые за ней, не меняются после
  открытия и публикации следующей рабочей редакции.
- [ ] Publish одновременно с question/fact/criterion/source mutation приводит
  только к одному из результатов: изменение вошло до validation либо получило
  conflict; опубликованная версия остаётся валидной и неизменяемой.
- [ ] Серверный readiness и publish возвращают одинаковые blocking issues.
- [ ] Мастер проходит все семь шагов, включая `Участники`, с клавиатуры и на ширинах
  `1440/1024/760/375px`; dirty guard работает для Back, sidebar и закрытия
  страницы.

## Источники и предложения фактов

- [ ] Массовая загрузка проверена на лимите файлов, mixed success, duplicate
  checksum, retry и отсутствии orphan storage/File/job.
- [ ] Официальный URL проверен на HTTPS, точный подтверждённый host, redirects,
  public A/AAAA, DNS rebinding, TLS, MIME, compressed/decompressed size и
  connect/read/total timeout.
- [ ] Query secrets и полный URL отсутствуют в audit, logs и safe errors.
- [ ] Snapshot bucket отклоняет anonymous GET/LIST/PUT; crash до/во время/после
  PUT и delete failure восстанавливаются без orphan object.
- [ ] Два URL/document workers не сохраняют два результата; потерявший lease
  worker не может менять source/job.
- [ ] Новый fact-suggestion run нельзя начать, пока есть необработанные
  кандидаты; все кандидаты всех прогонов доступны администратору.
- [ ] Accept требует связь хотя бы с одним вопросом; reject требует причину;
  только подтверждённые и связанные факты попадают в scoring context.
- [ ] Provider REQUESTING после ambiguous crash не вызывает повторный billable
  запрос автоматически.
- [ ] Удаление источника во время extraction/provider run блокируется и не
  стирает историю решений каскадом.
- [ ] Поиск ЖК работает за пределами первых 100 записей, показывает PDF count;
  `PRESENTATION`/`DOCUMENT` выбраны по умолчанию, `FLOOR_PLAN` — только
  вручную.
- [ ] Foreign `objectFileId`, non-PDF, oversize и checksum mismatch
  отклоняются; повторный attach создаёт один source/job.
- [ ] Linked PDF сохраняет immutable provenance при clone version и смене ЖК;
  смена ЖК не удаляет source, manual upload и URL продолжают работать.
- [ ] Выбор ЖК/PDF не вызывает OpenAI; в scoring попадают только явно
  подтверждённые и связанные с вопросами факты.

## Audience и назначения

- [ ] Upgrade сохраняет legacy проекты `ALL_ELIGIBLE`; новый проект создаётся
  `ASSIGNED_ONLY`, пустой assignment set не позволяет открыть его.
- [ ] Eligible selector исключает inactive/deleted/без `training:take`;
  concurrent edit даёт controlled revision conflict без потерянного update.
- [ ] Test employee A видит/запускает назначенный проект в Platforma и
  Telegram; B не видит и получает neutral deny для direct link/stale callback.
- [ ] Реальная PostgreSQL race `start ↔ revoke` не создаёт unauthorized
  attempt; уже созданная attempt завершается после revoke, история сохраняется.
- [ ] Старый assignment-unaware API не присутствует в rotation; rollback с
  включённым training выполняется только на assignment-aware revision.

## Phase A: Telegram real, OpenAI fake

- [ ] `STAGING_ALLOW_FAKE_PROVIDERS=true`; production config с этим флагом
  fail-fast.
- [ ] Webhook status/register выполнены оператором, secret header проверен.
- [ ] Private chat `/start`, rules callback, policy acceptance и duplicate
  update/callback проверены.
- [ ] Feature disable до webhook и при pending job не создаёт external calls;
  re-enable продолжает persisted jobs.
- [ ] SIGTERM/restart оставляет jobs recoverable и heartbeat обновляется.

## Audio

- [ ] Anonymous GET/LIST/PUT отклонены, sentinel удалён и HEAD подтверждён.
- [ ] Только synthetic OGG/WAV: download, merge, ffmpeg и protected playback.
- [ ] `File.url=null`, storage key не попадает в JSON/log.
- [ ] Privileged read создаёт audit; employee получает 404/нет ссылки.
- [ ] Crash after upload, orphan cleanup и bucket A→B recovery проверены.

## Phase B/C

- [ ] Отдельный synthetic OpenAI smoke прошёл по
  `openai-smoke-runbook.md`; flag возвращён в false.
- [ ] Project data controls и допустимая retention проверены; ZDR не
  заявляется без фактического подтверждения.
- [ ] Policy text, employee copy и pilot content утверждены.
- [ ] Один synthetic/test employee завершил happy/review/recovery paths.
- [ ] Ranking/CSV/review/operations/browser manual QA пройдены.
- [ ] Все go/no-go gates отмечены; иначе результат `NO-GO`.
