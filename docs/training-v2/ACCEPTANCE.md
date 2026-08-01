# Acceptance: Stage 2

## Критерии готовности к ручной приёмке

- `/training` показывает Telegram account state и основной project CTA
  «Пройти в Telegram» без нового route.
- Deep link привязана к текущим User/project, хранится только как SHA-256 hash,
  действует 15 минут и не расходует попытку до callback подтверждения.
- `/start <token>` атомарно связывает только private Telegram account, явно
  отклоняет конфликты и не использует token повторно.
- `/start` восстанавливает active attempt/current question/processing/timeout из
  Training domain tables без отдельной conversation state.
- Бот принимает только `message.voice`, сохраняет ordered multi-segments и
  начинает background processing только после «Завершить ответ».
- Worker безопасно claim-ит persisted answer, восстанавливает stale processing
  после restart и не допускает double processing.
- Telegram originals и merged WAV хранятся private с `File.url=null`; `ffmpeg`
  создаёт PCM mono 16 kHz WAV и всегда очищает temp directory.
- Fake transcription возвращает `[fake:pass]`; existing fake evaluator и единый
  answer-completion flow проводят MAIN + 3 FOLLOW_UP и сохраняют итог/history.
- Final processing failure не создаёт transcript/score/pass/fail.
- Нет OpenAI и инфраструктуры Stage 3–5.

## Local fake smoke

Сценарий не делает реальных Telegram/OpenAI вызовов.

1. Создать отдельную временную PostgreSQL database и применить только
   `prisma migrate deploy`.
2. Собрать API: `pnpm --dir apps/api build`.
3. Запустить vertical test с `NODE_ENV=test`,
   `TELEGRAM_TRANSPORT_MODE=fake` и `TRAINING_TEST_DATABASE_URL`, указывающим на
   временную database:
   `node --test apps/api/tests/training-v2-stage2-postgres.test.cjs`.
4. Убедиться, что scenario
   `vertical fake Telegram flow completes deep link, voice 1+3 and final result once`
   зелёный: он выполняет deep link, account link, start, два voice segments на
   каждый ответ, finish, processing, fake transcript/evaluation, 1+3 и result.
5. Запустить provider/unit/HTTP tests и headless browser smoke из Stage 2 test
   suite. Browser smoke использует production web build и intercepted local API;
   dev text fallback в нём отсутствует.
6. Удалить временную database. Local MinIO и внешняя сеть для этого smoke не
   требуются; audio storage/provider заменены локальными fake doubles, а
   реальный `ffmpeg` отдельно проверяется внутри API Docker image.

## Real Telegram smoke — только вручную

Не выполнять автоматически и не использовать production webhook.

Подготовка:

- создать test bot через BotFather;
- сохранить bot token и webhook secret только в untracked `.env`;
- задать `TELEGRAM_TRANSPORT_MODE=real`, `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`, отдельный
  `TRAINING_AUDIO_BUCKET`;
- поднять public HTTPS tunnel либо использовать доступный test URL;
- вручную временно направить Telegram webhook на
  `POST /training/telegram/webhook` с secret header;
- после smoke удалить test webhook.

Проверка:

1. Admin создаёт, публикует и открывает Training project.
2. Employee открывает `/training` и нажимает «Пройти в Telegram».
3. Employee открывает deep link; bot связывает account и показывает выбранный
   project без списания попытки.
4. Employee нажимает «Начать аттестацию» и получает MAIN.
5. Employee отправляет два voice messages и нажимает «Завершить ответ».
6. Bot показывает processing, затем следующий вопрос.
7. Employee проходит MAIN + 3 FOLLOW_UP и видит fake pass/fail result.
8. Во время active attempt повторный `/start` восстанавливает текущий вопрос;
   во время processing — сообщение «Ответ обрабатывается».
9. Text, photo, `message.audio`, document и остальные message kinds не создают
   answer/segment и получают просьбу отправить голосовое сообщение.
10. Повторные start/finish callbacks и одинаковый voice update не создают
    вторую attempt, question progression или segment.
11. Stage 1 web history показывает Telegram attempt; generic file endpoints не
    отдают private training audio.
12. Проверить private bucket: originals сохраняются в segment order, merged WAV
    имеет PCM mono 16 kHz, а все training `File.url` равны `null`.

## Автоматические проверки перед отчётом

- Unit/schema: hashing, callback/private parsing, fake client/transcriber,
  segment order, `ffmpeg` args/timeout, Prisma shape и migration constraints.
- PostgreSQL: token/account races, deduplication, finish idempotency, timeout,
  private File records, worker claim/restart/failure и полный 1+3 vertical flow.
- HTTP: account/link ownership/availability, webhook secret/body/private chat,
  rejected message kinds, voice metadata и unknown update ACK.
- Provider local stub: all four native client operations, timeout, 429/5xx retry,
  permanent 4xx и отсутствие token в errors.
- Web/headless Chromium: Telegram status/primary CTA, project-bound link,
  production hiding dev fallback и safe expired-link state.
- Migration: clean temporary PostgreSQL и Stage 1 → Stage 2 upgrade с сохранением
  fixture.
- Docker: API image build, `ffmpeg -version` и synthetic OGG → WAV PCM mono
  16 kHz smoke.
- Full API/web/workspace tests, builds, `prisma validate`, `git diff --check`,
  `.only`/`.skip` и scope scan.

Фактические команды и counts фиксируются в итоговом отчёте. Ручной real Telegram
smoke остаётся внешним gate до пользовательской приёмки.

## Definition of Done и переход к Stage 3

Stage 2 остаётся текущим даже после готовности кода и зелёных automated checks.
Только ручное подтверждение пользователя закрывает этап. OpenAI, facts,
criteria, review и любой другой Stage 3 scope не начинаются без отдельной задачи.
