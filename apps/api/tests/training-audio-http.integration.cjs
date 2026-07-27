require('reflect-metadata');

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const test = require('node:test');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const argon2 = require('argon2');
const {
  TrainingAnswerStatus,
  TrainingAttemptQuestionStatus,
  TrainingAttemptStatus,
  TrainingProjectStatus,
  TrainingQuestionType,
  TrainingVersionStatus,
  UserStatus,
} = require('@prisma/client');

const { AuthModule } = require('../dist/auth/auth.module.js');
const { FilesService } = require('../dist/files/files.service.js');
const { PrismaModule } = require('../dist/prisma/prisma.module.js');
const { PrismaService } = require('../dist/prisma/prisma.service.js');
const {
  TrainingAudioAccessService,
} = require('../dist/training/audio/training-audio-access.service.js');
const {
  TrainingAudioController,
} = require('../dist/training/audio/training-audio.controller.js');

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL must point to the runner-created isolated training database',
  );
}

test('real HTTP audio endpoint enforces JWT, permissions, scope, private response and audit', async () => {
  const originalAccessSecret = process.env.JWT_ACCESS_SECRET;
  const originalRefreshSecret = process.env.JWT_REFRESH_SECRET;
  process.env.JWT_ACCESS_SECRET = 'training-audio-http-access-test-secret';
  process.env.JWT_REFRESH_SECRET = 'training-audio-http-refresh-test-secret';

  const audio = Buffer.from('private-training-audio-http-fixture');
  const checksum = createHash('sha256').update(audio).digest('hex');
  const storage = {
    async readStoredFile(file) {
      assert.equal(file.bucket, 'training-audio-http-private');
      assert.equal(file.key, 'training-audio/http/merged.wav');
      assert.equal(file.url, null);
      return audio;
    },
  };

  class TrainingAudioHttpTestModule {}
  Module({
    imports: [PrismaModule, AuthModule],
    controllers: [TrainingAudioController],
    providers: [
      TrainingAudioAccessService,
      {
        provide: FilesService,
        useValue: storage,
      },
    ],
  })(TrainingAudioHttpTestModule);

  const app = await NestFactory.create(TrainingAudioHttpTestModule, {
    logger: false,
  });
  let prisma;
  try {
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);
    const fixture = await createHttpFixture(prisma, {
      audio,
      checksum,
    });
    const address = app.getHttpServer().address();
    assert.equal(typeof address, 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const endpoint = `${baseUrl}/training/admin/answers/${fixture.answerId}/audio`;

    const unauthorized = await fetch(endpoint);
    assert.equal(unauthorized.status, 401);

    const employeeToken = await login(
      baseUrl,
      fixture.users.employee,
    );
    const employee = await fetch(endpoint, {
      headers: authorization(employeeToken),
    });
    assert.equal(employee.status, 403);

    const outsideToken = await login(
      baseUrl,
      fixture.users.outside,
    );
    const outside = await fetch(endpoint, {
      headers: authorization(outsideToken),
    });
    assert.equal(outside.status, 404);

    const auditBefore = await prisma.auditLog.count({
      where: {
        action: 'training.audio.read',
        entityId: fixture.answerId,
      },
    });
    for (const role of ['trainingAdmin', 'admin']) {
      const token = await login(baseUrl, fixture.users[role]);
      const response = await fetch(endpoint, {
        headers: {
          ...authorization(token),
          'user-agent': `training-audio-http-${role}`,
        },
      });
      assert.equal(response.status, 200, role);
      assert.equal(response.headers.get('content-type'), 'audio/wav');
      assert.equal(
        response.headers.get('content-length'),
        String(audio.length),
      );
      assert.equal(
        response.headers.get('cache-control'),
        'private, no-store',
      );
      assert.equal(
        response.headers.get('x-content-type-options'),
        'nosniff',
      );
      const responseBody = Buffer.from(await response.arrayBuffer());
      assert.deepEqual(responseBody, audio);
      assert.equal(
        responseBody.includes(
          Buffer.from('training-audio/http/merged.wav'),
        ),
        false,
      );
      assert.equal(
        responseBody.includes(Buffer.from('http://')),
        false,
      );
    }

    const auditAfter = await prisma.auditLog.findMany({
      where: {
        action: 'training.audio.read',
        entityId: fixture.answerId,
      },
      orderBy: { createdAt: 'asc' },
    });
    assert.equal(auditAfter.length - auditBefore, 2);
    assert.deepEqual(
      auditAfter.slice(-2).map((entry) => entry.metadata.scope),
      ['administrative', 'administrative'],
    );

    const adminToken = await login(baseUrl, fixture.users.admin);
    const missing = await fetch(
      `${baseUrl}/training/admin/answers/${randomUUID()}/audio`,
      { headers: authorization(adminToken) },
    );
    assert.equal(missing.status, 404);
  } finally {
    await app.close();
    restoreEnvironment(
      'JWT_ACCESS_SECRET',
      originalAccessSecret,
    );
    restoreEnvironment(
      'JWT_REFRESH_SECRET',
      originalRefreshSecret,
    );
  }
});

