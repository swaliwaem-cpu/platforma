# Карта проекта Platforma (агентский отчёт от 2026-09-08)

> Ориентационная карта кодовой базы, составленная read-only исследованием.
> Это НЕ источник требований. Источники истины — текущий код,
> `apps/api/prisma/schema.prisma`, migrations, package scripts, тесты.
> Перед работой сверяться с актуальным состоянием ветки.

## Общее

Platforma — закрытая внутренняя платформа для брокеров недвижимости.
pnpm-монорепозиторий (pnpm@10):

- `apps/api` — backend, NestJS + Prisma + PostgreSQL/PostGIS + pgvector, JWT/cookie auth, server-side RBAC.
- `apps/web` — frontend, React 19 + TypeScript + Vite 8 (rolldown), Tailwind 4 + shadcn/Radix, MapLibre GL 6.
- `packages/shared` (`@platforma/shared`) — чистые TS-типы/контракты без рантайм-зависимостей; менять молча нельзя.
- `tools/feed-import` (`@platforma/feed-import`) — импорт XML-фидов лотов.
- `tools/wp-import` (`@platforma/wp-import`) — миграция контента из WordPress.
- `apps/api/prisma` — schema (~78 моделей, 2458 строк), 75 миграций, seed.
- `docker-compose.yml` + `docker/postgres` — локальный стек; `docker-compose.production.yml` — override для прода.

Сценарии продукта: авторизация/кабинет, каталог объектов, карта, карточка объекта,
админка (объекты/пользователи/фиды/импорт), подборки и презентации, обучение, AI-ассистент подбора лотов.

## Backend: apps/api (~14 модулей в AppModule)

Точки входа: `src/main.ts` (HTTP, порт 3000, без глобального /api префикса),
`src/training-voice-worker.main.ts` — отдельный процесс-воркер.

| Модуль | Путь | Назначение |
|---|---|---|
| PrismaModule | `src/prisma/` | глобальный PrismaService; `seed.ts` — permissions/roles/admin |
| AuthModule | `src/auth/` | login/refresh/logout/me, email-регистрация с кодом, JWT access/refresh/media |
| UsersModule | `src/users/` | CRUD пользователей, роли, архивация |
| ObjectsModule | `src/objects/` | CRUD объектов (`/objects`), публикация, галереи, гео-связи, поиск |
| DirectoriesModule | `src/directories/` | `/developers`, `/locations`, `/metro` (read-only) |
| CatalogLinksModule | `src/catalog-links/` | быстрые ссылки каталога |
| FeedsModule | `src/feeds/` | фиды: источники, маппинги, preview/run; spawn CLI `@platforma/feed-import`, очередь concurrency 3, автоимпорт 2 ч |
| FilesModule | `src/files/` | загрузка/выдача файлов; самописный SigV4-клиент S3/MinIO (без SDK); image variants через sharp; MediaController по media-token |
| MapModule | `src/map/` | `/map`; MapRoutingService — пешеходные маршруты через OpenRouteService matrix с PG-кэшем (stale-refresh 180 дней) |
| LotPresentationsModule | `src/lot-presentations/` | подборки лотов → PDF (pdfkit) |
| ProjectPresentationsModule | `src/project-presentations/` | презентации проектов: draft → async PDF, polling-воркер в API-процессе |
| TrainingModule | `src/training/` | учебно-экзаменационный модуль (~50 файлов) |
| WordpressImportModule | `src/wordpress-import/` | preview/run/repair WP-импорта |
| AssistantModule | `src/assistant/` | AI-ассистент подбора лотов (см. ниже) |
| HealthController | `src/health/` | health-check |

### Auth / RBAC

- `User → Role → RolePermission → Permission`; `UserSession` (refresh hash, 30 дней), `EmailAuthChallenge`.
- Access JWT 15 мин (Bearer), refresh — httpOnly cookie, media token — cookie ~200 мин (scope `files:read`). Пароли — argon2.
- Guards: `JwtAuthGuard`, `PermissionsGuard` + `@RequirePermissions(...)` (требует ВСЕ перечисленные), `MediaTokenGuard`, предметные guards (presentations, TrainingFeatureGuard).
- 27 permission-ключей в `src/prisma/seed.ts` (`admin:access`, `users:*`, `objects:*`, `files:*`, `import:*`, `feeds:*`, `assistant:*`, `training:*`…). Роли: admin (всё), editor, user.
- IDOR/ownership — в сервисах. Backend — единственный источник проверки доступа.

