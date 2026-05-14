# Команды проекта

- Установка зависимостей уже ожидается через `pnpm`.
- Полная сборка: `pnpm build`
- Сборка web: `pnpm build:web`
- Сборка API: `pnpm build:api`
- Все тесты, где есть scripts: `pnpm test`
- API tests: `pnpm --filter @platforma/api test`
- WordPress import tests: `pnpm --filter @platforma/wp-import test`
- Dev web: `pnpm dev:web -- --port 5173 --strictPort`
- Dev API: `pnpm dev:api`

## Dev server

- Web dev server всегда запускай только на порту `5173`.
- Запускай Vite со строгим портом: `pnpm dev:web -- --port 5173 --strictPort`.
- Если порт `5173` занят, не переключайся на другой порт автоматически; сначала останови старый процесс или уточни у пользователя, что делать.
