# Prompt для Codex

Выполни ТОЛЬКО этап 8: реальные OpenAI provider abstractions для transcription и evaluation, structured output, deterministic scoring и review flow. Не расширяй UI результатов сверх необходимого API.

Прочитай:
- scoring/review rules в `spec/00_rules_business.md`;
- domain/data models в `spec/01_architecture_data_domain.md`;
- OpenAI sections в `spec/02_telegram_audio_ai_documents.md`;
- env/API в `spec/03_api_frontend_jobs_env.md`;
- «Этап 8» и provider tests в `spec/04_stages_tests_acceptance.md`.

Требования:
- server-side fetch/provider abstraction; model IDs только env;
- Audio Transcriptions API для подготовленного файла;
- Responses API + strict Structured Outputs для оценки;
- `store: false`, где применимо;
- transcript считается недоверенными данными;
- модель не придумывает facts/questions и не считает финальный score;
- backend валидирует IDs/schema/evidence и детерминированно считает балл;
- −5 за отдельное подтверждённое несоответствие, duplicate error один раз;
- unsupported claim не штрафуется автоматически и переводит в REQUIRES_REVIEW;
- admin/training_admin review/override с причиной и audit log;
- сохранять model/prompt/schema version, usage, latency, request id;
- retries для 429/5xx/timeouts и manual fallback.

Обычные tests используют fixtures/fakes, не реальные API. Добавь opt-in provider smoke command, но не запускай без ключей/явного разрешения. Build/tests/checklist и ОСТАНОВИСЬ.
