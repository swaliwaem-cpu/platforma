# Prompt для Codex

Выполни ТОЛЬКО этап 6: Telegram account linking, start links, webhook shell и диалог экзамена поверх готового fake attempt engine. Реальное скачивание/обработка аудио пока не делай.

Прочитай:
- `spec/00_rules_business.md`: сценарий, попытки, что показывать сотруднику;
- `spec/02_telegram_audio_ai_documents.md`: Telegram integration;
- `spec/03_api_frontend_jobs_env.md`: Employee/Integration API и env;
- `spec/04_stages_tests_acceptance.md`: «Этап 6».

Реализуй server-side fetch provider abstraction для Telegram без SDK, если architecture decision не доказывает обратное.

Обязательно:
- одноразовый opaque deep-link token, в БД только hash;
- private chats only;
- один активный Telegram account на platform user и наоборот;
- webhook secret verification;
- idempotency по update_id/message IDs;
- принимать как ответ только `message.voice`;
- text/audio/document/video note отклонять;
- несколько voice-частей + inline-кнопка «Завершить ответ»;
- подтверждение старта до списания попытки;
- команды/кнопки из спецификации;
- после ответа только «Ответ принят»;
- fake pipeline для локальных/integration tests.

Webhook должен быстро ACK и не выполнять тяжёлую работу. Добавь contract/integration tests, обнови checklist и ОСТАНОВИСЬ.
