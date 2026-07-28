# Training OpenAI synthetic smoke runbook

Дата актуализации: 2026-07-28. Реальный smoke не запускался: API-баланс ещё
не пополнен. Без успешного smoke pilot и production запрещены.

1. Создать отдельный OpenAI Project для staging и настроить billing/limits.
2. Создать project-scoped service account/key и сохранить key только в
   secret store.
3. Проверить project data controls и документировать фактическую retention.
   Не заявлять Zero Data Retention без подтверждения.
4. Проверить доступ к моделям:
   `gpt-4o-mini-transcribe-2025-12-15`, `gpt-4o-transcribe`,
   `gpt-5.6-terra` с `medium`, review с `high`.
5. Использовать только короткий synthetic WAV без человеческого голоса.
6. В изолированной shell-сессии задать real provider/key и
   `OPENAI_SMOKE_ENABLED=true`.
7. Выполнить ровно:

```bash
pnpm --filter @platforma/api test:training:openai:smoke
```

Smoke отключает retries и делает один transcription и один Responses
evaluation request. Нельзя печатать key, prompt, transcript или output.
Допустимый отчёт: success/failure, model, safe request ID, usage, latency.

8. Сразу вернуть `OPENAI_SMOKE_ENABLED=false`, удалить key из shell history и
   проверить, что обычные tests принудительно используют fake providers.
9. При 429/billing/model/data-control ошибке — `NO-GO`; не повторять
   автоматически и не переходить к pilot.
