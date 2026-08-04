require('reflect-metadata');

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const { NestFactory } = require('@nestjs/core');
const { JwtService } = require('@nestjs/jwt');
const {
  PrismaClient,
  TrainingAnswerProcessingStatus,
  TrainingAnswerSource,
  UserStatus,
} = require('@prisma/client');

const databaseUrl = process.env.TRAINING_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('Training Stage 3 HTTP scenarios require the targeted runner', () => {
    assert.equal(process.env.TRAINING_TEST_DATABASE_URL, undefined);
  });
} else {
  process.env.DATABASE_URL = databaseUrl;
  process.env.FEED_AUTO_IMPORT_ENABLED = 'false';
  process.env.JWT_ACCESS_SECRET = 'training-v2-stage3-http-secret';
  process.env.TRAINING_AI_MODE = 'fake';
  process.env.TELEGRAM_TRANSPORT_MODE = 'fake';
  delete process.env.OPENAI_API_KEY;

  const { TrainingModule } = require('../dist/training/training.module.js');
  const {
    TrainingAttemptStateService,
  } = require('../dist/training/training-attempt-state.service.js');
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const jwt = new JwtService();
  let app;
  let baseUrl;
  let state;
  let admin;
  let employee;
  let adminToken;
  let employeeToken;

  before(async () => {
    await prisma.$connect();
    await clearTrainingData();
    admin = await createUser('stage3-http-admin', [
      'admin:access',
      'training:participate',
      'training:projects:manage',
      'training:results:read',
      'training:results:review',
    ]);
    employee = await createUser('stage3-http-employee', ['training:participate']);
    adminToken = signAccessToken(admin);
    employeeToken = signAccessToken(employee);

    app = await NestFactory.create(TrainingModule, { logger: false });
    state = app.get(TrainingAttemptStateService);
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await app?.close();
    await clearTrainingData();
    await prisma.$disconnect();
  });

  test('project PATCH persists facts/criteria and publish rejects a project without facts', async () => {
    const emptyProject = await createProject('Stage 3 publish validation');
    const withoutFacts = projectDraft('Stage 3 publish validation');
    withoutFacts.facts = [];
    const emptyFactsDraft = await request(
      `/training/admin/projects/${emptyProject.id}`,
      {
        token: adminToken,
        method: 'PATCH',
        body: withoutFacts,
      },
    );
    assert.equal(emptyFactsDraft.status, 200);
    const invalidPublish = await request(
      `/training/admin/projects/${emptyProject.id}/publish`,
      { token: adminToken, method: 'POST' },
    );
    assert.equal(invalidPublish.status, 400);
    assert.match(JSON.stringify(invalidPublish.body), /факт/iu);

    const project = await createConfiguredProject('Stage 3 HTTP contract');
    assert.equal(project.facts.length, 11);
    assert.equal(
      project.criteria
        .filter((criterion) => criterion.questionType === 'MAIN')
        .reduce((sum, criterion) => sum + criterion.maxPoints, 0),
      55,
    );
    assert.equal(
      project.criteria
        .filter((criterion) => criterion.questionType === 'FOLLOW_UP')
        .reduce((sum, criterion) => sum + criterion.maxPoints, 0),
      15,
    );
  });

  test('review RBAC and serializers cover pending, override and technical failure states', async () => {
    const project = await createConfiguredProject('Stage 3 visibility');
    await request(`/training/admin/projects/${project.id}/publish`, {
      token: adminToken,
      method: 'POST',
    });
    await request(`/training/admin/projects/${project.id}`, {
      token: adminToken,
      method: 'PATCH',
      body: { isOpen: true },
    });

    const pending = await answerAttempt(
      await startAttempt(project.id),
      '[fake:review]',
    );
    assert.equal(pending.status, 'REQUIRES_REVIEW');
    assert.equal(pending.result.finalScore, null);
    assert.deepEqual(pending.result.safeBreakdown, []);
    assert.equal(pending.result.message, 'Требует проверки.');
    assertNoEmployeeInternals(pending);

    const denied = await request(`/training/admin/attempts/${pending.id}/review`, {
      token: employeeToken,
      method: 'POST',
      body: { decision: 'APPROVE' },
    });
    assert.equal(denied.status, 403);

    const adminDetail = await request(`/training/admin/attempts/${pending.id}`, {
      token: adminToken,
    });
    assert.equal(adminDetail.status, 200);
    assert.equal(typeof adminDetail.body.calculatedScore, 'number');
    assert.equal(adminDetail.body.finalScore, null);
    assert.equal(adminDetail.body.questions.every((question) => question.answer.text === '[fake:review]'), true);
    assert.equal(adminDetail.body.questions.every((question) => question.facts.length > 0), true);

    const approved = await request(`/training/admin/attempts/${pending.id}/review`, {
      token: adminToken,
      method: 'POST',
      body: { decision: 'APPROVE' },
    });
    const repeatedApprove = await request(`/training/admin/attempts/${pending.id}/review`, {
      token: adminToken,
      method: 'POST',
      body: { decision: 'APPROVE' },
    });
    assert.equal(approved.status, 201);
    assert.deepEqual(repeatedApprove.body, approved.body);
    assert.equal(approved.body.finalScore, approved.body.calculatedScore);
    const conflictingReview = await request(`/training/admin/attempts/${pending.id}/review`, {
      token: adminToken,
      method: 'POST',
      body: { decision: 'OVERRIDE', finalScore: 44, comment: 'Другой итог' },
    });
    assert.equal(conflictingReview.status, 409);

    const overriddenAttempt = await answerAttempt(
      await startAttempt(project.id),
      '[fake:review]',
    );
    const overridden = await request(
      `/training/admin/attempts/${overriddenAttempt.id}/review`,
      {
        token: adminToken,
        method: 'POST',
        body: {
          decision: 'OVERRIDE',
          finalScore: 44,
          comment: 'Итог проверен вручную',
        },
      },
    );
    assert.equal(overridden.status, 201);
    assert.equal(overridden.body.finalScore, 44);
    const employeeOverride = await request(
      `/training/attempts/${overriddenAttempt.id}`,
      { token: employeeToken },
    );
    assert.equal(employeeOverride.body.result.finalScore, 44);
    assert.deepEqual(employeeOverride.body.result.safeBreakdown, []);
    assert.equal(
      employeeOverride.body.result.message,
      'Итог скорректирован после проверки.',
    );
    assertNoEmployeeInternals(employeeOverride.body);

    const technicalAttempt = await startAttempt(project.id);
    const answer = await prisma.trainingAnswer.create({
      data: {
        attemptQuestionId: technicalAttempt.currentQuestion.id,
        source: TrainingAnswerSource.TELEGRAM,
        processingStatus: TrainingAnswerProcessingStatus.PROCESSING,
        submittedAt: new Date(),
      },
    });
    assert.equal(
      await state.failTelegramVoiceAttempt(
        answer.id,
        'OPENAI_UPSTREAM_FAILURE',
        'transcription',
        undefined,
        1,
      ),
      true,
    );
    const employeeTechnical = await request(
      `/training/attempts/${technicalAttempt.id}`,
      { token: employeeToken },
    );
    assert.equal(employeeTechnical.body.status, 'TECHNICAL_FAILED');
    assert.equal(employeeTechnical.body.result.finalScore, null);
    assert.equal(employeeTechnical.body.result.attemptRefunded, true);
    assert.equal(
      employeeTechnical.body.result.message,
      'Произошла техническая ошибка. Попытка возвращена.',
    );
    assertNoEmployeeInternals(employeeTechnical.body);
    const replacement = await startAttempt(project.id);
    assert.equal(replacement.attemptNumber, 4);
  });

  async function createProject(title) {
    const response = await request('/training/admin/projects', {
      token: adminToken,
      method: 'POST',
      body: { title, allowRetakeAfterPass: true },
    });
    assert.equal(response.status, 201);
    return response.body;
  }

  async function createConfiguredProject(title) {
    const created = await createProject(title);
    const response = await request(`/training/admin/projects/${created.id}`, {
      token: adminToken,
      method: 'PATCH',
      body: projectDraft(title),
    });
    assert.equal(response.status, 200);
    return response.body;
  }

  function projectDraft(title) {
    return {
      title,
      description: 'Stage 3 HTTP fixture',
      realEstateObjectId: null,
      sortOrder: 0,
      attemptLimit: 5,
      timeLimitMinutes: 7,
      passScore: 75,
      allowRetakeAfterPass: true,
      accessMode: 'ALL_PARTICIPANTS',
      mainQuestion: `${title}: главный вопрос`,
      followUpQuestions: Array.from(
        { length: 10 },
        (_, index) => `${title}: дополнительный вопрос ${index + 1}`,
      ),
      facts: Array.from({ length: 11 }, (_, index) => ({
        id: null,
        questionType: index === 0 ? 'MAIN' : 'FOLLOW_UP',
        questionPosition: index === 0 ? 1 : index,
        statement: `${title}: утверждённый факт ${index + 1}`,
        aliases: [`термин ${index + 1}`],
        isRequired: true,
        position: 1,
      })),
      criteria: [
        {
          id: null,
          questionType: 'MAIN',
          code: 'main_total',
          title: 'Основной ответ',
          guidance: '',
          maxPoints: 55,
          position: 1,
        },
        {
          id: null,
          questionType: 'FOLLOW_UP',
          code: 'follow_up_total',
          title: 'Дополнительный ответ',
          guidance: '',
          maxPoints: 15,
          position: 1,
        },
      ],
    };
  }

  async function startAttempt(projectId) {
    const response = await request(`/training/projects/${projectId}/attempts`, {
      token: employeeToken,
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID() },
      body: { confirmed: true },
    });
    assert.equal(response.status, 201);
    return response.body;
  }

  async function answerAttempt(initial, text) {
    let attempt = initial;
    while (attempt.currentQuestion) {
      const response = await request(`/training/attempts/${attempt.id}/answers`, {
        token: employeeToken,
        method: 'POST',
        body: { attemptQuestionId: attempt.currentQuestion.id, text },
      });
      assert.equal(response.status, 201);
      attempt = response.body;
    }
    return attempt;
  }

  function assertNoEmployeeInternals(value) {
    const serialized = JSON.stringify(value);
    assert.doesNotMatch(
      serialized,
      /transcript|evaluation|calculatedScore|reviewComment|OPENAI_|requestId|Model/iu,
    );
  }

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
        name: `training-s3-http-${label.slice(-8)}-${randomUUID().slice(0, 8)}`,
        description: 'Training Stage 3 HTTP test role',
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
    await prisma.trainingProjectAssignment.deleteMany();
    await prisma.trainingFact.deleteMany();
    await prisma.trainingCriterion.deleteMany();
    await prisma.trainingQuestion.deleteMany();
    await prisma.trainingProject.deleteMany();
    await prisma.user.deleteMany({ where: { email: { endsWith: '@training.test' } } });
    await prisma.role.deleteMany({ where: { name: { startsWith: 'training-s3-http-' } } });
  }
}
