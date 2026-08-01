require('reflect-metadata');

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const test = require('node:test');
const {
  FileStorage,
  PrismaClient,
  TrainingJobKind,
  TrainingJobStatus,
  TrainingProjectStatus,
  TrainingSourceDocumentType,
  TrainingSourceExtractionStatus,
  TrainingVersionStatus,
} = require('@prisma/client');

const {
  TrainingDocumentWorkerService,
} = require('../dist/training/training-document-worker.service.js');

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL must point to the runner-created isolated training database',
  );
}

const observerPrisma = new PrismaClient();
const firstWorkerPrisma = new PrismaClient();
const secondWorkerPrisma = new PrismaClient();

test.after(async () => {
  await Promise.all([
    observerPrisma.$disconnect(),
    firstWorkerPrisma.$disconnect(),
    secondWorkerPrisma.$disconnect(),
  ]);
});

test('PostgreSQL document workers persist one extraction when duplicate jobs reach two consumers', async () => {
  const fixture = await createDocumentFixture();
  const firstJob = await createExtractionJob(fixture.document.id, 'first');
  const secondJob = await createExtractionJob(fixture.document.id, 'second');
  const readGate = createDeferred();
  let readCalls = 0;
  const files = {
    async readStoredFile() {
      readCalls += 1;
      await readGate.promise;
      return fixture.buffer;
    },
  };
  const firstWorker = new TrainingDocumentWorkerService(
    firstWorkerPrisma,
    files,
  );
  const secondWorker = new TrainingDocumentWorkerService(
    secondWorkerPrisma,
    files,
  );

  const firstDrain = firstWorker.drain();
  await waitFor(() => readCalls === 1);
  await secondWorker.drain();

  const releasedJob = await observerPrisma.trainingJob.findUniqueOrThrow({
    where: { id: secondJob.id },
  });
  assert.equal(releasedJob.status, TrainingJobStatus.PENDING);
  assert.equal(releasedJob.attempts, 0);
  assert.equal(
    releasedJob.lastErrorCode,
    'DOCUMENT_EXTRACTION_ALREADY_RUNNING',
  );
  assert.equal(releasedJob.lockOwner, null);
  assert.equal(readCalls, 1);

  readGate.resolve();
  await firstDrain;

  const [completedFirstJob, extractedDocument] = await Promise.all([
    observerPrisma.trainingJob.findUniqueOrThrow({
      where: { id: firstJob.id },
    }),
    observerPrisma.trainingSourceDocument.findUniqueOrThrow({
      where: { id: fixture.document.id },
    }),
  ]);
  assert.equal(completedFirstJob.status, TrainingJobStatus.SUCCEEDED);
  assert.equal(completedFirstJob.attempts, 1);
  assert.equal(completedFirstJob.lockOwner, null);
  assert.equal(
    extractedDocument.extractionStatus,
    TrainingSourceExtractionStatus.READY,
  );
  assert.match(extractedDocument.extractedText, /Platforma document worker/u);

  await observerPrisma.trainingJob.update({
    where: { id: secondJob.id },
    data: { runAt: new Date('1998-01-01T00:00:00.000Z') },
  });
  const restartedConsumer = new TrainingDocumentWorkerService(
    secondWorkerPrisma,
    files,
  );
  await restartedConsumer.drain();

  const obsoleteDuplicate = await observerPrisma.trainingJob.findUniqueOrThrow({
    where: { id: secondJob.id },
  });
  assert.equal(obsoleteDuplicate.status, TrainingJobStatus.SUCCEEDED);
  assert.equal(obsoleteDuplicate.attempts, 1);
  assert.deepEqual(obsoleteDuplicate.errorDetailsJson, { obsolete: true });
  assert.equal(obsoleteDuplicate.lockOwner, null);
  assert.equal(readCalls, 1);
});

test('PostgreSQL document worker recovers a stale lease and completes the same durable job', async () => {
  const fixture = await createDocumentFixture({
    extractionStatus: TrainingSourceExtractionStatus.PROCESSING,
  });
  const staleAt = new Date(Date.now() - 10 * 60_000);
  const staleJob = await createExtractionJob(fixture.document.id, 'stale', {
    status: TrainingJobStatus.RUNNING,
    attempts: 1,
    lockOwner: 'training-document:crashed-worker',
    lockedAt: staleAt,
    heartbeatAt: staleAt,
  });
  let readCalls = 0;
  const files = {
    async readStoredFile() {
      readCalls += 1;
      return fixture.buffer;
    },
  };
  const restartedWorker = new TrainingDocumentWorkerService(
    firstWorkerPrisma,
    files,
  );

  await restartedWorker.drain();

  const [recoveredJob, extractedDocument] = await Promise.all([
    observerPrisma.trainingJob.findUniqueOrThrow({
      where: { id: staleJob.id },
    }),
    observerPrisma.trainingSourceDocument.findUniqueOrThrow({
      where: { id: fixture.document.id },
    }),
  ]);
  assert.equal(recoveredJob.status, TrainingJobStatus.SUCCEEDED);
  assert.equal(recoveredJob.attempts, 2);
  assert.equal(recoveredJob.lockOwner, null);
  assert.equal(recoveredJob.lockedAt, null);
  assert.equal(recoveredJob.heartbeatAt, null);
  assert.equal(
    extractedDocument.extractionStatus,
    TrainingSourceExtractionStatus.READY,
  );
  assert.match(extractedDocument.extractedText, /Platforma document worker/u);
  assert.equal(readCalls, 1);
});

async function createDocumentFixture(options = {}) {
  const suffix = randomUUID();
  const buffer = createStoredZip([
    {
      name: 'word/document.xml',
      data: Buffer.from(
        '<?xml version="1.0"?><w:document xmlns:w="urn:w"><w:body>' +
          '<w:p><w:r><w:t>Platforma document worker</w:t></w:r></w:p>' +
          '</w:body></w:document>',
      ),
    },
  ]);
  const checksum = createHash('sha256').update(buffer).digest('hex');
  const project = await observerPrisma.trainingProject.create({
    data: {
      slug: `document-worker-${suffix}`,
      title: 'Document worker PostgreSQL contract',
      status: TrainingProjectStatus.DRAFT,
      versions: {
        create: {
          versionNumber: 1,
          status: TrainingVersionStatus.DRAFT,
        },
      },
    },
    include: { versions: true },
  });
  const file = await observerPrisma.file.create({
    data: {
      storage: FileStorage.MINIO,
      bucket: 'platforma-training-private',
      key: `training/tests/document-worker/${suffix}.docx`,
      originalName: 'facts.docx',
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes: BigInt(buffer.length),
      checksum,
    },
  });
  const document = await observerPrisma.trainingSourceDocument.create({
    data: {
      projectVersionId: project.versions[0].id,
      fileId: file.id,
      documentType: TrainingSourceDocumentType.DOCX,
      checksum,
      extractionStatus:
        options.extractionStatus ?? TrainingSourceExtractionStatus.PENDING,
    },
  });
  return { buffer, document };
}

function createExtractionJob(sourceDocumentId, label, overrides = {}) {
  return observerPrisma.trainingJob.create({
    data: {
      kind: TrainingJobKind.EXTRACT_SOURCE_DOCUMENT,
      status: TrainingJobStatus.PENDING,
      payloadJson: { sourceDocumentId },
      idempotencyKey: `document-worker:test:${sourceDocumentId}:${label}`,
      runAt: new Date('1998-01-01T00:00:00.000Z'),
      ...overrides,
    },
  });
}

function createDeferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for document worker state');
}

function createStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const value of buffer) {
    crc = crcTable[(crc ^ value) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
