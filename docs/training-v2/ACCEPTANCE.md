# Acceptance: Stage 1

## Критерии готовности

- Admin может создать один draft, сохранить manual config и ровно 1+10
  вопросов, publish и global open/close.
- Eligible Employee видит общий упорядоченный список только опубликованных и
  открытых проектов с корректными attempt/result summaries.
- Попытка создаётся только после явного confirmation, сразу считается
  использованной и не превышает limit при concurrent requests.
- Start атомарно сохраняет project/scoring/timer config и все 11 question texts.
- После main answer backend сохраняет выбор ровно трёх разных snapshot-candidates.
- Четыре text answers immutable; fake evaluator синхронно и детерминированно
  сохраняет `PASSED`, `FAILED` или `REQUIRES_REVIEW` в `TrainingAttempt`.
- Employee видит только собственный безопасный result/history; Admin видит
  минимальную попытку с выбранными вопросами и fake answers.
- Вторая попытка отдельна; edit проекта не меняет первую.
- Production-код не содержит инфраструктуру Stage 2+.

## Автоматические проверки

### PostgreSQL и API behavior

- Publish отклоняет любой набор, кроме точного 1 main + 10 additional.
- Closed/unpublished project не виден и не стартует.
- Concurrent availability и edit/unpublish сохраняют invariant:
  неопубликованный проект всегда закрыт.
- Duplicate `Idempotency-Key` возвращает ту же попытку.
- Два concurrent starts при limit `1` создают не более одной попытки.
- Snapshot содержит 11 вопросов; selection содержит 1 main + 3 unique
  additional из исходного snapshot-пула.
- Нельзя ответить на candidate, чужой, уже отвеченный или не текущий вопрос.
- Timer и attempt limit проверяет backend; client не задаёт score/status.
- `FAKE_PASS`, `FAKE_FAIL`, `FAKE_REVIEW` дают стабильные ожидаемые outcomes.
- Best/last confirmed исключают `REQUIRES_REVIEW` и неподтверждённый score.
- Второй attempt имеет отдельные id/data; mutation проекта не меняет первый.
- Если source project/questions изменены после start snapshot, но до main answer,
  три additional выбираются из прежних десяти snapshots, а config/text/result
  попытки не меняются.
- Завершённый result нельзя изменить или автоматически пересчитать.

Статистическая равномерность random selection не тестируется. Проверяются
server-side выбор, размер, уникальность и принадлежность snapshot-пулу.

### HTTP contracts и security

- Anonymous получает `401`, authenticated без permission — `403`.
- Employee UUID probing чужой попытки не раскрывает существование или данные.
- Admin endpoints требуют `admin:access` и `training:manage`.
- Employee endpoints требуют `training:participate` и ownership.
- Employee DTO не содержит семь candidates, fake answer texts, чужие результаты,
  hidden facts/answers, errors, review comments, transcript или audio fields.
- Frontend permission gates совпадают с backend permissions, но не заменяют их.
- Prisma entities не выдаются напрямую; dates/status/score сериализуются явно.

### Web behavior

- Работают navigation, direct URL, back/forward и denied route.
- Есть loading, empty, error/retry и защита от duplicate submit/stale response.
- Start требует confirmation; видны общий timer и used/remaining counters.
- UI проходит main → 3 additional → result и показывает три result statuses.
- Reload/reconnect, abandonment и timeout проверяются по утверждённым решениям,
  а не только browser state; recovery заранее не предполагается.

### Workspace checks

- Targeted pure, API/PostgreSQL, HTTP и web behavior tests зелёные.
- `pnpm --filter @platforma/api test` проходит.
- `pnpm --filter @platforma/web test` проходит.
- `pnpm build` и `pnpm test` проходят.
- `git diff --check` проходит.
- Migration проверена на чистой временной PostgreSQL database.

## Один ручной end-to-end сценарий

1. Admin создаёт проект с limit `3` и `allowRetakeAfterPass=true`.
2. Добавляет 1 main и 10 additional вопросов.
3. Публикует и открывает проект.
4. Employee видит проект и counters.
5. Подтверждает start; used увеличивается, timer начинается.
6. Отвечает на main.
7. Получает 3 разных additional вопроса.
8. Отвечает на все три и получает fake result.
9. Видит result и попытку в собственной history.
10. Admin видит ту же попытку.
11. Employee завершает вторую попытку; обе записи существуют отдельно.
12. Admin закрывает и изменяет проект, затем повторно публикует.
13. Первая попытка сохраняет прежние config, texts, selection, answers и result.

## Ограничения приёмки

- Пять Training-моделей, 13 endpoints и пять frontend routes — верхняя граница
  утверждённого Stage 1 scope.
- Нет `TrainingProjectVersion`, отдельного `TrainingResult`, worker/queue,
  provider/job/run, audio/storage, parsers, review/ranking/operations.
- Новый файл более 500 строк объяснён; более 700 не принимается.
- Mock/static-only green не заменяет PostgreSQL, HTTP и ручную проверку.

## Definition of Done

Stage 1 завершён только когда закрыты применимые `NEEDS_DECISION`, выполнены все
критерии выше, ручной сценарий пройден за один сеанс, diff остаётся в границах,
а отчёт явно отделяет executed checks от внешнего/manual QA.

## Переход к Stage 2

Stage 2 не начинается автоматически. Нужны зелёный Stage 1, зафиксированная
ручная приёмка и отдельное явное разрешение пользователя. До этого Telegram,
voice/audio, storage, `ffmpeg` и fake transcription не проектируются в коде.
