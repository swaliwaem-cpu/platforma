# Training staging smoke checklist

Дата актуализации: 2026-07-28. В этапе 10 пункты ниже не выполнялись.

## Infrastructure

- [ ] Отдельные staging DB/buckets/bot/OpenAI project/users подтверждены.
- [ ] Backup создан и test restore/manifest проверены.
- [ ] Production build и все additive migrations применены через
  `prisma migrate deploy`; status после deploy чистый.
- [ ] HTTPS, exact CORS origin и secure cookies проверены.
- [ ] `GET /health` не раскрывает детали и показывает `ready`.
- [ ] Operations summary доступен только по `training:operations:read`.

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
