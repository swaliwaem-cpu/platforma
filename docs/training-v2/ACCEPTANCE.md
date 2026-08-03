# Acceptance: Stage 5 Part 4/4 — Connected E2E and Final Readiness

## Критерии готовности

- `pnpm test:training-v2:e2e` с нуля создаёт и очищает isolated PostgreSQL,
  MinIO и network, собирает API/web, применяет все migrations и использует
  только fake Telegram/OpenAI providers.
- Одни и те же project/user/attempt/answer IDs проходят через live API, DB,
  private storage, real `ffmpeg` и live browser без cross-user contamination.
- 10 concurrent users дают provider peak больше одного и не больше default `3`;
  duplicate update/voice/finish, restart/fencing, timeout, technical refund,
  shutdown и disable/re-enable заканчиваются проверенным persisted state.
- Results/history/review, ranking/current coverage/CSV и protected audio имеют
  корректный RBAC, ownership, redaction и review refresh idempotency.
- Revoke/close блокирует новый старт, не ломает уже начатую попытку, а изменение
  source/questions/assignments не меняет её snapshot.
- На 105 сотрудниках и 10 проектах pagination точна, API/CSV order стабилен,
  CSV formula-safe, page использует две bounded SQL-команды, CSV — четыре для
  двух batches; query plan не раздувает page rows.
- Stage 4/4.5 и Stage 5 regression, API/web/root tests/builds, Prisma, browser,
  Compose, images, `ffmpeg`, graceful shutdown и hygiene gates зелёные.

## Automated fake/local acceptance

1. `pnpm test:training-v2:e2e` — единый connected flow, performance, browser,
   security, clean migrations, image/`ffmpeg`, process stop и resource cleanup.
2. `pnpm --filter @platforma/api test` и `pnpm --filter @platforma/web test`.
3. `TRAINING_MATERIAL_BROWSER_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' pnpm --filter @platforma/api test:training:stage4:browser`.
4. `pnpm test` и `pnpm build`.
5. `pnpm --filter @platforma/api exec prisma validate`.
6. `docker compose config --quiet` и production-mode syntax check с
   `NODE_ENV=production TRAINING_MODULE_ENABLED=false`.
7. `git diff --check`, `.only`/`.skip`, migration/excluded-scope, secret,
   provider-mode и leftover Docker resource scans.

## Локальная ручная fake-приёмка

1. Запустить `pnpm test:training-v2:e2e` и убедиться в финальном
   `TRAINING_V2_STAGE5_PART4_E2E_OK` без оставшихся E2E containers/volumes/network.
2. В локальном UI пройти employee result/history и admin results/review/ranking,
   скачать CSV и прослушать/закрыть protected audio.
3. Проверить ALL/ASSIGNED projects, overlapping assignments и revoke во время
   активной попытки: текущая попытка завершается, новый старт заблокирован.
4. Выключить и включить `TRAINING_MODULE_ENABLED`: entry/actions/worker должны
   остановиться controlled способом, persisted work — продолжиться после enable.
5. Проверить empty/error/mobile states results и отсутствие technical/provider/
   storage metadata в employee и public responses.

## Real local Telegram/OpenAI acceptance — только по отдельному разрешению

25. Создать 10 Training projects.
26. Смешать `ALL_PARTICIPANTS` и `ASSIGNED_USERS`.
27. Назначить нескольких сотрудников на несколько проектов с пересечениями.
28. Связать один проект с реальным ЖК.
29. Добавить PDF и официальный URL.
30. Сгенерировать suggestions и вручную утвердить выбранные facts/questions.
31. Опубликовать и открыть проекты.
32. Связать двух разных пользователей с разными Telegram accounts и работать
    одновременно.
33. Один раз выполнить real OpenAI transcription/evaluation без автоповтора.
34. Проверить `REQUIRES_REVIEW` для unsupported claims.
35. Проверить employee result/history без private provider payload.
36. Проверить ranking, current coverage и CSV.
37. Проверить protected audio playback и закрытие blob URL.
38. Отозвать assignment во время активной попытки и проверить finish/new-start.
39. Изменить source/questions/assignments и подтвердить неизменность старого
    attempt snapshot/result.

## Future production rollout checklist — не выполнялся

1. Создать отдельный reviewed commit/tag и зафиксировать rollback image.
2. Проверить production env, HTTPS public/webhook URLs, distinct buckets,
   Telegram/OpenAI modes/models и отсутствие secret output.
3. Сделать проверенный DB backup и подготовить additive migration/rollback plan.
4. Собрать production API/web images и проверить Compose config.
5. Выполнить `prisma migrate deploy`, затем повторить `prisma migrate status`.
6. Выполнить актуальный permission seed и проверить RBAC.
7. Развернуть с `TRAINING_MODULE_ENABLED=false` и проверить health.
8. По отдельному разрешению выполнить один synthetic OpenAI smoke без retry.
9. Включить module, зарегистрировать Telegram webhook operator-командой и
   проверить status без вывода token/secret.
10. Выполнить ручной multi-user acceptance и наблюдение logs/health/worker.
11. Для rollback выключить module, удалить webhook только с явным confirm и
    вернуть предыдущий image; данные не удалять.

## Definition of Done

Part 4 code-ready только при зелёных automated gates, трёх финальных read-only
verdicts, очищенных временных ресурсах и отсутствии real external/deploy/commit
действий. Полный production-ready остаётся внешним статусом до выполнения real
local acceptance и future production rollout checklist.