### Training V2 (`src/training/`)

Голосовые экзамены сотрудников по проектам недвижимости; интерфейс — Telegram-бот.
Канон документации: `docs/training-v2/{README,BUSINESS_RULES,DECISIONS,ARCHITECTURE,CURRENT_STAGE,ACCEPTANCE}.md`.
Статус: Stage 5 Part 4/4, final acceptance pending.

- Контроллеры (6): employee API, admin API, materials, config, audio-access, telegram webhook (`POST /training/telegram/webhook`, secret-token, 64 KB лимит).
- Ядро: `training-project.service.ts` (DRAFT→PUBLISHED_CLOSED→OPEN), `training-attempt.service.ts` + state (snapshot 1 main + 10 вопросов, таймер, 3 из 10, лимиты, retake-delay), results/review/ranking.
- Знания: knowledge service, materials (PDF через pdfjs-dist, URL через cheerio).
- AI: три провайдер-интерфейса с DI-токенами (`TRAINING_EVALUATOR`, `TRAINING_TRANSCRIBER`, `TRAINING_MATERIAL_SUGGESTER`), fake/alibaba по `TRAINING_AI_MODE` (DashScope: DeepSeek для вопросов и оценки, `qwen3-asr-flash` для голоса, ключ `ALIBABA_API_KEY` общий с ассистентом); учёт расхода — `training-ai-usage.service.ts`.
- Voice worker (910 строк): PG row-lock claim (lock_owner + heartbeat + fencing, stale 2 мин, concurrency 3); транскрибация → оценка → outbox.
- Telegram: линковка по токену (TTL 15 мин), outbox-worker (claim+heartbeat, retry до 8 раз, backoff до часа).
- Скрипты: `training:webhook:{status,register,delete}`, `test:training-v2:e2e`, `benchmark:training:*`.

### Интеграции backend

S3/MinIO (самописный SigV4 на fetch/HMAC), OpenRouteService (пешеходные маршруты, PG-кэш),
Alibaba DashScope (training и assistant), Yandex Search API (assistant), Telegram Bot API, nodemailer (email-коды), ffmpeg (аудио),
sharp (variants), pdfkit/pdfjs-dist, playwright-core (рендер презентаций), cheerio.
Внешней очереди нет — везде in-process polling-воркеры с PG-claim (lock_owner/heartbeat/stale-recovery).

## AI-ассистент: apps/api/src/assistant/ (v2)

Подбирает лоты (сначала Platforma, потом сайты застройщиков и агрегаторы), отвечает на вопросы о конкретном ЖК по его карточке и объясняет термины рынка. План этапа 1 — `docs/helpr2/1st.md`.
Старый модуль v1 (спека `docs/helpar/speka.md`) снят 2026-09-23, код — в ветке `archive/assistant-v1`. Его таблицы (`assistant_*`) пока в БД и схеме: удаление v1 из этапа 1 не сделано. Новый код читает из v1 только `assistant_object_metro_route_facts` + `assistant_metro_access_points` (минуты пешком до метро). У ЖК, созданных после удаления скрипта пересчёта, этих данных нет.

