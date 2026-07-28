# Stage 10 manual QA

Автоматизация не заменяет следующие staging-проверки:

- Employee desktop/mobile 375 px: policy modal keyboard/focus/scroll, точный
  текст/version/date, disabled navigation, Telegram disconnected/connected,
  used/left, completed/review/manual-adjusted visibility.
- Training admin: list/filters/detail, protected audio playback, transcript,
  errors/unsupported, review partial failure/retry, ranking и CSV в целевых
  spreadsheet clients.
- Operations: read/manage RBAC, queue/age/heartbeat/stuck/review/privacy,
  DEAD/FAILED retry с reason и AuditLog, отсутствие payload/secrets.
- Themes/reduced motion, focus order, dialog Escape/close, narrow tables.
- Реальные staging Telegram/webhook/audio/OpenAI выполняются только после
  соответствующих go/no-go gates и не выполнялись в этапе 10.
