# Модуль обучения: baseline recovery

Дата: 2026-08-01. Ветка: `on-ser`. Вердикт: `REFACTOR_BASELINE_READY`.

Рефакторинг, удаление dead code, UI-изменения, реальные Telegram/OpenAI, SSH и production rollout не выполнялись.

## Исходное состояние

Первоначальный полный API PostgreSQL run завершился `85 pass / 21 fail`. Повторное воспроизведение до изменений дало `86 pass / 20 fail`: один из двух OpenAI crash-window child tests успел пройти за счёт race. Это не другой набор дефектов, а доказательство недетерминированной синхронизации одной общей причины.

| Группа | Failure | Root cause | Категория | Production fix | Test fix |
|---|---:|---|---|---|---|
| OpenAI restart | 3 | тест ждал `TrainingAnswer.status`, но не committed `TrainingProviderRun.REQUESTING`; crash мог произойти до billing fence | race / fixture drift | не требовался | ждать persisted `REQUESTING`; проверять отсутствие автоматического повторного вызова, историю primary/reprocess и active result |
| Publication race | 1 | fixture перестал быть publishable после усиления readiness; late mutation дополнительно конфликтовала по position до version lock | fixture drift / неверный тест | не требовался | полный publishable fixture; late fact с уникальным code; exact immutable conflict; реальные concurrent publication/version tests |
| Telegram identity | 1 | повторно использован `telegramId=501_103` | test contamination | не требовался | уникальная identity и scoped cleanup test jobs |
| Telegram undefined engine | 3 | два worker-сценария передавали несуществующий `engine`; оставшийся due job запускал каскад | неверная fixture | не требовался | test worker по умолчанию получает настоящий `TrainingAttemptEngineService` |
| Telegram direct workers | 13 | прямые test instances не передавали dependency, которая присутствует в production Nest wiring; dead-critical recovery каскадно падал | fixture drift / shared-state cascade | не требовался | единый test subclass с production-equivalent engine wiring; валидные time/identity fixtures |
| **Итого** | **21** | пять общих причин | исходный красный baseline | **0 production bugs среди исходных 21** | исправлены причины, а не 21 assertion по отдельности |

Во время обязательных повторов найден дополнительный production concurrency bug, который не входил в исходные 21: `Serializable` helper attempt engine делал только три немедленных повтора `P2034`. Конкурентные `finalizeAttempt` и job drain могли исчерпать их в одном contention-окне. Исправление ограничено пятью попытками и линейной bounded паузой `10–40 ms`; transaction/lock order, timeout и domain result не менялись.

Ещё один timeout crash-window test имел ту же несинхронизированную fixture-причину OpenAI и также переведён на ожидание committed `REQUESTING`.

## Зафиксированные контракты

### OpenAI recovery

- `PENDING` означает, что внешний запрос ещё не claimed; такой run можно перевести в `REQUESTING` и выполнить.
- `REQUESTING` после stale restart считается `AMBIGUOUS`: неизвестно, был ли внешний ответ/списание до потери процесса.
- `REQUESTING → AMBIGUOUS` не вызывает новый provider request автоматически; answer/attempt выводятся из бесконечного processing в terminal technical/timeout path.
- `SUCCEEDED` переиспользует persisted provider result и не вызывает повторный provider request.
- `FAILED` и `AMBIGUOUS` являются terminal provider runs и требуют explicit reprocess.
- Explicit reprocess создаёт новый run с `runType=REPROCESS` и новым idempotency key. Primary run и его статус не перезаписываются.
- После успешного reprocess `activeTranscription`/`activeEvaluation` указывает на новый provider run, а исторический primary остаётся доступен.
- Exactly-once billing не обещается: окно между внешним side effect и DB commit принципиально классифицируется как ambiguous. Контракт обещает отсутствие автоматического повторного платного вызова после durable `REQUESTING`.

Контракт проверяется real PostgreSQL restart tests для transcription, evaluation, persisted succeeded result, timeout и explicit reprocessing.

### Publication

