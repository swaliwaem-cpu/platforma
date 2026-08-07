# Шаг 3. Дедуплицировать одинаковые evidence-фрагменты

Работаем над модулем обучения в репозитории swaliwaem-cpu/platforma.

## Цель

После дедупликации целых документов удалить точные повторения страниц, абзацев и evidence-фрагментов между разными уникальными источниками до выбора контекста для модели.

Безопасный scope этого шага — только exact dedup после нормализации. Не применяй fuzzy, embeddings или semantic similarity: похожие тексты с разными цифрами и условиями нельзя случайно схлопнуть.

## Контекст и зависимости

Шаги 1 и 2 должны быть завершены. Этот шаг выполняется после whole-source dedup и до selectEvidenceFragments.

Основные текущие точки:

- apps/api/src/training/training-material-suggester.ts
- apps/api/src/training/training-material-extraction.ts
- apps/api/tests/training-v2-stage4-domain.test.cjs

## Границы задачи

Реализуй только глобальную exact-дедупликацию нормализованных evidence-фрагментов внутри одного generation payload.

Не меняй:

- source storage и список материалов;
- публичные DTO;
- compact locator contract;
- context budget;
- Prisma;
- provider model, retries и prompt cache;
- общий кэш между проектами.

Не делай commit, push, deploy, production или paid calls.

## Обязательный preflight

1. Выполни git branch --show-current и git status --short.
2. Прочитай AGENTS.md, docs/BACKEND_GUIDE.md и релевантные части docs/RISK_ZONES.md.
3. Найди весь путь createEvidenceFragments → selectEvidenceFragments → compilation.references → persist facts.
4. Проверь все нормализаторы текста и не создавай дублирующую normalization-функцию без причины.
5. Используй read-only субагентов: один проверяет алгоритм выбора evidence, второй — сохранность provenance и tests. Общий worktree меняет только главный агент.
6. Сохрани существующие пользовательские изменения; запрещены reset и destructive checkout.

## Аудит перед изменением

1. Зафиксируй, какие повторы уже удаляются внутри одного источника.
2. Определи точный canonical fingerprint фрагмента:
   - единая нормализация whitespace и Unicode;
   - без удаления цифр, единиц измерения, знаков сравнения и значимой пунктуации;
   - детерминированный hash или exact key.
3. Определи детерминированный canonical reference для повторяющегося текста.
4. Проверь semantic round-robin: каждый уникальный источник должен иметь шанс представить уникальные факты.
5. Если один fragment должен сохранять несколько citations, а текущий references contract этого не поддерживает, не расширяй модель молча. Остановись и задай вопрос.

## Требуемое поведение

1. Один и тот же нормализованный фрагмент попадает в AI payload один раз.
2. Уникальные фрагменты каждого источника сохраняются.
3. Тексты, различающиеся числами, датами, площадью, ценой, сроками или условиями, не считаются дублями.
4. Результат не зависит от порядка входных источников.
5. Canonical reference всегда указывает на существующую текущую ревизию.
6. rawFragments, uniqueFragments, rawChars и uniqueChars доступны в безопасных внутренних метриках или structured logs без содержимого документов.
7. sourceHash меняется только при изменении фактически уникального контекста или версии алгоритма, а не при добавлении точного дубля.

## Ограничения реализации

- Не добавляй embeddings, LLM-классификатор или новую библиотеку.
- Не дедуплицируй на основании substring overlap.
- Не меняй качество выборки ради максимального процента сжатия.
- Сохрани grounded evidence и обратное отображение locator.
- Если canonical AI payload изменился, повысить compiler/policy version.
- Не переносить provider call в транзакцию и не менять bounded retry.

## Критерии приёмки

- Общий абзац из двух разных источников отправляется один раз.
- Уникальный абзац каждого источника остаётся.
- Почти одинаковые абзацы с разными числами остаются двумя фрагментами.
- Перестановка источников дает тот же уникальный payload и sourceHash.
- Все references валидны.
- Метрики позволяют увидеть коэффициент exact dedup без утечки текста.

## Проверки

Добавь targeted cases в apps/api/tests/training-v2-stage4-domain.test.cjs:

- shared paragraph плюс два уникальных;
- различающиеся числовые факты;
- Unicode и whitespace normalization;
- order invariance;
- references на canonical source;
- sourceHash не меняется от добавления exact duplicate.

Запусти:

- pnpm build:api
- node --test apps/api/tests/training-v2-stage4-domain.test.cjs
- git diff --check

Не запускай web, Telegram E2E, PostgreSQL или реальный OpenAI.

## Stop conditions

Остановись и спроси пользователя, если:

- exact dedup уничтожает обязательное представление источника;
- нужен новый multi-citation публичный контракт;
- нормализация может убирать значимые цифры или условия;
- требуется semantic/fuzzy dedup.

## Финальный отчёт

Укажи:

- точное правило дедупликации;
- какие файлы изменены;
- raw/unique counts на fixtures;
- проверки и результат;
- что вручную проверить на реальных документах;
- риски и спорные места.

После отчёта остановись. Не переходи к шагу 4.
