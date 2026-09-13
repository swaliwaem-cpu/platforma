# SESSION NOTES

Общий журнал между чатами. После каждой законченной задачи агент
дописывает сюда краткое саммари: что сделано и что важно помнить.
Без полного расписывания — 2–4 строки на задачу.

Новые записи — вверху (обратный хронологический порядок).
Кратко и по фактам, без воды. Хронология и отчёты — не требования,
это рабочая память между сессиями.

---

## 2026-09-13

### Миграция ассистента OpenAI → Alibaba DashScope (выполнено, локально, без коммита)

- Planner Luna/Terra → qwen-plus/qwen-max, embeddings → text-embedding-v4, весь транспорт — DashScope compatible-mode `/chat/completions` вместо Responses API. Env: `ALIBABA_API_KEY`, `ASSISTANT_ALIBABA_BASE_URL/TIMEOUT_MS/STRUCTURED_OUTPUT`, режим `ASSISTANT_AI_MODE=alibaba`; `OPENAI_API_KEY` остался только для Training. Цены в каталоге по официальному прайсу: qwen-plus $0.40/$1.20 (long >256K: $1.20/$3.60), qwen-max $1.60/$6.40, embedding $0.07 за 1M.
- Source discovery переведён на Chat Completions без web_search; live discovery заблокирован гейтом `ASSISTANT_SOURCE_DISCOVERY_WEB_SEARCH_UNVERIFIED`, обход — флаг `ASSISTANT_SOURCE_DISCOVERY_WEB_SEARCH_ACKNOWLEDGED=true` (только для stub-тестов и верификации). Промпты discovery всё ещё требуют веб-поиск — осознанно, до задачи по enable_search.
- Важно: usage-контракт нового транспорта — `cacheWriteInputTokens` и `webSearchCalls` всегда 0; eval/rollout/preflight ждут `providerMode`/`provider: 'alibaba'`. Production compose не получил `ASSISTANT_AI_MODE` (дефолт `:-fake` запрещён compose-контрактом) — включение ассистента на проде потребует явного добавления переменной.
- Проверки: `pnpm test` 960/960, `pnpm build`, assistant postgres-harnesses зелёные, t07 connected e2e зелёный (одно flaky-падение login при холодном web-контейнере, при повторе прошло). t06-postgres падает на свежей БД из-за отсутствия цепочки rollout events — pre-existing, подтверждено прогоном на до-миграционном коде. Не запускалось: t03-browser-runtime (нет привязки к LLM-транспорту), платные live smoke — ждут живого ключа Alibaba.

### Анализ замены OpenAI на Kimi/Moonshot (исследование, без изменений кода)

- OpenAI-ключ недействителен; оценили миграцию. SDK openai нет — везде raw fetch, но все 4 LLM-точки говорят на Responses API; у Kimi только Chat Completions (есть strict json_schema, tool calling, prompt caching). Нет у Moonshot: embeddings, Whisper, нативный web_search с allowed_domains.
- Минимум для planner: ~6 файлов, ~200–300 строк (gateway body/parser, имена моделей, pricing, гейт base URL). Полная миграция всех 6 точек: ~13 файлов, ~1.5–2k строк переписки.

### Сравнение китайских LLM-провайдеров для замены Luna/Terra (исследование)

- Кандидаты с OpenAI-совместимым Chat Completions: DeepSeek (V4-Flash $0.14/$0.28, V4-Pro ~$0.44/$0.87+ за 1M токенов), Qwen (3.7-Plus $0.40/$1.60, 3.7-Max $2.50/$7.50), GLM/Z.ai (4.7 $0.60/$2.20, 5.3 $1.40/$4.40), MiniMax (M2.7 $0.30/$1.20), Kimi (k2.6 $0.95/$4, k3 $3/$15).
- Strict json_schema из коробки подтверждён только у Kimi K3; DeepSeek — json_object-режим (нужна локальная валидация, у нас она есть). Рекомендация: Luna=DeepSeek V4-Flash, Terra=DeepSeek V4-Pro или Kimi k2.6. Embeddings/Whisper отдельно у всех китайцев.

## 2026-09-08

### Реконструкция статуса AI-ассистента (исследование, без изменений кода)

- Точка остановки: FIX-GEO2 реализован в коде полностью (коммиты 7f58604→e78a3c6, 06–07.09), все сценарии покрыты тестами; не закрыты две процедурные задачи — реальная загрузка справочника метро с полным покрытием опубликованных объектов (`assistant:metro:refresh --file`) и ручная UI-сверка времени с картой.
- До RC: все live-gates zaebal6 не пройдены (200-case eval, source/geo canary, adversarial UI, feed gate, rollout preflight) — каждый ждёт отдельной авторизации с платными вызовами. Rollout stage = ADMINS. Чекбоксы в zaebal1–6 не отмечены, хотя код этапов 1–6 на месте.
- Риск: FIX-GEO2 изменил planner-контракт после создания eval runner — перед RC-прогоном проверить, что frozen dataset и gates не инвалидированы.

### Создание журнала

- Заведён этот файл как shared-память между чатами внутри проекта.
- Источник требований всё равно остаётся: текущая задача → AGENTS.md → код.
- Правило: после завершения задачи агент дописывает сюда итоги.

---

## Шаблон записи

```markdown
### <YYYY-MM-DD> — <короткое название задачи>

<2–4 строки: что сделано, какие файлы тронуты, что важно помнить.>
```
