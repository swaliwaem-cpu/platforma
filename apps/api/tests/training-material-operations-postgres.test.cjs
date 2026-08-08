require('reflect-metadata');

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, beforeEach, describe, test } = require('node:test');
const {
  PrismaClient,
  TrainingMaterialOperationStatus,
  UserStatus,
} = require('@prisma/client');

const { TrainingMaterialOperationService } = require('../dist/training/training-material-operation.service.js');

const databaseUrl = process.env.TRAINING_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('Training material operation PostgreSQL scenarios require the targeted runner', () => {
    assert.equal(process.env.TRAINING_TEST_DATABASE_URL, undefined);
  });
} else {
  describe('Training material operation PostgreSQL worker', { concurrency: false }, () => {
    process.env.TRAINING_MODULE_ENABLED = 'true';
    process.env.TRAINING_MATERIAL_WORKER_ENABLED = 'false';
    process.env.TRAINING_MATERIAL_WORKER_CONCURRENCY = '2';
    process.env.TRAINING_MATERIAL_WORKER_STALE_LOCK_MS = '5000';

    const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

    before(async () => prisma.$connect());
    beforeEach(clearData);
    after(async () => {
      await clearData();
      await prisma.$disconnect();
    });

    test('same idempotency key creates one operation and rejects a different payload', async () => {
      const scenario = await createScenario('idempotency');
      const materials = new MaterialHarness(prisma);
      const worker = createWorker(materials);
      const idempotencyKey = randomUUID();
      const input = {
        projectId: scenario.project.id,
        actorId: scenario.user.id,
        idempotencyKey,
        title: 'Официальный источник',
        sourceUrl: 'https://example.test/source',
        officialConfirmed: true,
        replaceExistingQuestions: false,
      };

      const [first, repeated] = await Promise.all([
        worker.queueOfficialUrl(input),
        worker.queueOfficialUrl(input),
      ]);
      assert.equal(first.id, repeated.id);
      assert.equal(await prisma.trainingMaterialOperation.count(), 1);
      await assert.rejects(
        () => worker.queueOfficialUrl({ ...input, title: 'Другой источник' }),
        /IDEMPOTENCY_KEY_REUSED/u,
      );
    });

    test('SKIP LOCKED and global capacity let only one worker process an operation', async () => {
      const scenario = await createScenario('concurrency');
      const materials = new MaterialHarness(prisma, true);
      const firstWorker = createWorker(materials);
      const secondWorker = createWorker(materials);
      const operation = await queueUrl(firstWorker, scenario);
      const secondOperation = await firstWorker.queueOfficialUrl({
        projectId: scenario.project.id,
        actorId: scenario.user.id,
        idempotencyKey: randomUUID(),
        title: 'Second worker source',
        sourceUrl: 'https://example.test/worker-second',
        officialConfirmed: true,
        replaceExistingQuestions: false,
      });

      const firstRun = firstWorker.runOnce();
      await materials.waitUntilStarted();
      assert.equal(await secondWorker.runOnce(), false);
      assert.equal(materials.calls, 1);
      assert.equal((await prisma.trainingMaterialOperation.findUniqueOrThrow({
        where: { id: secondOperation.id },
      })).status, TrainingMaterialOperationStatus.QUEUED);
      materials.release();
      assert.equal(await firstRun, true);

      const completed = await prisma.trainingMaterialOperation.findUniqueOrThrow({
        where: { id: operation.id },
      });
      assert.equal(completed.status, TrainingMaterialOperationStatus.READY);
      assert.equal(completed.attempts, 1);
      assert.equal(completed.lockedBy, null);
    });

    test('a stale claim is recovered after restart with a fresh fencing token', async () => {
      const scenario = await createScenario('restart');
      const worker = createWorker(new MaterialHarness(prisma));
      const operation = await queueUrl(worker, scenario);
      await prisma.trainingMaterialOperation.update({
        where: { id: operation.id },
        data: {
          status: TrainingMaterialOperationStatus.GENERATING,
          attempts: 1,
          lockedAt: new Date(Date.now() - 10_000),
          lockedBy: 'dead-worker-token',
          startedAt: new Date(Date.now() - 10_000),
        },
      });

      assert.equal(await worker.runOnce(), true);
      const recovered = await prisma.trainingMaterialOperation.findUniqueOrThrow({
        where: { id: operation.id },
      });
      assert.equal(recovered.status, TrainingMaterialOperationStatus.READY);
      assert.equal(recovered.attempts, 2);
      assert.equal(recovered.lockedBy, null);
    });

    test('retry rebases a failed operation on the current project knowledge version', async () => {
      const scenario = await createScenario('retry-version');
      const worker = createWorker(new MaterialHarness(prisma));
      const operation = await queueUrl(worker, scenario);
      await prisma.trainingMaterialOperation.update({
        where: { id: operation.id },
        data: {
          status: TrainingMaterialOperationStatus.FAILED,
          errorCode: 'QUESTION_KNOWLEDGE_STALE',
          finishedAt: new Date(),
        },
      });
      const project = await prisma.trainingProject.update({
        where: { id: scenario.project.id },
        data: { knowledgeVersion: { increment: 1 } },
      });

      const retried = await worker.retry(operation.id);

      assert.equal(retried.status, TrainingMaterialOperationStatus.QUEUED);
      assert.equal(retried.baseKnowledgeVersion, project.knowledgeVersion);
      assert.equal(retried.errorCode, null);
    });

    test('a worker that loses its fencing token cannot finalize a replacement claim', async () => {
      const scenario = await createScenario('fencing');
      const materials = new MaterialHarness(prisma, true);
      const worker = createWorker(materials);
      const operation = await queueUrl(worker, scenario);

      const running = worker.runOnce();
      await materials.waitUntilStarted();
      await prisma.trainingMaterialOperation.update({
        where: { id: operation.id },
        data: { lockedBy: 'replacement-token' },
      });
      materials.release();
      assert.equal(await running, true);

      const fenced = await prisma.trainingMaterialOperation.findUniqueOrThrow({
        where: { id: operation.id },
      });
      assert.equal(fenced.status, TrainingMaterialOperationStatus.GENERATING);
      assert.equal(fenced.lockedBy, 'replacement-token');
    });

    function createWorker(materials) {
      return new TrainingMaterialOperationService(prisma, {
        statObject: async () => null,
      }, materials);
    }

    function queueUrl(worker, scenario) {
      return worker.queueOfficialUrl({
        projectId: scenario.project.id,
        actorId: scenario.user.id,
        idempotencyKey: randomUUID(),
        title: 'Worker source',
        sourceUrl: 'https://example.test/worker',
        officialConfirmed: true,
        replaceExistingQuestions: false,
      });
    }

    async function createScenario(label) {
      const role = await prisma.role.create({
        data: { name: `material-operation-${label}-${randomUUID().slice(0, 8)}` },
      });
      const user = await prisma.user.create({
        data: {
          email: `${label}-${randomUUID()}@material-operation.test`,
          passwordHash: 'test-hash',
          name: label,
          status: UserStatus.ACTIVE,
          roleId: role.id,
        },
      });
      const project = await prisma.trainingProject.create({
        data: {
          title: `Material operation ${label}`,
          description: null,
          sortOrder: 0,
          attemptLimit: 3,
          timeLimitSeconds: 420,
          passScore: 75,
          allowRetakeAfterPass: true,
        },
      });
      return { role, user, project };
    }

    async function clearData() {
      await prisma.trainingMaterialOperationItem.deleteMany();
      await prisma.trainingMaterialOperation.deleteMany();
      await prisma.trainingProject.deleteMany({
        where: { title: { startsWith: 'Material operation ' } },
      });
      await prisma.user.deleteMany({
        where: { email: { endsWith: '@material-operation.test' } },
      });
      await prisma.role.deleteMany({
        where: { name: { startsWith: 'material-operation-' } },
      });
    }
  });

  class MaterialHarness {
    constructor(prisma, blocked = false) {
      this.prisma = prisma;
      this.blocked = blocked;
      this.calls = 0;
      this.started = new Promise((resolve) => { this.signalStarted = resolve; });
      this.barrier = new Promise((resolve) => { this.releaseBarrier = resolve; });
    }

    async assertAsyncCreationAllowed(projectId) {
      const project = await this.prisma.trainingProject.findUniqueOrThrow({
        where: { id: projectId },
        select: { id: true, knowledgeVersion: true },
      });
      return project;
    }

    async requireEditableProjectForMaterials() {}

    async processQueuedOfficialUrlOperation(input) {
      this.calls += 1;
      await input.onStage('GENERATING');
      this.signalStarted();
      if (this.blocked) await this.barrier;
      await input.onStage('PERSISTING');
      return {
        material: { id: input.materialId, latestRevision: { id: input.revisionId } },
        sourceHash: 'a'.repeat(64),
      };
    }

    waitUntilStarted() {
      return this.started;
    }

    release() {
      this.releaseBarrier();
    }
  }
}
