-- The project (ЖК) presentation generator becomes permission-gated: the plain "user" role loses it,
-- while admin, editor and training_admin keep it. Lot presentations stay open to every authenticated user.
INSERT INTO "permissions" ("id", "key", "description", "created_at", "updated_at")
VALUES (
  gen_random_uuid(),
  'presentations:projects:manage',
  'Create project (ЖК) PDF presentations',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO NOTHING;

-- New marketing role: the standard catalog access plus the project presentation generator, without training.
INSERT INTO "roles" ("id", "name", "description", "created_at", "updated_at")
VALUES (
  gen_random_uuid(),
  'marketing',
  'Marketing role',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("name") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id", "created_at")
SELECT "roles"."id", "permissions"."id", CURRENT_TIMESTAMP
FROM "roles"
JOIN "permissions" ON "permissions"."key" = 'presentations:projects:manage'
WHERE "roles"."name" IN ('admin', 'editor', 'training_admin', 'marketing')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id", "created_at")
SELECT "roles"."id", "permissions"."id", CURRENT_TIMESTAMP
FROM "roles"
JOIN "permissions" ON "permissions"."key" IN ('objects:read', 'developers:read', 'locations:read', 'metro:read')
WHERE "roles"."name" = 'marketing'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
