# Prompt для Codex

Выполни ТОЛЬКО backend этап управления учебным контентом: проекты, draft/published versions, вопросы, факты, критерии, настройки попыток и публикация. Frontend-редактор документов пока не делай.

Прочитай:
- audit/architecture/checklist;
- `spec/00_rules_business.md`: проекты, сценарий, scoring, review, материалы;
- `spec/01_architecture_data_domain.md`: модели и domain logic;
- `spec/03_api_frontend_jobs_env.md`: Admin API;
- `spec/04_stages_tests_acceptance.md`: «Этап 3».

Реализуй NestJS controllers/services для админских CRUD и publication workflow с существующими guards/permissions.

Публикация обязана валидировать:
- ровно 1 активный main и 10 активных follow-up;
- сумму весов main = 55;
- сумму весов каждого follow-up = 15;
- pass score, attempt limit, timer 5–7 минут, cooldown/availability settings;
- отсутствие duplicate positions/codes;
- наличие фактов/критериев;
- immutable published version.

Удалять разрешено только неиспользованный draft; остальное архивируется/версионируется. Все привилегированные действия журналируй через существующий AuditLog.

Добавь unit/integration tests, build/tests, обнови checklist и ОСТАНОВИСЬ.
