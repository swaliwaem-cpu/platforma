require('reflect-metadata');

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const {
  FileStorage,
  PrismaClient,
  TrainingFactSourceType,
  TrainingMaterialRevisionStatus,
  TrainingMaterialType,
  TrainingQuestionType,
  UserStatus,
} = require('@prisma/client');
const { TrainingMaterialService } = require('../dist/training/training-material.service.js');
const { TrainingMaterialExtractionService } = require('../dist/training/training-material-extraction.js');

const databaseUrl = process.env.TRAINING_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('Training Stage 4 PostgreSQL scenarios require the targeted temporary database runner', () => {
    assert.equal(process.env.TRAINING_TEST_DATABASE_URL, undefined);
  });
} else {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  let user;
  let role;

  before(async () => {
    await prisma.$connect();
    await clearData();
    role = await prisma.role.create({ data: { name: `stage4-pg-${randomUUID()}`, description: 'stage4' } });
    user = await prisma.user.create({ data: {
      email: `stage4-pg-${randomUUID()}@training-s4.test`, passwordHash: 'hash',
      name: 'Stage 4 PG', status: UserStatus.ACTIVE, roleId: role.id,
    } });
  });

  after(async () => {
    await clearData();
    await prisma.$disconnect();
  });

  test('PostgreSQL enforces READY immutability, same-project source and private file RESTRICT', async () => {
    const project = await createProject('first');
    const otherProject = await createProject('second');
    const question = await createQuestion(project.id, 'first');
    const otherQuestion = await createQuestion(otherProject.id, 'second');
    const file = await prisma.file.create({ data: {
      storage: FileStorage.MINIO, bucket: 'platforma-training-materials',
      key: `training-v2/materials/${randomUUID()}/one.pdf`, url: null,
      originalName: 'one.pdf', mimeType: 'application/pdf', sizeBytes: 10n,
      checksum: 'a'.repeat(64), uploadedById: user.id,
    } });
    const material = await prisma.trainingMaterial.create({ data: {
      projectId: project.id, type: TrainingMaterialType.PDF, title: 'PDF', createdById: user.id,
      revisions: { create: revisionData(1, file.id) },
    }, include: { revisions: true } });
    const revision = material.revisions[0];

    await assert.rejects(
      () => prisma.trainingMaterialRevision.update({
        where: { id: revision.id }, data: { extractedText: 'mutated' },
      }),
      /READY training material revision payload is immutable/,
    );
    await prisma.trainingMaterialRevision.update({
      where: { id: revision.id }, data: {
        suggestionStatus: 'READY', suggestionsJson: [], suggestionModel: 'fake',
      },
    });
    await assert.rejects(() => prisma.file.delete({ where: { id: file.id } }));

    const fact = await prisma.trainingFact.create({ data: {
      questionId: question.id, statement: 'Материальный факт', aliasesJson: [],
      position: 1, sourceType: TrainingFactSourceType.MATERIAL,
      sourceRevisionId: revision.id, sourceLabel: 'PDF', sourceLocator: 'page:1',
      sourceExcerpt: 'Immutable extracted text',
    } });
    assert.equal(fact.sourceRevisionId, revision.id);
    await assert.rejects(
      () => prisma.trainingFact.create({ data: {
        questionId: otherQuestion.id, statement: 'Cross project', aliasesJson: [],
        position: 1, sourceType: TrainingFactSourceType.MATERIAL,
        sourceRevisionId: revision.id, sourceLabel: 'PDF', sourceLocator: 'page:1',
        sourceExcerpt: 'Immutable extracted text',
      } }),
      /same project/iu,
    );

    const manual = await prisma.trainingFact.create({ data: {
      questionId: question.id, statement: 'Existing manual fact', aliasesJson: [], position: 2,
    } });
    assert.equal(manual.sourceType, 'MANUAL');
    assert.equal(manual.sourceLabel, 'Добавлено вручную');

    const secondMaterial = await prisma.trainingMaterial.create({ data: {
      projectId: project.id, type: TrainingMaterialType.MANUAL_TEXT,
      title: 'Second', createdById: user.id,
    } });
    await assert.rejects(() => prisma.trainingMaterialRevision.create({ data: {
      materialId: secondMaterial.id,
      previousRevisionId: revision.id,
      ...revisionData(1, null),
    } }));

    const failedRevision = await prisma.trainingMaterialRevision.create({ data: {
      materialId: secondMaterial.id,
      revisionNumber: 1,
      status: TrainingMaterialRevisionStatus.FAILED,
      extractedText: '',
      segmentsJson: [],
      contentHash: '0'.repeat(64),
      extractionMetadataJson: { method: 'TEST', errorCode: 'TEST_FAILED' },
      diffJson: { previousRevisionId: null, added: [], removed: [], unchangedCount: 0, changed: true },
      isChanged: true,
      createdById: user.id,
    } });
    await assert.rejects(
      () => prisma.trainingFact.create({ data: {
        questionId: question.id, statement: 'Failed source', aliasesJson: [],
        position: 3, sourceType: TrainingFactSourceType.MATERIAL,
        sourceRevisionId: failedRevision.id, sourceLabel: 'Failed',
        sourceLocator: 'page:1', sourceExcerpt: 'Unavailable',
      } }),
      /READY/iu,
    );
  });

  test('object snapshot reads only backend allowlist and refresh never mutates the old revision', async () => {
    const object = await prisma.realEstateObject.create({ data: {
      title: 'Original object', slug: `stage4-${randomUUID()}`,
      ceilingHeight: '3 м', priceFrom: 12_000_000,
    } });
    const project = await prisma.trainingProject.create({ data: {
      title: 'Object project', realEstateObjectId: object.id,
      attemptLimit: 3, timeLimitSeconds: 420, passScore: 75,
      allowRetakeAfterPass: false, contentSchemaVersion: 3,
    } });
    const service = new TrainingMaterialService(
      prisma,
      {},
      new TrainingMaterialExtractionService(),
      {},
      {},
    );
    const created = await service.createObjectSnapshot(
      project.id, user.id, 'Object snapshot', ['title', 'ceilingHeight'],
    );
    assert.equal(created.latestRevision.extractedText, 'Original object\n\n3 м');
    assert.doesNotMatch(created.latestRevision.extractedText, /12000000/);
    assert.deepEqual(created.latestRevision.segments.map((segment) => segment.locator), [
      'object-field:title',
      'object-field:ceilingHeight',
    ]);
    assert.equal(created.latestRevision.extractionMetadata.objectId, object.id);
    assert.equal(created.latestRevision.extractionMetadata.objectTitle, 'Original object');
    assert.deepEqual(created.latestRevision.extractionMetadata.fieldCodes, ['title', 'ceilingHeight']);
    assert.deepEqual(created.latestRevision.extractionMetadata.fieldValues, {
      title: 'Original object',
      ceilingHeight: '3 м',
    });
    await assert.rejects(
      () => service.refresh(created.id, user.id, { fieldCodes: ['priceFrom'] }),
      /OBJECT_FIELD_CODES_INVALID/,
    );

    await prisma.realEstateObject.update({
      where: { id: object.id }, data: { title: 'Updated object', ceilingHeight: '3,2 м', priceFrom: 15_000_000 },
    });
    const refreshed = await service.refresh(created.id, user.id, {
      fieldCodes: ['title', 'ceilingHeight'],
    });
    assert.equal(refreshed.latestRevision.revisionNumber, 2);
    assert.equal(refreshed.latestRevision.extractedText, 'Updated object\n\n3,2 м');
    const old = refreshed.revisions.find((revision) => revision.revisionNumber === 1);
    assert.equal(old.extractedText, 'Original object\n\n3 м');
    assert.equal(old.extractionMetadata.objectTitle, 'Original object');
    assert.deepEqual(old.extractionMetadata.fieldValues, {
      title: 'Original object',
      ceilingHeight: '3 м',
    });

    const concurrent = await Promise.all([
      service.refresh(created.id, user.id, { fieldCodes: ['title'] }),
      service.refresh(created.id, user.id, { fieldCodes: ['title', 'ceilingHeight'] }),
    ]);
    assert.deepEqual(
      concurrent.map((item) => item.latestRevision.revisionNumber).sort((left, right) => left - right),
      [3, 4],
    );
    const archived = await service.archive(created.id);
    assert.equal(archived.status, 'ARCHIVED');
  });

  async function createProject(label) {
    return prisma.trainingProject.create({ data: {
      title: `Stage 4 ${label}`, attemptLimit: 3, timeLimitSeconds: 420,
      passScore: 75, allowRetakeAfterPass: false, contentSchemaVersion: 3,
    } });
  }

  async function createQuestion(projectId, label) {
    return prisma.trainingQuestion.create({ data: {
      projectId, type: TrainingQuestionType.MAIN, text: `Question ${label}`, position: 1,
    } });
  }

  function revisionData(revisionNumber, fileId) {
    return {
      revisionNumber,
      status: TrainingMaterialRevisionStatus.READY,
      fileId,
      extractedText: 'Immutable extracted text',
      segmentsJson: [{ locator: 'page:1', label: 'Страница 1', text: 'Immutable extracted text' }],
      contentHash: 'b'.repeat(64),
      extractionMetadataJson: { method: 'TEST' },
      diffJson: { previousRevisionId: null, added: [], removed: [], unchangedCount: 0, changed: true },
      isChanged: true,
      createdById: user.id,
    };
  }

  async function clearData() {
    await prisma.trainingProjectAssignment.deleteMany();
    await prisma.trainingFact.deleteMany();
    await prisma.trainingMaterialRevision.deleteMany();
    await prisma.trainingMaterial.deleteMany();
    await prisma.trainingQuestion.deleteMany();
    await prisma.trainingProject.deleteMany();
    await prisma.realEstateObject.deleteMany({ where: { slug: { startsWith: 'stage4-' } } });
    await prisma.file.deleteMany({ where: { key: { startsWith: 'training-v2/materials/' } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: '@training-s4.test' } } });
    await prisma.role.deleteMany({ where: { name: { startsWith: 'stage4-pg-' } } });
  }
}
