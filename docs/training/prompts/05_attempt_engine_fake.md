# Prompt для Codex

Выполни ТОЛЬКО этап 5: domain engine попытки с fake providers, без реального Telegram/OpenAI/storage audio pipeline.

Прочитай:
- business rules целиком в `spec/00_rules_business.md`;
- state machine/domain logic в `spec/01_architecture_data_domain.md`;
- API/worker expectations в `spec/03_api_frontend_jobs_env.md`;
- «Этап 5» и обязательные tests в `spec/04_stages_tests_acceptance.md`.

Реализуй:
1. Транзакционный старт попытки с немедленным списанием.
2. Настраиваемый лимит попыток, cooldown, окно доступности, pass score и возможность пересдачи после успешного прохождения.
3. Полностью случайный выбор 3 разных follow-up из 10 при старте; никаких AI gap scores.
4. State machine 1 main + 3 follow-up.
5. Несколько voice segments на answer как абстрактные fake inputs; кнопка finish моделируется domain command.
6. Общий таймер, warnings, grace period, skipped timeout = 0.
7. Fake transcription/evaluation providers.
8. Backend scoring 55+15+15+15, penalties −5, unsupported claim => REQUIRES_REVIEW.
9. Idempotent finalization и best reviewed result.

Добавь исчерпывающие unit/integration tests, включая concurrency и четвёртую попытку. Никаких внешних вызовов. Обнови checklist и ОСТАНОВИСЬ.
