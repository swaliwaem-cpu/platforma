# Acceptance: Stage 5 Part 1 — Results, Audio, Review

## Критерии готовности

- Employee project cards содержат attempts left, лучший и последний
  подтверждённый результат; pending review не раскрывает provisional score.
- Employee history использует snapshot title, показывает duration, safe
  breakdown и refund/message semantics; transcript/evaluation/provider/audio
  metadata отсутствуют в JSON.
- Technical failure не имеет final/pass и не расходует limit. Pending review не
  имеет employee final/pass. Timeout duration ограничен `expiresAt`.
- Admin results защищён `training:results:read`, имеет bounded server filters,
  pagination/total, stable sort и lightweight response.
- Admin detail отделяет immutable snapshot от current access/assignment,
  показывает review actor и admin-only evidence/request metadata.
- Audio endpoint защищён отдельным `training:audio:read`; отсутствие права даёт
  403, отсутствующий/невалидный object — одинаковый safe 404.
- Успешное audio-чтение проверяет private bucket, deterministic key, ownership,
  MIME, URL=null, size, checksum и WAV header, отвечает no-store и пишет один
  bounded audit. Employee API не содержит audio reference.
- UI Blob URL отменяется/revoke-ится; stale response не может заменить новый.
- Успешный review POST сохраняется в UI до refresh; ошибка refresh не вызывает
  и не предлагает второй POST.
- Ranking, CSV, production hardening, общий Stage 5 E2E, deploy и commit
  отсутствуют.

## Automated fake/local acceptance

1. Shared/API/web builds и `prisma validate` без schema/migration изменений.
2. Unit/domain: query bounds/ranges, protected WAV integrity, safe 404 и bounded
   audit.
3. Isolated PostgreSQL: employee confirmed/pending/technical semantics, safe
   breakdown, revoke history, assignment/current-access separation, real raw SQL
   filters/pagination/sort.
4. HTTP/RBAC: 401/403, независимые results/audio permissions, safe lightweight
   results JSON, no-store audio response и persisted audit.
5. Frontend source tests: results route, server filters/pagination, review partial
   success, Blob lifecycle и Telegram-independent employee results.
6. Targeted browser: results loading/filter/pagination/detail, review refresh
   failure и protected audio load/close/error on both supported themes.
7. Full API/web/workspace tests and builds, `git diff --check`, `.only`/`.skip`,
   secret/real-call/excluded-scope scans and cleanup temporary DB/object.

## Локальная ручная приёмка

1. Под employee проверить лучший/последний результат, остаток попыток, pending,
   timeout и технический refund в «Моих попытках».
2. Под admin открыть `/admin/training/results`, применить фильтры и pagination,
   открыть detail из строки.
3. Сравнить snapshot title/settings с текущим project и current assignment после
   revoke/reactivate.
4. Проверить approve/override и сценарий: POST успешен, detail refresh временно
   недоступен — повторный POST не предлагается.
5. Под admin с `training:audio:read` загрузить/прослушать/закрыть WAV; проверить
   no-store и audit. Под ролью только с `training:results:read` получить 403.
6. Проверить desktop/mobile, `minimal-luxury` и `dark-premium`, loading/empty/
   error/focus/reduced-motion states.

## Definition of Done

Part 1 готов к ручной локальной приёмке только при зелёных automated gates.
Part 2–4, production deploy и commit остаются отдельными не начатыми задачами.
