# Patch 5. Общий промт подготовки и деплоя production

Используйте этот файл вместе только с одним этапом из `docs/patch5`.
Не объединяйте исправления, reconciliation и фактический production deploy
в один запуск.

## Этапы

1. [Подготовить локальный release candidate](./01-prepare-local-release-candidate.md)
2. [Сверить production и собрать воспроизводимый deploy candidate](./02-reconcile-production-candidate.md)
3. [Выполнить контролируемый production deploy](./03-deploy-production.md)

## Как запускать этапы

### Этап 1

```text
Прочитай и соблюдай docs/patch5/00-new-window-context.md.
Выполни только docs/patch5/01-prepare-local-release-candidate.md.
Production, SSH, commit и push запрещены. После отчёта остановись.
```

### Этап 2

```text
Прочитай и соблюдай docs/patch5/00-new-window-context.md.
Выполни только docs/patch5/02-reconcile-production-candidate.md.
Разрешаю read-only SSH preflight production. Любые изменения production,
контейнеров, файлов, env, базы, storage и Git checkout на сервере запрещены.
Commit и push разрешены только если я отдельно явно добавлю это в сообщение.
После отчёта остановись.
```

### Этап 3

Текущий проверенный candidate:

```text
Прочитай и соблюдай docs/patch5/00-new-window-context.md.
Выполни только docs/patch5/03-deploy-production.md.
Разрешаю production deploy ровно полного commit SHA:
69c64667592f3d1191e8799a902af2e4fb05ae7a.
Разрешаю прямую SSH-аутентификацию по паролю, переданному в текущем launch
message. Используй пароль только для этого подключения, не печатай и не сохраняй
его в файлы, env, shell history, process arguments или отчёт.
Не выполняй реальные платные OpenAI/Telegram smoke-вызовы и не меняй webhook
без моей отдельной команды.
```

Если полный SHA, host/user/password или прямое разрешение на production deploy
не переданы в launch message, этап 3 обязан завершиться со статусом `STOP`,
ничего не меняя.

## Общий промт

