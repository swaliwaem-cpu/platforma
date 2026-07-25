# Prompt для Codex

Выполни ТОЛЬКО этап 4: админский UI учебного контента и pipeline загрузки/извлечения материалов PDF/DOCX/PPTX/XLSX. Не начинай Telegram, audio transcription или AI scoring.

Прочитай:
- audit/architecture/checklist;
- `spec/00_rules_business.md`: материалы и UI-ожидания;
- `spec/02_telegram_audio_ai_documents.md`: только раздел Document ingestion;
- `spec/03_api_frontend_jobs_env.md`: Admin API и frontend;
- `spec/04_stages_tests_acceptance.md`: «Этапы 3–4» в части UI/документов.

Сначала обоснуй минимальный набор зависимостей для чтения DOCX/PPTX/XLSX. Не добавляй тяжёлые библиотеки, если достаточно поддерживаемых узких пакетов. PDF переиспользуй через существующий file flow, расширяя MIME безопасно.

Реализуй:
- страницы списка/создания/редактирования training projects;
- вкладки Основное, Материалы, Главный вопрос, Дополнительные вопросы, Факты, Критерии, Проверка/публикация;
- опциональную связь с RealEstateObject;
- upload и extraction status;
- extracted text как черновик, но только подтверждённые админом структурированные факты участвуют в оценке;
- ошибки публикации, draft/version UX;
- текущую дизайн-систему и apiRequest.

Добавь тесты, build/tests, обнови checklist и ОСТАНОВИСЬ.
