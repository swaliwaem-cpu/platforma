# Media Token для всех файлов Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` или `superpowers:subagent-driven-development` при реализации. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** заменить загрузку защищенных медиа через `fetch -> blob -> objectURL` на обычные URL с отдельным `media-token` cookie на 200 минут.

**Architecture:** `login` и `refresh` выдают отдельный httpOnly cookie `platforma_media_token`. Новый `GET /media/files/:id/content` проверяет только подпись media-token без запроса пользователя/permissions в БД. Admin и editor получают облегченный доступ ко всем file content; user получает тот же media-token при наличии `objects:read`.

**Tech Stack:** NestJS, `@nestjs/jwt`, Prisma, React/Vite, существующий MinIO/S3 storage.

---

## 1. Backend Auth

**Files:**
- Modify: `apps/api/src/auth/auth.types.ts`
- Modify: `apps/api/src/auth/cookies.ts`
- Modify: `apps/api/src/auth/auth.service.ts`
- Modify: `apps/api/src/auth/auth.controller.ts`
- Create: `apps/api/src/auth/media-token.guard.ts`
- Modify: `apps/api/src/auth/auth.module.ts`

**Steps:**
- [x] Add `MediaTokenPayload` type:
  - `sub: string`
  - `email: string`
  - `type: 'media'`
  - `scope: 'files:read'`
  - `role: string`
- [x] Add cookie helpers:
  - `getMediaCookieName()` returns `process.env.MEDIA_COOKIE_NAME ?? 'platforma_media_token'`
  - `getMediaCookieOptions(maxAge?)` returns `httpOnly: true`, `secure: NODE_ENV === 'production'`, `sameSite: 'lax'`, `path: '/'`, `maxAge`
- [x] Update `AuthService.issueTokens()` to issue `mediaToken` together with access/refresh:
  - TTL: `MEDIA_TOKEN_TTL_MINUTES ?? 200`
  - secret: `JWT_MEDIA_SECRET ?? 'change-me-media-secret'`
  - issue token only when `user.permissions.includes('objects:read')`
- [x] Update `AuthController.login()` and `refresh()` to set media cookie next to refresh cookie.
- [x] Update `logout()` to clear both refresh cookie and media cookie.
- [x] Create `MediaTokenGuard`:
  - read cookie `platforma_media_token`
  - verify JWT with `JWT_MEDIA_SECRET`
  - accept only `type === 'media'` and `scope === 'files:read'`
  - do not inject or query Prisma
- [x] Export `MediaTokenGuard` from `AuthModule`.

---

## 2. Backend Media Endpoint

**Files:**
- Create: `apps/api/src/files/file-content-response.ts`
- Create: `apps/api/src/files/media.controller.ts`
- Modify: `apps/api/src/files/files.controller.ts`
- Modify: `apps/api/src/files/files.module.ts`
- Optional Modify: `apps/api/src/users/users.controller.ts`

**Steps:**
- [x] Extract shared file response code into `file-content-response.ts`:
  - `Content-Type`
  - `Content-Length`
  - `Cache-Control`: images `private, max-age=86400`, other files `private, max-age=300`
  - `X-Platforma-File-Variant` for non-original variants
  - `Content-Disposition: inline`
- [x] Add `MediaController` with route:
  - `GET /media/files/:id/content?variant=card|thumbnail|detail`
  - `@UseGuards(MediaTokenGuard)`
  - calls `FilesService.getContent(id, variant)`
  - sends response through shared helper
- [x] Keep old `GET /files/:id/content` with `JwtAuthGuard + PermissionsGuard` for backward compatibility.
- [x] Register `MediaController` in `FilesModule`.
- [x] Do not change Prisma schema or migrations.

---

## 3. Frontend Media URLs

**Files:**
- Modify: `apps/web/src/files/SecureImage.tsx`
- Modify: `apps/web/src/objects/ObjectDetailPage.tsx`
- Modify: `apps/web/src/App.tsx`

**Steps:**
- [x] In `SecureImage.tsx`, replace `fetch()` loading with a direct URL:
  - `/media/files/:fileId/content`
  - append `variant` as a query parameter
  - do not use `credentials` inside `<img>`; the cookie will be sent by the browser for the API domain when cookie/CORS settings are correct
