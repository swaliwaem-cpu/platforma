UPDATE "users"
SET "status" = 'deactivated',
    "deleted_at" = NULL,
    "refresh_token_hash" = NULL,
    "refresh_token_expires_at" = NULL
WHERE "deleted_at" IS NOT NULL;
