# Telegram, аудио, OpenAI и обработка документов

> Источник: финальный мастер-план от 25.07.2026. Этот файл является частью разбитой спецификации.

# 7. Telegram-интеграция

## 7.1. Привязка

Platforma создаёт одноразовый deep link:

```text
https://t.me/<bot_username>?start=<opaque_token>
```

Требования:

- private chat only;
- token до 64 base64url characters;
- cryptographically random;
- short TTL;
- hash in DB;
- атомарное одноразовое использование;
- один активный Telegram account на Platforma user и наоборот;
- конфликт не перепривязывать молча.

## 7.2. Webhook

Route без внутреннего глобального `/api` prefix:

```text
POST /training/telegram/webhook
```

Проверять Telegram secret header. Быстро ACK; тяжёлая работа только через jobs/worker.

Поддержать:

- `/start`;
- список открытых проектов;
- мои результаты;
- правила;
- callback `Начать`;
- callback `Завершить ответ`;
- callback открытия Platforma.

`/cancel` во время активной попытки не отменяет её. Ответить, что попытку нельзя остановить и таймер продолжает идти.

## 7.3. Сообщения

До старта:

> После подтверждения попытка будет списана. На весь экзамен отведено N минут. Экзамен нельзя поставить на паузу или продолжить позже.

После части:

> Часть N принята. Отправьте ещё голосовую часть или завершите ответ.

После вопроса:

> Ответ принят.

Финал:

> Результат: 82/100. Аттестация пройдена. Осталось попыток: 2.

При review:

> Результат отправлен на проверку.

Предварительный балл и status passed/failed в Telegram до решения
администратора не показываются. Если переход в Platforma разрешён, сообщение
содержит только кнопку открытия платформы.

---

# 8. Аудио, ffmpeg и акустические метрики

Telegram voice обычно приходит как Opus-контейнер, а актуальный OpenAI upload endpoint не принимает OGG напрямую. Поэтому worker обязан нормализовать файл.

## 8.1. Pipeline

1. Получить file metadata через Telegram `getFile`.
2. Проверить ограничение cloud Bot API download, размер и duration.
3. Скачать original segment.
4. Сохранить original segment в private bucket бессрочно.
5. Через `ffprobe` проверить codec/duration/channels/sample rate.
6. Для каждой части создать временный WAV PCM 16 kHz mono.
7. Объединить части одного ответа в один WAV.
8. Выполнить `ffmpeg silencedetect` для пауз.
9. Отправить combined WAV на transcription provider.
10. Удалить временные нормализованные файлы после успешной обработки.

Добавить `ffmpeg` в API/worker Docker image. Запускать только через безопасный `spawn` с массивом аргументов, никогда не строить shell-команду из пользовательского имени файла.

## 8.2. Метрики

Детерминированно считать:

- суммарную длительность voice;
- длительность речи без длинных пауз;
- words per minute;
- количество и суммарную длительность пауз;
- максимальную паузу;
- filler words из настраиваемого русского словаря;
- прямые повторы слов и n-gram repetitions;
- долю повторов;
- количество незавершённых фраз/дисфлюенций по консервативной эвристике.

Не делать медицинские/психологические выводы и не оценивать «уверенность» по тембру.

---

# 9. OpenAI providers

## 9.1. Транскрибация

Provider interface не зависит от конкретного SDK.

Рекомендуемый default на дату плана:

```text
OPENAI_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe
```

Fallback/reprocessing:

```text
OPENAI_TRANSCRIPTION_REVIEW_MODEL=gpt-4o-transcribe
```

Передавать language `ru` и короткий approved vocabulary prompt с названием ЖК, застройщиком и профессиональными терминами. Не передавать эталонный полный ответ, чтобы не исказить transcript.

Сохранять:

- actual model ID;
- request ID;
- latency;
- usage;
- transcript;
- provider error classification.

## 9.2. Оценивание

Рекомендуемый cost-efficient default на дату плана:

```text
OPENAI_EVALUATION_MODEL=gpt-5.6-luna
OPENAI_EVALUATION_REASONING=low
```

Для повторной проверки спорных случаев:

```text
OPENAI_REVIEW_MODEL=gpt-5.6-terra
OPENAI_REVIEW_REASONING=medium
```

Модели задаются env и должны быть заменяемыми без миграции кода. После калибровки закрепить конкретный snapshot/model ID в каждой evaluation record.

Использовать Responses API и strict Structured Outputs. Для запроса оценки использовать `store: false` там, где это поддерживается.

LLM получает только:

- текст вопроса;
- transcript;
- approved facts и aliases;
- criteria и anchors;
- акустические/текстовые метрики;
- правила штрафов;
- IDs сущностей.

LLM не получает web search и не должна использовать внешние знания.

## 9.3. Structured output

Логическая схема:

```json
{
  "schema_version": "1",
  "answer_relevance": "relevant|partial|irrelevant",
  "fact_assessments": [
    {
      "fact_id": "uuid",
      "verdict": "correct|partial|missing|incorrect|unsupported",
      "evidence": "короткий фрагмент transcript",
      "explanation": "кратко",
      "confidence": 0.0
    }
  ],
  "unsupported_claims": [
    {
      "claim": "пересказ утверждения",
      "evidence": "фрагмент transcript",
      "confidence": 0.0
    }
  ],
  "criterion_assessments": [
    {
      "criterion_id": "uuid",
      "suggested_points": 0,
      "evidence": "фрагмент или метрики",
      "explanation": "кратко"
    }
  ],
  "summary": "1–3 предложения",
  "requires_manual_review": false,
  "review_reasons": []
}
```

Backend обязан:

- валидировать JSON Schema;
- отвергать неизвестные IDs;
- проверять, что evidence существует в transcript или опирается на переданные метрики;
- считать points сам;
- применять `−5` за distinct incorrect fact;
- не штрафовать unsupported до review;
- clamp score;
- сохранять AI output и server calculation отдельно.

Никаких chain-of-thought в БД или UI.

---

# 10. Document ingestion

Расширить server-side training upload, не превращая общий пользовательский upload в приём произвольных файлов.

Поддерживаемые MIME/ext:

- PDF;
- DOCX;
- PPTX;
- XLSX.

Сделать adapter interface:

```text
TrainingDocumentExtractor
- supports(mimeType, extension)
- extract(buffer) -> text + structured locators + metadata
```

Adapters:

- PDF text extractor;
- DOCX paragraphs/tables;
- PPTX slide text;
- XLSX sheet/cell text.

Безопасность:

- allow-list MIME и extension;
- maximum file bytes;
- maximum uncompressed bytes;
- maximum entries for ZIP-based formats;
- extraction timeout;
- maximum extracted characters;
- filename sanitization;
- no macros execution;
- no formulas evaluation from XLSX;
- no external links fetching.

После extraction admin создаёт/подтверждает structured facts. Публикация невозможна, если обязательные facts не подтверждены.

---

# 11. API
