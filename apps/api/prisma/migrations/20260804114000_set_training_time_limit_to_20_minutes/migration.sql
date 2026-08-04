ALTER TABLE "training_projects"
  ALTER COLUMN "time_limit_seconds" SET DEFAULT 1200;

UPDATE "training_projects"
SET
  "time_limit_seconds" = 1200,
  "updated_at" = CURRENT_TIMESTAMP
WHERE "time_limit_seconds" = 420;
