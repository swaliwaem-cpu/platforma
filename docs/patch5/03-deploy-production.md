# Этап 3. Выполнить контролируемый production deploy

Приоритет: P0

Тип работы: production change с backup, migration и rollback gates

Production mutations: разрешены только для exact SHA из launch message

Real paid/provider smoke и webhook changes: запрещены без отдельной команды

## Промт этапа

```text
Цель: развернуть на production ровно один заранее проверенный полный commit SHA,
сделать проверенный backup, применить только существующие additive migrations,
адресно переключить runtime services и доказать health/rollback readiness без
потери данных, duplicate workers и скрытого использования грязного checkout.

Сам путь к этому файлу не является разрешением на deploy. Launch message должен
содержать фразу `Разрешаю production deploy` и полный 40-character candidate SHA.
Если SHA сокращён, содержит placeholder, не опубликован в разрешённом remote или
не совпадает с `READY_FOR_DEPLOY_APPROVAL` отчётом этапа 2 — заверши `STOP` без
SSH mutation.

Обязательные preconditions до первой production mutation:

1. Есть свежие зелёные отчёты этапов 1 и 2 для того же exact SHA.
2. Candidate checkout чистый, commit доступен из разрешённого remote, migration
   manifest и production Compose versioned, exact API/web images воспроизводимы.
3. Все production dirty changes из предыдущего checkout сохранены и явно
   reconciled; ни один неизвестный modified/untracked path не будет перезаписан.
4. Launch message явно содержит production host, user и password и разрешает
   прямую password-аутентификацию. Отдельный SSH key, alias или предварительная
   ротация password не требуются. Password используется только для текущей
   интерактивной SSH-сессии и не сохраняется в repository, env, shell history,
   process arguments, scripts, logs или отчёте.
5. Согласовано maintenance window и ручной владелец решения GO/rollback.
6. Определены previous image digests/tags, forward-compatible image rollback и
   отдельный план DB restore. Автоматический destructive DB rollback запрещён.
7. Для пяти pending migrations подтверждено, что они являются ожидаемыми
   existing migrations candidate; applied production migrations не изменены.
8. Нет активных voice claims/jobs/опасных material operations и конфликтующих
   review/attempt writes. Если активность есть, штатно дождись завершения или
   остановись; не используй `--confirm-active` без отдельного решения оператора.
9. Есть достаточно места для database backup, build layers и rollback images.
10. Production health до deploy зафиксирован; старый healthy runtime не считается
    доказательством готовности нового candidate.

До выполнения покажи пользователю короткий GO/NO-GO preflight со значениями без
секретов: target SHA, current production SHA/state, pending migrations, active
claims/jobs, backup destination, services to recreate и rollback image digests.
Если любой пункт `NO-GO`, остановись до mutation.

Безопасная последовательность:

1. Открой SSH только к host/user из launch message. Разрешено обычное
   интерактивное password-подключение; успешная аутентификация является
   достаточным access gate. Не требуй SSH key или alias и не используй password
   в command line. Установи `GIT_PAGER=cat PAGER=cat`, строгую обработку exit
   codes и UTC deployment ID.
2. Повтори read-only baseline: Git state, health, container IDs/image digests,
   restart counts, commands, safe worker flags, disk, Compose service list,
   migration status и active work. Не печатай full env/Compose config.
3. Создай уникальный deployment backup вне repository и production volumes:
   - metadata с UTC, target/current SHA и image digests без secrets;
   - безопасную копию `.env.production`/Compose с restrictive permissions, не
     выводя содержимое;
   - custom-format PostgreSQL dump;
   - SHA-256 dump и проверку `pg_restore --list`;
   - rollback tags/digests exact currently running API/web images;
   - manifest production dirty-state preservation из этапа 2.
4. Подтверди, что migrations не удаляют production storage/data и что audio
   deletion остаётся operator-only. Если найден destructive SQL, automatic GC
   или необходимость storage restore без проверенного snapshot — `STOP`.
5. Разверни exact candidate в чистом release checkout/worktree. Не выполняй
   `git pull` поверх грязного `/opt/platforma`, не reset/clean старый checkout и
   не собирай image из смешанного source tree.
6. Валидируй объединённый production Compose exact candidate с
   `.env.production`, не печатая config. Проверь fail-closed required env,
   service commands, restart policy, volumes, ports, healthchecks и topology:
   API voice flag `false`, отдельный worker flag `true`, replicas 1, один API
   image digest для API/worker.
7. Собери уникально tagged API/web candidate images до переключения traffic.
   Зафиксируй их image IDs/digests и докажи, что source manifest соответствует
   exact target SHA.
8. Выполни initial `prisma migrate status`. Exit code из-за ожидаемых pending
   migrations не трактуй как автоматическое разрешение deploy: сначала сверь
   точный список и checksums с manifest.
9. Примени только `prisma migrate deploy` exact candidate image. Запрещены
   `migrate dev`, reset, db push, resolve, seed без отдельной необходимости и
   любой ручной write SQL.
10. Повтори `prisma migrate status` и проверь `_prisma_migrations`: ожидаемое
    общее количество, все rows завершены, failed/partial/rolled-back отсутствуют,
    applied checksums совпадают.
11. Запусти обязательный `pnpm training:worker:predeploy` в корректном
    production context. Exit code 2 блокирует rollout. Не обходи gate и не
    пересоздавай worker при active claims без отдельного подтверждения.
12. Переключай только затронутые runtime services адресно, без restart PostgreSQL,
    Redis и MinIO:
    - API через targeted `up -d --no-deps` exact candidate;
    - дождись healthy API;
    - `training-voice-worker` отдельным `--no-deps --force-recreate` после
      predeploy gate;
    - web адресно после готовности API;
    - используй фактические production Compose filenames/flags из этапа 2.
13. Не запускай полный broad `docker compose up -d --build`, если он может
    пересоздать infrastructure или одновременно поднять второй voice worker.
14. Выполни post-deploy checks:
    - local и public health: `status=ok`, `database=ok`, `training=ready`;
    - web HTTP 200 и стабильные route/asset markers;
    - protected unauthenticated endpoints возвращают ожидаемые 401/403/404;
    - API и worker используют exact candidate image; voice worker ровно один;
    - свежие worker heartbeats, нет stuck jobs/claims/recent errors;
    - restart counts стабильны, logs не содержат panic, migration, provider,
      permission или storage ошибок;
    - новые tables/columns/defaults/indexes существуют и constraints валидны;
    - private audio/material endpoints и operator-only deletion contract
      сохраняются.
15. Выполни bounded observation после rollout и ещё раз проверь health, logs,
    heartbeats, active work и restart counts. Не оставляй SSH session открытой.

Feature/provider boundary:

- не регистрируй и не удаляй Telegram webhook;
- не запускай OpenAI smoke, transcription/evaluation/generation benchmark или
  реальное Telegram сообщение;
- не меняй model/reasoning/feature flags и env values, кроме заранее
  утверждённого exact deploy contract;
- startup существующих services допустим, но намеренные billable/provider calls
  требуют отдельной команды;
- manual signed-in admin/employee smoke перечисли отдельно и выполняй только при
  наличии тестовых production accounts и явного разрешения.

Rollback:

1. При ошибке до migration не переключай traffic; удали только явно созданные
   candidate resources, сохранив evidence и backup.
2. После additive migrations предпочитай feature disable/worker stop и возврат
   previous image digest с сохранением новой schema/data.
3. Не выполняй down migration, restore dump поверх production, volume deletion,
   broad `down` или destructive SQL без отдельного утверждённого incident plan.
4. Если previous image несовместим с уже применённой schema, не откатывай его
   вслепую; остановись, удерживай безопасное состояние и предложи forward fix.

Немедленные stop conditions:

- target SHA/remote/history не совпадает с этапом 2;
- production checkout всё ещё содержит необъяснённые dirty changes;
- backup не создан, hash/`pg_restore --list` не прошли или места недостаточно;
- migration list/checksum отличается от manifest или есть failed migration;
- Compose config невалиден, раскрывает secret, включает duplicate voice worker,
  использует разные API images или не имеет ожидаемой restart policy;
- active claims/predeploy gate красный;
- build не соответствует exact SHA;
- baseline health уже красный и причина не установлена;
- требуется destructive DB/storage action, env change, webhook или paid call,
  не разрешённые launch message;
- любой targeted service не становится healthy в bounded interval.

Критерий завершения: production работает на exact разрешённом SHA и image
digests, backup проверен, migrations полностью завершены, infrastructure не
перезапускалась, voice worker единственный, health/logs/heartbeats/postchecks
зелёные, rollback artifacts сохранены, secrets не раскрыты. Финальный отчёт
должен отдельно перечислить manual/provider gates, которые не выполнялись.
```
