# Current Stage: Stage 2 — Telegram и Voice Transport

## Цель

Доказать полный transport-flow: Employee выбирает проект на `/training`, получает
одноразовую Telegram deep link, связывает существующего пользователя,
подтверждает старт, отвечает голосом на 1 MAIN + 3 FOLLOW_UP, а backend реально
скачивает и нормализует audio, после чего fake transcription и существующий fake
evaluator формируют результат.

Код и автоматические проверки могут быть готовы, но текущим этапом остаётся
Stage 2 до ручного подтверждения пользователя. Stage 3 не начинается
автоматически.

## Входит

- Project-bound deep link с SHA-256 hash, TTL 15 минут и atomic consume.
- Связь Telegram account с существующим активным `User`, явные конфликты и
  private-chat boundary.
- `/start <token>`, подтверждение старта и `/start` resume из domain state.
- Только `message.voice`, несколько ordered segments и отдельный finish callback.
- Persisted `TrainingAnswer` processing unit, PostgreSQL claim, heartbeat,
  bounded retry и stale-lock restart recovery внутри API process.
- Реальные Telegram `getFile`/download в real mode и fake client для tests.
- Private originals и merged WAV через существующие `File`/S3 abstractions,
  отдельный `TRAINING_AUDIO_BUCKET` и `File.url=null`.
- `ffmpeg`: WAV PCM mono 16 kHz, timeout и guaranteed temp cleanup.
- Узкий deterministic fake transcriber и существующий Stage 1 fake evaluator.
- Основной production CTA «Пройти в Telegram» на существующем `/training`;
  Stage 1 text UI только в `import.meta.env.DEV` и automated tests.
- Employee history и Admin attempt view из Stage 1 без audio player.

## Не входит

- OpenAI и любые реальные transcription/evaluation providers.
- Facts, criteria, semantic scoring, unsupported claims и penalty logic.
- Manual review/review UI, admin audio player, ranking и CSV.
- Documents, PDF/DOCX/PPTX/XLSX parsers, RAG, embeddings и materials workflow.
- Generic jobs, отдельный worker app/container, outbox, provider runs и update
  ledger.
- Telegram Mini App, project list внутри bot, unlink/admin/operations endpoints,
  webhook registration tooling и bot settings UI.
- Policy acceptance, monitoring stack, staging, production deploy и pilot.

## Реализуемая последовательность

1. Additive schema: три Stage 2 models и минимальные поля `TrainingAnswer`.
2. Telegram account/link/webhook boundary и fake/native client.
3. Voice segments, private audio, `ffmpeg`, fake transcription и persisted worker.
4. Dialog 1+3, Telegram-first `/training`, vertical fake flow и canonical docs.
5. Полные automated checks, Docker `ffmpeg` smoke и три read-only verifier.
6. Остановиться с отчётом и ждать ручной приёмки Stage 2.

## Ограничения scope

- Только `TrainingTelegramAccount`, `TrainingTelegramLinkToken` и
  `TrainingAnswerSegment`; отдельные job/audio/session/update models запрещены.
- Только три новых endpoints: account state, project-bound link и webhook.
- Одна additive Stage 2 migration; applied migrations не изменяются.
- Нового frontend route, dependency, lockfile change, worker container или SDK
  нет.
- Технический processing failure не получает обычный score; repeat-answer UX и
  voice grace period явно отложены.

## Ручная приёмка

Ожидаются два отдельных сценария из `ACCEPTANCE.md`: локальный fake smoke без
внешних providers и ручной real Telegram smoke через временный test webhook.
Production webhook не регистрируется.

## Stop conditions

- Появляется OpenAI или предметная инфраструктура Stage 3–5.
- Требуется четвёртая Stage 2 model, пятый endpoint или новый frontend route.
- Audio становится публичным либо key содержит PII.
- Webhook скачивает/объединяет audio внутри HTTP request.
- Concurrent workers могут обработать один answer дважды или restart теряет
  persisted `PROCESSING` answer.
- Voice progression дублирует Stage 1 scoring/finalization.
- PostgreSQL, HTTP, provider, audio, browser, Docker или workspace проверки
  остаются красными.
