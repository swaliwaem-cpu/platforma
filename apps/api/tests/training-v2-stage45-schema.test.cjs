const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const repositoryRoot = resolve(__dirname, '../../..');
const schema = readFileSync(resolve(repositoryRoot, 'apps/api/prisma/schema.prisma'), 'utf8');
const migration = readFileSync(
  resolve(
    repositoryRoot,
    'apps/api/prisma/migrations/20260802190000_add_training_v2_project_assignments/migration.sql',
  ),
  'utf8',
);
const shared = readFileSync(resolve(repositoryRoot, 'packages/shared/src/training.ts'), 'utf8');
const accessService = readFileSync(
  resolve(repositoryRoot, 'apps/api/src/training/training-project-access.service.ts'),
  'utf8',
);

test('Stage 4.5 schema adds access mode and one assignment model', () => {
  assert.match(schema, /enum TrainingProjectAccessMode \{[\s\S]*ALL_PARTICIPANTS[\s\S]*ASSIGNED_USERS/);
  assert.match(
    schema,
    /model TrainingProject \{[\s\S]*accessMode\s+TrainingProjectAccessMode\s+@default\(ASSIGNED_USERS\)/,
  );
  assert.match(
    schema,
    /model TrainingProjectAssignment \{[\s\S]*projectId\s+String[\s\S]*userId\s+String[\s\S]*assignedById\s+String\?[\s\S]*assignedAt\s+DateTime[\s\S]*revokedAt\s+DateTime\?[\s\S]*@@unique\(\[projectId, userId\]\)[\s\S]*@@index\(\[projectId, revokedAt\]\)[\s\S]*@@index\(\[userId, revokedAt\]\)/,
  );
});

test('Stage 4.5 migration backfills old projects and defaults only new projects', () => {
  assert.match(migration, /CREATE TYPE "training_project_access_mode"/);
  assert.match(migration, /UPDATE "training_projects"[\s\S]*'all_participants'/);
  assert.match(migration, /ALTER COLUMN "access_mode" SET DEFAULT 'assigned_users'/);
  assert.match(migration, /CREATE TABLE "training_project_assignments"/);
  assert.match(migration, /ON DELETE RESTRICT/);
  assert.match(migration, /ON DELETE SET NULL/);
  assert.doesNotMatch(migration, /DROP TABLE|DROP TYPE|DELETE FROM|TRUNCATE/);
});

test('Stage 4.5 contracts stay bounded and do not expose assignment internals', () => {
  assert.match(shared, /TrainingProjectAssignmentUser = \{[\s\S]*userId: string;[\s\S]*name: string;[\s\S]*email: string;[\s\S]*status:[\s\S]*canParticipate: boolean;[\s\S]*isAssigned: boolean;[\s\S]*assignedAt: string \| null;/);
  assert.doesNotMatch(shared, /TrainingProjectAssignmentUser = \{[\s\S]{0,500}(assignedById|revokedAt|passwordHash|telegramUserId)/);
});

test('Stage 4.5 access service uses database filters and parameterized queries', () => {
  assert.match(accessService, /newAttemptProjectWhere/);
  assert.match(accessService, /employeeProjectWhere/);
  assert.match(accessService, /assignments: \{ some: \{ userId, revokedAt: null \} \}/);
  assert.match(accessService, /Prisma\.sql/);
  assert.doesNotMatch(accessService, /\$queryRawUnsafe|\$executeRawUnsafe/);
});