- `assistant.controller.ts` — `GET /assistant/config`, `POST /assistant/jobs` (вся переписка + `pageObjectSlug` + `conversationId`), `GET /assistant/jobs/:id` (polling), `POST /assistant/turns/:id/feedback` (👍/👎 только своего хода). Доступ: `objects:read` + `ASSISTANT_MODULE_ENABLED` + `ASSISTANT_ROLLOUT_STAGE` (ADMINS/PILOT/ALL). `AssistantAdminController` — `GET /assistant/admin/turns`, `/turns/:id`, `/usage?days=` только с `admin:access`.
- `assistant.service.ts` — задания в памяти процесса (один активный на пользователя, дедлайн 150 с, TTL 15 мин). Историю переписки хранит браузер (sessionStorage); каждый ход (и упавший) пишется в журнал, `turnId` = id задания.
- `assistant-turn-log.service.ts` — таблица `assistant_turns`: вопрос и ответ с маскировкой телефонов/почты, лоты, источники, трасса инструментов, токены (с кэшем), стоимость через `estimateTrainingAiCost`, оценки. Раз в сутки удаляет ходы старше 90 дней. Админ-список, карточка хода, расход по дням (московские сутки).
- `assistant-agent.ts` — цикл модели (по умолчанию `deepseek-v4.1-flash` через Alibaba) с инструментами `find_projects`, `search_lots`, `get_project_facts`, `web_search`, `open_page`, `give_answer`; системный промпт + справочник рынка; проверка ответа: лоты Platforma — только id из `search_lots`, веб-лоты — только с открытых сайтов, цена — только если число есть на странице. `sources` ответа — прочитанные карточки, ЖК показанных лотов и открытые сайты с датой.
- `assistant-market-knowledge.ts` — текст справочника (классы и критерии, отделка, ипотека без ставок, термины). Медианы цены за м² по классам в нём — черновик по локальной базе, заменить прод-цифрами.
- `assistant-catalog.tools.ts` — поиск проекта (тот же `findCatalogSearchObjectIds`, что строка поиска каталога), карточка ЖК для `get_project_facts` и SQL по доступным лотам. Фильтры: класс (синонимы через `@platforma/shared/property-class`), отделка (сырые `decoration/renovation` фидов → 4 значения в SQL `CASE`, мебель — `raw_payload @_Furniture` ФСК), цена за м², минуты до метро, год сдачи от/до, «уже сдан».
- `assistant-web.tools.ts` — поиск: Yandex Search API, если заданы `YANDEX_SEARCH_API_KEY` + `YANDEX_SEARCH_FOLDER_ID`, иначе headless-браузер читает выдачу Startpage → Brave → Yahoo (Google/Bing/Яндекс/Mojeek дают капчу; выключается `ASSISTANT_BROWSER_SEARCH_ENABLED=false`). Чтение страницы Playwright’ом: текст, ссылки на подбор квартир и лоты из JSON, который грузит страница. Агрегаторы (m2.ru, ЦИАН) часто отдают headless-браузеру заглушку.
- `assistant-llm.client.ts` — DashScope compatible-mode `/chat/completions` с function calling (`ALIBABA_API_KEY`, `ASSISTANT_MODEL`, по умолчанию `deepseek-v4.1-flash`; на ключе есть qwen3.x, deepseek-v4*, kimi/glm — последние два отвергают параметры запроса); читает `prompt_tokens_details.cached_tokens`. Встроенный веб-поиск DashScope на intl-аккаунте не работает (проверено 2026-09-23).
- Классы ЖК: `packages/shared/src/property-class.{mjs,cjs,d.cts}` — Комфорт-класс, Бизнес-класс, Премиум-класс, Делюкс + синонимы («элитка», «de luxe» → Делюкс). `objects.service` принимает только их (иначе 400; старое нестандартное значение живёт, пока его не меняют). `apps/api/scripts/assistant-class-suggestions.cjs` — `suggest` (модель предлагает класс ЖК без класса, CSV) и `apply` (пишет проверенный CSV с audit log; без `--write` — dry run).
- Тесты: `apps/api/tests/assistant.test.cjs` (фейковые LLM/каталог/веб, HTTP-гарды), `assistant-postgres.test.cjs` (SQL фильтров, карточка ЖК, журнал; нужен `ASSISTANT_TEST_DATABASE_URL` одноразовой БД после `prisma migrate deploy`).
- Замер качества: `pnpm assistant:eval` — платный прогон набора `apps/api/tests/fixtures/assistant-eval/phase1.json` на живой модели и локальной БД, отчёт в `docs/helpr2/eval/`. `--dist <папка>` — прогнать другую сборку api (замер «до»), `--only id1,id2`, `--web`.

## Frontend: apps/web (~86 файлов src)

