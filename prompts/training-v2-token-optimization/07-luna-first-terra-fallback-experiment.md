# Шаг 7. Провести Luna-first / Terra-fallback эксперимент

Работаем над модулем обучения в репозитории swaliwaem-cpu/platforma.

## Цель

Проверить, может ли более дешёвая модель Luna генерировать вопросы приемлемого качества, а Terra использоваться как строго ограниченный fallback.

Этот шаг сначала создаёт безопасный benchmark и выключенный по умолчанию router. Он не включает Luna на production. Production routing разрешается только отдельной командой после representative quality review.

## Контекст и зависимости

Шаги 1–6 должны быть завершены либо шаг 6 явно отложен. Model strategy должна входить в generation key/sourceHash, чтобы артефакты разных стратегий не смешивались.

Основные текущие точки:

- apps/api/src/training/training-material-suggester.ts
- apps/api/src/training/training-openai-client.ts
- apps/api/src/training/training-runtime-config.ts
- apps/api/tests/training-v2-stage4-openai.test.cjs
- apps/api/tests/training-v2-stage4-domain.test.cjs
- apps/api/tests/training-v2-stage5-part3-domain.test.cjs
- apps/api/tests/training-v2-stage3-evaluation-provider.test.cjs
- apps/api/tests/training-v2-openai-smoke.cjs

## Предлагаемая безопасная рамка

- Default strategy: terra_only.
- Экспериментальный strategy: luna_then_terra.
- Максимум два HTTP attempts суммарно на одну компиляцию:
  - один Luna;
  - один Terra при разрешённой причине fallback.
- Никакого третьего вызова.
- Автоматические tests только stub/fake.
- Реальный benchmark только после отдельного разрешения тратить деньги.

Это предлагаемая, а не уже утверждённая политика. Fallback по умолчанию разрешай только после успешного HTTP-ответа Luna, который не прошёл локальную строгую schema/evidence validation. Не добавляй переход на Terra при timeout, 429 или 5xx без отдельного согласования. Если transport retry сохраняется, он расходует тот же общий бюджет из двух HTTP attempts: после второго attempt Terra fallback уже невозможен.

## Границы задачи

Реализуй:

- current official model/config validation;
- opt-in benchmark;
- disabled-by-default router;
- hard cap calls;
- usage и fallback telemetry;
- quality report format.

Не включай production strategy, не меняй evaluator/transcriber, не ослабляй validation, не делай commit, push, deploy или real paid calls.

## Обязательный preflight

1. Выполни git branch --show-current и git status --short.
2. Прочитай AGENTS.md, docs/BACKEND_GUIDE.md, docs/TESTING_AND_DEPLOY.md и docs/RISK_ZONES.md.
3. Изучи package scripts и существующий opt-in OpenAI smoke.
4. Через актуальную официальную документацию OpenAI проверь:
   - действующие model IDs;
   - поддержку Responses API, structured output, reasoning и cache options;
   - актуальные цены и ограничения.
5. Найди все retry внутри TrainingOpenAIClient. Спроектируй единый общий бюджет максимум в два HTTP attempts и докажи, что новый router не создаст 2 Luna + 2 Terra.
6. Используй read-only субагентов:
   - provider/retry contract;
   - quality validator;
   - usage/cost accounting.
   Редактирует только главный агент.
7. Сохрани dirty worktree.

## Аудит перед изменением

1. Зафиксируй current Terra baseline на существующих fixtures без нового paid run.
2. Проверь, что current validator гарантирует и чего не гарантирует:
   - ровно 1 MAIN + 10 FOLLOW_UP;
   - валидные grounded locators;
   - 1–3 facts;
   - semantic truthfulness;
   - duplicate topics;
   - coverage.
3. Сформируй representative eval-набор из 10 Platforma objects разных размеров и типов, но не запускай его платно.
4. Определи quality gates до реализации router.
5. Если официальный model ID или pricing нельзя подтвердить, остановись.

## Требуемое поведение

1. terra_only полностью сохраняет текущее production behavior.
2. luna_then_terra доступен только явным config flag.
3. Валидный Luna response завершает генерацию после одного вызова.
4. Невалидный по локальной schema/evidence validation Luna response вызывает ровно один Terra fallback.
5. Невалидный Terra response возвращает безопасную существующую публичную ошибку без третьего вызова.
6. 429, timeout и 5xx не должны самопроизвольно переходить на другую модель. Допустимый transport retry той же модели использует оставшийся общий бюджет; суммарно всегда не более двух HTTP attempts.
7. В usage telemetry для каждого attempt фиксируются:
   - model;
   - request ID;
   - input, cached, cache-write, output, reasoning и total tokens;
   - latency;
   - fallback reason;
   - final model;
   - estimated cost по переданному в benchmark price snapshot.
8. Логи не содержат prompt, source excerpts, голоса, ключи и персональные данные.
9. Model strategy и версия validator входят в sourceHash/global artifact key.

## Quality gates

Автоматически:

- strict schema;
- ровно 11 вопросов нужных типов;
- существующие locator;
- 1–3 facts;
- отсутствие exact duplicate questions;
- обязательное покрытие заданного числа unique sources;
- отсутствие пустых или слишком общих формулировок по детерминированным правилам.

Вручную перед production:

- factual grounding каждого statement;
- отсутствие смысловых дублей;
- полезность вопросов для брокера;
- сопоставимое покрытие с Terra;
- сравнение cost per accepted compilation, а не только cost per request.

## Ограничения реализации

- Не увеличивай число HTTP attempts выше двух.
- Не используй общий maxRetries отдельно для каждой модели; единый attempt budget должен быть доказуем тестами.
- Не включай Luna default.
- Не подменяй ручной semantic review структурной валидацией.
- Не добавляй новую библиотеку или внешний eval-сервис.
- Не меняй evaluator Telegram.

## Критерии приёмки

- Stub: валидная Luna — ровно один call.
- Stub: невалидная Luna — одна Luna и одна Terra.
- Stub: невалидны обе — два calls и безопасная ошибка.
- Stub: timeout/429/5xx не переключают модель, transport retry расходует единый бюджет и суммарно не превышает два attempts.
- Usage, request IDs, models и fallback reason соответствуют фактическим calls.
- Strategy влияет на sourceHash/artifact key.
- Production config по умолчанию terra_only.
- Opt-in benchmark без enable-флага явно skipped.

## Проверки

Запусти без реальных provider calls:

- pnpm build:api
- node --test apps/api/tests/training-v2-stage4-openai.test.cjs
- node --test apps/api/tests/training-v2-stage4-domain.test.cjs
- node --test apps/api/tests/training-v2-stage5-part3-domain.test.cjs
- если менялся общий client: node --test apps/api/tests/training-v2-stage3-evaluation-provider.test.cjs
- проверку benchmark без enable-флага: ожидается skipped
- git diff --check

Не запускай real OpenAI smoke, production или deploy.

## Stop conditions

Остановись и спроси пользователя, если:

- нужен paid benchmark;
- предлагается fallback на transport errors;
- официальный model ID, price или capability не подтверждены;
- quality gate требует субъективного решения;
- router может сделать более двух HTTP attempts;
- требуется включить Luna на production.

## Финальный отчёт

Сообщи:

- подтверждённые model IDs/capabilities со ссылками на официальную документацию;
- реализованный call budget и fallback contract;
- файлы и tests;
- готовый план representative A/B и предельный денежный бюджет;
- что требуется утвердить перед платным benchmark и production;
- риски.

После отчёта остановись. Не включай Luna на production.