- [x] Preserve the current public component API, including the `accessToken` prop, so existing call sites do not need a broad rewrite.
- [x] Preserve lazy behavior:
  - before viewport intersection, do not set `src`
  - after viewport intersection, set direct media URL
- [x] Keep image error handling through `onError`.
- [x] In `ObjectDetailPage.tsx`, replace `SecureFileButton` behavior:
  - do not use `fetch + blob`
  - open `window.open(buildMediaFileContentUrl(fileId), '_blank', 'noopener,noreferrer')`
- [x] In `App.tsx`, replace `SecureProfileImage`:
  - use direct `/media/files/:fileId/content?variant=thumbnail`
  - remove `fetch -> blob -> objectURL`
- [x] Keep old authenticated fetches only for upload/update/delete actions, not for reading file content.

---

## 4. Tests

**Backend:**
- [x] `apps/api/tests/auth-rbac.test.cjs`:
  - `MediaTokenGuard` rejects missing cookie.
  - `MediaTokenGuard` rejects token with `type !== 'media'`.
  - `MediaTokenGuard` accepts a valid media-token and does not require Prisma.
- [x] `apps/api/tests/api-contract.test.cjs`:
  - `AuthController.login()` sets refresh cookie and media cookie.
  - `AuthController.refresh()` rotates refresh cookie and refreshes media cookie.
  - `AuthController.logout()` clears both cookies.
- [x] Add or update a contract test for `MediaController`:
  - endpoint delegates to `FilesService.getContent()`.
  - endpoint has no `RequirePermissions`.

**Frontend:**
- [x] `apps/web/tests/secure-image-variants.test.mjs`:
  - `SecureImage` builds `/media/files/` URLs.
  - variant query remains supported.
  - `SecureImage.tsx` no longer contains `fetchSecureImageObjectUrl`, `response.blob()`, or `URL.createObjectURL`.
- [x] Add a check that `ObjectDetailPage.tsx` opens PDF through `/media/files/` without `fetch`.
- [x] Add a check that profile photo in `App.tsx` no longer uses `/users/me/profile-photo/content`.

**Commands:**
- [x] `pnpm --filter @platforma/api test`
- [x] `pnpm --filter @platforma/web test`
- [x] `pnpm build`

---

## 5. Deploy Notes

**Before deploy, add env on the server:**
- [x] Document expected env in `.env.example`, `apps/api/.env.example` and `docker-compose.yml`.
- [x] Set `JWT_MEDIA_SECRET=<strong-random-secret>` on the production server.
- [x] Set `MEDIA_TOKEN_TTL_MINUTES=200` on the production server.
- [x] Optional: set `MEDIA_COOKIE_NAME=platforma_media_token` on the production server.
- [x] Deploy commit `599c641` on production through `docker compose -f docker-compose.prod.yml up -d --build`.

**Acceptance Criteria:**
- User/admin/editor receive `platforma_media_token` after login/refresh.
- Catalog, object detail, admin previews, PDF files, and profile photos open through `/media/files/...`.
- Media requests do not perform DB user/permissions checks.
- Admin/editor do not pass permission checks for every image.
- User gets file content access for 200 minutes through media-token.
- Logout clears media cookie.
- Old `/files/:id/content` keeps working through the old auth flow.

---

## Assumptions

- `admin` and `editor` are trusted roles and receive an optimized media-token without DB checks per file.
- `user` receives media-token only if the user has `objects:read` when the token is issued.
- The project currently has no object-level ACL for files; existing `/files/:id/content` is protected only by generic `objects:read`.
- The risk of role change or user blocking during the 200-minute TTL is accepted for this version.
- File metadata caching and MinIO streaming are not part of this task; they remain separate optimizations if media-token does not remove enough latency.

---

## 6. Production follow-up: image loading UX and media diagnostics

- [x] Keep PDF behavior unchanged.
- [x] Make `SecureImage` mark `loaded` only after browser image preload finishes.
- [x] Add image-only `Server-Timing` for `/media/files/:id/content` diagnostics.
- [x] Use `detail` 1440px image variant inside object lightbox instead of `original`.