- **Routing самописный, без библиотеки**: `App.tsx` (1554 строки) — весь routing, shell, LoginPage; `usePathname()` слушает popstate + перехват кликов по `<a>`; цепочка `pathname.startsWith(...)`.
- Маршруты: `/login`, `/cabinet`, `/catalog` (+`/life`, `/comm`, `/map`), `/objects/:slug` (+`/lots/:unitId`), `/presentations` (+`/projects`), `/training/*`, `/admin/*` (objects, users, catalog-links, feeds, import, assistant, training). Тяжёлые страницы — lazy(). Permission gates — только UX.
- **Auth**: `auth/AuthProvider.tsx` — refresh через httpOnly cookie при mount, access token в памяти, single-flight refresh на 401, события `platforma-auth-updated/cleared`.
- **API client — `admin/api.ts`** (имя обманчиво, это ОБЩИЙ клиент; не дублировать): `apiRequest`, Bearer, `credentials: include`, перевод ошибок на русский.
- **Карта** (`src/map/`): MapLibre GL 6, стиль OpenFreeMap Liberty; фасад `PlatformMap.tsx` (155 строк: points/geometries/fullscreen/measurement/fallback-состояния); runtime config через `window.__PLATFORMA_RUNTIME_CONFIG__` (`/runtime-config.js`, можно выключить карту без ребилда); OpenMapTiles-специфика: amenity-слои, локализация подписей на ru, метро/МЦД фильтры. Миграция с Яндекс.Карт завершена (тест проверяет отсутствие YandexMap).
- **Ассистент** (`src/assistant/`): плавающий draggable/resizable чат-виджет поверх shell (для `objects:read`), slug проекта из pathname, `conversationId` в sessionStorage, polling заданий раз в секунду, карточки лотов Platforma и сайтов, плашки источников с датой, 👍/👎 с комментарием. Админ-страница `admin/AssistantAdminPage.tsx` (`/admin/assistant`): расход за 30 дней, журнал ходов (фильтр «только 👎»), карточка хода с трассой инструментов.
- **UI**: гибрид — глобальный `styles.css` (11k строк предметных классов) + Tailwind/shadcn точечно; темы светлая/`dark-premium`; i18n нет, всё жёстко на русском; lucide-react.
- Production-статика: собственный `server.mjs` (gzip/brotli, SPA-fallback, runtime-config из env).
- Большие файлы (styles.css 11k, ObjectDetailPage 2.9k, CatalogPage 2.8k, App.tsx 1.5k) — осознанная политика «цельный читаемый файл».

## Данные: apps/api/prisma/schema.prisma (78 моделей)

PostgreSQL + PostGIS (`searchPoint` geography(Point,4326)) + pgvector. Домены:

- Пользователи/доступ: User, Role/Permission/RolePermission, UserSession, EmailAuthChallenge.
- Каталог: RealEstateObject (type/status, ручные + feed-цены, координаты+search_point, wpPostId), Developer (normalizedName), Location (дерево), MetroStation, ObjectLocation, ObjectMetroStation, MapWalkingRouteCache, CatalogQuickLink.
- Фиды: FeedSource, FeedSourceMapping, FeedImportRun, FeedUnit (+ FeedResidentialUnitDetails / FeedCommercialUnitDetails 1:1, rawPayload — весь XML-узел), FeedMediaAsset/FeedUnitMedia (дедуп по sourceUrl).
- Файлы: File (LOCAL/MINIO), FileVariant (THUMBNAIL/CARD/DETAIL), ObjectImage, ObjectFile.
- Презентации: LotPresentation*, ProjectPresentation*.
- Training (~20 моделей): Project/KnowledgeVersion/Assignment, Question/Fact/Criterion, Attempt→AttemptQuestion→Answer→AnswerSegment, AiUsageEvent, Material(+Revision/Operation), AudioStorageEntry, DeletionManifest, TelegramAccount/LinkToken/Outbox.
- Ассистент: `AssistantTurn` (журнал v2). Модели v1 (~25 `Assistant*`) — архивные таблицы; новый код читает только `AssistantObjectMetroRouteFact` и `AssistantMetroAccessPoint`.
- Аудит: AuditLog, ImportReport (wp-import журнал).

## Импорты

### tools/feed-import (src/index.ts 5574 строки)

