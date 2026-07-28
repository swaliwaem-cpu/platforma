# Training stage 9: manual UI checklist

Дата: 2026-07-28.

Использовать только локальные/staging fake fixtures без реальных голосов,
реального Telegram delivery и billable OpenAI calls.

## Подготовка

- [ ] Feature flag включён, API/web собраны из одного commit.
- [ ] Есть employee, training_admin и admin test users с актуальным RBAC seed.
- [ ] Fake fixture содержит: нет попыток, pass, fail, pending review,
  technical refund, несколько попыток с лучшей не последней, unsupported
  claim, transcript/evidence, processing error.
- [ ] Проверка выполняется на 375 px, tablet и desktop.

## Employee `/training`

- [ ] Telegram disconnected/connected/loading/error состояния понятны.
- [ ] Connect/start создают одноразовую ссылку только по явному клику.
- [ ] Unlink обновляет state и не показывает Telegram/platform account IDs.
- [ ] Карточки показывают best/last, attempts left, time limit и backend
  eligibility/retryAt.
- [ ] Проект с active attempt/limit/cooldown/passed/deadline блокирует start.
- [ ] История фильтруется по проекту; loading/empty/error не ломают layout.
- [ ] Pending review не показывает provisional score/summary/breakdown.
- [ ] Own detail показывает только разрешённые criteria.
- [ ] В Network/DOM employee response нет transcript, errors, audio URL,
  ranking, provider/storage/Telegram metadata.
- [ ] Чужой UUID возвращает `404`, anonymous — `401`, missing permission —
  `403`.

## Admin results

- [ ] Filters user/project/date/score/status/review/pass и sort применяются на
  сервере; pagination сохраняет bounded page size.
- [ ] List остаётся быстрым и не загружает transcript/audio bytes.
- [ ] Detail показывает timeline, 4 questions, segments metadata, protected
  audio, active transcript, acoustic/evidence/components, scores, provider
  versions/usage/latency/errors, review/job history.
- [ ] Audio загружается только по клику, refreshes JWT через общий API client,
  предыдущий/закрытый object URL revoke; публичного URL нет.
- [ ] Без `training:audio:read` player отсутствует и endpoint даёт `403`.

## Review

- [ ] Comment обязателен; `OVERRIDDEN` требует score.
- [ ] Для каждого unsupported claim выбрано `ACCEPTED` либо `INCORRECT`.
- [ ] Во время POST повторная отправка disabled.
- [ ] Network failure retry использует тот же `Idempotency-Key`.
- [ ] Same key/same payload не создаёт duplicate review/audit/penalty.
- [ ] `409` показан понятным сообщением без автоматической новой отправки.
- [ ] После успеха detail и ranking повторно загружены.
- [ ] Reprocessing доступен только reviewer и создаёт новую immutable version.

## Ranking и CSV

- [ ] Лучшая подтверждённая попытка используется даже если она не последняя.
- [ ] Pending review, technical failure и refunded attempt исключены.
- [ ] Failed completed project участвует в completed/average, неоткрытый — нет.
- [ ] Tie-break совпадает с documented server formula.
- [ ] При <2 projects narrative сообщает о недостаточности данных.
- [ ] Expanded row показывает per-project criteria/errors/unsupported claims.
- [ ] CSV открывается с русским Unicode, quotes/newlines корректны.
- [ ] Значения `=`, `+`, `-`, `@`, tab/CR/LF не выполняются как формулы.
- [ ] CSV не содержит transcript/audio/storage/provider/Telegram/secrets.

## Responsive/accessibility

- [ ] Keyboard focus виден; controls имеют label/aria state.
- [ ] Touch targets удобны, горизонтальная admin table прокручивается.
- [ ] На 375 px карточки/filters/detail не выходят за viewport.
- [ ] `prefers-reduced-motion` отключает spinner animation.
- [ ] Light и dark theme используют существующие CSS variables.

## Вне этапа

- Production migration/deploy, pilot data, real Telegram delivery, real OpenAI
  smoke и этап 10 не выполняются в рамках этого checklist.