async function createHttpFixture(prisma, { audio, checksum }) {
  const unique = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const password = 'TrainingAudio!1';
  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
  });
  const audioPermission = await prisma.permission.create({
    data: {
      key: `training:audio:read`,
      description: 'Read private training audio',
    },
  });
  const resultsPermission = await prisma.permission.create({
    data: {
      key: `training:results:read`,
      description: 'Read administrative training results',
    },
  });

  const roleDefinitions = {
    employee: [],
    owner: [audioPermission.id],
    outside: [audioPermission.id],
    trainingAdmin: [audioPermission.id, resultsPermission.id],
    admin: [audioPermission.id, resultsPermission.id],
  };
  const users = {};
  for (const [roleName, permissionIds] of Object.entries(
    roleDefinitions,
  )) {
    const role = await prisma.role.create({
      data: {
        name: `training-audio-http-${roleName}-${unique}`,
        permissions: {
          create: permissionIds.map((permissionId) => ({
            permissionId,
          })),
        },
      },
    });
    const email = `${roleName.toLowerCase()}-${unique}@example.test`;
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        name: roleName,
        status: UserStatus.ACTIVE,
        roleId: role.id,
      },
    });
    users[roleName] = {
      email,
      password,
      id: user.id,
    };
  }

  const project = await prisma.trainingProject.create({
    data: {
      slug: `training-audio-http-${unique}`,
      title: 'Training audio HTTP integration',
      status: TrainingProjectStatus.OPEN,
    },
  });
  const version = await prisma.trainingProjectVersion.create({
    data: {
      projectId: project.id,
      versionNumber: 1,
      status: TrainingVersionStatus.DRAFT,
    },
  });
  const question = await prisma.trainingQuestion.create({
    data: {
      projectVersionId: version.id,
      type: TrainingQuestionType.MAIN,
      text: 'HTTP audio question',
      position: 1,
      maxScore: 55,
    },
  });
  await prisma.trainingProjectVersion.update({
    where: { id: version.id },
    data: {
      status: TrainingVersionStatus.PUBLISHED,
      publishedById: users.admin.id,
      publishedAt: new Date(),
    },
  });
  await prisma.trainingProject.update({
    where: { id: project.id },
    data: { activeVersionId: version.id },
  });
  const startedAt = new Date(Date.now() - 1_000);
  const attempt = await prisma.trainingAttempt.create({
    data: {
      userId: users.owner.id,
      projectId: project.id,
      projectVersionId: version.id,
      attemptNumber: 1,
      status: TrainingAttemptStatus.COMPLETED,
      startedAt,
      expiresAt: new Date(Date.now() + 60_000),
      graceExpiresAt: new Date(Date.now() + 120_000),
      completedAt: new Date(),
      settingsSnapshotJson: {},
    },
  });
  const attemptQuestion = await prisma.trainingAttemptQuestion.create({
    data: {
      attemptId: attempt.id,
      questionId: question.id,
      sequence: 1,
      status: TrainingAttemptQuestionStatus.SCORED,
    },
  });
  const file = await prisma.file.create({
    data: {
      storage: 'MINIO',
      bucket: 'training-audio-http-private',
      key: 'training-audio/http/merged.wav',
      url: null,
      mimeType: 'audio/wav',
      sizeBytes: BigInt(audio.length),
      checksum,
    },
  });
  const answer = await prisma.trainingAnswer.create({
    data: {
      attemptQuestionId: attemptQuestion.id,
      status: TrainingAnswerStatus.SCORED,
      mergedAudioFileId: file.id,
      mergedAudioDurationMilliseconds: 1_000,
      audioPreparedAt: new Date(),
    },
  });

  return {
    answerId: answer.id,
    users,
  };
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
  const payload = JSON.parse(responseText);
  assert.equal(typeof payload.accessToken, 'string');
  return payload.accessToken;
}

function authorization(token) {
  return { authorization: `Bearer ${token}` };
}

function restoreEnvironment(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
