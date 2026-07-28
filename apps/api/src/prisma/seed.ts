import {
  Prisma,
  PrismaClient,
  UserStatus,
} from '@prisma/client';
import * as argon2 from 'argon2';

import {
  TRAINING_ADMIN_PERMISSION_KEYS,
  TRAINING_PERMISSION_DEFINITIONS,
  TRAINING_PILOT_PERMISSION_KEYS,
} from '../training/training.permissions';
import {
  CURRENT_TRAINING_POLICY,
} from '../training/training-policy.seed';
import { seedImmutableTrainingPolicy } from '../training/training-policy-seeder';

const prisma = new PrismaClient();

const BASE_USER_PERMISSION_KEYS = [
  'objects:read',
  'developers:read',
  'locations:read',
  'metro:read',
] as const;

const NON_TRAINING_PERMISSION_DEFINITIONS = [
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
] as const;

const permissions = [
  ...NON_TRAINING_PERMISSION_DEFINITIONS,
  ...TRAINING_PERMISSION_DEFINITIONS,
] as const;

const rolePermissions: Record<string, readonly string[]> = {
  admin: [
    ...NON_TRAINING_PERMISSION_DEFINITIONS.map(([key]) => key),
    ...TRAINING_ADMIN_PERMISSION_KEYS,
    'training:data:delete',
  ],
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
  user: BASE_USER_PERMISSION_KEYS,
  training_pilot: [
    ...BASE_USER_PERMISSION_KEYS,
    ...TRAINING_PILOT_PERMISSION_KEYS,
  ],
};

type SeedEnvironment = {
  ADMIN_EMAIL?: string;
  ADMIN_NAME?: string;
  ADMIN_PASSWORD?: string;
  ADMIN_PASSWORD_HASH?: string;
};

export async function seedPlatforma(
  client: PrismaClient,
  environment: SeedEnvironment = process.env,
  policy = CURRENT_TRAINING_POLICY,
) {
  return client.$transaction(async (tx) => {
    const permissionRecords = new Map<string, { id: string }>();

    for (const [key, description] of permissions) {
      const permission = await tx.permission.upsert({
        where: { key },
        update: { description },
        create: { key, description },
        select: { id: true },
      });

      permissionRecords.set(key, permission);
    }

    const roleRecords = new Map<string, { id: string }>();
    for (const [name, permissionKeys] of Object.entries(rolePermissions)) {
      const description = roleDescription(name);
      const role = await tx.role.upsert({
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
      const permissionIds = permissionKeys.map((key) => {
        const permission = permissionRecords.get(key);

        if (!permission) {
          throw new Error(`Permission "${key}" was not seeded`);
        }
        return permission.id;
      });

      await tx.rolePermission.deleteMany({
        where: {
          roleId: role.id,
          permissionId: { notIn: permissionIds },
        },
      });
      await tx.rolePermission.createMany({
        data: permissionIds.map((permissionId) => ({
          roleId: role.id,
          permissionId,
        })),
        skipDuplicates: true,
      });

      roleRecords.set(name, role);
    }

    const adminRole = roleRecords.get('admin');
    if (!adminRole) {
      throw new Error('Admin role was not seeded');
    }

    const adminEmail = environment.ADMIN_EMAIL ?? 'admin@example.com';
    const existingAdmin = await tx.user.findUnique({
      where: { email: adminEmail },
      select: {
        id: true,
        roleId: true,
        status: true,
        deletedAt: true,
      },
    });
    const admin = existingAdmin
      ? assertExistingAdminIsSafe(existingAdmin, adminRole.id, adminEmail)
      : await createInitialAdmin(tx, adminRole.id, adminEmail, environment);

    await seedImmutableTrainingPolicy(tx, policy, admin.id);

    return {
      adminEmail,
      permissionCount: permissions.length,
      policyVersion: policy.version,
    };
  });
}

async function seed() {
  const result = await seedPlatforma(prisma);
  console.log(
    `Seeded ${result.permissionCount} permissions, roles, admin user ${result.adminEmail} and training policy ${result.policyVersion}.`,
  );
}

function roleDescription(name: string) {
  if (name === 'training_admin') return 'Training administrator role';
  if (name === 'training_pilot') return 'Temporary training pilot role';
  return `${name[0]?.toUpperCase()}${name.slice(1)} role`;
}

function assertExistingAdminIsSafe(
  admin: {
    id: string;
    roleId: string;
    status: UserStatus;
    deletedAt: Date | null;
  },
  adminRoleId: string,
  adminEmail: string,
) {
  if (
    admin.roleId !== adminRoleId ||
    admin.status !== UserStatus.ACTIVE ||
    admin.deletedAt !== null
  ) {
    throw new Error(
      `Existing admin user "${adminEmail}" must already be active, undeleted and assigned to role "admin"`,
    );
  }
  return { id: admin.id };
}

async function createInitialAdmin(
  tx: Prisma.TransactionClient,
  adminRoleId: string,
  adminEmail: string,
  environment: SeedEnvironment,
) {
  const explicitAdminPasswordHash = environment.ADMIN_PASSWORD_HASH;
  const explicitAdminPassword = environment.ADMIN_PASSWORD;
  const passwordHash =
    explicitAdminPasswordHash && explicitAdminPasswordHash.length > 0
      ? explicitAdminPasswordHash
      : await argon2.hash(explicitAdminPassword ?? '12345', {
          type: argon2.argon2id,
        });
  return tx.user.create({
    data: {
      email: adminEmail,
      name: environment.ADMIN_NAME ?? 'Platform Admin',
      passwordHash,
      roleId: adminRoleId,
      status: UserStatus.ACTIVE,
    },
    select: { id: true },
  });
}

if (require.main === module) {
  void seed()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
