# Этап 1. Подготовить локальный release candidate

Приоритет: P0

Тип работы: локальные исправления и полный release gate

Production и SSH: запрещены

Commit, push и tag: запрещены

## Промт этапа

```text
Цель: устранить подтверждённые локальные блокеры диапазона
`ecfc8f5e52eb202a687e2f7efe90101346beef43^..HEAD`, выполнить свежую полную
проверку candidate в безопасном fake/test окружении и остановиться до любых
production/reconciliation/commit действий.

Затронутые risk zones:

- external providers и background jobs;
- files, private audio и object storage;
- Prisma migrations;
- Docker/env/deploy contract;
- frontend routing и code splitting.

Подтверждённые предпосылки, которые нужно сначала перепроверить:

1. `apps/api/tests/training-v2-stage5-part4-e2e.cjs` около строки 1212 ожидает
   первые ASCII bytes `RIFF` от admin audio endpoint.
2. Текущий pipeline сохраняет merged answer как `merged.webm`, использует
   `audio/webm` и EBML magic bytes `1a 45 df a3`; поэтому connected fake E2E
   проверяет устаревший WAV contract.
3. `git diff --check ecfc8f5e52eb202a687e2f7efe90101346beef43^..HEAD`
   находил trailing whitespace в:
   - `docs/patch-3/02-worker-deploy-safety.md`;
   - `docs/patch-3/08-question-generation-costs.md`;
   - `docs/patch-3/10-audio-storage-gc.md`;
   - `docs/patch-3/11-training-frontend-code-splitting.md`.
4. Остальные full build/unit, disposable migration replay, изолированные
   PostgreSQL checks и browser checks проходили во время предыдущего аудита, но
   этот результат нужно получить заново для текущего candidate.

Обязательный порядок:

1. Проверь branch/status/HEAD, полный commit range, существующие package scripts
   и сохрани исходное пользовательское изменение `.gitignore`.
2. Проследи фактический contract audio от создания merged file до
   `TrainingAudioAccessService`, HTTP headers и connected E2E. Найди все тесты,
   которые намеренно покрывают legacy WAV fallback, и не заменяй их без причины.
3. Подтверди, что падение E2E вызвано только устаревшим ожиданием format, а не
   повреждённым audio, неверным MIME, утечкой private file или случайным выбором
   Docker image.
4. Минимально исправь connected E2E. Проверка должна подтверждать реальный WebM
   contract: HTTP status, `cache-control`, MIME/filename headers при наличии,
   EBML magic bytes и сохранение access-control проверок 403/404. Не подменяй
   проверку произвольным non-empty buffer.
5. Удали только trailing whitespace в четырёх перечисленных документах. Не
   переписывай их содержание и не форматируй соседние файлы.
6. Если найдена другая production-code регрессия, сначала воспроизведи её
   отдельным targeted test. Не расширяй scope молча; при необходимости изменения
   бизнес-поведения остановись с `STOP` и покажи факты.
7. Не создавай `docker-compose.production.yml` по памяти. Его получение и
   reconciliation с production относится только к этапу 2.

Безопасное окружение проверок:

- `TRAINING_AI_MODE=fake`;
- `TELEGRAM_TRANSPORT_MODE=fake`;
- без реального `OPENAI_API_KEY` и без production env;
- отдельная disposable PostgreSQL для replay/integration;
- временные containers/networks/volumes/storage с гарантированным cleanup;
- freshly built API/web images, а не случайно оставшиеся локальные tags.

Минимальная матрица проверки после исправлений:

1. Targeted audio/access/E2E tests затронутого contract.
2. `pnpm test:training-v2:e2e` на явно определённых свежих API и web image IDs.
3. `pnpm build`.
4. `pnpm test`.
5. Prisma validate и generate фактическими scripts текущего API workspace.
6. Полный `prisma migrate deploy` всех migrations на новой disposable
   PostgreSQL, затем `prisma migrate status`, проверка `_prisma_migrations`,
   повторный deploy как no-op и cleanup.
7. Изолированные PostgreSQL tests material worker fencing, ranking fixture,
   voice worker/predeploy и других изменённых Patch 3 data paths. Не запускай все
   несовместимые fixtures на одной базе.
8. Существующие browser checks Training routing, manual review, ranking/loading
   и code splitting через локальный preview. Если in-app Browser недоступен,
   используй существующие Playwright scripts и зафиксируй причину fallback.
9. `docker compose config` для текущего локального Compose и build затронутых
   images без production env.
10. `git diff --check` и проверка итогового дерева относительно
    `ecfc8f5e52eb202a687e2f7efe90101346beef43^`, включающая незакоммиченные
    исправления.

Для нестабильных tests заранее задай bounded повторы: максимум пять для
material-worker fencing и максимум три для browser ranking/loading. Первый
root-cause failure анализируй отдельно от каскадных ошибок fixture.

Инварианты, которые нельзя ослабить ради зелёного результата:

- private training audio и materials не становятся generic public files;
- backend RBAC/ownership checks сохраняются;
- audio deletion остаётся только явно подтверждённой operator-операцией, без
  автоматического GC пользователей или проектов;
- API не запускает voice worker, отдельный worker остаётся единственным owner;
- fake tests не выполняют реальные Telegram/OpenAI/provider calls;
- historical migrations не редактируются;
- `.only`, `.skip`, удаление assertions и повышение warning limits не считаются
  исправлением.

Stop conditions:

- фактический audio contract не WebM или EBML bytes не соответствуют format;
- connected E2E падает не только на устаревшем `RIFF` assertion;
- migration replay требует изменения уже применённой migration;
- тест требует production/shared database, production storage или paid provider;
- для исправления требуется production Compose, SSH, commit/push или новая
  зависимость;
- обнаружена неоднозначность бизнес-поведения.

Критерий завершения: минимальные локальные исправления внесены, connected fake
E2E и вся указанная release matrix зелёные, `git diff --check` чистый, временные
ресурсы удалены, исходная `.gitignore` сохранена. Заверши со статусом `ГОТОВО` и
остановись без commit, push, production и начала этапа 2.
```