```text
Работаем в репозитории `/Users/nick/Documents/platforma` над подготовкой Patch 5:
довести изменения Training V2 из диапазона
`ecfc8f5e52eb202a687e2f7efe90101346beef43^..HEAD` до воспроизводимого
production release и выполнить только явно выбранный этап.

Состояние на момент подготовки этих промтов, 2026-08-09:

- ветка: `training-v2`;
- HEAD: `cbd5c927f55f9af69e9722f4f7f744257fe7e4e7`;
- `origin/training-v2` указывал на тот же commit;
- диапазон от `ecfc8f5e52eb202a687e2f7efe90101346beef43`
  включительно содержал 11 commits и менял 138 files;
- в рабочем дереве было пользовательское изменение `.gitignore`;
- локальная ветка `deploy/training-v2-production` указывала на
  `0a5d578bb1976027a37a58e463c8762e7c4ab487`, а соответствующий origin ref —
  на `4eee0373c9c64f56e85acf47b6d7cb561bb42fdc`;
- `training-v2` и deploy-ветки имели разошедшуюся историю;
- в `training-v2` отсутствовал versioned `docker-compose.production.yml`.

Это снимок, а не неизменное требование. В начале выбранного этапа обязательно
перепроверь `git branch --show-current`, `git status --short`, полный HEAD,
remote refs, package scripts и фактические файлы. Не переключай ветку сам.
Если факты изменились, используй текущий код как источник истины и явно покажи
отличия от снимка.

Известный результат последнего preflight-а, который также нужно перепроверять:

- `pnpm build` проходил;
- `pnpm test` проходил: API 434, web 311, feed import 64, WP import 23 tests;
- Prisma validate/generate и полный replay 58 migrations на disposable
  PostgreSQL проходили, повторный deploy был no-op;
- изолированные PostgreSQL tests и browser checks проходили;
- connected fake E2E падал на ожидании WAV/`RIFF`, хотя текущий audio pipeline
  возвращал WebM с EBML header;
- `git diff --check` для полного диапазона находил trailing whitespace в четырёх
  документах Patch 3;
- production Compose snapshot мог одновременно включать voice worker внутри API
  и отдельный `training-voice-worker`; у отдельного worker отсутствовала
  подтверждённая restart policy;
- production checkout `/opt/platforma` был грязным: 15 modified и 8 untracked
  paths, а runtime API image соответствовал содержимому грязного checkout,
  а не его committed HEAD;
- production HEAD во время снимка был `5a8a20d`, текущий сервис был здоров,
  production database содержала 53 завершённые migrations, а пять новых Patch 3
  migrations ещё не были применены;
- активных locked answers и выполняющихся/review attempts на момент снимка не было.

Ни один из этих пунктов не является разрешением менять production и ни один
успешный старый прогон не заменяет свежую проверку выбранного candidate.

Перед работой полностью прочитай:

- корневой `AGENTS.md`;
- `docs/PROJECT_CONTEXT.md`;
- `docs/TESTING_AND_DEPLOY.md`;
- `docs/RISK_ZONES.md`;
- выбранный файл этапа.

Дополнительные документы читай только по необходимости. Источники требований:
текущий запрос пользователя, ближайший `AGENTS.md`, текущий код/Prisma/package
scripts/tests, затем активная документация. Старые планы и Git history нужны
только для расследования конкретной регрессии или reconciliation.

Общие правила:

1. Не откатывай и не перезаписывай `.gitignore` и любые другие исходные
   пользовательские изменения.
2. Не выполняй `git reset --hard`, destructive checkout, удаление веток,
   `prisma migrate reset`, `prisma db push`, `prisma migrate dev`, destructive
   rollback базы или удаление production volumes.
3. Не изменяй уже применённые production migrations. Новые data changes должны
   быть additive и отдельно обоснованы.
4. Не добавляй зависимости, не делай попутный рефакторинг и массовое
   форматирование.
5. Не печатай и не сохраняй пароли, tokens, полные env-файлы, unredacted Compose
   config или connector strings. Не добавляй production host/user/password в Git.
6. Прямая SSH-аутентификация по паролю разрешена, если host, user и password
   явно переданы в launch message этапа 3. Используй password только через
   интерактивный SSH prompt; не печатай, не сохраняй и не добавляй его в Git,
   env, shell history, process arguments, scripts, logs или отчёт.
7. Локальные автоматические проверки принудительно запускай с fake/stub
   providers, отдельной временной PostgreSQL и временным storage. Не выполняй
   реальные платные OpenAI/Telegram вызовы.
8. Production и SSH разрешены только в границах выбранного этапа и launch
   message. Read-only SSH этапа 2 не разрешает ни одной server-side mutation.
9. Commit, push, tag, webhook registration, production env changes и deploy
   требуют отдельного прямого разрешения. Разрешение на один пункт не разрешает
   остальные.
10. Не начинай следующий этап. Если текущий этап упирается в его границу,
    остановись и подготовь точный handoff.

Перед изменениями сначала установи причину по текущему коду. Найди все
использования затрагиваемых symbols/files, проверь фактические scripts и назови
затронутые risk zones. Если текущий код опровергает предпосылку, есть конфликт
источников или требуется новая бизнес-логика, остановись и покажи доказательства.

Любая временная database/container/network/volume/worktree/patch должна иметь
уникальное имя, находиться вне пользовательских данных и удаляться даже при
ошибке. Не удаляй исходные production-файлы и не используй широкие globs.

Финальный отчёт дай по-русски. Начни с одного статуса:

- `ГОТОВО` — критерии выбранного этапа выполнены;
- `READY_FOR_RELEASE_COMMIT` — candidate проверен, но commit/push не разрешены;
- `READY_FOR_DEPLOY_APPROVAL` — существует чистый полный SHA и все predeploy
  gates зелёные, но production deploy ещё не разрешён;
- `STOP` — сработало обязательное stop condition;
- `BLOCKED` — продолжение невозможно без внешнего решения.

Укажи изменённые файлы, все реально запущенные команды и результаты, cleanup,
непройденные/не запущенные проверки, ручные gates, остаточные риски, полный
candidate SHA и итоговый `git status --short`. Отдельно перечисли production
действия, если они были, и подтверди отсутствие секретов в выводе.

Этап: <вставить путь ровно к одному файлу из docs/patch5>
```
