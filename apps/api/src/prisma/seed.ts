import { PrismaClient, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';

import {
  TRAINING_ADMIN_PERMISSION_KEYS,
  TRAINING_PERMISSION_DEFINITIONS,
  TRAINING_USER_PERMISSION_KEYS,
} from '../training/training.permissions';
import { CURRENT_TRAINING_POLICY } from '../training/training-policy.seed';
import { seedImmutableTrainingPolicy } from '../training/training-policy-seeder';

const prisma = new PrismaClient();

const permissions = [
  ['admin:access', 'Access admin area'],
  ['users:read', 'Read users'],
  ['users:create', 'Create users'],
  ['users:update', 'Update users'],
  ['users:delete', 'Delete or archive users'],
  ['objects:read', 'Read real estate objects'],
  ['objects:create', 'Create real estate objects'],
  ['objects:update', 'Update real estate objects'],
  ['objects:publish', 'Publish real estate objects'],
  ['developers:read', 'Read developers'],
  ['locations:read', 'Read locations'],
  ['metro:read', 'Read metro stations'],
  ['files:upload', 'Upload files'],
  ['files:delete', 'Delete files'],
  ['import:preview', 'Run WordPress import preview'],
  ['import:run', 'Run WordPress import'],
  ['feeds:read', 'Read feed sources and units'],
  ['feeds:manage', 'Manage feed sources'],
  ['feeds:run', 'Run feed imports'],
  ['audit-log:read', 'Read audit log'],
  ...TRAINING_PERMISSION_DEFINITIONS,
] as const;

const rolePermissions = {
  admin: permissions.map(([key]) => key),
  training_admin: ['admin:access', ...TRAINING_ADMIN_PERMISSION_KEYS],
  editor: [
    'admin:access',
    'objects:read',
    'objects:create',
    'objects:update',
    'objects:publish',
    'developers:read',
    'locations:read',
    'metro:read',
    'files:upload',
    'files:delete',
  ],
  user: [
    'objects:read',
    'developers:read',
    'locations:read',
    'metro:read',
    ...TRAINING_USER_PERMISSION_KEYS,
  ],
} as const;

async function seed() {
  const permissionRecords = new Map<string, { id: string }>();

  for (const [key, description] of permissions) {
    const permission = await prisma.permission.upsert({
      where: { key },
      update: { description },
      create: { key, description },
      select: { id: true },
    });

    permissionRecords.set(key, permission);
  }

  for (const [name, permissionKeys] of Object.entries(rolePermissions)) {
    const description =
      name === 'training_admin'
        ? 'Training administrator role'
        : `${name[0]?.toUpperCase()}${name.slice(1)} role`;
    const role = await prisma.role.upsert({
      where: { name },
      update: {
        description,
      },
      create: {
        name,
        description,
      },
      select: { id: true },
    });

    for (const key of permissionKeys) {
      const permission = permissionRecords.get(key);

      if (!permission) {
        throw new Error(`Permission "${key}" was not seeded`);
      }

      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: role.id,
            permissionId: permission.id,
          },
        },
        update: {},
        create: {
          roleId: role.id,
          permissionId: permission.id,
        },
      });
    }
  }

  const adminRole = await prisma.role.findUniqueOrThrow({
    where: { name: 'admin' },
    select: { id: true },
  });

  const adminEmail = process.env.ADMIN_EMAIL ?? 'admin@example.com';
  const adminName = process.env.ADMIN_NAME ?? 'Platform Admin';
  const explicitAdminPasswordHash = process.env.ADMIN_PASSWORD_HASH;
  const explicitAdminPassword = process.env.ADMIN_PASSWORD;
  const adminPasswordHash =
    explicitAdminPasswordHash && explicitAdminPasswordHash.length > 0
      ? explicitAdminPasswordHash
      : await argon2.hash(explicitAdminPassword ?? '12345', {
          type: argon2.argon2id,
        });
  const shouldUpdateAdminPassword = Boolean(explicitAdminPasswordHash || explicitAdminPassword);

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {
      name: adminName,
      ...(shouldUpdateAdminPassword ? { passwordHash: adminPasswordHash } : {}),
      roleId: adminRole.id,
      status: UserStatus.ACTIVE,
    },
    create: {
      email: adminEmail,
      name: adminName,
      passwordHash: adminPasswordHash,
      roleId: adminRole.id,
      status: UserStatus.ACTIVE,
    },
    select: { id: true },
  });

  await prisma.$transaction(async (tx) => {
    await seedImmutableTrainingPolicy(
      tx,
      CURRENT_TRAINING_POLICY,
      admin.id,
    );
  });

  console.log(
    `Seeded ${permissions.length} permissions, roles, admin user ${adminEmail} and training policy ${CURRENT_TRAINING_POLICY.version}.`,
  );
}

void seed()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
