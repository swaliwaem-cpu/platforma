# Prompt для Codex

Выполни ТОЛЬКО этап 2: Prisma schema, безопасная миграция и базовые repository/domain types модуля обучения. Не делай полноценные API, UI, Telegram или OpenAI.

Прочитай:
- audit/architecture/checklist;
- `spec/00_rules_business.md` полностью по бизнес-правилам;
- `spec/01_architecture_data_domain.md` — целевая архитектура, Prisma-модель, permissions и state machine;
- `spec/04_stages_tests_acceptance.md` — «Этап 2» и связанные тесты.

Требования:
1. Используй существующий `User`; отдельный employee не создавай.
2. `TrainingProject.realEstateObjectId` nullable.
3. Published version immutable; попытка pinned к версии.
4. Поддержи 1 main + 10 follow-up, voice segments, reviews, processed Telegram updates и PostgreSQL-backed jobs.
5. Учти бессрочное хранение аудио как текущую бизнес-политику, но не делай storage публичным.
6. Ограничения/индексы/unique constraints должны обеспечивать идемпотентность и целостность.
7. Миграция должна быть additive и безопасной для существующих production-данных.
8. Добавь schema/contract tests в текущем стиле.

Не seed'и реальные проекты и вопросы. Не вызывай внешние API.

Сгенерируй Prisma client, выполни build/tests, обнови checklist и ОСТАНОВИСЬ.
