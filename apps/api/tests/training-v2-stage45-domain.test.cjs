require('reflect-metadata');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { BadRequestException, ForbiddenException } = require('@nestjs/common');

const {
  TrainingProjectAccessService,
} = require('../dist/training/training-project-access.service.js');
const {
  parseBulkTrainingProjectAssignmentsInput,
  parseTrainingAssignmentUsersQuery,
} = require('../dist/training/training.validation.js');

const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';

test('Stage 4.5 bulk validation deduplicates IDs and keeps the 500 item boundary', () => {
  assert.deepEqual(
    parseBulkTrainingProjectAssignmentsInput({
      action: 'ASSIGN',
      userIds: [firstId, firstId, secondId],
    }),
    { action: 'ASSIGN', userIds: [firstId, secondId] },
  );
  assert.throws(
    () => parseBulkTrainingProjectAssignmentsInput({ action: 'ASSIGN', userIds: [] }),
    BadRequestException,
  );
  assert.throws(
    () =>
      parseBulkTrainingProjectAssignmentsInput({
        action: 'REVOKE',
        userIds: Array.from({ length: 501 }, () => firstId),
      }),
    BadRequestException,
  );
});

test('Stage 4.5 picker validation bounds pagination and filters', () => {
  assert.deepEqual(parseTrainingAssignmentUsersQuery({}), {
    page: 1,
    limit: 20,
    search: '',
    assigned: 'all',
  });
  assert.throws(
    () => parseTrainingAssignmentUsersQuery({ limit: '101' }),
    BadRequestException,
  );
  assert.throws(
    () => parseTrainingAssignmentUsersQuery({ assigned: 'maybe' }),
    BadRequestException,
  );
});

test('Stage 4.5 policy requires an active participant before project access', async () => {
  const service = new TrainingProjectAccessService({
    user: { findFirst: async () => null },
  });

  await assert.rejects(
    service.assertNewAttemptAccess(firstId, secondId),
    ForbiddenException,
  );
});

test('Stage 4.5 employee project filter combines current access with active recovery', () => {
  const service = new TrainingProjectAccessService({});
  const filter = service.employeeProjectWhere(firstId);

  assert.equal(filter.OR.length, 2);
  assert.equal(filter.OR[0].OR[0].accessMode, 'ALL_PARTICIPANTS');
  assert.deepEqual(filter.OR[0].OR[1].assignments, {
    some: { userId: firstId, revokedAt: null },
  });
  assert.deepEqual(filter.OR[1].attempts.some, {
    userId: firstId,
    status: 'IN_PROGRESS',
  });
});

test('Stage 4.5 picker serializes only the safe user DTO', async () => {
  const now = new Date('2026-08-02T12:00:00.000Z');
  const prisma = {
    trainingProject: { findUnique: async () => ({ id: firstId }) },
    user: {
      findMany: () =>
        Promise.resolve([
          {
            id: secondId,
            name: 'Сотрудник',
            email: 'employee@example.test',
            status: 'ACTIVE',
            role: { permissions: [{ permissionId: firstId }] },
            trainingProjectAssignments: [{ assignedAt: now }],
            passwordHash: 'must-not-leak',
          },
        ]),
      count: () => Promise.resolve(1),
    },
    trainingProjectAssignment: { count: () => Promise.resolve(1) },
    $transaction: (operations) => Promise.all(operations),
  };
  const service = new TrainingProjectAccessService(prisma);
  const response = await service.listAssignmentUsers(firstId, {
    page: 1,
    limit: 20,
    search: null,
    assigned: 'all',
  });

  assert.deepEqual(response.items, [
    {
      userId: secondId,
      name: 'Сотрудник',
      email: 'employee@example.test',
      status: 'ACTIVE',
      canParticipate: true,
      isAssigned: true,
      assignedAt: now.toISOString(),
    },
  ]);
  assert.doesNotMatch(JSON.stringify(response), /passwordHash|assignedById|revokedAt/);
});
