require('reflect-metadata');

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const { NestFactory } = require('@nestjs/core');
const { JwtService } = require('@nestjs/jwt');
const { PrismaClient } = require('@prisma/client');

const databaseUrl = process.env.TRAINING_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('Training Stage 5 Part 2 HTTP scenarios require the targeted temporary database runner', () => {
    assert.equal(process.env.TRAINING_TEST_DATABASE_URL, undefined);
  });
} else {
  process.env.DATABASE_URL = databaseUrl;
  process.env.FEED_AUTO_IMPORT_ENABLED = 'false';
  process.env.JWT_ACCESS_SECRET = 'training-v2-stage5-part2-http-secret';
  process.env.TRAINING_AI_MODE = 'fake';
  process.env.TELEGRAM_TRANSPORT_MODE = 'fake';

  const { TrainingModule } = require('../dist/training/training.module.js');
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const jwt = new JwtService();
  let app;
  let baseUrl;
  let readerToken;
  let deniedToken;

  before(async () => {
    await prisma.$connect();
    const reader = await createUser('reader', ['training:results:read']);
    const denied = await createUser('denied', []);
    readerToken = sign(reader);
    deniedToken = sign(denied);
    app = await NestFactory.create(TrainingModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  });

  after(async () => { await app?.close(); await prisma.$disconnect(); });

  test('Stage 5 Part 2 ranking and CSV use the independent results-read permission', async () => {
    assert.equal((await request('/training/admin/ranking')).status, 401);
    assert.equal((await request('/training/admin/ranking', deniedToken)).status, 403);
    assert.equal((await request('/training/admin/ranking/export.csv', deniedToken)).status, 403);

    const ranking = await request('/training/admin/ranking?page=1&limit=5', readerToken);
    assert.equal(ranking.status, 200);
    assert.equal(Array.isArray(ranking.json.items), true);
    assert.ok(ranking.json.items.length > 0);
    assert.doesNotMatch(JSON.stringify(ranking.json), /passwordHash|refreshToken|answerText|transcript|requestId|bucket|key/iu);

    const csv = await request('/training/admin/ranking/export.csv?currentlyEligible=true', readerToken);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /^text\/csv/iu);
    assert.match(csv.headers.get('content-disposition'), /training-ranking\.csv/iu);
    assert.equal(csv.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual([...csv.body.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  });

  async function createUser(label, permissions) {
    const role = await prisma.role.create({ data: { name: `ranking-http-${label}-${randomUUID()}` } });
    for (const key of permissions) {
      const permission = await prisma.permission.upsert({ where: { key }, update: {}, create: { key } });
      await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    }
    return prisma.user.create({ data: { email: `${label}-${randomUUID()}@ranking-http.test`, passwordHash: 'not-used', name: label, status: 'ACTIVE', roleId: role.id } });
  }

  function sign(user) {
    return jwt.sign({ sub: user.id, email: user.email, type: 'access' }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '15m' });
  }

  async function request(path, token) {
    const response = await fetch(`${baseUrl}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const contentType = response.headers.get('content-type') ?? '';
    const body = contentType.includes('application/json')
      ? await response.json()
      : Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, json: contentType.includes('application/json') ? body : null, body };
  }
}