- Форматы: YANDEX_REALTY, CIAN_XML, AVITO_XML, FSK_XML, TEKTA_XML — класс-парсер на формат.
- Команды: `analyze` (без БД), `preview` (dry-run по FeedSource), `run` (запись FeedUnit/детали/медиа в MinIO `feeds/YYYY/MM/<sha256(url)>`).
- TEKTA Era: только `flats.flat` и `offices.office`; коммерция/кладовки/паркинги НЕ импортируются; media не подтягивается (UNC-пути) — задокументировано в `docs/TEKTA_ERA_FEED_FIELD_MAP.md`.
- Автоимпорт: `FEED_AUTO_IMPORT_ENABLED` в api.

### tools/wp-import

- Читает MySQL WordPress read-only (mysql2, пост-типы `nedvizhimosts`/`commercials`) + примонтированные uploads/.
- Команды: preview/run, repair preview|run (переназначение primary location, дедуп застройщиков по алиасам — в одной транзакции).
- Не затирает ручные правки: whitelist `ManualObjectOverrideField`. Идемпотентность по `wpPostId`. Пишет ImportReport.

## Инфраструктура

- `docker/postgres/` — собственный образ: postgis 16-3.5 + pgvector 0.8.6.
- `docker-compose.yml` (локально, всё уже поднято): postgres:5432, redis:6379, minio:9000/9001 (бакеты platforma, platforma-training-audio, platforma-training-materials), api:3000 (по умолчанию `ASSISTANT_MODULE_ENABLED=false`, AI/geo — fake), training-voice-worker, assistant-source-worker (профиль, выключен), web:5173.
- `docker-compose.production.yml` — override: секреты обязательны (`:?required`), порты закрыты за прокси (127.0.0.1), `TRAINING_AI_MODE=alibaba`, `TELEGRAM_TRANSPORT_MODE=real`, готовые images из CI.
- Деплой: push в `main` = раскатка на прод → никогда без явной команды пользователя.
- Миграции: 75, эволюция каталог→фиды→презентации→training v1→v2→assistant t01–t07→geo2. Последние: `20260903173000_add_assistant_geo2_metro_routes`, `20260907010000_allow_zero_assistant_metro_duration`.

## Тесты и проверки

- Раннер — `node --test` поверх CJS (НЕ Jest). `apps/api/tests/run-tests.cjs` (~95 файлов) одним процессом, все AI/внешние провайдеры в fake.
- Слои: `*-domain.test.cjs` (чистая логика), `*-http.test.cjs` (Nest, guards/routes), `*-postgres.test.cjs` (реальный PG: транзакции, race, locks), `*.cjs` без `.test` — ручные e2e/smoke.
- Web: `node --test tests/*.test.mjs` (~68 файлов, unit/контрактные), `*.browser.mjs` — Playwright, отдельными скриптами.
- Команды: корневые `pnpm test`, `pnpm build`; targeted `test:training-*`, `benchmark:*`.
- После изменений: targeted tests + workspace build; при cross-cutting — `pnpm test` + `pnpm build`.

## Правила игры (из AGENTS.md)

- Не пушить в main без явной команды (push = деплой на прод).
- Не переключать ветку без разрешения; не откатывать чужие изменения.
- Миграции только additive; `prisma migrate reset` / `db push` на shared базы — запрещены.
- Не менять публичные API и shared contracts молча; RBAC только на backend.
- Не плодить utils.ts/helpers.ts; цельные читаемые файлы предпочтительнее конфетти.
- Локальные Docker-контейнеры не перезапускать без необходимости.
- UI-проверки: локальная admin-учётка из `apps/api/.env` (ADMIN_EMAIL/ADMIN_PASSWORD), не выводить в логи/ответы.

## Горячее на 2026-09-08

- Активная работа: FIX-GEO2 в ассистенте (logical plans, metro walking facts, hardening границ). Последние коммиты: classify cancelled geo2 metro fixture requests, harden geo2 boundaries, supported union in planner structured output.
- Незакоммичено: `AGENTS.md` (modified), рабочие заметки `docs/helpar/*.md` (fix-geo2, fix-tk1, pidafix1-3, zaebal1-6).
- Training V2: Stage 5 Part 4, final acceptance pending.
- Ассистент: переписан заново 2026-09-23 (v1 в `archive/assistant-v1`); rollout ADMINS, перевод в PILOT/ALL — только по команде.

