const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '../../..');
const schemaPath = path.join(rootDir, 'apps/api/prisma/schema.prisma');
const migrationPath = path.join(
  rootDir,
  'apps/api/prisma/migrations/20260525160000_add_user_sessions/migration.sql',
);

function readProjectFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

test('Prisma schema defines per-device user sessions for refresh tokens', () => {
  const schema = readProjectFile(schemaPath);

  assert.match(schema, /model User \{[\s\S]*sessions\s+UserSession\[\][\s\S]*@@map\("users"\)[\s\S]*\}/);
  assert.match(schema, /model UserSession \{[\s\S]*userId\s+String\s+@map\("user_id"\)\s+@db\.Uuid[\s\S]*refreshTokenHash\s+String\s+@map\("refresh_token_hash"\)[\s\S]*refreshTokenExpiresAt\s+DateTime\s+@map\("refresh_token_expires_at"\)[\s\S]*lastUsedAt\s+DateTime\s+@default\(now\(\)\)\s+@map\("last_used_at"\)[\s\S]*\}/);
  assert.match(schema, /user\s+User\s+@relation\(fields: \[userId\], references: \[id\], onDelete: Cascade\)/);
  assert.match(schema, /@@index\(\[userId\]\)/);
  assert.match(schema, /@@index\(\[refreshTokenExpiresAt\]\)/);
  assert.match(schema, /@@map\("user_sessions"\)/);
});

test('user sessions migration creates cascade auth-only session table', () => {
  const migration = readProjectFile(migrationPath);

  assert.match(migration, /CREATE TABLE "user_sessions"/);
  assert.match(migration, /"user_id" UUID NOT NULL/);
  assert.match(migration, /"refresh_token_hash" TEXT NOT NULL/);
  assert.match(migration, /"refresh_token_expires_at" TIMESTAMP\(3\) NOT NULL/);
  assert.match(migration, /"last_used_at" TIMESTAMP\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP/);
  assert.match(migration, /FOREIGN KEY \("user_id"\) REFERENCES "users"\("id"\) ON DELETE CASCADE ON UPDATE CASCADE/);
});
