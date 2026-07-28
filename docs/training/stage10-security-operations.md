# Stage 10 security and operations contract

## Permissions

| Permission | admin | training_admin | employee |
| --- | --- | --- | --- |
| `training:operations:read` | yes | yes | no |
| `training:operations:manage` | yes | yes | no |
| current policy read/own acceptance | authenticated training user | authenticated training user | yes |

Остальные project/results/review/audio permissions этапов 1–9 не изменены.
Backend guards, ownership selects и masked `404` являются источником
авторизации; frontend checks только скрывают UI.

## New endpoints/routes

- `GET /training/policy`;
- `POST /training/policy/accept`;
- `GET /training/admin/operations/summary` (legacy-equivalent base GET также
  поддержан);
- `POST /training/admin/operations/jobs/:jobId/retry` с обязательным
  `Idempotency-Key`;
- `/admin/training/operations`.

## Server-side limits

- Link token TTL `15 min`, cooldown `30 sec`, максимум `10/hour`, один active.
- Webhook body `98304 bytes`, hard maximum config `102400`, только known
  message/callback fields и idempotent update IDs.
- Retry reason `3..500`; operations retry и review сохраняют обязательный
  `Idempotency-Key`, canonical payload hash и replay result. Повтор того же
  payload идемпотентен, конфликтующий payload отклоняется.
- Audio: 20 MiB segment, 80 MiB answer, 32 segments, 600 sec, ffmpeg 90 sec.
- OpenAI: upload <25 MiB, bounded retries/deadline/response/output tokens.
- Ranking pagination/filters bounded, CSV обходит тот же core батчами 100.

Operations summary остаётся агрегированной: queue/heartbeat/policy/status,
ages, counts и safe error codes без user/job/object identifiers, payload,
transcript, audio, bucket/object keys и credential state.

Новые зависимости, monitoring framework, router и rate-limit subsystem не
добавлялись.