---

# Приложение: инструкции и правила (зафиксировано 2026-09-08)

## Иерархия инструкций проекта

1. **Текущая задача пользователя** — высший приоритет.
2. **`/Users/nick/Documents/platforma/AGENTS.md`** — постоянные правила проекта (Codex project instructions, auto-loaded). Файл в репозитории, всегда актуален из рабочего дерева.
3. **`~/.codex/AGENTS.md`** — глобальные правила Codex (ниже дословно).
4. Активные гайды по областям (читать только относящиеся к задаче):
   - `docs/PROJECT_CONTEXT.md` — общий контекст;
   - `docs/FRONTEND_GUIDE.md` — frontend;
   - `docs/BACKEND_GUIDE.md` — backend/API/data;
   - `docs/TESTING_AND_DEPLOY.md` — тесты, Docker, миграции, deploy;
   - `docs/RISK_ZONES.md` — постоянные зоны риска;
   - `docs/manual-qa-checklist.md`, `docs/staging-production-env-checklist.md` — чек-листы приёмки окружений.
5. НЕ являются инструкциями: `docs/helpar/*`, `docs/superpowers/*`, `docs/patch*`, `docs/training*`,
   `prompts/training-v2-token-optimization/*` (это LLM-промпты модуля Training), `.superpowers/*`,
   старые планы/отчёты, git history — только по прямому запросу.

## Глобальные правила Codex — ДОСЛОВНО (~/.codex/AGENTS.md)

> # Global Codex Rules
>
> ## Язык общения
>
> - Всегда отвечай мне на русском языке.
> - Объяснения, планы, вопросы, резюме и комментарии к изменениям пиши на русском.
> - Имена файлов, классов, функций, переменных и CSS-переменных пиши на английском.
> - Допускай уместную обсценную лексику, лёгкую иронию и дружеские подколы, если они соответствуют тону пользователя и не мешают ясности общения.
>
> ## Поведение перед работой
>
> - Если задача непонятна, неоднозначна или есть несколько вариантов реализации — сначала задай уточняющие вопросы.
> - Не делай предположений по логике, дизайну, структуре проекта или ожидаемому поведению без уточнения.
> - Перед крупными изменениями сначала кратко опиши план и дождись подтверждения.
> - Не добавляй новые библиотеки, зависимости, сборщики или фреймворки без моего разрешения.
>
> ## Стиль работы
>
> - Пиши чистый, понятный и поддерживаемый код.
> - Не ломай существующую структуру проекта.
> - Если изменение может повлиять на верстку, дизайн или поведение сайта — сначала предупреди.
> - Не запускай больше 6 субагентов одновременно суммарно по всему дереву текущей задачи. Вложенные субагенты входят в этот лимит; перед делегированием проверяй число активных агентов и запрещай дочерним агентам дальнейшее разветвление, если свободных слотов нет.
> - В конце ответа всегда кратко указывай:
>   - что сделано;
>   - какие файлы изменены;
>   - что нужно проверить вручную;
>   - есть ли спорные места.

## Прочие находки Codex (не поведенческие инструкции)

- `~/.codex/rules/default.rules` — машинный allow-list разрешённых shell-команд Codex (prefix_rule ... allow), не поведенческие правила.
- `~/.codex/config.toml` — конфиг Codex: model `gpt-5.6-terra`, reasoning `ultra`, включённые плагины (figma, build-web-apps, documents, spreadsheets, presentations, pdf, template-creator, visualize, superpowers, sites, browser, codex-app-tools).
- Отдельных `AGENTS.md` в `apps/*`, `tools/*`, `packages/*` нет — корневой единственный.
- `.cursorrules`, `CLAUDE.md`, `.cursor/`, `.claude/` в проекте отсутствуют.

## Ключевые выдержки из гайдов (сверено с оригиналами 2026-09-08)

### Backend (docs/BACKEND_GUIDE.md)

