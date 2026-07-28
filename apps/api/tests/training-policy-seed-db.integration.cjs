const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const test = require('node:test');
const {
  PrismaClient,
  TrainingPolicyAcceptanceSource,
  UserStatus,
} = require('@prisma/client');

const {
  seedImmutableTrainingPolicy,
} = require('../dist/training/training-policy-seeder.js');

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL must point to the runner-created isolated training database',
  );
}

const prisma = new PrismaClient();

test.after(async () => {
  await prisma.$disconnect();
});

test.afterEach(async () => {
  await prisma.trainingPolicyAcceptance.deleteMany({
    where: { policyVersion: { version: { startsWith: 'policy-seed-' } } },
  });
  await prisma.trainingPolicyVersion.deleteMany({
    where: { version: { startsWith: 'policy-seed-' } },
  });
  await prisma.user.deleteMany({
    where: { email: { startsWith: 'policy-seed-' } },
  });
  await prisma.role.deleteMany({
    where: { name: { startsWith: 'policy-seed-role-' } },
  });
});

test('policy seed is a no-op for identical content and rejects mutation of an accepted version', async () => {
  const fixture = await createFixture();
  const first = await prisma.$transaction((tx) =>
    seedImmutableTrainingPolicy(tx, fixture.policy, fixture.user.id),
  );
  const storedBefore = await prisma.trainingPolicyVersion.findUniqueOrThrow({
    where: { id: first.id },
  });
  await prisma.trainingPolicyAcceptance.create({
    data: {
      userId: fixture.user.id,
      policyVersionId: first.id,
      source: TrainingPolicyAcceptanceSource.PLATFORM,
    },
  });

  const repeated = await prisma.$transaction((tx) =>
    seedImmutableTrainingPolicy(tx, fixture.policy, fixture.user.id),
  );
  const storedAfter = await prisma.trainingPolicyVersion.findUniqueOrThrow({
    where: { id: first.id },
  });
  assert.deepEqual(repeated, { id: first.id, created: false });
  assert.equal(storedAfter.updatedAt.getTime(), storedBefore.updatedAt.getTime());
  assert.equal(
    await prisma.trainingPolicyAcceptance.count({
      where: { policyVersionId: first.id, userId: fixture.user.id },
    }),
    1,
  );

  for (const changed of [
    { ...fixture.policy, body: 'changed body' },
    { ...fixture.policy, checksum: 'b'.repeat(64) },
    {
      ...fixture.policy,
      body: 'changed body with forged checksum',
      checksum: fixture.policy.checksum,
    },
  ]) {
    await assert.rejects(
      prisma.$transaction((tx) =>
        seedImmutableTrainingPolicy(tx, changed, fixture.user.id),
      ),
      /is immutable; publish changed text under a new version/u,
    );
  }

  const unchanged = await prisma.trainingPolicyVersion.findUniqueOrThrow({
    where: { id: first.id },
  });
  assert.equal(unchanged.body, fixture.policy.body);
  assert.equal(unchanged.checksum, fixture.policy.checksum);
  assert.equal(unchanged.isActive, true);
});

test('new policy version preserves old acceptance without satisfying the new version', async () => {
  const fixture = await createFixture();
  const first = await prisma.$transaction((tx) =>
    seedImmutableTrainingPolicy(tx, fixture.policy, fixture.user.id),
  );
  await prisma.trainingPolicyAcceptance.create({
    data: {
      userId: fixture.user.id,
      policyVersionId: first.id,
      source: TrainingPolicyAcceptanceSource.PLATFORM,
    },
  });
  const nextPolicy = {
    ...fixture.policy,
    version: `${fixture.policy.version}.2`,
    body: 'new approved policy text',
    checksum: checksum(`${fixture.policy.version}.2:new approved policy text`),
  };
  const second = await prisma.$transaction((tx) =>
    seedImmutableTrainingPolicy(tx, nextPolicy, fixture.user.id),
  );

  assert.equal(second.created, true);
  assert.equal(
    (
      await prisma.trainingPolicyVersion.findUniqueOrThrow({
        where: { id: first.id },
      })
    ).isActive,
    false,
  );
  assert.equal(
    (
      await prisma.trainingPolicyVersion.findUniqueOrThrow({
        where: { id: second.id },
      })
    ).isActive,
    true,
  );
  assert.equal(
    await prisma.trainingPolicyAcceptance.count({
      where: { userId: fixture.user.id, policyVersionId: first.id },
    }),
    1,
  );
  assert.equal(
    await prisma.trainingPolicyAcceptance.count({
      where: { userId: fixture.user.id, policyVersionId: second.id },
    }),
    0,
  );
});

async function createFixture() {
  const unique = randomUUID();
  const role = await prisma.role.create({
    data: {
      name: `policy-seed-role-${unique}`,
      description: 'Policy seed integration role',
    },
  });
  const user = await prisma.user.create({
    data: {
      email: `policy-seed-${unique}@example.test`,
      name: 'Policy Seed User',
      passwordHash: 'policy-seed-test-hash',
      roleId: role.id,
      status: UserStatus.ACTIVE,
    },
  });
  return {
    user,
    policy: {
      version: `policy-seed-${unique}`,
      title: 'Policy seed title',
      body: 'Policy seed body',
      effectiveAt: '2026-07-28T00:00:00.000Z',
      isActive: true,
      approvalStatus: 'APPROVED',
      checksum: checksum(`policy-seed-${unique}:Policy seed body`),
    },
  };
}

function checksum(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
