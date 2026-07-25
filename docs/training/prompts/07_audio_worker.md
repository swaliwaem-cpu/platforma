# Prompt для Codex

Выполни ТОЛЬКО этап 7: private audio storage, voice segments, ffmpeg pipeline и отдельный PostgreSQL-backed worker. OpenAI пока остаётся fake provider.

Прочитай:
- `spec/00_rules_business.md`: voice, timer, storage;
- `spec/01_architecture_data_domain.md`: TrainingJob и state machine;
- `spec/02_telegram_audio_ai_documents.md`: audio/ffmpeg metrics;
- `spec/03_api_frontend_jobs_env.md`: durable jobs, worker, env;
- `spec/04_stages_tests_acceptance.md`: «Этап 7».

Реализуй:
1. Отдельный private training audio bucket или явно безопасную multi-bucket поддержку S3 service.
2. Server-side download Telegram voice, MIME/size validation.
3. Сохранение каждого сегмента.
4. Безопасный ffmpeg concat/convert без shell injection, с timeout/resource limits и cleanup временных файлов.
5. Извлечение объективных метрик, предусмотренных спецификацией.
6. PostgreSQL TrainingJob claim/heartbeat/retry/stale recovery/idempotency.
7. `training-worker.main.ts`, отдельную команду package.json и worker service в Compose.
8. Защищённый audio streaming endpoint с `training:audio:read`; никаких публичных бессрочных URL.
9. Fake transcription job после подготовки файла.

Добавь fixtures и tests на restart/retry/duplicate/cleanup. Обнови Docker/env docs, build/tests, checklist и ОСТАНОВИСЬ.
