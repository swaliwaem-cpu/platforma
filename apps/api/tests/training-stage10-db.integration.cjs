require('reflect-metadata');

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const argon2 = require('argon2');
const {
  PrismaClient,
  TrainingJobKind,
  TrainingJobStatus,
  TrainingPolicyAcceptanceSource,
  TrainingProjectStatus,
  TrainingQuestionType,
  TrainingVersionStatus,
  UserStatus,
} = require('@prisma/client');

const { AuthModule } = require('../dist/auth/auth.module.js');
const {
  S3StorageService,
} = require('../dist/files/s3-storage.service.js');
const { PrismaModule } = require('../dist/prisma/prisma.module.js');
const { PrismaService } = require('../dist/prisma/prisma.service.js');
const {
  TrainingAttemptEngineService,
} = require('../dist/training/training-attempt-engine.service.js');
const {
  DeterministicFakeTrainingEvaluationProvider,
  DeterministicFakeTrainingTranscriptionProvider,
} = require('../dist/training/training-attempt.providers.js');
const {
  TrainingPolicyService,
} = require('../dist/training/training-policy.service.js');
const {
  TrainingConfigService,
} = require('../dist/training/training.config.js');
const {
  TrainingFeatureGuard,
} = require('../dist/training/training-feature.guard.js');
const {
  TrainingOperationsController,
} = require('../dist/training/training-operations.controller.js');
const {
  TrainingOperationsService,
} = require('../dist/training/training-operations.service.js');
const {
  TrainingPolicyController,
} = require('../dist/training/training-policy.controller.js');
const {
  TrainingOpenAiConfig,
} = require('../dist/training/openai/training-openai.config.js');
const {
  TrainingTelegramConfig,
} = require('../dist/training/telegram/training-telegram.config.js');
const {
  TrainingTelegramLinkService,
} = require('../dist/training/telegram/training-telegram-link.service.js');
const {
  DeterministicQuestionSelector,
  MutableTrainingClock,
} = require('./helpers/training-attempt-fake-prisma.cjs');

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL must point to the runner-created isolated training database',
  );
}

const prisma = new PrismaClient();

test.after(async () => {
  await prisma.$disconnect();
});

