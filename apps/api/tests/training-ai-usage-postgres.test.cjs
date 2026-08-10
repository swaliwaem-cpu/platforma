require('reflect-metadata');

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const { NestFactory } = require('@nestjs/core');
const { JwtService } = require('@nestjs/jwt');
const {
  PrismaClient,
  TrainingQuestionType,
  UserStatus,
} = require('@prisma/client');

const databaseUrl = process.env.TRAINING_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('Training AI usage PostgreSQL scenarios require the targeted temporary database runner', () => {
    assert.equal(process.env.TRAINING_TEST_DATABASE_URL, undefined);
  });
} else {
  process.env.DATABASE_URL = databaseUrl;
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET = 'training-ai-usage-http-secret';
  process.env.TRAINING_AI_MODE = 'fake';
  process.env.TELEGRAM_TRANSPORT_MODE = 'fake';
  process.env.TRAINING_MATERIAL_WORKER_ENABLED = 'false';

  const { TrainingAiUsageService } = require('../dist/training/training-ai-usage.service.js');
  const { TrainingModule } = require('../dist/training/training.module.js');
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const jwt = new JwtService();
  let app;
  let baseUrl;
  let reader;
  let employee;
  let project;
  let question;
  let attempt;
  let operationRunId;

  before(async () => {
    await prisma.$connect();
    await clearData();
    reader = await createUser('ai-usage-reader', ['training:results:read']);
    employee = await createUser('ai-usage-employee', ['training:participate']);
    project = await prisma.trainingProject.create({
      data: {
        title: 'AI usage project',
        attemptLimit: 3,
        timeLimitSeconds: 420,
        passScore: 75,
        allowRetakeAfterPass: false,
      },
    });
    question = await prisma.trainingQuestion.create({
      data: {
        projectId: project.id,
        type: TrainingQuestionType.MAIN,
        text: 'Главный вопрос',
        position: 1,
      },
    });
    attempt = await prisma.trainingAttempt.create({
      data: {
        userId: employee.id,
        projectId: project.id,
        attemptNumber: 1,
        startIdempotencyKey: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
        projectSnapshotJson: { schemaVersion: 1, projectTitle: project.title },
        fakeEvaluationVersion: 'test-v1',
      },
    });

    const service = new TrainingAiUsageService(prisma);
    operationRunId = randomUUID();
    const occurredAt = new Date(Date.now() - 1_000);
    assert.equal(await service.record(recordInput({
      operationRunId,
      projectId: project.id,
      attemptId: attempt.id,
      questionId: question.id,
      attemptOrdinal: 3,
      outcome: 'provider_error',
      errorCode: 'OPENAI_RATE_LIMITED',
      httpStatus: 429,
      isRetry: true,
      occurredAt,
    })), true);
    assert.equal(await service.record(recordInput({
      operationRunId,
      projectId: project.id,
      attemptId: attempt.id,
      questionId: question.id,
      attemptOrdinal: 1,
      outcome: 'accepted',
      occurredAt,
    })), true);
    assert.equal(await service.record(recordInput({
      operationRunId,
      projectId: project.id,
      attemptId: attempt.id,
      questionId: question.id,
      attemptOrdinal: 2,
      outcome: 'local_validation_failed',
      errorCode: 'LOCAL_SCHEMA_INVALID',
      fallbackReason: 'luna_local_validation_failed',
      isRetry: false,
      isFallback: true,
      occurredAt,
    })), true);
    assert.equal(await service.record(recordInput({
      operationRunId,
      projectId: project.id,
      attemptId: attempt.id,
      questionId: question.id,
      attemptOrdinal: 1,
      outcome: 'accepted',
      responseId: 'duplicate-response',
      occurredAt,
    })), true);

    app = await NestFactory.create(TrainingModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  });

  after(async () => {
    await app?.close();
    await clearData();
    await prisma.$disconnect();
  });

  test('durable writer deduplicates provider attempts and a fresh service reads aggregates', async () => {
    assert.equal(await prisma.trainingAiUsageEvent.count({ where: { operationRunId } }), 3);

    const restarted = new TrainingAiUsageService(prisma);
    const report = await restarted.report({
      from: new Date(Date.now() - 60_000),
      to: new Date(Date.now() + 60_000),
      projectId: project.id,
      attemptId: attempt.id,
      operationRunId: null,
    });

    assert.equal(report.totals.attempts, 3);
    assert.equal(report.totals.runs, 1);
    assert.equal(report.totals.acceptedAttempts, 1);
    assert.equal(report.totals.failedAttempts, 2);
    assert.equal(report.totals.retryAttempts, 1);
    assert.equal(report.totals.retryRate, 1);
    assert.equal(report.totals.extraCallRatio, 2);
    assert.equal(report.totals.fallbackAttempts, 1);
    assert.equal(report.totals.inputTokens, 300);
    assert.equal(report.totals.cachedTokens, 120);
    assert.equal(report.totals.cachedTokenRatio, 0.4);
    assert.equal(report.totals.errorRate, 0.6667);
    assert.equal(report.totals.retryOverhead.totalTokens, 150);
    assert.equal(report.totals.fallbackOverhead.totalTokens, 150);
    assert.equal(report.totals.estimatedCostUsd, 0.002199);
    assert.deepEqual(report.totals.pricingVersions, ['openai-standard-pricing-2026-08-07']);
    assert.equal(report.byOperation[0].operation, 'training_answer_evaluation');
    assert.equal(report.byModel[0].model, 'gpt-5.6-terra');
    assert.equal(report.byProject[0].projectId, project.id);
    assert.equal(report.recentRuns.items[0].operationRunId, operationRunId);
    assert.equal(report.recentRuns.items[0].attempts, 3);
    assert.doesNotMatch(JSON.stringify(report), /response-primary|duplicate-response|request-primary/u);
  });

  test('telemetry persistence fails open and logs only a safe database code', async () => {
    const service = new TrainingAiUsageService(prisma);
    const warnings = [];
    service.logger = { warn: (value) => warnings.push(value) };

    assert.equal(await service.record(recordInput({
      operationRunId: randomUUID(),
      projectId: randomUUID(),
      attemptId: null,
      questionId: null,
      attemptOrdinal: 1,
      outcome: 'accepted',
    })), false);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].event, 'training_ai_usage_persist_failed');
    assert.equal(typeof warnings[0].code, 'string');
    assert.deepEqual(Object.keys(warnings[0]).sort(), ['code', 'event', 'operation']);
  });

  test('daily report warns on a bounded token spike against the trailing baseline', async () => {
    const service = new TrainingAiUsageService(prisma);
    for (const [day, totalTokens] of [
      ['2026-08-03', 1_000],
      ['2026-08-04', 1_000],
      ['2026-08-05', 1_000],
      ['2026-08-06', 10_000],
    ]) {
      assert.equal(await service.record(recordInput({
        operationRunId: randomUUID(),
        projectId: project.id,
        attemptId: null,
        questionId: null,
        occurredAt: new Date(`${day}T12:00:00.000Z`),
        usage: {
          inputTokens: totalTokens * 0.8,
          cachedTokens: totalTokens * 0.2,
          cacheWriteTokens: 0,
          outputTokens: totalTokens * 0.2,
          reasoningTokens: 0,
          totalTokens,
        },
      })), true);
    }

    const report = await service.report({
      from: new Date('2026-08-03T00:00:00.000Z'),
      to: new Date('2026-08-07T00:00:00.000Z'),
      projectId: project.id,
      attemptId: null,
      operationRunId: null,
    });

    assert.deepEqual(report.warnings, [{
      code: 'DAILY_TOKEN_SPIKE',
      day: '2026-08-06',
      totalTokens: 10_000,
      baselineAverageTokens: 1_000,
      ratio: 10,
    }]);
  });

  test('admin AI usage HTTP endpoint enforces auth, permission and bounded query', async () => {
    assert.equal((await request('/training/admin/ai-usage')).status, 401);
    assert.equal((await request('/training/admin/ai-usage', sign(employee))).status, 403);
    const authorized = await request(
      `/training/admin/ai-usage?attemptId=${attempt.id}`,
      sign(reader),
    );
    assert.equal(authorized.status, 200, JSON.stringify(authorized.body));
    assert.equal(authorized.body.totals.attempts, 3);
    assert.equal(authorized.body.range.attemptId, attempt.id);
    assert.doesNotMatch(JSON.stringify(authorized.body), /response-primary|request-primary/u);

    const invalid = await request(
      '/training/admin/ai-usage?from=2025-01-01&to=2026-08-08',
      sign(reader),
    );
    assert.equal(invalid.status, 400);
  });

  function recordInput(overrides) {
    return {
      operationRunId: randomUUID(),
      operation: 'training_answer_evaluation',
      requestedModel: 'gpt-5.6-terra',
      model: 'gpt-5.6-terra',
      reasoningEffort: 'medium',
      promptVersion: 'training-evaluator-prompt-v2',
      compilerVersion: null,
      schemaVersion: 'training-v2-evaluation-v1',
      projectId: null,
      attemptId: null,
      questionId: null,
      attemptOrdinal: 1,
      clientRequestId: randomUUID(),
      requestId: 'request-primary',
      responseId: 'response-primary',
      httpStatus: 200,
      outcome: 'accepted',
      errorCode: null,
      fallbackReason: null,
      isRetry: false,
      isFallback: false,
      usage: {
        inputTokens: 100,
        cachedTokens: 40,
        cacheWriteTokens: 10,
        outputTokens: 50,
        reasoningTokens: 12,
        totalTokens: 150,
      },
      latencyMs: 100,
      ...overrides,
    };
  }

  async function createUser(label, permissionKeys) {
    const role = await prisma.role.create({
      data: { name: `${label}-${randomUUID()}`, description: label },
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
        email: `${label}-${randomUUID()}@training-ai-usage.test`,
        passwordHash: 'hash',
        name: label,
        status: UserStatus.ACTIVE,
        roleId: role.id,
      },
    });
  }

  function sign(user) {
    return jwt.sign({ sub: user.id, email: user.email, type: 'access' }, {
      secret: process.env.JWT_ACCESS_SECRET,
      expiresIn: '1h',
    });
  }

  async function request(path, token) {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return {
      status: response.status,
      body: await response.json().catch(() => null),
    };
  }

  async function clearData() {
    await prisma.trainingAiUsageEvent.deleteMany();
    await prisma.trainingAttemptQuestion.deleteMany();
    await prisma.trainingAttempt.deleteMany();
    await prisma.trainingQuestion.deleteMany();
    await prisma.trainingProject.deleteMany();
    await prisma.user.deleteMany({
      where: { email: { endsWith: '@training-ai-usage.test' } },
    });
    await prisma.role.deleteMany({
      where: { name: { startsWith: 'ai-usage-' } },
    });
  }
}
