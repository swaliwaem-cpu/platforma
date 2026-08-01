require('reflect-metadata');

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const { NestFactory } = require('@nestjs/core');
const { JwtService } = require('@nestjs/jwt');
const { PrismaClient, UserStatus } = require('@prisma/client');

const databaseUrl = process.env.TRAINING_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('Training HTTP scenarios require the targeted temporary database runner', () => {
    assert.equal(process.env.TRAINING_TEST_DATABASE_URL, undefined);
  });
} else {
  process.env.DATABASE_URL = databaseUrl;
  process.env.FEED_AUTO_IMPORT_ENABLED = 'false';
  process.env.JWT_ACCESS_SECRET = 'training-v2-http-test-secret';

  const { TrainingModule } = require('../dist/training/training.module.js');
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const jwt = new JwtService();
  let app;
  let baseUrl;
  let admin;
  let employee;
  let stranger;
  let adminToken;
  let employeeToken;
  let strangerToken;

  before(async () => {
    await prisma.$connect();
    await clearTrainingData();
    admin = await createUser('http-admin', [
      'admin:access',
      'training:participate',
      'training:projects:manage',
      'training:results:read',
    ]);
    employee = await createUser('http-employee', ['training:participate']);
    stranger = await createUser('http-stranger', ['training:participate']);
    adminToken = signAccessToken(admin);
    employeeToken = signAccessToken(employee);
    strangerToken = signAccessToken(stranger);

    app = await NestFactory.create(TrainingModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await app?.close();
    await clearTrainingData();
    await prisma.$disconnect();
  });

  test('real Nest HTTP enforces RBAC, ownership and the complete 1+3 contract', async () => {
    const anonymous = await request('/training/projects');
    assert.equal(anonymous.status, 401);

    const deniedManage = await request('/training/admin/projects', {
      token: employeeToken,
      method: 'POST',
      body: { title: 'Denied', allowRetakeAfterPass: true },
    });
    const deniedResults = await request('/training/admin/attempts', {
      token: employeeToken,
    });
    assert.equal(deniedManage.status, 403);
    assert.equal(deniedResults.status, 403);

    const created = await request('/training/admin/projects', {
      token: adminToken,
      method: 'POST',
      body: { title: 'HTTP Training', allowRetakeAfterPass: true },
    });
    assert.equal(created.status, 201);
    const projectId = created.body.id;

    const updated = await request(`/training/admin/projects/${projectId}`, {
      token: adminToken,
      method: 'PATCH',
      body: {
        title: 'HTTP Training',
        description: 'Stage 1',
        realEstateObjectId: null,
        sortOrder: 2,
        attemptLimit: 3,
        timeLimitMinutes: 7,
        passScore: 75,
        allowRetakeAfterPass: true,
        mainQuestion: 'Главный HTTP вопрос',
        followUpQuestions: Array.from(
          { length: 10 },
          (_, index) => `HTTP follow-up ${index + 1}`,
        ),
      },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.followUpQuestions.length, 10);

    assert.equal(
      (await request(`/training/admin/projects/${projectId}/publish`, {
        token: adminToken,
        method: 'POST',
      })).status,
      201,
    );
    assert.equal(
      (await request(`/training/admin/projects/${projectId}`, {
        token: adminToken,
        method: 'PATCH',
        body: { isOpen: true },
      })).body.isOpen,
      true,
    );

    const projects = await request('/training/projects', { token: employeeToken });
    assert.equal(projects.status, 200);
    assert.equal(projects.body.items.length, 1);
    assert.doesNotMatch(JSON.stringify(projects.body), /followUpQuestions|projectSnapshotJson/);

    let attempt = (
      await request(`/training/projects/${projectId}/attempts`, {
        token: employeeToken,
        method: 'POST',
        headers: { 'Idempotency-Key': randomUUID() },
        body: { confirmed: true },
      })
    ).body;
    assert.equal(attempt.currentQuestion.sequence, 1);
    assert.doesNotMatch(JSON.stringify(attempt), /HTTP follow-up|projectSnapshotJson/);

    const foreignProbe = await request(`/training/attempts/${attempt.id}`, {
      token: strangerToken,
    });
    assert.equal(foreignProbe.status, 404);

    for (let sequence = 1; sequence <= 4; sequence += 1) {
      const response = await request(`/training/attempts/${attempt.id}/answers`, {
        token: employeeToken,
        method: 'POST',
        body: {
          attemptQuestionId: attempt.currentQuestion.id,
          text: '[fake:pass]',
          score: 999,
          status: 'COMPLETED',
          isPassed: false,
          userId: stranger.id,
        },
      });

      assert.equal(response.status, 201);
      attempt = response.body;

      if (sequence < 4) {
        assert.equal(attempt.currentQuestion.sequence, sequence + 1);
      }
    }

    assert.equal(attempt.status, 'COMPLETED');
    assert.equal(attempt.result.finalScore, 100);
    assert.equal(attempt.result.isPassed, true);

    const employeeHistory = await request('/training/attempts', { token: employeeToken });
    const strangerHistory = await request('/training/attempts', { token: strangerToken });
    assert.equal(employeeHistory.body.items.length, 1);
    assert.equal(strangerHistory.body.items.length, 0);

    const adminAttempts = await request('/training/admin/attempts', { token: adminToken });
    const adminDetail = await request(`/training/admin/attempts/${attempt.id}`, {
      token: adminToken,
    });
    assert.equal(adminAttempts.status, 200);
    assert.equal(adminAttempts.body.items.length, 1);
    assert.equal(adminDetail.status, 200);
    assert.equal(adminDetail.body.questions.length, 4);
    assert.equal(adminDetail.body.questions.every((question) => question.answer.text === '[fake:pass]'), true);
  });

  async function request(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...options.headers,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const body = response.status === 204 ? null : await response.json();

    return { status: response.status, body };
  }

  function signAccessToken(user) {
    return jwt.sign(
      { sub: user.id, email: user.email, type: 'access' },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '1h' },
    );
  }

  async function createUser(label, permissionKeys) {
    const role = await prisma.role.create({
      data: {
        name: `training-test-${label}-${randomUUID()}`,
        description: 'Training HTTP test role',
      },
    });

    for (const key of permissionKeys) {
      const permission = await prisma.permission.upsert({
        where: { key },
        update: {},
        create: { key, description: key },
      });
      await prisma.rolePermission.create({
        data: { roleId: role.id, permissionId: permission.id },
      });
    }

    return prisma.user.create({
      data: {
        email: `${label}-${randomUUID()}@training.test`,
        passwordHash: 'test-hash',
        name: label,
        status: UserStatus.ACTIVE,
        roleId: role.id,
      },
    });
  }

  async function clearTrainingData() {
    await prisma.trainingAnswerSegment.deleteMany();
    await prisma.trainingAnswer.deleteMany();
    await prisma.trainingAttemptQuestion.deleteMany();
    await prisma.trainingAttempt.deleteMany();
    await prisma.trainingTelegramLinkToken.deleteMany();
    await prisma.trainingTelegramAccount.deleteMany();
    await prisma.trainingQuestion.deleteMany();
    await prisma.trainingProject.deleteMany();
    await prisma.user.deleteMany({ where: { email: { endsWith: '@training.test' } } });
    await prisma.role.deleteMany({ where: { name: { startsWith: 'training-test-' } } });
    await prisma.permission.deleteMany({
      where: {
        key: {
          in: [
            'training:participate',
            'training:projects:manage',
            'training:results:read',
          ],
        },
      },
    });
  }
}