test('PostgreSQL stage 10 policy gates attempts, versions, revocation and audit without deleting history', async () => {
  const fixture = await createFixture();
  const policyService = new TrainingPolicyService(prisma);
  const engine = createEngine(policyService);

  await assert.rejects(
    engine.confirmStart({
      userId: fixture.userId,
      projectId: fixture.projectId,
      confirmed: true,
    }),
    (error) =>
      error?.response?.code === 'TRAINING_POLICY_ACCEPTANCE_REQUIRED',
  );
  assert.equal(
    await prisma.trainingAttempt.count({
      where: { userId: fixture.userId, projectId: fixture.projectId },
    }),
    0,
  );

  const firstAcceptance = await policyService.accept(
    fixture.userId,
    TrainingPolicyAcceptanceSource.PLATFORM,
  );
  const repeatedAcceptance = await policyService.accept(
    fixture.userId,
    TrainingPolicyAcceptanceSource.PLATFORM,
  );
  assert.equal(firstAcceptance.accepted, true);
  assert.deepEqual(repeatedAcceptance, firstAcceptance);
  assert.equal(
    await prisma.trainingPolicyAcceptance.count({
      where: {
        userId: fixture.userId,
        policyVersionId: fixture.firstPolicyId,
        revokedAt: null,
      },
    }),
    1,
  );

  const started = await engine.confirmStart({
    userId: fixture.userId,
    projectId: fixture.projectId,
    confirmed: true,
  });
  assert.equal(started.attempt.isConsumed, true);

  const links = new TrainingTelegramLinkService(prisma, {
    botUsername: 'stage10_test_bot',
    linkTokenTtlMinutes: 15,
    linkTokenCooldownSeconds: 30,
    linkTokenMaxIssuesPerHour: 3,
  });
  await links.issueLinkToken(fixture.telegramUserId);
  await assert.rejects(
    links.issueLinkToken(fixture.telegramUserId),
    (error) => error?.status === 429,
  );
  assert.equal(
    await prisma.trainingLinkToken.count({
      where: {
        userId: fixture.telegramUserId,
        revokedAt: null,
        usedAt: null,
      },
    }),
    1,
  );
  await engine.appendVoiceSegment({
    attemptId: started.attempt.id,
    kind: 'VOICE',
    updateId: 9_100_001n,
    fakeTranscript: 'synthetic policy history',
    recordingStartedAt: new Date('2026-07-28T10:00:00.000Z'),
    durationSeconds: 4,
  });
  const answer = await prisma.trainingAnswer.findFirstOrThrow({
    where: {
      attemptQuestion: { attemptId: started.attempt.id },
    },
  });
  const audioFile = await prisma.file.create({
    data: {
      bucket: 'stage10-private-test',
      key: `training-audio/${answer.id}.wav`,
      url: null,
      originalName: 'synthetic.wav',
      mimeType: 'audio/wav',
      sizeBytes: 128n,
      checksum: 'a'.repeat(64),
    },
  });
  await prisma.trainingAnswer.update({
    where: { id: answer.id },
    data: { mergedAudioFileId: audioFile.id },
  });

  const secondPolicy = await prisma.$transaction(async (tx) => {
    await tx.trainingPolicyVersion.update({
      where: { id: fixture.firstPolicyId },
      data: { isActive: false },
    });
    return tx.trainingPolicyVersion.create({
      data: {
        version: `stage10-v2-${fixture.unique}`,
        title: 'Stage 10 policy v2',
        body: 'Updated policy body',
        checksum: '2'.repeat(64),
        effectiveAt: new Date('2026-07-28T00:00:00.000Z'),
        isActive: true,
        approvalStatus: 'APPROVED',
        createdById: fixture.publisherId,
      },
    });
  });
  await assert.rejects(
    engine.confirmStart({
      userId: fixture.userId,
      projectId: fixture.projectId,
      confirmed: true,
    }),
    (error) =>
      error?.response?.code === 'TRAINING_POLICY_ACCEPTANCE_REQUIRED',
  );

  await policyService.accept(
    fixture.userId,
    TrainingPolicyAcceptanceSource.PLATFORM,
  );
  await prisma.trainingPolicyAcceptance.updateMany({
    where: {
      userId: fixture.userId,
      policyVersionId: secondPolicy.id,
      revokedAt: null,
    },
    data: { revokedAt: new Date('2026-07-28T11:00:00.000Z') },
  });
  await assert.rejects(
    engine.confirmStart({
      userId: fixture.userId,
      projectId: fixture.projectId,
      confirmed: true,
    }),
    (error) =>
      error?.response?.code === 'TRAINING_POLICY_ACCEPTANCE_REQUIRED',
  );
  assert.equal(
    await prisma.trainingAttempt.count({
      where: { id: started.attempt.id },
    }),
    1,
  );
  assert.equal(await prisma.file.count({ where: { id: audioFile.id } }), 1);

  const telegramAcceptance = await policyService.accept(
    fixture.telegramUserId,
    TrainingPolicyAcceptanceSource.TELEGRAM,
  );
  assert.equal(telegramAcceptance.acceptance.source, 'TELEGRAM');

  for (const userId of [
    fixture.blockedUserId,
    fixture.deactivatedUserId,
  ]) {
    await assert.rejects(
      policyService.accept(
        userId,
        TrainingPolicyAcceptanceSource.PLATFORM,
      ),
      (error) =>
        error?.response?.code === 'TRAINING_POLICY_USER_INACTIVE',
    );
  }

  assert.equal(
    await prisma.auditLog.count({
      where: {
        actorUserId: fixture.userId,
        action: 'training.policy.accept',
      },
    }),
    2,
  );
});

