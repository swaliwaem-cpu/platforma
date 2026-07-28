# Training go / no-go checklist

Дата актуализации: 2026-07-28. Production запрещён, пока любой обязательный
gate не отмечен.

## Code

- [ ] Все builds/unit/PostgreSQL/HTTP/browser/Docker/full fake E2E зелёные.
- [ ] Additive migrations прошли на staging с backup/status/post-check.
- [ ] Feature disable/re-enable, rollback, worker restart и outbox recovery
  проверены на staging.

## Telegram

- [ ] Отдельный staging bot, real HTTPS webhook и secret header.
- [ ] Private chat, real synthetic/test voice, duplicate update/callback,
  shutdown/restart проверены.

## Audio

- [ ] Anonymous GET/LIST/PUT denied; private download/ffmpeg/playback/audit
  зелёные.
- [ ] Crash/orphan cleanup и persisted-bucket recovery проверены.

## OpenAI

- [ ] Billing, project-scoped key, model access и rate limits подтверждены.
- [ ] Project data controls документированы.
- [ ] Ровно один synthetic transcription/evaluation smoke прошёл.
- [ ] Calibration 20–30 примеров одобрена экспертами.

## Product

- [ ] Policy/employee copy утверждены руководителем.
- [ ] Project content/facts/questions/criteria/anchors утверждены.
- [ ] Pass score, weights, critical errors и review procedure утверждены.

## Operations

- [ ] Backup/test restore, health/operations и dead-job handling проверены.
- [ ] Назначены incident contact, rollback owner и reviewer.
- [ ] Есть доступ для webhook revoke/restore и token/key rotation.
- [ ] Наблюдаются heartbeat, queue age, stuck attempts, review и safe errors.

Итог: [ ] GO  [ ] NO-GO. Решение, дата и ответственный:
