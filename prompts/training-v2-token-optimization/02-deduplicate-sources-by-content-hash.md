# Шаг 2. Дедуплицировать одинаковые источники по contentHash

Работаем над модулем обучения в репозитории swaliwaem-cpu/platforma.

## Цель

Не отправлять модели один и тот же PDF или другой материал повторно, если фактическое содержимое одинаково, но имя файла, заголовок, revision ID или metadata различаются.

Дедупликация касается только AI-контекста генерации. Не удаляй сохранённые материалы, файлы, версии или пользовательские записи.

## Контекст и зависимости

Шаг 1 должен быть завершён. Не реализовывай fragment dedup, компактные ID, adaptive budget или cross-project reuse.

Основные текущие точки:

- apps/api/src/training/training-material.service.ts
- apps/api/src/training/training-material-suggester.ts
- apps/api/src/training/training-material-extraction.ts
- apps/api/src/training/training-project-knowledge.service.ts
- apps/api/tests/training-v2-stage4-domain.test.cjs

Текущая реализация уже дедуплицирует некоторые источники, но source key включает title/type/contentHash. Поэтому одинаковый контент под разными именами может повторно попасть в prompt.

## Границы задачи

Реализуй exact whole-source dedup по фактическому contentHash для AI payload.

Не делай:

- fuzzy или semantic dedup;
- дедупликацию отдельных абзацев между разными документами;
- удаление материалов или storage objects;
- Prisma migration;
- изменение публичных DTO;
- общий кэш между проектами;
- commit, push, deploy, production или paid calls.

## Обязательный preflight

1. Выполни git branch --show-current и git status --short.
2. Прочитай AGENTS.md, docs/BACKEND_GUIDE.md и релевантные части docs/RISK_ZONES.md.
3. Изучи package scripts и текущие незакоммиченные изменения.
4. Найди все места создания TrainingQuestionDraftSource и все consumers contentHash, sourceHash и references.
5. Проверь persisted и prospective flows: сохранённый материал, новый PDF, URL и Platforma import.
6. Используй read-only субагентов для аудита источников и проверки provenance. Редактирует только главный агент.
7. Не откатывай и не переписывай существующий dirty diff.

## Аудит перед изменением

1. Зафиксируй текущий алгоритм normalizeQuestionSources и расчет sourceHash.
2. Подтверди, откуда приходит TrainingMaterialRevision.contentHash.
3. Проверь, есть ли contentHash у prospective extraction до сохранения.
4. Определи детерминированное правило выбора canonical source, независимое от входного порядка.
5. Докажи, как references переводят внутренний locator в актуальные revisionId, sourceLabel и исходный locator.
6. Если одинаковое содержимое может иметь разные правила доступа или бизнес-смысл, остановись и покажи конкретный конфликт.

## Требуемое поведение

1. Два источника с одинаковым проверенным contentHash образуют один источник в AI-контексте независимо от title и revision ID.
2. Два источника с различным contentHash остаются разными.
3. Выбор canonical source детерминирован и не зависит от порядка загрузки.
4. Добавление второго дубликата не меняет generation sourceHash, поэтому существующий reuse contract получает тот же ключ и остаётся применимым.
5. При архивировании ранее выбранного дубликата следующая подготовка должна корректно привязать references к оставшемуся активному материалу.
6. Все сохранённые материалы продолжают отображаться и жить независимо.
7. Провенанс результата остаётся проверяемым: persisted TrainingFact должен указывать на существующую актуальную ревизию и исходный locator.

## Ограничения реализации

- Используй существующий криптографический contentHash, а не title и не имя файла.
- Не считай одинаковыми источники без надёжного contentHash только по длине или похожему тексту.
- Не добавляй новую зависимость.
- Не переноси provider call внутрь DB-транзакции.
- Если canonical payload или sourceHash contract меняется, повысить соответствующую compiler/policy version и зафиксировать это тестом.
- Сохрани инварианты: 1 MAIN + 10 FOLLOW_UP, 1–3 facts, grounded locators, монотонный knowledgeVersion.

## Критерии приёмки

- Одинаковый нормализованный PDF под двумя именами представлен модели один раз.
- Разные документы не схлопываются.
- Результат и sourceHash стабильны при перестановке источников.
- references указывают на активный material revision текущего проекта.
- Повторная подготовка после добавления дубликата сохраняет тот же sourceHash и не инвалидирует существующий reuse contract.
- Нет удаления данных, миграций и изменений frontend.

## Проверки

Добавь targeted cases в apps/api/tests/training-v2-stage4-domain.test.cjs:

- одинаковый contentHash, разные title/revision IDs;
- различный contentHash;
- обратный порядок входных источников;
- архивирование canonical duplicate и свежая привязка references.

Запусти:

- pnpm build:api
- node --test apps/api/tests/training-v2-stage4-domain.test.cjs
- git diff --check

Provider, PostgreSQL, HTTP, web и E2E на этом шаге не нужны, если scope остался чисто доменным.

## Stop conditions

Остановись и спроси пользователя, если:

- для нужного flow нет надёжного contentHash;
- для сохранения provenance требуется Prisma migration;
- дубликаты имеют различающиеся access или retention semantics;
- изменение sourceHash конфликтует с уже существующим незакоммиченным knowledge patch.

## Финальный отчёт

Сообщи:

- что считалось дубликатом до и после;
- какие файлы изменены;
- какие инварианты и tests добавлены;
- ожидаемое сокращение raw/unique chars на тестовой fixture без платного вызова;
- что нужно проверить вручную;
- остаточные риски.

После отчёта остановись. Не переходи к шагу 3.
