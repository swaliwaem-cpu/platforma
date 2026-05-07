# Staging / Production Env Checklist

## API

- `NODE_ENV` is set to `production` outside local development.
- `PORT` matches the runtime ingress or container port.
- `WEB_ORIGIN` contains the exact frontend origin and allows credentials.
- `DATABASE_URL` points to PostgreSQL with PostGIS enabled.
- `REDIS_URL` points to the runtime Redis instance.
- `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` are unique strong secrets, not defaults.
- `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL_DAYS`, and `REFRESH_COOKIE_NAME` are reviewed for the environment.
- `ADMIN_EMAIL`, `ADMIN_NAME`, and either `ADMIN_PASSWORD` or `ADMIN_PASSWORD_HASH` are set for initial seed only.

## Storage

- `S3_ENDPOINT` points to the internal S3-compatible endpoint.
- `S3_PUBLIC_ENDPOINT` points to the public file endpoint reachable by users.
- `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and `MINIO_BUCKET` are set.
- `FILE_IMAGE_MAX_SIZE_BYTES` and `FILE_PDF_MAX_SIZE_BYTES` match operational limits.
- Bucket creation permissions are available at startup or the bucket is pre-created.

## WordPress Import

- `WP_DB_HOST`, `WP_DB_PORT`, `WP_DB_USER`, `WP_DB_PASSWORD`, `WP_DB_NAME`, and `WP_TABLE_PREFIX` are set.
- The WordPress DB user is read-only.
- If API runs in Docker and connects over TCP, the WordPress MySQL user allows connections from the Docker host/gateway.
- If local WordPress is socket-only, run the import CLI on the host or add an explicit socket mount strategy before using API-triggered import.
- `WP_POST_TYPE` matches the audited object post type.
- `WP_IMPORT_LIMIT` is empty for full import or set intentionally for staging smoke runs.
- For Docker Compose, `WP_UPLOADS_HOST_PATH` points to the host `wp-content/uploads` directory.
- `WP_UPLOADS_PATH` points to the container mount path, usually `/wp-uploads`.
- API-triggered import is checked through `/wordpress-import/preview` before enabling `/wordpress-import/run`.

## Web

- `VITE_API_URL` points to the public API origin.
- `VITE_YANDEX_MAPS_API_KEY` is optional: if it is empty, maps render through the no-key Yandex widget mode with app-side markers and balloons.
- The frontend origin matches `WEB_ORIGIN` on the API.

## Deployment Checks

- Prisma migrations are applied before starting the API.
- Seed is run once per environment and default credentials are rotated.
- Healthcheck `/health` returns database `ok` and `postgis: true`.
- `/auth/login`, `/auth/refresh`, and `/auth/logout` work with secure cookies behind the target proxy.
- Admin import preview creates an `ImportReport` and does not write objects in preview mode.
- Repeated import run is idempotent by `wpPostId` and `wpAttachmentId`.
- File upload, file content read, and linked-file deletion work against the target storage.
- Catalog, object detail page, catalog map, admin users, admin objects, and admin import are checked on desktop and mobile.
