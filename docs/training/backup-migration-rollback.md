# Training backup, migration and rollback

Дата актуализации: 2026-07-29. Команды production/staging в этапе 10 не
выполнялись.

## Backup и проверка

С feature disabled создать PostgreSQL custom-format backup и независимый
inventory/versioned snapshot private S3 buckets:

```bash
pg_dump --format=custom --no-owner --file=platforma-before-training.dump "$DATABASE_URL"
pg_restore --list platforma-before-training.dump >platforma-before-training.list
test -s platforma-before-training.dump
test -s platforma-before-training.list
```

Сохранить checksum, timestamp, DB host/name, migration HEAD, image revision и
bucket snapshot/version IDs в защищённом change record. Проверка backup —
test restore в отдельную database с counts/FK checks; не восстанавливать
поверх работающей DB.

## Migration

```bash
pnpm training:staging preflight
pnpm training:staging prisma validate
pnpm training:staging prisma migrate status
pnpm training:staging prisma migrate deploy
pnpm training:staging prisma migrate status
```

После deploy проверить policy unique active constraint, acceptance history,
legacy `ALL_ELIGIBLE` backfill, default новых проектов `ASSIGNED_ONLY`,
assignment/provenance FK/indexes, worker heartbeat, health, operations summary
и отсутствие orphan jobs/files.
Нельзя использовать `migrate reset`, `db push` или destructive down migration
после появления данных.

В staging preflight обязан завершиться до первого `migrate status/deploy`.
Все host-команды выполняются из корня через один runner, который явно
загружает `.env.staging`, требует `DEPLOYMENT_ENV=staging` и повторяет
isolation-check перед каждым Prisma process.
Docker API image выполняет тот же preflight до автоматического
`prisma migrate deploy`; worker повторяет проверку до создания Nest context.

## Safe rollback

1. `TRAINING_MODULE_ENABLED=false`; проверить controlled status и отсутствие
   новых claims/external calls.
2. С явным подтверждением удалить/отключить webhook, обычно сохранив pending
   updates.
3. Остановить `training-worker`; сохранить PostgreSQL и S3.
4. Откатить API/worker/frontend image на совместимую revision. Не удалять
   новые additive tables/columns.
5. OpenAI mode/key не использовать; private audio objects не перемещать и не
   удалять.
6. Исправить код, повторно deploy и проверить migrations/health/privacy.
7. Вернуть webhook, затем re-enable training.
8. Убедиться, что persisted jobs продолжены recovery policy без дублей.

После появления `ASSIGNED_ONLY` старый assignment-unaware API несовместим с
данными: он может показать открытый проект всем eligible users. Поэтому
rollback image допустим только если он уже поддерживает audience/assignments.
Иначе training остаётся disabled до forward-fix. Additive
audience/assignment/provenance columns/tables, assignments, source provenance
и attempts не удалять и не «откатывать» destructive SQL.

Если требуется полное восстановление, развернуть backup в новой изолированной
DB, проверить migration history/data integrity и переключить приложение
только по отдельному change plan. S3 восстанавливать по snapshot inventory,
сохраняя persisted bucket/key и `File.url=null`.
