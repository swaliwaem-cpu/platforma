# Шаг 1. Отключить невыгодную запись prompt cache при генерации вопросов

Работаем над модулем обучения в репозитории swaliwaem-cpu/platforma.

## Цель

Снизить стоимость одного запроса генерации вопросов для нового проекта, отключив только невыгодную implicit cache-write в динамическом generation-path.

Важно: не отключай и не меняй полезный explicit cache оценщика ответов в Telegram. Этот шаг не про кэш оценки ответов и не про общий кэш готовых вопросов между проектами.

Причина шага: в наблюдавшемся production-вызове генерации нового проекта было записано 16 629 cache-write tokens и прочитано 0 cached tokens. Для одноразового динамического запроса такая запись увеличивает стоимость и не даёт экономии. Сначала подтверди текущий контракт кода и актуальный контракт Responses API, затем внеси минимальное изменение.

## Контекст и зависимости

Это первый независимый шаг. Следующие оптимизации не реализовывай.

Основные текущие точки:

- apps/api/src/training/training-material-suggester.ts
- apps/api/src/training/training-openai-client.ts
- apps/api/src/training/training-openai-evaluator.ts
- apps/api/tests/training-v2-stage4-openai.test.cjs
- apps/api/tests/training-v2-stage3-evaluation-provider.test.cjs

## Границы задачи

Реализуй только политику cache-write для запроса создания 1 MAIN и 10 FOLLOW_UP вопросов.

Не меняй:

- evaluator и его cache policy;
- transcription;
- retry policy общего OpenAI-клиента;
- sourceHash, compiler version, context budget и дедупликацию;
- Prisma schema и migrations;
- frontend и Telegram UX.

Не делай commit, push, deploy, production-вызовы и реальные платные OpenAI-вызовы без отдельной прямой команды.

## Обязательный preflight

1. Выполни git branch --show-current и git status --short.
2. Прочитай корневой AGENTS.md, docs/BACKEND_GUIDE.md и релевантные части docs/RISK_ZONES.md.
3. Изучи реальные scripts в package.json до запуска команд.
4. Найди все producers запросов Responses API и все consumers usage/cache metrics.
5. Сохрани все существующие пользовательские изменения. Запрещены reset, destructive checkout и перезапись чужого diff.
6. Используй read-only субагентов для независимого аудита generation-path и evaluator-path. Редактирует общий worktree только главный агент.

## Аудит перед изменением

1. Докажи по текущему коду, где формируется body запроса training_question_generation.
2. Докажи отдельным поиском, где и зачем применяется explicit caching оценщика.
3. По актуальной официальной документации OpenAI проверь:
   - поддержку prompt_cache_options для реально настроенной модели;
   - что режим explicit без breakpoint отключает implicit breakpoint и не создаёт cache-write;
   - поведение для других допустимых model IDs.
4. Если production-конфигурация допускает модель, для которой параметр не поддерживается, не придумывай silent fallback. Остановись и задай один конкретный вопрос либо предложи безопасный model-aware вариант.

## Требуемое поведение

1. Только запрос генерации новых вопросов должен явно отключать implicit cache-write поддерживаемым API-механизмом.
2. В запросе не должно появиться prompt cache breakpoint.
3. store должен оставаться false.
4. Строгая JSON schema, reasoning, model, лимиты и generation instructions не меняются.
5. Explicit caching оценщика Telegram должен остаться без изменений.
6. Нельзя добавлять собственный in-memory cache или новую зависимость.
7. Логи usage должны по-прежнему позволять видеть input, cached, cache-write, output, reasoning и total tokens без вывода секретов или полного prompt.

## Ограничения реализации

- Минимальный ожидаемый scope: training-material-suggester.ts и профильный provider test.
- Не меняй TrainingOpenAIClient, если body уже формируется локально и общей причины для изменения нет.
- Не распространяй новую cache policy на legacy suggestions без доказанного требования.
- Сохрани публичную ошибку QUESTION_DRAFT_GENERATION_FAILED.
- Не ослабляй существующую проверку ровно 11 вопросов и grounded evidence.

## Критерии приёмки

- Stub-тест фиксирует требуемые cache options в body generation-запроса.
- Stub-тест фиксирует отсутствие cache breakpoint и prompt_cache_key.
- Guard-тест подтверждает, что explicit caching оценщика не сломан.
- Количество provider-вызовов и retry-поведение не изменились.
- Нет изменений Prisma, frontend, Telegram и соседних OpenAI flows.

## Проверки

Запусти только:

- pnpm build:api
- node --test apps/api/tests/training-v2-stage4-openai.test.cjs
- node --test apps/api/tests/training-v2-stage3-evaluation-provider.test.cjs
- git diff --check

Используй fake/stub providers. Реальный OpenAI smoke не запускай.

## Stop conditions

Остановись и спроси пользователя, если:

- официальный API-контракт не подтверждает безопасный параметр для текущей модели;
- изменение требует правки общего клиента и затрагивает evaluator;
- тест выявляет, что generation-запрос реально повторно читает значимый объём cache;
- нужен production-доступ или платный вызов.

## Финальный отчёт

Кратко сообщи:

- что доказано про причину лишней cache-write;
- что изменено и в каких файлах;
- какие проверки прошли;
- почему evaluator cache не затронут;
- что нужно проверить вручную по production usage после отдельного разрешения;
- риски и спорные места.

После отчёта остановись. Не переходи к шагу 2.
