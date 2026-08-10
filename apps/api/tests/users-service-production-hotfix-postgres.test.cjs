require('reflect-metadata');

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { after, before, beforeEach, describe, test } = require('node:test');
const { PrismaClient, UserStatus } = require('@prisma/client');

const { UsersService } = require('../dist/users/users.service.js');

const databaseUrl = process.env.TRAINING_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('UsersService production hotfix PostgreSQL scenarios require the targeted temporary database runner', () => {
    assert.equal(process.env.TRAINING_TEST_DATABASE_URL, undefined);
  });
} else {
  describe('UsersService production hotfix PostgreSQL', { concurrency: false }, () => {
    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const service = new UsersService(prisma, {});
    const request = {
      headers: {
        'user-agent': 'users-hotfix-postgres-test',
        'x-forwarded-for': '127.0.0.1',
      },
      ip: '127.0.0.1',
    };

    before(async () => {
      await prisma.$connect();
    });

    beforeEach(async () => {
      await dropRevokeFailureTrigger();
      await prisma.trainingTelegramLinkToken.deleteMany();
      await prisma.trainingTelegramAccount.deleteMany();
      await prisma.userSession.deleteMany();
      await prisma.auditLog.deleteMany({
        where: {
          OR: [
            { action: { startsWith: 'user.' } },
            { action: 'training.telegram.auto_revoke' },
          ],
        },
      });
      await prisma.trainingProject.deleteMany({
        where: { title: { startsWith: 'Users hotfix test ' } },
      });
      await prisma.user.deleteMany({
        where: { email: { endsWith: '@users-hotfix.test' } },
      });
      await prisma.role.deleteMany({
        where: { name: { startsWith: 'users-hotfix-' } },
      });
    });

    after(async () => {
      await dropRevokeFailureTrigger();
      await prisma.$disconnect();
    });

    test('role change without training permission revokes sessions, unused tokens and active account with audit', async () => {
      const scenario = await createScenario('role-loss');

      await service.update(
        scenario.target.id,
        { roleId: scenario.restrictedRole.id },
        scenario.actor,
        request,
      );

      const [user, sessions, unusedToken, usedToken, account, autoRevoke] = await Promise.all([
        prisma.user.findUniqueOrThrow({ where: { id: scenario.target.id } }),
        prisma.userSession.count({ where: { userId: scenario.target.id } }),
        prisma.trainingTelegramLinkToken.findUniqueOrThrow({ where: { id: scenario.unusedToken.id } }),
        prisma.trainingTelegramLinkToken.findUniqueOrThrow({ where: { id: scenario.usedToken.id } }),
        prisma.trainingTelegramAccount.findUniqueOrThrow({ where: { id: scenario.account.id } }),
        prisma.auditLog.findFirstOrThrow({
          where: {
            action: 'training.telegram.auto_revoke',
            entityId: scenario.account.id,
          },
        }),
      ]);

      assert.equal(user.roleId, scenario.restrictedRole.id);
      assert.equal(user.refreshTokenHash, null);
      assert.equal(user.refreshTokenExpiresAt, null);
      assert.equal(sessions, 0);
      assert.ok(unusedToken.revokedAt instanceof Date);
      assert.equal(usedToken.revokedAt, null);
      assert.ok(account.revokedAt instanceof Date);
      assert.deepEqual(autoRevoke.metadata, {
        userId: scenario.target.id,
        accountId: scenario.account.id,
        reason: 'training_permission_removed',
      });
    });

    test('deactivation revokes refresh and Telegram access atomically', async () => {
      const scenario = await createScenario('deactivate');

      await service.deactivate(scenario.target.id, scenario.actor, request);

      const [user, sessions, token, account, actions] = await Promise.all([
        prisma.user.findUniqueOrThrow({ where: { id: scenario.target.id } }),
        prisma.userSession.count({ where: { userId: scenario.target.id } }),
        prisma.trainingTelegramLinkToken.findUniqueOrThrow({ where: { id: scenario.unusedToken.id } }),
        prisma.trainingTelegramAccount.findUniqueOrThrow({ where: { id: scenario.account.id } }),
        prisma.auditLog.findMany({
          where: { entityId: { in: [scenario.target.id, scenario.account.id] } },
          orderBy: { createdAt: 'asc' },
        }),
      ]);

      assert.equal(user.status, UserStatus.DEACTIVATED);
      assert.equal(user.refreshTokenHash, null);
      assert.equal(user.refreshTokenExpiresAt, null);
      assert.equal(sessions, 0);
      assert.ok(token.revokedAt instanceof Date);
      assert.ok(account.revokedAt instanceof Date);
      assert.deepEqual(actions.map((entry) => entry.action), [
        'user.deactivate',
        'training.telegram.auto_revoke',
      ]);
    });

    test('audit failure rolls back role, refresh sessions and Telegram state', async () => {
      const scenario = await createScenario('audit-rollback');
      const missingActor = {
        ...scenario.actor,
        id: randomUUID(),
      };

      await assert.rejects(() =>
        service.update(
          scenario.target.id,
          { roleId: scenario.restrictedRole.id },
          missingActor,
          request,
        ),
      );

      await assertScenarioUnchanged(scenario);
      assert.equal(
        await prisma.auditLog.count({
          where: { entityId: { in: [scenario.target.id, scenario.account.id] } },
        }),
        0,
      );
    });

    test('revoke failure rolls back deactivation, audit, sessions and token updates', async () => {
      const scenario = await createScenario('revoke-rollback');
      await createRevokeFailureTrigger();

      try {
        await assert.rejects(
          () => service.deactivate(scenario.target.id, scenario.actor, request),
          /forced training account revoke failure/i,
        );
      } finally {
        await dropRevokeFailureTrigger();
      }

      await assertScenarioUnchanged(scenario);
      assert.equal(
        await prisma.auditLog.count({
          where: { entityId: { in: [scenario.target.id, scenario.account.id] } },
        }),
        0,
      );
    });

    async function createScenario(label) {
      const scenarioId = randomUUID().slice(0, 8);
      const permission = await prisma.permission.upsert({
        where: { key: 'training:participate' },
        update: {},
        create: {
          key: 'training:participate',
          description: 'Participate in training',
        },
      });
      const participantRole = await prisma.role.create({
        data: {
          name: `users-hotfix-p-${label}-${scenarioId}`,
          description: 'Users hotfix participant role',
          permissions: { create: { permissionId: permission.id } },
        },
      });
      const restrictedRole = await prisma.role.create({
        data: {
          name: `users-hotfix-r-${label}-${scenarioId}`,
          description: 'Users hotfix restricted role',
        },
      });
      const actorRole = await prisma.role.create({
        data: {
          name: `users-hotfix-a-${label}-${scenarioId}`,
          description: 'Users hotfix actor role',
        },
      });
      const actorUser = await prisma.user.create({
        data: {
          email: `actor-${label}-${randomUUID()}@users-hotfix.test`,
          passwordHash: 'actor-test-hash',
          name: 'Users hotfix actor',
          status: UserStatus.ACTIVE,
          roleId: actorRole.id,
        },
      });
      const refreshTokenExpiresAt = new Date(Date.now() + 60_000);
      const target = await prisma.user.create({
        data: {
          email: `target-${label}-${randomUUID()}@users-hotfix.test`,
          passwordHash: 'target-test-hash',
          refreshTokenHash: 'target-refresh-hash',
          refreshTokenExpiresAt,
          name: 'Users hotfix target',
          status: UserStatus.ACTIVE,
          roleId: participantRole.id,
        },
      });
      await prisma.userSession.create({
        data: {
          userId: target.id,
          refreshTokenHash: 'session-refresh-hash',
          refreshTokenExpiresAt,
        },
      });
      const project = await prisma.trainingProject.create({
        data: {
          title: `Users hotfix test ${label} ${randomUUID()}`,
          allowRetakeAfterPass: true,
        },
      });
      const account = await prisma.trainingTelegramAccount.create({
        data: {
          userId: target.id,
          telegramUserId: 9_000_000_001n,
          chatId: 9_000_000_002n,
          username: `hotfix_${label.replaceAll('-', '_')}`,
        },
      });
      const unusedToken = await prisma.trainingTelegramLinkToken.create({
        data: {
          userId: target.id,
          projectId: project.id,
          tokenHash: tokenHash(`${label}-unused`),
          expiresAt: refreshTokenExpiresAt,
        },
      });
      const usedToken = await prisma.trainingTelegramLinkToken.create({
        data: {
          userId: target.id,
          projectId: project.id,
          tokenHash: tokenHash(`${label}-used`),
          expiresAt: refreshTokenExpiresAt,
          usedAt: new Date(),
        },
      });

      return {
        account,
        actor: {
          id: actorUser.id,
          email: actorUser.email,
          name: actorUser.name,
          status: actorUser.status,
          role: { id: actorRole.id, name: actorRole.name },
          permissions: [],
        },
        participantRole,
        restrictedRole,
        target,
        unusedToken,
        usedToken,
      };
    }

    async function assertScenarioUnchanged(scenario) {
      const [user, sessions, unusedToken, account] = await Promise.all([
        prisma.user.findUniqueOrThrow({ where: { id: scenario.target.id } }),
        prisma.userSession.count({ where: { userId: scenario.target.id } }),
        prisma.trainingTelegramLinkToken.findUniqueOrThrow({ where: { id: scenario.unusedToken.id } }),
        prisma.trainingTelegramAccount.findUniqueOrThrow({ where: { id: scenario.account.id } }),
      ]);

      assert.equal(user.roleId, scenario.participantRole.id);
      assert.equal(user.status, UserStatus.ACTIVE);
      assert.equal(user.refreshTokenHash, 'target-refresh-hash');
      assert.ok(user.refreshTokenExpiresAt instanceof Date);
      assert.equal(sessions, 1);
      assert.equal(unusedToken.revokedAt, null);
      assert.equal(account.revokedAt, null);
    }

    async function createRevokeFailureTrigger() {
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION patch5_fail_training_account_revoke()
        RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'forced training account revoke failure';
        END;
        $$ LANGUAGE plpgsql;
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER patch5_fail_training_account_revoke
        BEFORE UPDATE OF revoked_at ON training_telegram_accounts
        FOR EACH ROW
        WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
        EXECUTE FUNCTION patch5_fail_training_account_revoke();
      `);
    }

    async function dropRevokeFailureTrigger() {
      await prisma.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS patch5_fail_training_account_revoke
        ON training_telegram_accounts;
      `);
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS patch5_fail_training_account_revoke();');
    }

    function tokenHash(value) {
      return createHash('sha256').update(`${value}-${randomUUID()}`).digest('hex');
    }
  });
}
