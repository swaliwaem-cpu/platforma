# Этап 2. Сверить production и собрать воспроизводимый deploy candidate

Приоритет: P0

Тип работы: read-only production audit и локальный release reconciliation

Production mutations: запрещены

Commit и push: только по отдельному прямому разрешению

## Промт этапа

```text
Цель: безопасно зафиксировать фактическое состояние production, объяснить все
расхождения с `training-v2`, восстановить versioned production Compose contract
и получить воспроизводимый чистый deploy candidate. Ничего на production в этом
этапе не менять.

Launch message этого этапа разрешает только read-only SSH preflight. Он не
разрешает pull/fetch на сервере, checkout/reset, создание backup-файлов на
сервере, изменение env/permissions, migration, restart/recreate/build, registry
push, webhook или любой paid/provider вызов.

Известный снимок, который нужно перепроверить:

- production checkout: `/opt/platforma`;
- production HEAD во время аудита: `5a8a20d`;
- checkout содержал 15 modified и 8 untracked paths;
- manifest исходников runtime API image совпадал с грязным host checkout, но не
  с committed HEAD, поэтому runtime нельзя было воспроизвести из Git;
- production service был здоров: `status=ok`, `database=ok`, `training=ready`,
  web отвечал HTTP 200, restart count контейнеров был нулевым;
- database содержала 53 завершённые migrations, совпадавшие по checksum с
  первыми 53 локальными migrations; пять новых Patch 3 migrations отсутствовали;
- отдельный production overlay при объединении с base Compose мог включать
  `TRAINING_VOICE_WORKER_ENABLED=true` и в API, и в отдельном worker; restart
  policy worker не была подтверждена;
- локальные refs на момент подготовки: `training-v2`/`origin/training-v2` =
  `cbd5c927f55f9af69e9722f4f7f744257fe7e4e7`, local deploy branch =
  `0a5d578bb1976027a37a58e463c8762e7c4ab487`, origin deploy branch =
  `4eee0373c9c64f56e85acf47b6d7cb561bb42fdc`;
- истории `training-v2` и deploy branch разошлись, поэтому merge/cherry-pick
  strategy нельзя выбирать по одному количеству commits.

До SSH:

1. Подтверди, что этап 1 завершён свежим зелёным отчётом на текущем tree. Если
   connected E2E, build/test, migration replay или diff check красные — `STOP`.
2. Проверь локальные branch/status/HEAD/refs и не переключай текущую ветку.
3. Подготовь локальный `mktemp -d` для redacted evidence. Не клади production
   patch, env, credentials или dumps в repository.
4. Установи `GIT_PAGER=cat PAGER=cat`; не запускай команды, которые могут открыть
   interactive pager или вывести secret values.

Read-only production inventory:

1. Подтверди hostname, UTC time, `/opt/platforma`, filesystem/disk headroom и
   текущую health baseline.
2. Получи только безопасные Git facts: branch, полный HEAD, upstream relation,
   `git status --short --branch`, modified/untracked path list, diff stat и object
   hashes. Не печатай содержимое подозрительных config/env/credential files.
3. Сохрани tracked diff потоком в локальный временный файл без вывода в chat;
   отдельно получи только явно перечисленные untracked source/config files,
   исключая env, keys, dumps, storage data и secrets. Просканируй локальную копию
   на credentials до анализа и не добавляй её в Git автоматически.
4. Зафиксируй container names, image IDs/digests, created time, commands,
   health, restart policy и restart counts. Из effective env извлекай только
   безопасный allowlist: `NODE_ENV`, `TRAINING_VOICE_WORKER_ENABLED`,
   `TRAINING_MATERIAL_WORKER_ENABLED`, `TRAINING_AI_MODE`,
   `TELEGRAM_TRANSPORT_MODE`; не выводи весь `docker inspect` env.
5. Проверь, существует ли одновременно voice worker в API process и отдельном
   service, сколько replicas/processes реально работает и используют ли API и
   worker один exact image ID.
6. Проверь Compose filenames, service names и итоговую topology через безопасные
   выборочные поля. Не печатай полный unredacted `docker compose config`.
7. Выполни только read-only database checks: Prisma migration status/manifest,
   `_prisma_migrations` completion/checksums, наличие пяти новых tables/columns,
   counts активных voice claims/jobs/material operations/review attempts. Перед
   raw SQL проверь фактические Prisma `@@map` и enum mappings.
8. Проверь object-storage topology и bucket names только в redacted виде; не
   листай содержимое audio, не скачивай пользовательские файлы и не меняй
   lifecycle/policy.
9. Заверши SSH-сессию до локального reconciliation.

На production запрещены даже «подготовительные» mutations:

- `git pull`, `git fetch`, checkout, switch, reset, clean, stash, commit;
- создание tar/patch/backup в `/opt` или repository; evidence передавай потоком
  в локальный временный каталог;
- запись файлов, chmod/chown, редактирование `.env.production`;
- `docker compose build/up/down/restart/stop`, image tag/remove/prune;
- Prisma deploy/resolve/reset/db push, seed и любой write SQL;
- создание database/storage backup — это начало этапа 3;
- kill signals, webhook operations и provider calls.

Reconciliation после закрытия SSH:

1. Построй таблицу provenance для каждого production modified/untracked path:
   committed history, production-only config, незакоммиченный hotfix, generated
   output, secret/runtime data или неизвестное происхождение.
2. Ничего не отбрасывай молча. Для каждого hotfix укажи, должен ли он войти в
   candidate, уже присутствует ли эквивалент в `training-v2` и каким test он
   подтверждается.
3. Сравни обе разошедшиеся histories по patch-id/content, а не только SHA и
   commit count. Предложи конкретную merge/cherry-pick/rebuild strategy с
   ожидаемым списком commits и conflicts.
4. Если strategy требует branch switch, нового worktree, cherry-pick, merge,
   commit или push, сначала покажи точный план и дождись отдельного разрешения.
   До подтверждения допустим только read-only audit и локальные временные files.
5. После разрешения собирай candidate в отдельном чистом local worktree/branch;
   основной пользовательский worktree и `.gitignore` не менять.
6. Версионируй фактический `docker-compose.production.yml` только после сверки с
   текущей production topology. Не копируй env values, host, password, token или
   machine-specific paths.
7. Production Compose contract обязан обеспечивать:
   - API: `TRAINING_VOICE_WORKER_ENABLED=false`;
   - ровно один отдельный `training-voice-worker` с flag `true`;
   - worker replicas не выше 1;
   - API и worker используют один exact API image;
   - restart policy для runtime services явно совместима с production;
   - корректные command/PID/SIGTERM/stop grace/health/depends_on;
   - отсутствие dev defaults, опубликованных infrastructure ports и fake mode;
   - required production env fail closed без вывода values.
8. Добавь/усиль contract tests production overlay, чтобы duplicate voice worker,
   отсутствие restart policy и несовпадающие image IDs снова делали gate красным.
9. Проверь объединённый Compose через безопасный synthetic env, build exact
   candidate images и повтори релевантную матрицу этапа 1 в чистом worktree.
10. Сформируй manifest candidate: полный SHA, parent/history, file list,
    migration count/checksums, image tags/digests, Compose files, test commands и
    результаты. Candidate не должен зависеть от грязного `/opt/platforma`.

Commit/push boundary:

- если launch message не разрешает commit — остановись со статусом
  `READY_FOR_RELEASE_COMMIT`, укажи точные paths и рекомендуемый subject;
- если commit разрешён, stage explicit paths, выполни `git diff --cached --check`
  и создай один scoped release commit без `.gitignore`, env и временных evidence;
- push выполняй только если он отдельно назван с точным remote и branch;
- после разрешённого commit/push перепроверь remote full SHA и заверши
  `READY_FOR_DEPLOY_APPROVAL`;
- не создавай tag без отдельной команды.

Stop conditions:

- production path/host/HEAD не соответствует ожидаемому и target нельзя
  однозначно подтвердить;
- обнаружены secrets в tracked/untracked production changes;
- грязные production изменения нельзя классифицировать или безопасно сохранить;
- runtime image не удаётся связать с доступными source files;
- production migration manifest/checksum расходится с local history;
- Compose contract требует одновременный duplicate worker или dev/fake defaults;
- для reconciliation требуется потерять commit, переписать history или изменить
  applied migration;
- этап 1 не полностью зелёный;
- пользователь не подтвердил предложенную Git strategy или commit/push scope.

Критерий завершения: все production расхождения объяснены и сохранены, существует
чистый воспроизводимый local candidate с versioned production Compose contract,
полным manifest и зелёными gates. Production не изменён. Без разрешения на
commit/push остановись на `READY_FOR_RELEASE_COMMIT`; с разрешением и проверенным
remote SHA — на `READY_FOR_DEPLOY_APPROVAL`. Не начинай этап 3.
```
