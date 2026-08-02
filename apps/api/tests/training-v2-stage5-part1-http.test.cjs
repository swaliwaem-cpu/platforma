require('reflect-metadata');

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const { NestFactory } = require('@nestjs/core');
const { JwtService } = require('@nestjs/jwt');
const { PrismaClient, UserStatus } = require('@prisma/client');

const databaseUrl = process.env.TRAINING_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('Training Stage 5 Part 1 HTTP scenarios require the targeted temporary database runner', () => {
    assert.equal(process.env.TRAINING_TEST_DATABASE_URL, undefined);
  });
} else {
  process.env.DATABASE_URL = databaseUrl;
  process.env.FEED_AUTO_IMPORT_ENABLED = 'false';
  process.env.JWT_ACCESS_SECRET = 'training-v2-stage5-http-secret';
  process.env.TRAINING_AI_MODE = 'fake';
  process.env.TELEGRAM_TRANSPORT_MODE = 'fake';
  process.env.TRAINING_AUDIO_BUCKET = 'platforma-training-audio-stage5-test';

  const { S3StorageService } = require('../dist/files/s3-storage.service.js');
  const { TrainingModule } = require('../dist/training/training.module.js');
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const jwt = new JwtService();
  let app;
  let baseUrl;
  let employeeToken;
  let employeeId;
  let strangerToken;
  let resultsToken;
  let audioToken;
  let attemptId;
  let answerId;
  let audioKey;

  before(async () => {
    await prisma.$connect();
    const employee = await createUser('employee', ['training:participate']);
    employeeId = employee.id;
    const stranger = await createUser('stranger', ['training:participate']);
    const resultsReader = await createUser('results', ['training:results:read']);
    const audioReader = await createUser('audio', ['training:results:read', 'training:audio:read']);
    employeeToken = sign(employee);
    strangerToken = sign(stranger);
    resultsToken = sign(resultsReader);
    audioToken = sign(audioReader);

    const project = await prisma.trainingProject.create({
      data: {
        title: 'Stage 5 HTTP result',
        status: 'PUBLISHED',
        accessMode: 'ALL_PARTICIPANTS',
        isOpen: true,
        allowRetakeAfterPass: true,
      },
    });
    const startedAt = new Date('2026-08-02T10:00:00.000Z');
    const completedAt = new Date('2026-08-02T10:02:00.000Z');
    const attempt = await prisma.trainingAttempt.create({
      data: {
        userId: employee.id,
        projectId: project.id,
        attemptNumber: 1,
        startIdempotencyKey: randomUUID(),
        status: 'COMPLETED',
        completionReason: 'COMPLETED',
        startedAt,
        expiresAt: new Date('2026-08-02T10:07:00.000Z'),
        completedAt,
        finalScore: 88,
        isPassed: true,
        calculatedScore: 88,
        projectSnapshotJson: snapshot(project.title),
        fakeEvaluationVersion: 'training-v2-fake-v1',
      },
    });
    attemptId = attempt.id;
    const question = await prisma.trainingAttemptQuestion.create({
      data: {
        attemptId: attempt.id,
        sequence: 1,
        type: 'MAIN',
        questionTextSnapshot: 'Question',
        maxScore: 55,
        status: 'ANSWERED',
        presentedAt: startedAt,
        answeredAt: completedAt,
      },
    });
    answerId = randomUUID();
    audioKey = `training-v2/answers/${answerId}/merged.wav`;
    const wav = Buffer.alloc(48);
    wav.write('RIFF', 0, 'ascii');
    wav.write('WAVE', 8, 'ascii');
    const checksum = createHash('sha256').update(wav).digest('hex');
    const file = await prisma.file.create({
      data: {
        storage: 'MINIO',
        bucket: process.env.TRAINING_AUDIO_BUCKET,
        key: audioKey,
        url: null,
        originalName: 'merged.wav',
        mimeType: 'audio/wav',
        sizeBytes: BigInt(wav.length),
        checksum,
      },
    });
    await prisma.trainingAnswer.create({
      data: {
        id: answerId,
        attemptQuestionId: question.id,
        source: 'TELEGRAM',
        processingStatus: 'COMPLETED',
        text: 'Ответ сотрудника',
        score: 55,
        fakeOutcome: 'SCORED',
        safeBreakdownJson: {
          version: 'training-v2-fake-v1',
          basis: 'FAKE_PASS',
          awardedScore: 55,
          maxScore: 55,
        },
        transcriptionStatus: 'COMPLETED',
        evaluationStatus: 'COMPLETED',
        submittedAt: completedAt,
        mergedAudioFileId: file.id,
      },
    });
    await prisma.trainingAttempt.create({
      data: {
        userId: employee.id,
        projectId: project.id,
        attemptNumber: 2,
        startIdempotencyKey: randomUUID(),
        status: 'REQUIRES_REVIEW',
        completionReason: 'COMPLETED',
        startedAt: new Date('2026-08-02T11:00:00.000Z'),
        expiresAt: new Date('2026-08-02T11:07:00.000Z'),
        completedAt: new Date('2026-08-02T11:04:00.000Z'),
        calculatedScore: 76,
        finalScore: null,
        isPassed: null,
        reviewStatus: 'PENDING',
        projectSnapshotJson: snapshot(project.title),
        fakeEvaluationVersion: 'training-v2-fake-v1',
      },
    });

    app = await NestFactory.create(TrainingModule, { logger: false });
    await app.get(S3StorageService).putObject({
      bucket: process.env.TRAINING_AUDIO_BUCKET,
      key: audioKey,
      body: wav,
      contentType: 'audio/wav',
    });
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  });

  after(async () => {
    if (app && audioKey) {
      await app.get(S3StorageService).deleteObject(audioKey, process.env.TRAINING_AUDIO_BUCKET).catch(() => {});
    }
    await app?.close();
    await prisma.$disconnect();
  });

  test('Stage 5 Part 1 HTTP enforces independent results and audio permissions', async () => {
    assert.equal((await request('/training/admin/results')).status, 401);
    assert.equal((await request('/training/admin/results', employeeToken)).status, 403);
    const results = await request(`/training/admin/results?page=1&limit=20&passed=true&userId=${employeeId}`, resultsToken);
    assert.equal(results.status, 200);
    assert.equal(results.json.total, 1);
    assert.equal(results.json.items[0].id, attemptId);
    assert.doesNotMatch(JSON.stringify(results.json), /text|evaluation|audio|bucket|key/iu);
    assert.equal((await request(`/training/admin/attempts/${randomUUID()}`, resultsToken)).status, 404);

    const ownHistory = await request('/training/attempts', employeeToken);
    assert.equal(ownHistory.status, 200);
    assert.equal(ownHistory.json.items.length, 2);
    const pending = ownHistory.json.items.find((item) => item.status === 'REQUIRES_REVIEW');
    assert.equal(pending.finalScore, null);
    assert.equal(pending.isPassed, null);
    assert.deepEqual(pending.safeBreakdown, []);
    assert.equal(pending.message, 'Результат проверяется.');
    assert.doesNotMatch(
      JSON.stringify(ownHistory.json),
      /calculatedScore|transcript|evaluation|objectiveMetrics|requestId|audioAvailable|mergedAudio|bucket|checksum|reviewComment|reviewedBy/iu,
    );
    assert.equal((await request(`/training/attempts/${attemptId}`, employeeToken)).status, 200);
    assert.equal((await request(`/training/attempts/${attemptId}`, strangerToken)).status, 404);

    const path = `/training/admin/answers/${answerId}/audio`;
    assert.equal((await request(path, resultsToken)).status, 403);
    assert.equal((await request(path, employeeToken)).status, 403);
    const audio = await request(path, audioToken);
    assert.equal(audio.status, 200);
    assert.equal(audio.headers.get('content-type'), 'audio/wav');
    assert.equal(audio.headers.get('cache-control'), 'private, no-store');
    assert.equal(audio.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(audio.body.toString('ascii', 0, 4), 'RIFF');
    assert.equal(
      await prisma.auditLog.count({
        where: { actorUserId: tokenUserId(audioToken), action: 'training.audio.read', entityId: answerId },
      }),
      1,
    );
  });

  async function createUser(label, permissions) {
    const role = await prisma.role.create({
      data: { name: `stage5-http-${label}-${randomUUID().slice(0, 8)}`, description: 'Stage 5 HTTP role' },
    });
    await prisma.permission.createMany({
      data: permissions.map((key) => ({ key, description: key })),
      skipDuplicates: true,
    });
    for (const key of permissions) {
      const permission = await prisma.permission.findUniqueOrThrow({ where: { key } });
      await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    }
    return prisma.user.create({
      data: {
        email: `${label}-${randomUUID()}@training-stage5-http.test`,
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

  function snapshot(projectTitle) {
    return {
      schemaVersion: 1,
      projectTitle,
      settings: { attemptLimit: 3, timeLimitSeconds: 420, passScore: 75, allowRetakeAfterPass: true },
      questions: [
        { sourceQuestionId: randomUUID(), type: 'MAIN', text: 'Main', position: 1 },
        ...Array.from({ length: 10 }, (_, index) => ({
          sourceQuestionId: randomUUID(),
          type: 'FOLLOW_UP',
          text: `Follow-up ${index + 1}`,
          position: index + 1,
        })),
      ],
    };
  }

  function tokenUserId(token) {
    return jwt.decode(token).sub;
  }

  async function request(path, token) {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    const body = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') ?? '';
    return {
      status: response.status,
      headers: response.headers,
      body,
      json: contentType.includes('application/json') ? JSON.parse(body.toString('utf8')) : null,
    };
  }
}
