# Prompt для Codex

Выполни ТОЛЬКО этапы 9–10: employee results UI, admin results/review UI и рейтинг. Интеграционный backend уже должен существовать.

Прочитай:
- `spec/00_rules_business.md`: видимость результата, review и рейтинг;
- `spec/03_api_frontend_jobs_env.md`: Employee/Admin API и frontend;
- `spec/04_stages_tests_acceptance.md`: «Этапы 9–10».

Employee `/training`:
- общий список доступных проектов одинаковый для всех eligible users;
- порядок/глобальная доступность от admin;
- Telegram connection;
- best reviewed score, attempts used/left, pass/fail;
- в Telegram только общий балл/status/остаток попыток;
- в платформе собственный общий балл и разрешённая разбивка критериев;
- никаких transcript, конкретных ошибок и общего рейтинга.

Admin:
- projects/result filters;
- detail timeline, 4 questions, segments/audio, transcript, breakdown, errors, unsupported claims, AI summary;
- review/override с обязательной причиной;
- рейтинг по каждому пользователю без отделов;
- best reviewed result является основным;
- колонки из бизнес-спецификации;
- CSV только если уже предусмотрено утверждённым API, без audio URLs/storage keys.

Соблюдай permissions и current UI patterns. Добавь ownership/IDOR и frontend tests, build/tests/checklist и ОСТАНОВИСЬ.
