-- Add normalized developer names for future duplicate protection.
-- Existing conflicting groups stay NULL until the manual alias/repair step resolves them.
ALTER TABLE "developers" ADD COLUMN "normalized_name" TEXT;

WITH normalized_developers AS (
    SELECT
        "id",
        lower(regexp_replace(btrim("name"), '\s+', ' ', 'g')) AS "normalized_name",
        count(*) OVER (
            PARTITION BY lower(regexp_replace(btrim("name"), '\s+', ' ', 'g'))
        ) AS "normalized_count"
    FROM "developers"
)
UPDATE "developers" AS d
SET "normalized_name" = nd."normalized_name"
FROM normalized_developers AS nd
WHERE d."id" = nd."id"
  AND nd."normalized_count" = 1;

CREATE UNIQUE INDEX "developers_normalized_name_key" ON "developers"("normalized_name");
