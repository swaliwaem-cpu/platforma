# Этап 2. Проверить синхронизированную production migration chain

Приоритет: P0

Тип работы: локальная проверка migrations на disposable PostgreSQL

Production: запрещён

## Промт этапа

```text
Цель: доказать, что синхронизированная цепочка из 58 Prisma migrations полностью воспроизводится на чистой временной PostgreSQL и совместима с фактической production history, не затрагивая существующую локальную или production БД.

Подтверждённый контекст, который сначала нужно перепроверить по текущему worktree:

- production использует 53 migrations; runtime image, checkout и `_prisma_migrations` совпадали 53/53 по checksum;
- физические V1-объекты на production уже удалены применённой migration `20260731120000_replace_training_v1_with_v2`;
- девять V1 migrations должны оставаться в истории и не являются физическими V1-объектами;
- локально byte-exact восстановлены 13 production migrations:
  - девять V1 migrations от `20260725210000_add_training_module` до `20260728130000_fix_training_stage10_final_review_findings`;
  - `20260729120000_training_content_creation_workflow`;
  - `20260729160000_add_training_linked_sources_assignments`;
  - `20260731120000_replace_training_v1_with_v2`;
  - `20260804114000_set_training_time_limit_to_20_minutes`;
- после production chain добавлены пять Patch 3 migrations:
  - `20260807190000_add_training_telegram_delivery_outbox`;
  - `20260808120000_add_training_material_operations`;
  - `20260808160000_add_training_ai_usage_events`;
  - `20260808180000_optimize_training_audio_pipeline`;
  - `20260808210000_add_training_audio_storage_catalog`;
- Prisma schema должна задавать `TrainingProject.timeLimitSeconds @default(1200)`.

Критическое ограничение: `20260731120000_replace_training_v1_with_v2` содержит удаление `public.training_*` объектов через `CASCADE`. На этом этапе её разрешено выполнять только внутри новой disposable БД, созданной специально для полного replay. Никогда не запускай полный replay против существующей, shared или production БД.

Обязательный порядок:

1. До изменений read-only субагент независимо проверяет 58 migration-файлов, их порядок, checksums, Prisma mappings и отсутствие модификаций уже применённых production migrations.
2. Главный агент проверяет branch/status/HEAD, фактические package scripts и отделяет исходные пользовательские изменения.
3. Подтверди:
   - ровно 58 migration directories;
   - 53 production migrations совпадают с утверждённым production manifest;
   - пять Patch 3 migrations идут после production chain;
   - `timeLimitSeconds` имеет default `1200` и в schema, и после replay.
4. Выполни `prisma validate` и `prisma generate` без production env.
5. Создай отдельный временный PostgreSQL container/database со случайным уникальным именем, отдельным volume/network и test credentials. Не используй Compose-default database.
6. Примени полный `prisma migrate deploy` к пустой disposable БД.
7. Проверь:
   - `prisma migrate status` сообщает `Database schema is up to date`;
   - в `_prisma_migrations` ровно 58 завершённых строк;
   - failed, partial и rolled-back migrations отсутствуют;
   - повторный `migrate deploy` является no-op;
   - существуют таблицы Telegram outbox, material operations, AI usage и audio storage catalog;
   - четыре audio metrics columns присутствуют в `training_answers`;
   - default `training_projects.time_limit_seconds` равен `1200`;
   - constraints/indexes валидны.
8. Запусти targeted schema/migration tests и `pnpm build:api` с fake/stub providers.
9. Удали временные container, database, network и volume даже при ошибке.
10. После проверки отдельный read-only субагент проверяет diff, checksum manifest, результаты replay и cleanup.

Жёсткие запреты:

- не подключаться к production по SSH;
- не применять migrations к существующей локальной, shared, staging или production БД;
- не выполнять `prisma migrate resolve`, `prisma db push`, `prisma migrate reset` или `prisma migrate dev`;
- не редактировать содержимое 53 production migrations;
- не создавать новый archive/bridge migration поверх уже существующего `replace_training_v1_with_v2`;
- не копировать production rows, секреты, env или storage;
- не выполнять реальные Telegram/OpenAI и платные вызовы;
- не коммитить, не пушить и не деплоить без отдельной команды.

Stop conditions:

- checksum любой из 53 production migrations отличается от утверждённого manifest;
- migration count или порядок отличается от ожидаемых 58;
- datasource нельзя доказанно признать disposable;
- полный replay требует изменения исторической migration;
- cleanup migration сталкивается с внешней зависимостью;
- повторный deploy не является no-op;
- после replay schema не совпадает с Prisma contract;
- для продолжения требуется production backup/clone или доступ к production.

Критерий завершения: чистая disposable БД воспроизводит все 58 migrations, повторный deploy ничего не меняет, итоговая schema соответствует Prisma contract, временные ресурсы удалены. После этого остановись: проверка на clone production backup и применение пяти новых migrations являются отдельным этапом с отдельным разрешением.
```