- Controller — тонкая HTTP-граница; business logic в предметных services; сохранять DI tokens и module boundaries.
- Prisma entities не возвращать напрямую при ограниченном контракте; explicit serializers и `select`; не менять route/status/error contract молча.
- Auth: авторизация всегда на backend; IDOR через ownership/scope; seed ролей менять с пониманием влияния.
- Prisma/PG: schema — только по отдельному плану; migrations additive; не редактировать применённые; `db push` запрещён; короткие транзакции, без внешних HTTP внутри транзакции; race чинить root cause, не timeout.
- Queries: explicit select, N+1, raw SQL только параметризованный, индексы после проверки query plan.
- External/jobs: timeout + bounded retries, идемпотентные jobs, restart не теряет persisted work, не логировать секреты/raw payload.
- Files: MIME/размер/ownership, нет бессрочных public URLs, проверка DB references перед удалением.
- Imports: сначала analyze/preview, затем run, проверка отчёта; production import не запускать автоматически.
- Tests: pure logic — unit; concurrency — реальный PostgreSQL; guards/routes — HTTP tests с реальным Nest; providers — stub; race-тест не заменять fake repository.

### Frontend (docs/FRONTEND_GUIDE.md)

- Сохранять app shell и визуальный язык; без generic AI-дизайна, градиентов, стекломорфизма; не превращать внутренние экраны в лендинг.
- Не подключать новый router/state manager; использовать существующий AuthProvider и API client (`admin/api.ts`).
- Async state обязан покрывать: loading, empty, error, retry, stale response, unmount, AbortController, race, очистку Blob/Object URLs.
- Permission gates — только UX; backend — источник авторизации; прямой URL не должен обходить RBAC.
- Формы: не скрывать backend error, не очищать форму после неудачного сохранения, один idempotency-ключ на retry операции.
- CSS: локальные предметные классы; desktop+mobile; focus states/контраст/touch targets; `prefers-reduced-motion`; не удалять CSS по строковому совпадению без проверки conditional/data-state/Radix.
- Проверки после изменений: targeted web tests, web build, loading/empty/error, direct URL, back/forward, mobile viewport, разные permissions.

### Testing & Deploy (docs/TESTING_AND_DEPLOY.md)

- Источник команд — текущие package.json; перед запуском проверить, что script существует.
- Локальная задача: targeted tests → build workspace → `git diff --check`. Cross-cutting: + API tests, web tests, `pnpm build`, `pnpm test`.
- Нельзя: `.only`, `.skip` вместо исправления, удаление failing tests, утверждать о прогоне без запуска.
- Тесты: без production DB/buckets/платных провайдеров/реального Telegram; принудительный fake env; concurrency на изолированной БД.
- Staging/prod Prisma: только `migrate status` + `migrate deploy`; запрещены `migrate reset`, `db push`, `migrate dev`. До prod migration: backup → проверка backup → config validation → build → migrate deploy → post-validation.
- Docker: до изменений проверить service names/healthchecks/signals/volumes/secrets в build context; после — `docker compose config`, build, smoke, graceful stop.
- Production — только по прямой команде; без разрешения нельзя SSH, prod migrations, webhook register, платный smoke, prod env, пересоздание контейнеров.
- Voice worker rollout: адресный `docker compose up -d --build --no-deps api` НЕ трогает worker; перед пересозданием worker — `pnpm training:worker:predeploy` (exit 2 блокирует при активных claims); replicas выше 1 запрещены до повторной проверки fencing.
- Rollback: feature disable → stop worker/ingress → предыдущий image → fix forward; destructive down migration и restore backup поверх prod — только с отдельным планом.

### Risk Zones (docs/RISK_ZONES.md)

Постоянные зоны: auth/sessions/cookies; RBAC/permissions (расхождение front/back, seed, IDOR); Prisma/migrations/seed;
shared contracts и serialization (Decimal/BigInt/Date); files/media/storage; frontend routing; async lifecycle;
catalog/map/global CSS; import tools; external providers/jobs; Docker/env/deploy.
Правило: задача затрагивает зону → назвать зону в плане, найти связанные файлы, запустить обязательные проверки,
без попутного рефакторинга, указать остаточный риск в финальном ответе.
