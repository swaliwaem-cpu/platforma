# Этап 3. Исправить выбор Docker image в Training E2E

Приоритет: P1

Тип работы: исправление тестовой инфраструктуры

Production: запрещён

## Промт этапа

```text
Цель: исключить ложноположительный Training E2E на устаревшем Docker image и гарантировать, что тест проверяет image, собранный из текущего checkout.

Предпосылки предыдущего аудита, которые нужно перепроверить:

- `apps/api/tests/training-v2-stage5-part4-e2e.cjs` в пяти местах жёстко использовал `platforma-api:latest`;
- `docker-compose.yml` по умолчанию использовал `${API_IMAGE:-platforma-api:local}` для API и worker;
- обычный E2E мог пройти на старом `latest` image с другой migration history;
- принудительное использование свежего API image обнаружило реальную DI-ошибку.

Для web hardcoded `platforma-web:latest` может быть корректным Compose tag, но его соответствие только что выполненному build всё равно нужно доказать по effective tag/image ID.

Порядок работы:

1. Read-only субагент проверяет все места выбора/tagging API и web images, build scripts, Compose defaults, cleanup и способы запуска E2E.
2. Главный агент воспроизводит расхождение на локальных безопасных images и после Compose build фиксирует effective tags и image IDs без публикации registry.
3. Получай API image из эффективного Compose config или используй тот же существующий default `platforma-api:local`. Для web определи реальный output tag Compose build. Не заводи второй build path или новый tag.
4. После build разреши оба tags в immutable image IDs. Один и тот же API ID должен использоваться для Prisma validate/deploy/status, внутреннего E2E runner и shutdown fixture; web container должен запускаться по только что полученному web ID.
5. Выведи безопасную идентификацию обоих images в лог теста и fail-fast, если ID нельзя получить. Не создавай отдельную систему content hashing.
6. Сохрани изоляцию project name, временной БД/volumes/networks и cleanup при success/failure/SIGINT.
7. Не обходи ошибки приложения заменой теста на mocked HTTP.
8. После правок read-only субагент проверяет diff, cleanup и отсутствие зависимости от локально оставшихся images.

Границы:

- не менять бизнес-код Training ради зелёного E2E;
- менять только `apps/api/tests/training-v2-stage5-part4-e2e.cjs`, пока текущий код не докажет необходимость другого scope;
- `prisma migrate deploy` допустим только внутри одноразовой PostgreSQL, созданной самим E2E; никогда против Compose-default, основной локальной или shared БД;
- не пушить images и не использовать production registry;
- не трогать production Compose/env;
- не скрывать migration/boot failures retries без жёсткого лимита;
- не добавлять зависимости.

Минимальные проверки:

- проверить существование фактического script `test:training-v2:e2e`;
- `docker compose config` с безопасными test env без вывода секретов;
- `docker compose config --images`: API должен разрешаться в `platforma-api:local` при default env;
- убедиться, что `platforma-api:latest` больше не используется в E2E-файле;
- локально выполнить `docker compose build api web` из текущего checkout;
- запустить точную команду `pnpm test:training-v2:e2e` на этих image IDs;
- отдельно доказать fail-fast при невозможности разрешить image ID;
- проверить cleanup контейнеров/сетей/volumes;
- `git diff --check`.

Критерий завершения: E2E не может молча использовать старые API/web images, выводит безопасную идентификацию обоих immutable IDs и запускает текущий код; production и registry не затронуты.

Если актуальный image после этого падает на DI, migrations или бизнес-сценарии, остановись и отчитай отдельную причину. Не исправляй соседний дефект внутри этого этапа.

Если Docker daemon недоступен, остановись и явно укажи, что E2E не проверен.

Если текущий harness уже имеет надёжную content identity, остановись после аудита и покажи доказательства вместо дублирования механизма.
```
