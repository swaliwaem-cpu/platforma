# Шаг 5. Ввести адаптивный бюджет контекста генерации

Работаем над модулем обучения в репозитории swaliwaem-cpu/platforma.

## Цель

Перестать безусловно набирать контекст до одного максимума и выбирать минимальный достаточный budget после exact-дедупликации, не ухудшая покрытие источников и качество 11 вопросов.

Этот шаг не должен молча менять production default. Сначала реализуй детерминированный алгоритм, локальные метрики и opt-in A/B 30 000 против 24 000 символов. Переключение production policy возможно только после отдельного подтверждения пользователя по результатам.

## Контекст и зависимости

Шаги 1–4 должны быть завершены. Budget рассчитывается только по unique fragments, иначе дубли искусственно завышают потребность.

Основные текущие точки:

- apps/api/src/training/training-material-suggester.ts
- apps/api/src/training/training-runtime-config.ts
- apps/api/tests/training-v2-stage4-domain.test.cjs
- apps/api/tests/training-v2-stage4-openai.test.cjs
- apps/api/tests/training-v2-openai-smoke.cjs

## Границы задачи

Реализуй:

- чистую детерминированную budget policy;
- safe metrics;
- opt-in benchmark harness для сравнения 30k и 24k;
- сохранение текущего production default до ручного quality gate.

Не включай:

- real paid benchmark без отдельного разрешения;
- Luna routing;
- cross-project cache;
- Prisma;
- frontend;
- бесконечные E2E;
- commit, push и deploy.

## Обязательный preflight

1. Выполни git branch --show-current и git status --short.
2. Прочитай AGENTS.md, docs/BACKEND_GUIDE.md, docs/TESTING_AND_DEPLOY.md и релевантные части docs/RISK_ZONES.md.
3. Изучи package scripts и существующий opt-in smoke contract.
4. Найди все readers OPENAI_QUESTION_GENERATION_SOURCE_MAX_CHARS и все места, где budget входит в sourceHash.
5. Используй read-only субагентов: один аудирует алгоритм selection, другой — benchmark safety и test matrix. Редактирует только главный агент.
6. Не трогай существующие пользовательские изменения.

## Аудит перед изменением

1. Зафиксируй baseline policy и hard cap.
2. Собери без provider-вызова распределение raw/unique/selected chars и fragments на существующих fixtures.
3. Проверь обязательное представление каждого уникального источника и сохранение числовых фактов.
4. Предложи точные детерминированные пороги на основании измерений.
5. Не предполагай произвольные ступени 18k/24k/30k без evidence.
6. Если текущих fixtures недостаточно для выбора порогов, реализуй policy с default-preserving режимом и остановись с таблицей, какие реальные данные нужны.

## Требуемое поведение

1. Чистая функция принимает характеристики unique evidence и config, возвращает chosenBudget и policyVersion.
2. Есть hard ceiling, который невозможно превысить.
3. Короткий набор не дополняется лишним текстом только ради бюджета.
4. Для среднего и большого набора выбор детерминирован и сохраняет представление уникальных источников.
5. Фактически выбранный budget и policyVersion входят в sourceHash.
6. Structured metrics содержат:
   - raw/unique/selected chars;
   - raw/unique/selected fragments;
   - chosen budget;
   - число unique sources;
   - latency, retry count и usage при разрешённом benchmark;
   - результат валидации 1 + 10 вопросов.
7. Metrics не содержат полный prompt, excerpts, API keys или персональные данные.
8. Benchmark запускается только явным opt-in env-флагом и без него завершается как skipped.
9. Прогоны 30k и 24k выполняются последовательно с одной моделью, reasoning, compiler и источниками.

## Ограничения реализации

- Не меняй process.env параллельно внутри одного процесса.
- Не ослабляй schema, grounded facts и duplicate-question validation.
- Не маскируй уменьшение качества средним token count.
- Production default остаётся прежним до отдельного решения.
- Не добавляй внешнюю observability-библиотеку.
- Не запускай benchmark автоматически из обычного test suite.

## Критерии приёмки

- Pure tests покрывают short, medium, large и hard-cap cases.
- Перестановка источников не меняет chosenBudget и selection.
- Каждый unique source представлен, когда это возможно в hard cap.
- Числовые уникальные факты не вытесняются exact duplicates.
- sourceHash различает budget/policy changes.
- Opt-in harness не тратит деньги без флага.
- Есть формат отчёта 30k vs 24k: tokens, estimated cost, latency, validity и ручной quality review.

## Проверки

Запусти без платных вызовов:

- pnpm build:api
- node --test apps/api/tests/training-v2-stage4-domain.test.cjs
- node --test apps/api/tests/training-v2-stage4-openai.test.cjs
- проверку opt-in harness без enable-флага: ожидается явный skipped
- git diff --check

Не запускай production и real OpenAI benchmark.

## Stop conditions

Остановись и спроси пользователя, если:

- требуется выбрать production threshold без достаточных данных;
- benchmark требует денег или production credentials;
- уменьшение budget снижает покрытие источников или валидность 11 вопросов;
- sourceHash или compiler version нельзя обновить без конфликта с текущим patch.

## Финальный отчёт

Сообщи:

- реализованную policy и почему production default не изменён;
- файлы и tests;
- локальные raw/unique/selected metrics;
- готовность A/B и точную команду, но не секреты;
- что должен утвердить пользователь после A/B;
- риски.

После отчёта остановись. Не переходи к шагу 6.