test('real stage 10 HTTP policy and operations endpoints enforce 401/403/404/200 and retry audit', async () => {
  const originalAccessSecret = process.env.JWT_ACCESS_SECRET;
  const originalRefreshSecret = process.env.JWT_REFRESH_SECRET;
  process.env.JWT_ACCESS_SECRET = 'training-stage10-http-access-secret';
  process.env.JWT_REFRESH_SECRET = 'training-stage10-http-refresh-secret';

  const trainingConfig = {
    isEnabled: () => true,
    assertEnabled: () => undefined,
    getConfig: () => ({ enabled: true, status: 'enabled' }),
  };
  class TrainingStage10HttpModule {}
  Module({
    imports: [PrismaModule, AuthModule],
    controllers: [
      TrainingPolicyController,
      TrainingOperationsController,
    ],
    providers: [
      TrainingPolicyService,
      TrainingOperationsService,
      TrainingFeatureGuard,
      {
        provide: TrainingConfigService,
        useValue: trainingConfig,
      },
      {
        provide: TrainingTelegramConfig,
        useValue: { transportMode: 'fake' },
      },
      {
        provide: TrainingOpenAiConfig,
        useValue: { providerMode: 'fake' },
      },
      {
        provide: S3StorageService,
        useValue: {
          getTrainingAudioPrivacyStatus: () => ({
            status: 'VERIFIED',
            checkedAt: '2026-07-28T10:00:00.000Z',
          }),
        },
      },
    ],
  })(TrainingStage10HttpModule);

  const app = await NestFactory.create(TrainingStage10HttpModule, {
    logger: false,
  });
  try {
    await app.listen(0, '127.0.0.1');
    const httpPrisma = app.get(PrismaService);
    const fixture = await createHttpFixture(httpPrisma);
    const address = app.getHttpServer().address();
    assert.equal(typeof address, 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const summaryUrl = `${baseUrl}/training/admin/operations/summary`;

    assert.equal((await fetch(`${baseUrl}/training/policy`)).status, 401);
    assert.equal((await fetch(summaryUrl)).status, 401);

    const noPermissionToken = await login(
      baseUrl,
      fixture.users.noPermission,
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/training/policy`, {
          headers: authorization(noPermissionToken),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(summaryUrl, {
          headers: authorization(noPermissionToken),
        })
      ).status,
      403,
    );

    const employeeToken = await login(baseUrl, fixture.users.employee);
    const policyResponse = await fetch(`${baseUrl}/training/policy`, {
      headers: authorization(employeeToken),
    });
    assert.equal(policyResponse.status, 200);
    assert.equal((await policyResponse.json()).accepted, false);
    const acceptanceResponse = await fetch(
      `${baseUrl}/training/policy/accept`,
      {
        method: 'POST',
        headers: authorization(employeeToken),
      },
    );
    assert.equal(acceptanceResponse.status, 201);
    assert.equal((await acceptanceResponse.json()).accepted, true);

    const operationsToken = await login(
      baseUrl,
      fixture.users.operations,
    );
    const summaryResponse = await fetch(summaryUrl, {
      headers: authorization(operationsToken),
    });
    assert.equal(summaryResponse.status, 200);
    const summaryText = await summaryResponse.text();
    const summary = JSON.parse(summaryText);
    assert.equal(summary.training.status, 'enabled');
    assert.equal(summary.audioPrivacy.status, 'VERIFIED');
    assert.equal(typeof summary.activeAttempts, 'number');
    assert.equal('payloadJson' in summary, false);
    for (const forbidden of [
      'training-stage10-private-payload',
      'transcript',
      'bucket',
      'secret',
    ]) {
      assert.equal(summaryText.includes(forbidden), false, forbidden);
    }

    const missingRetry = await fetch(
      `${baseUrl}/training/admin/operations/jobs/${randomUUID()}/retry`,
      {
        method: 'POST',
        headers: {
          ...authorization(operationsToken),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ reason: 'Checked by operator' }),
      },
    );
    assert.equal(missingRetry.status, 404);

    const retryResponse = await fetch(
      `${baseUrl}/training/admin/operations/jobs/${fixture.jobId}/retry`,
      {
        method: 'POST',
        headers: {
          ...authorization(operationsToken),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ reason: 'Checked by operator' }),
      },
    );
    assert.equal(retryResponse.status, 201);
    assert.equal((await retryResponse.json()).job.status, 'PENDING');
    const retriedJob = await httpPrisma.trainingJob.findUniqueOrThrow({
      where: { id: fixture.jobId },
    });
    assert.equal(retriedJob.status, TrainingJobStatus.PENDING);
    assert.equal(retriedJob.payloadJson.marker, 'training-stage10-private-payload');
    assert.equal(
      await httpPrisma.auditLog.count({
        where: {
          actorUserId: fixture.users.operations.id,
          action: 'training.operations.job.retry',
          entityId: fixture.jobId,
        },
      }),
      1,
    );
    await httpPrisma.trainingJob.delete({
      where: { id: fixture.jobId },
    });
  } finally {
    await app.close();
    restoreEnvironment('JWT_ACCESS_SECRET', originalAccessSecret);
    restoreEnvironment('JWT_REFRESH_SECRET', originalRefreshSecret);
  }
});

function createEngine(policyService) {
  return new TrainingAttemptEngineService(
    prisma,
    new MutableTrainingClock(new Date('2026-07-28T10:00:00.000Z')),
    new DeterministicQuestionSelector(),
    new DeterministicFakeTrainingTranscriptionProvider(),
    new DeterministicFakeTrainingEvaluationProvider(),
    undefined,
    undefined,
    false,
    {
      isEnabled: () => true,
      assertEnabled: () => undefined,
    },
    policyService,
  );
}

async function createHttpFixture(httpPrisma) {
  const unique = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const password = 'TrainingStage10!1';
  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
  });
  const permissionKeys = [
    'training:projects:read',
    'training:take',
    'training:operations:read',
    'training:operations:manage',
  ];
  const permissions = {};
  for (const key of permissionKeys) {
    permissions[key] = await httpPrisma.permission.upsert({
      where: { key },
      update: {},
      create: { key, description: key },
    });
  }
  const rolePermissions = {
    noPermission: [],
    employee: [
      permissions['training:projects:read'].id,
      permissions['training:take'].id,
    ],
    operations: [
      permissions['training:operations:read'].id,
      permissions['training:operations:manage'].id,
    ],
  };
  const users = {};
  for (const [name, permissionIds] of Object.entries(rolePermissions)) {
    const role = await httpPrisma.role.create({
      data: {
        name: `training-stage10-http-${name}-${unique}`,
        permissions: {
          create: permissionIds.map((permissionId) => ({ permissionId })),
        },
      },
    });
    const email =
      `training-stage10-http-${name.toLowerCase()}-${unique}@example.test`;
    const user = await httpPrisma.user.create({
      data: {
        email,
        passwordHash,
        name,
        status: UserStatus.ACTIVE,
        roleId: role.id,
      },
    });
    users[name] = { id: user.id, email, password };
  }
  const attempt = await httpPrisma.trainingAttempt.findFirstOrThrow({
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  const job = await httpPrisma.trainingJob.create({
    data: {
      kind: TrainingJobKind.FINALIZE_ATTEMPT,
      status: TrainingJobStatus.FAILED,
      payloadJson: {
        attemptId: attempt.id,
        marker: 'training-stage10-private-payload',
      },
      idempotencyKey: `training-stage10-http-${unique}`,
      lastErrorCode: 'SAFE_STAGE10_FAILURE',
      lastErrorMessage: 'generic failure',
    },
  });
  return { jobId: job.id, users };
}

async function login(baseUrl, credentials) {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: credentials.email,
      password: credentials.password,
    }),
  });
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  return JSON.parse(responseText).accessToken;
}

function authorization(token) {
  return { authorization: `Bearer ${token}` };
}

function restoreEnvironment(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function createFixture() {
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const role = await prisma.role.create({
    data: {
      name: `training-stage10-${unique}`,
      description: 'Stage 10 integration role',
    },
  });
  const createUser = (suffix, status = UserStatus.ACTIVE) =>
    prisma.user.create({
      data: {
        email: `training-stage10-${suffix}-${unique}@example.test`,
        passwordHash: 'not-used-in-domain-test',
        name: `Stage 10 ${suffix}`,
        status,
        roleId: role.id,
      },
    });
  const [publisher, user, telegramUser, blockedUser, deactivatedUser] =
    await Promise.all([
      createUser('publisher'),
      createUser('employee'),
      createUser('telegram'),
      createUser('blocked', UserStatus.BLOCKED),
      createUser('deactivated', UserStatus.DEACTIVATED),
    ]);
  const project = await prisma.trainingProject.create({
    data: {
      slug: `training-stage10-${unique}`,
      title: 'Stage 10 policy project',
      status: TrainingProjectStatus.DRAFT,
    },
  });
  const version = await prisma.trainingProjectVersion.create({
    data: {
      projectId: project.id,
      versionNumber: 1,
      status: TrainingVersionStatus.DRAFT,
      passScore: 75,
      attemptLimit: 3,
      cooldownMinutes: 60,
      totalTimeLimitSeconds: 420,
      finishGraceSeconds: 90,
      warningSecondsJson: [60, 20],
      allowRetakeAfterPass: true,
    },
  });
  await prisma.trainingQuestion.create({
    data: {
      projectVersionId: version.id,
      type: TrainingQuestionType.MAIN,
      text: 'Главный вопрос',
      position: 1,
      maxScore: 55,
    },
  });
  await prisma.trainingQuestion.createMany({
    data: Array.from({ length: 10 }, (_, index) => ({
      projectVersionId: version.id,
      type: TrainingQuestionType.FOLLOW_UP,
      text: `Дополнительный вопрос ${index + 1}`,
      position: index + 1,
      maxScore: 15,
    })),
  });
  await prisma.trainingProjectVersion.update({
    where: { id: version.id },
    data: {
      status: TrainingVersionStatus.PUBLISHED,
      publishedById: publisher.id,
      publishedAt: new Date('2026-07-27T10:00:00.000Z'),
    },
  });
  await prisma.trainingProject.update({
    where: { id: project.id },
    data: {
      status: TrainingProjectStatus.OPEN,
      activeVersionId: version.id,
    },
  });
  const firstPolicy = await prisma.trainingPolicyVersion.create({
    data: {
      version: `stage10-v1-${unique}`,
      title: 'Stage 10 policy v1',
      body: 'Initial policy body',
      checksum: '1'.repeat(64),
      effectiveAt: new Date('2026-07-27T00:00:00.000Z'),
      isActive: true,
      approvalStatus: 'APPROVED',
      createdById: publisher.id,
    },
  });
  return {
    unique,
    publisherId: publisher.id,
    userId: user.id,
    telegramUserId: telegramUser.id,
    blockedUserId: blockedUser.id,
    deactivatedUserId: deactivatedUser.id,
    projectId: project.id,
    firstPolicyId: firstPolicy.id,
  };
}
