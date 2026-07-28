const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const test = require('node:test');
const { PrismaClient } = require('@prisma/client');

const {
  seedPlatforma,
} = require('../dist/prisma/seed.js');
const {
  TRAINING_PILOT_PERMISSION_KEYS,
} = require('../dist/training/training.permissions.js');

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL must point to the runner-created isolated training database',
  );
}

const prisma = new PrismaClient();

test.after(async () => {
  await prisma.$disconnect();
});

test('seed reconciles exact pilot RBAC and preserves an existing admin identity', async () => {
  const unique = randomUUID();
  const adminEmail = `training-seed-admin-${unique}@example.test`;
  const policy = buildPolicy(`training-seed-policy-${unique}`);
  const initialEnvironment = {
    ADMIN_EMAIL: adminEmail,
    ADMIN_NAME: 'Seed RBAC Admin',
    ADMIN_PASSWORD: 'SeedRbacAdmin!1',
  };

  await seedPlatforma(prisma, initialEnvironment, policy);
  const firstAdmin = await prisma.user.findUniqueOrThrow({
    where: { email: adminEmail },
    select: {
      id: true,
      name: true,
      passwordHash: true,
      roleId: true,
      status: true,
      deletedAt: true,
    },
  });
  const firstRoleIds = await managedRoleIds();

  await addForbiddenTrainingGrants();
  await seedPlatforma(
    prisma,
    {
      ADMIN_EMAIL: adminEmail,
      ADMIN_NAME: 'Must not replace production name',
      ADMIN_PASSWORD_HASH: 'must-not-replace-production-password-hash',
    },
    policy,
  );
  await seedPlatforma(prisma, initialEnvironment, policy);

  const repeatedAdmin = await prisma.user.findUniqueOrThrow({
    where: { email: adminEmail },
    select: {
      id: true,
      name: true,
      passwordHash: true,
      roleId: true,
      status: true,
      deletedAt: true,
    },
  });
  assert.deepEqual(repeatedAdmin, firstAdmin);
  assert.deepEqual(await managedRoleIds(), firstRoleIds);

  assert.deepEqual(await rolePermissionKeys('user'), [
    'developers:read',
    'locations:read',
    'metro:read',
    'objects:read',
  ]);
  assert.deepEqual(await rolePermissionKeys('training_pilot'), [
    'developers:read',
    'locations:read',
    'metro:read',
    'objects:read',
    ...TRAINING_PILOT_PERMISSION_KEYS,
  ].sort());

  const adminTrainingKeys = (await rolePermissionKeys('admin')).filter(
    (key) => key.startsWith('training:'),
  );
  assert.equal(adminTrainingKeys.includes('training:take'), false);
  assert.equal(
    adminTrainingKeys.includes('training:own-results:read'),
    false,
  );
  assert.ok(adminTrainingKeys.includes('training:projects:manage'));
  assert.ok(adminTrainingKeys.includes('training:results:review'));
  assert.ok(adminTrainingKeys.includes('training:audio:read'));
  assert.ok(adminTrainingKeys.includes('training:ranking:read'));
  assert.ok(adminTrainingKeys.includes('training:operations:manage'));

  const seededPolicy = await prisma.trainingPolicyVersion.findUniqueOrThrow({
    where: { version: policy.version },
  });
  assert.equal(seededPolicy.isActive, true);
  assert.equal(seededPolicy.approvalStatus, 'APPROVED');
  assert.equal(seededPolicy.createdById, firstAdmin.id);
});

async function addForbiddenTrainingGrants() {
  const roles = await prisma.role.findMany({
    where: {
      name: { in: ['user', 'training_pilot', 'admin'] },
    },
    select: { id: true, name: true },
  });
  const forbiddenByRole = {
    user: [
      'training:take',
      'training:own-results:read',
      'training:projects:read',
    ],
    training_pilot: [
      'admin:access',
      'training:projects:read',
      'training:results:read',
    ],
    admin: ['training:take', 'training:own-results:read'],
  };
  for (const role of roles) {
    const keys = forbiddenByRole[role.name] ?? [];
    const permissions = await prisma.permission.findMany({
      where: { key: { in: keys } },
      select: { id: true },
    });
    await prisma.rolePermission.createMany({
      data: permissions.map((permission) => ({
        roleId: role.id,
        permissionId: permission.id,
      })),
      skipDuplicates: true,
    });
  }
}

async function rolePermissionKeys(roleName) {
  const role = await prisma.role.findUniqueOrThrow({
    where: { name: roleName },
    select: {
      permissions: {
        select: {
          permission: { select: { key: true } },
        },
      },
    },
  });
  return role.permissions
    .map(({ permission }) => permission.key)
    .sort();
}

async function managedRoleIds() {
  const roles = await prisma.role.findMany({
    where: {
      name: {
        in: ['admin', 'training_admin', 'editor', 'user', 'training_pilot'],
      },
    },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  return Object.fromEntries(roles.map((role) => [role.name, role.id]));
}

function buildPolicy(version) {
  const title = 'Approved pilot policy';
  const body = 'Approved pilot policy body';
  const effectiveAt = '2026-07-28T00:00:00.000Z';
  return {
    version,
    title,
    body,
    effectiveAt,
    isActive: true,
    approvalStatus: 'APPROVED',
    checksum: createHash('sha256')
      .update(JSON.stringify({ version, title, body, effectiveAt }), 'utf8')
      .digest('hex'),
  };
}