- Lock order остаётся project → version; content mutation использует shared lock, publication — exclusive lock.
- Из двух конкурентных publish одной draft version ровно один завершается успешно; второй получает conflict. Проект имеет один `activeVersionId`, один current `PUBLISHED` и один publication audit.
- После публикации content immutable на уровне service/DB safeguards; late mutation получает точный conflict `Published training version is immutable; create a new draft`.
- При публикации следующей версии предыдущая `PUBLISHED` становится `SUPERSEDED`, новая становится единственной active version.
- Существующая попытка сохраняет FK на старую версию; новая попытка после переключения получает новую active published version.
- Additive migration не нужна: существующих locks, FK, unique constraints и status transitions достаточно.

### Document worker ownership

- `TrainingDocumentWorkerService` намеренно может работать как несколько одинаковых consumers в API и dedicated worker runtime.
- Job claim защищён CAS по `PENDING/status/attempts`; дальнейшие записи требуют совпадающего `lockOwner`, lease и heartbeat.
- Source-document fence переводит только `PENDING/FAILED → PROCESSING`. Второй consumer видит активный job того же source, освобождает свой claim без расхода attempt и не читает storage повторно.
- После первого persisted extraction duplicate job завершается как obsolete без повторного extraction.
- Stale `RUNNING` lease детерминированно возвращается в `PENDING` либо `DEAD`; source reset выполняется только при отсутствии другого active owner.
- Гарантируется один persisted extraction result при конкурентных consumers. Exactly-once вычисление вне crash windows не формулируется как внешний billing contract.

Контракт проверяется новым real PostgreSQL файлом с двумя независимыми Prisma clients/worker instances, gated storage read, duplicate job и stale restart.

## Внесённые исправления

Production:

- attempt-engine `P2034` retry получил bounded backoff и пять попыток вместо трёх немедленных.

Tests/fixtures:

- OpenAI recovery и timeout tests синхронизированы по persisted provider run и усилены PostgreSQL assertions для всех `PENDING/REQUESTING/SUCCEEDED/FAILED/AMBIGUOUS` путей: terminal answer state, provider call count, reuse сохранённого результата, primary history, reprocess run и active selection.
- Publication fixture приведена к текущему readiness; добавлены race двух publish и old/new attempt version-pinning tests.
- Telegram workers получают production-equivalent attempt engine; тестовые identities/jobs изолированы; overdue fixture соблюдает `expiresAt > startedAt`.
- Добавлен document-worker PostgreSQL contract test и включён в общий runner.

Не менялись routes, DTO, callbacks, scoring, permissions, schema, applied migrations и UI.

## Финальные проверки

| Проверка | Результат |
|---|---|
| `pnpm --filter @platforma/api test` | pass; unit 537/537; PostgreSQL 111/111 |
| PostgreSQL repeat 1 | 111/111; clean temporary DB удалена |
| PostgreSQL repeat 2 | 111/111; clean temporary DB удалена |
| дополнительный PostgreSQL run внутри `pnpm test` | 111/111; clean temporary DB удалена |
| `pnpm --filter @platforma/web test` | 312/312 pass |
| `pnpm build` | pass; известный Vite warning для main chunk 790.87 kB |
| `pnpm test` | pass |
| Prisma validate | schema valid |
| migrations | 43/43 применены с нуля в каждом temporary DB run |
| `git diff --check` | pass |
| `.only` / `.skip` в изменённом test scope | не добавлены |

Runner принимает только local PostgreSQL hosts, создаёт UUID database, принудительно использует `NODE_ENV=test`, fake OpenAI/Telegram modes, удаляет `OPENAI_API_KEY` и дропает временную БД в cleanup/signal paths.

## Остаточные риски и границы

- Real Telegram/OpenAI не вызывались; это намеренно вне baseline recovery.
- Playwright, fake full-chain и Docker audio не входят в этот recovery gate; они остаются обязательными перед затрагивающими их будущими refactor batches.
- Известный Vite chunk warning не связан с training baseline и не исправлялся.
- Пользовательские untracked `output/pdf/training-admin-tate-guide.pdf` и `output/training-editor-design/` сохранены без изменений.
- Статус `REFACTOR_BASELINE_READY` не является командой начать рефакторинг. Требуется отдельное `REFACTOR_APPROVED`.
