require('reflect-metadata');

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const { NestFactory } = require('@nestjs/core');
const { JwtService } = require('@nestjs/jwt');
const { PrismaClient, UserStatus } = require('@prisma/client');

const databaseUrl = process.env.TRAINING_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('Training Stage 4.5 HTTP scenarios require the targeted temporary database runner', () => {
    assert.equal(process.env.TRAINING_TEST_DATABASE_URL, undefined);
  });
} else {
  process.env.DATABASE_URL = databaseUrl;
  process.env.FEED_AUTO_IMPORT_ENABLED = 'false';
  process.env.JWT_ACCESS_SECRET = 'training-v2-stage45-http-secret';
  process.env.TRAINING_AI_MODE = 'fake';
  process.env.TELEGRAM_TRANSPORT_MODE = 'fake';
  process.env.TELEGRAM_BOT_USERNAME = 'platforma_training_bot';

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
    admin = await createUser('http-admin', ['training:projects:manage']);
    employee = await createUser('http-employee', ['training:participate']);
    stranger = await createUser('http-stranger', ['training:participate']);
    adminToken = sign(admin);
    employeeToken = sign(employee);
    strangerToken = sign(stranger);
    app = await NestFactory.create(TrainingModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  });

  after(async () => {
    await app?.close();
    await prisma.$disconnect();
  });

  test('Stage 4.5 HTTP enforces RBAC, safe picker and atomic bulk access', async () => {
    assert.equal((await request('/training/admin/projects')).status, 401);

    const project = await createProject('Stage 4.5 HTTP');
    const pickerPath = `/training/admin/projects/${project.id}/assignment-users`;
    assert.equal((await request(pickerPath, { token: employeeToken })).status, 403);
    assert.equal(
      (await request(`/training/admin/projects/${project.id}/assignments/bulk`, {
        token: employeeToken,
        method: 'POST',
        body: { action: 'ASSIGN', userIds: [employee.id] },
      })).status,
      403,
    );

    const picker = await request(`${pickerPath}?page=1&limit=2&assigned=no&status=active&search=http`, {
      token: adminToken,
    });
    assert.equal(picker.status, 200);
    assert.equal(picker.body.limit, 2);
    assert.ok(picker.body.items.length > 0);
    assert.deepEqual(Object.keys(picker.body.items[0]).sort(), [
      'assignedAt',
      'canParticipate',
      'email',
      'isAssigned',
      'name',
      'status',
      'userId',
    ]);
    assert.doesNotMatch(JSON.stringify(picker.body), /passwordHash|roleId|telegramUserId|assignedById/);

    const missingUserId = randomUUID();
    const rejected = await request(`/training/admin/projects/${project.id}/assignments/bulk`, {
      token: adminToken,
      method: 'POST',
      body: { action: 'ASSIGN', userIds: [employee.id, missingUserId] },
    });
    assert.equal(rejected.status, 404);
    assert.equal(
      await prisma.trainingProjectAssignment.count({ where: { projectId: project.id, userId: employee.id } }),
      0,
    );

    const assigned = await request(`/training/admin/projects/${project.id}/assignments/bulk`, {
      token: adminToken,
      method: 'POST',
      body: { action: 'ASSIGN', userIds: [employee.id] },
    });
    assert.equal(assigned.status, 201);
    assert.equal(assigned.body.assigned, 1);

    const employeeProjects = await request('/training/projects', { token: employeeToken });
    const strangerProjects = await request('/training/projects', { token: strangerToken });
    assert.equal(employeeProjects.body.items.some((item) => item.id === project.id), true);
    assert.equal(strangerProjects.body.items.some((item) => item.id === project.id), false);

    const revoked = await request(`/training/admin/projects/${project.id}/assignments/bulk`, {
      token: adminToken,
      method: 'POST',
      body: { action: 'REVOKE', userIds: [employee.id] },
    });
    assert.equal(revoked.status, 201);
    assert.equal(revoked.body.revoked, 1);
    assert.equal(
      (await request(`/training/projects/${project.id}/attempts`, {
        token: employeeToken,
        method: 'POST',
        headers: { 'Idempotency-Key': randomUUID() },
        body: { confirmed: true },
      })).status,
      403,
    );
    assert.equal(
      (await request(`/training/projects/${project.id}/telegram-link`, {
        token: employeeToken,
        method: 'POST',
      })).status,
      403,
    );
  });

  test('mode-only PATCH keeps an open project open and records a bounded audit', async () => {
    const project = await createProject('Mode HTTP');
    const updated = await request(`/training/admin/projects/${project.id}`, {
      token: adminToken,
      method: 'PATCH',
      body: { accessMode: 'ALL_PARTICIPANTS' },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.accessMode, 'ALL_PARTICIPANTS');
    assert.equal(updated.body.isOpen, true);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: 'training_project', entityId: project.id },
      orderBy: { createdAt: 'desc' },
    });
    assert.equal(audit.action, 'training.project_access_mode.update');
    assert.doesNotMatch(JSON.stringify(audit.metadata), /email|telegram|userIds/iu);
  });

  test('full draft PATCH records the same bounded access-mode audit', async () => {
    const created = await request('/training/admin/projects', {
      token: adminToken,
      method: 'POST',
      body: { title: 'Full draft mode audit', allowRetakeAfterPass: true },
    });
    assert.equal(created.status, 201);
    const updated = await request(`/training/admin/projects/${created.body.id}`, {
      token: adminToken,
      method: 'PATCH',
      body: { ...draft('Full draft mode audit'), accessMode: 'ALL_PARTICIPANTS' },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.accessMode, 'ALL_PARTICIPANTS');
    const audits = await prisma.auditLog.findMany({
      where: {
        entityType: 'training_project',
        entityId: created.body.id,
        action: 'training.project_access_mode.update',
      },
    });
    assert.equal(audits.length, 1);
    assert.deepEqual(audits[0].metadata, {
      from: 'ASSIGNED_USERS',
      to: 'ALL_PARTICIPANTS',
    });
  });

  async function createProject(title) {
    const created = await request('/training/admin/projects', {
      token: adminToken,
      method: 'POST',
      body: { title, allowRetakeAfterPass: true },
    });
    assert.equal(created.status, 201);
    const projectId = created.body.id;
    const updated = await request(`/training/admin/projects/${projectId}`, {
      token: adminToken,
      method: 'PATCH',
      body: draft(title),
    });
    assert.equal(updated.status, 200);
    assert.equal((await request(`/training/admin/projects/${projectId}/publish`, {
      token: adminToken,
      method: 'POST',
    })).status, 201);
    const opened = await request(`/training/admin/projects/${projectId}`, {
      token: adminToken,
      method: 'PATCH',
      body: { isOpen: true },
    });
    assert.equal(opened.status, 200);
    return opened.body;
  }

  function draft(title) {
    return {
      title,
      description: null,
      realEstateObjectId: null,
      sortOrder: 0,
      attemptLimit: 3,
      timeLimitMinutes: 7,
      passScore: 75,
      allowRetakeAfterPass: true,
      accessMode: 'ASSIGNED_USERS',
      mainQuestion: `${title} main`,
      followUpQuestions: Array.from({ length: 10 }, (_, index) => `${title} follow-up ${index + 1}`),
      facts: Array.from({ length: 11 }, (_, index) => ({
        id: null,
        questionType: index === 0 ? 'MAIN' : 'FOLLOW_UP',
        questionPosition: index === 0 ? 1 : index,
        statement: `${title} fact ${index + 1}`,
        aliases: [`term ${index + 1}`],
        isRequired: true,
        position: 1,
      })),
      criteria: [
        { id: null, questionType: 'MAIN', code: 'main', title: 'Main', guidance: '', maxPoints: 55, position: 1 },
        { id: null, questionType: 'FOLLOW_UP', code: 'follow_up', title: 'Follow-up', guidance: '', maxPoints: 15, position: 1 },
      ],
    };
  }

  async function createUser(label, permissions) {
    const role = await prisma.role.create({
      data: { name: `stage45-${label}-${randomUUID().slice(0, 8)}`, description: 'Stage 4.5 HTTP role' },
    });
    for (const key of permissions) {
      const permission = await prisma.permission.upsert({
        where: { key },
        update: {},
        create: { key, description: key },
      });
      await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    }
    return prisma.user.create({
      data: {
        email: `${label}-${randomUUID()}@training-stage45-http.test`,
        passwordHash: 'test-hash',
        name: label,
        status: UserStatus.ACTIVE,
        roleId: role.id,
      },
    });
  }

  function sign(user) {
    return jwt.sign(
      { sub: user.id, email: user.email, type: 'access' },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '15m' },
    );
  }

  async function request(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...options.headers,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
}
