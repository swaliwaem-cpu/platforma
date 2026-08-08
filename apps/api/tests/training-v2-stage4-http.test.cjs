require('reflect-metadata');

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const { NestFactory } = require('@nestjs/core');
const { JwtService } = require('@nestjs/jwt');
const { PrismaClient, UserStatus } = require('@prisma/client');
const PDFDocument = require('pdfkit');

const databaseUrl = process.env.TRAINING_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('Training Stage 4 HTTP scenarios require the targeted temporary database runner', () => {
    assert.equal(process.env.TRAINING_TEST_DATABASE_URL, undefined);
  });
} else {
  process.env.DATABASE_URL = databaseUrl;
  process.env.FEED_AUTO_IMPORT_ENABLED = 'false';
  process.env.JWT_ACCESS_SECRET = 'training-v2-stage4-http-secret';
  process.env.TRAINING_AI_MODE = 'fake';
  process.env.TELEGRAM_TRANSPORT_MODE = 'fake';
  process.env.TRAINING_MATERIAL_WORKER_ENABLED = 'false';

  const { TrainingModule } = require('../dist/training/training.module.js');
  const { TrainingMaterialOperationService } = require('../dist/training/training-material-operation.service.js');
  const { S3StorageService } = require('../dist/files/s3-storage.service.js');
  const { TRAINING_MATERIAL_SUGGESTER } = require('../dist/training/training-material-suggester.js');
  const { TrainingUrlExtractor } = require('../dist/training/training-url-extractor.js');
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const jwt = new JwtService();
  let app;
  let baseUrl;
  let admin;
  let employee;
  let adminToken;
  let employeeToken;
  let storage;
  let operationWorker;

  before(async () => {
    await prisma.$connect();
    await clearData();
    admin = await createUser('stage4-admin', ['training:projects:manage', 'training:results:read', 'objects:read']);
    employee = await createUser('stage4-employee', ['training:participate']);
    adminToken = sign(admin);
    employeeToken = sign(employee);
    app = await NestFactory.create(TrainingModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    storage = app.get(S3StorageService);
    operationWorker = app.get(TrainingMaterialOperationService);
    baseUrl = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  });

  after(async () => {
    await app?.close();
    await clearData();
    await prisma.$disconnect();
  });

  test('materials HTTP enforces 401/403, revisions, manual apply and immutable attempt citation', async () => {
    assert.equal((await request('/training/admin/projects/x/materials')).status, 401);
    const created = await request('/training/admin/projects', {
      token: adminToken, method: 'POST', body: { title: 'Stage 4 HTTP', allowRetakeAfterPass: true },
    });
    assert.equal(created.status, 201);
    const projectId = created.body.id;
    const configured = await request(`/training/admin/projects/${projectId}`, {
      token: adminToken, method: 'PATCH', body: draft(),
    });
    assert.equal(configured.status, 200);

    assert.equal((await request(`/training/admin/projects/${projectId}/materials`, { token: employeeToken })).status, 403);
    assert.equal((await request(`/training/admin/projects/${projectId}/materials`, { token: adminToken })).status, 200);
    assert.equal((await request(`/training/admin/materials/${randomUUID()}`, { token: adminToken })).status, 404);

    const invalidType = await request(`/training/admin/projects/${projectId}/materials`, {
      token: adminToken, method: 'POST', body: { type: 'UNKNOWN', title: 'Invalid' },
    });
    assert.equal(invalidType.status, 400);

    const material = await request(`/training/admin/projects/${projectId}/materials`, {
      token: adminToken,
      method: 'POST',
      body: { type: 'MANUAL_TEXT', title: 'Ручной источник', text: 'Высота потолков составляет три метра.' },
    });
    assert.equal(material.status, 201);
    assert.equal(material.body.latestRevision.revisionNumber, 1);
    const revisionId = material.body.latestRevision.id;

    const suggested = await request(`/training/admin/material-revisions/${revisionId}/suggestions`, {
      token: adminToken, method: 'POST',
    });
    assert.equal(suggested.status, 201);
    assert.equal(await prisma.trainingFact.count({ where: { sourceRevisionId: revisionId } }), 0);
    const suggestion = suggested.body.revisions[0].suggestions[0];
    const applied = await request(`/training/admin/material-revisions/${revisionId}/apply-suggestions`, {
      token: adminToken,
      method: 'POST',
      body: { suggestions: [{
        suggestionId: suggestion.id,
        targetQuestionId: suggestion.targetQuestionId,
        statement: 'Высота потолков — 3 метра.',
        aliases: ['потолки 3 м'],
        isRequired: true,
        sourceLocator: suggestion.sourceLocator,
        sourceExcerpt: suggestion.sourceExcerpt,
      }] },
    });
    assert.equal(applied.status, 201);
    assert.equal(applied.body.createdFactIds.length, 1);
    const duplicate = await request(`/training/admin/material-revisions/${revisionId}/apply-suggestions`, {
      token: adminToken,
      method: 'POST',
      body: { suggestions: [{
        suggestionId: suggestion.id,
        targetQuestionId: suggestion.targetQuestionId,
        statement: 'Высота потолков — 3 метра!',
        aliases: [], isRequired: true,
        sourceLocator: suggestion.sourceLocator,
        sourceExcerpt: suggestion.sourceExcerpt,
      }] },
    });
    assert.equal(duplicate.status, 201, JSON.stringify(duplicate.body));
    assert.equal(duplicate.body.createdFactIds.length, 0);
    assert.equal(duplicate.body.duplicates[0].reason, 'DUPLICATE_FACT');

    await request(`/training/admin/projects/${projectId}/publish`, { token: adminToken, method: 'POST' });
    await request(`/training/admin/projects/${projectId}`, { token: adminToken, method: 'PATCH', body: { isOpen: true } });
    const started = await request(`/training/projects/${projectId}/attempts`, {
      token: employeeToken,
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID() },
      body: { confirmed: true },
    });
    assert.equal(started.status, 201);
    assert.doesNotMatch(JSON.stringify(started.body), /material|revision|sourceExcerpt|sourceUrl/iu);
    const adminAttempt = await request(`/training/admin/attempts/${started.body.id}`, { token: adminToken });
    const sourced = adminAttempt.body.questions.flatMap((question) => question.facts)
      .find((fact) => fact.sourceType === 'MATERIAL');
    assert.equal(sourced.sourceRevisionId, revisionId);
    assert.equal(sourced.sourceLabel, 'Ручной источник');

    await request(`/training/admin/projects/${projectId}`, { token: adminToken, method: 'PATCH', body: { isOpen: false } });
    const refreshed = await request(`/training/admin/materials/${material.body.id}/revisions`, {
      token: adminToken, method: 'POST', body: { text: 'Новый текст второй ревизии.' },
    });
    assert.equal(refreshed.body.latestRevision.revisionNumber, 2);
    const unchangedAttempt = await request(`/training/admin/attempts/${started.body.id}`, { token: adminToken });
    const unchangedSource = unchangedAttempt.body.questions.flatMap((question) => question.facts)
      .find((fact) => fact.sourceType === 'MATERIAL');
    assert.equal(unchangedSource.sourceRevisionId, revisionId);
  });

  test('PDF HTTP keeps the file private and serves it only through the material endpoint', async () => {
    const created = await request('/training/admin/projects', {
      token: adminToken, method: 'POST', body: { title: 'Stage 4 PDF', allowRetakeAfterPass: false },
    });
    const pdf = await makePdf('Synthetic text PDF');
    const form = new FormData();
    form.set('title', 'Private PDF');
    form.set('file', new Blob([pdf], { type: 'application/pdf' }), 'fixture.pdf');
    const uploadedResponse = await fetch(`${baseUrl}/training/admin/projects/${created.body.id}/materials/pdf`, {
      method: 'POST', headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': randomUUID(),
      }, body: form,
    });
    const uploadedOperation = await uploadedResponse.json();
    assert.equal(uploadedResponse.status, 202, JSON.stringify(uploadedOperation));
    const uploadedCompleted = await finishOperation(uploadedOperation);
    assert.equal(uploadedCompleted.status, 'READY', JSON.stringify(uploadedCompleted));
    const uploaded = (await request(`/training/admin/materials/${uploadedCompleted.result.materialId}`, {
      token: adminToken,
    })).body;
    assert.equal(uploaded.latestRevision.extractionMetadata.pageCount, 1);
    const persistedRevision = await prisma.trainingMaterialRevision.findUnique({
      where: { id: uploaded.latestRevision.id }, include: { file: true },
    });
    assert.equal(persistedRevision.file.url, null);
    assert.equal(persistedRevision.file.bucket, process.env.TRAINING_MATERIAL_BUCKET ?? 'training-materials');
    assert.equal(persistedRevision.file.checksum.length, 64);
    const generatedQuestions = await prisma.trainingQuestion.findMany({
      where: { projectId: created.body.id, isActive: true },
    });
    assert.equal(generatedQuestions.length, 11);
    assert.equal(generatedQuestions.filter((question) => question.type === 'MAIN').length, 1);
    assert.equal(generatedQuestions.filter((question) => question.type === 'FOLLOW_UP').length, 10);
    const generatedFacts = await assertGeneratedFacts(created.body.id);
    assert.equal(generatedFacts.every((fact) => fact.sourceRevisionId === uploaded.latestRevision.id), true);

    const replacementRequiredForm = new FormData();
    replacementRequiredForm.set('title', 'Second PDF');
    replacementRequiredForm.set('file', new Blob([pdf], { type: 'application/pdf' }), 'second.pdf');
    const replacementRequired = await fetch(
      `${baseUrl}/training/admin/projects/${created.body.id}/materials/pdf`,
      { method: 'POST', headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': randomUUID(),
      }, body: replacementRequiredForm },
    );
    assert.equal(replacementRequired.status, 409);
    assert.equal((await replacementRequired.json()).message, 'PROJECT_QUESTIONS_REPLACE_CONFIRMATION_REQUIRED');
    assert.equal(await prisma.trainingMaterial.count({ where: { projectId: created.body.id } }), 1);

    const replacementConfirmedForm = new FormData();
    replacementConfirmedForm.set('title', 'Second PDF');
    replacementConfirmedForm.set('file', new Blob([pdf], { type: 'application/pdf' }), 'second.pdf');
    replacementConfirmedForm.set('replaceExistingQuestions', 'true');
    const replacementConfirmedResponse = await fetch(
      `${baseUrl}/training/admin/projects/${created.body.id}/materials/pdf`,
      { method: 'POST', headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': randomUUID(),
      }, body: replacementConfirmedForm },
    );
    const replacementOperation = await replacementConfirmedResponse.json();
    assert.equal(replacementConfirmedResponse.status, 202, JSON.stringify(replacementOperation));
    const replacementCompleted = await finishOperation(replacementOperation);
    const replacementConfirmed = (await request(
      `/training/admin/materials/${replacementCompleted.result.materialId}`,
      { token: adminToken },
    )).body;
    const replacementFacts = await assertGeneratedFacts(created.body.id);
    const replacementSourceRevisionIds = new Set([
      uploaded.latestRevision.id,
      replacementConfirmed.latestRevision.id,
    ]);
    assert.equal(
      replacementFacts.every((fact) => replacementSourceRevisionIds.has(fact.sourceRevisionId)),
      true,
    );
    assert.equal(await prisma.trainingFact.count({
      where: { id: { in: generatedFacts.map((fact) => fact.id) } },
    }), generatedFacts.length);
    assert.deepEqual(
      replacementFacts.map((fact) => fact.id),
      generatedFacts.map((fact) => fact.id),
    );

    const generic = await request(`/files/${persistedRevision.file.id}/content`, { token: adminToken });
    assert.equal(generic.status, 404);
    const privateDownload = await fetch(`${baseUrl}/training/admin/materials/${uploaded.id}/pdf`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(privateDownload.status, 200);
    assert.equal(privateDownload.headers.get('cache-control'), 'private, no-store');
    assert.equal(Buffer.from(await privateDownload.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
    assert.equal((await fetch(`${baseUrl}/training/admin/materials/${uploaded.id}/pdf`, {
      headers: { Authorization: `Bearer ${employeeToken}` },
    })).status, 403);

    const blankPdf = await makePdf('');
    const blankForm = new FormData();
    blankForm.set('title', 'Scanned-like PDF');
    blankForm.set('file', new Blob([blankPdf], { type: 'application/pdf' }), 'blank.pdf');
    blankForm.set('replaceExistingQuestions', 'true');
    const blankResponse = await fetch(`${baseUrl}/training/admin/projects/${created.body.id}/materials/pdf`, {
      method: 'POST', headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': randomUUID(),
      }, body: blankForm,
    });
    const blankOperation = await blankResponse.json();
    assert.equal(blankResponse.status, 202, JSON.stringify(blankOperation));
    const blankCompleted = await finishOperation(blankOperation);
    assert.equal(blankCompleted.status, 'FAILED');
    const blankMaterial = (await request(
      `/training/admin/materials/${blankCompleted.result.materialId}`,
      { token: adminToken },
    )).body;
    assert.equal(blankMaterial.latestRevision.status, 'FAILED');
    assert.equal(blankMaterial.latestRevision.extractionMetadata.errorCode, 'PDF_TEXT_LAYER_MISSING');
    assert.equal(blankMaterial.latestRevision.suggestions, null);
    assert.deepEqual(
      (await assertGeneratedFacts(created.body.id)).map((fact) => fact.id),
      replacementFacts.map((fact) => fact.id),
    );

    const invalidForm = new FormData();
    invalidForm.set('title', 'Invalid PDF');
    invalidForm.set('file', new Blob([Buffer.from('not-pdf')], { type: 'application/pdf' }), 'invalid.pdf');
    invalidForm.set('replaceExistingQuestions', 'true');
    const invalid = await fetch(`${baseUrl}/training/admin/projects/${created.body.id}/materials/pdf`, {
      method: 'POST', headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': randomUUID(),
      }, body: invalidForm,
    });
    assert.equal(invalid.status, 400);

    const wrongMimeForm = new FormData();
    wrongMimeForm.set('title', 'Wrong MIME');
    wrongMimeForm.set('file', new Blob([pdf], { type: 'text/plain' }), 'fixture.pdf');
    wrongMimeForm.set('replaceExistingQuestions', 'true');
    assert.equal((await fetch(`${baseUrl}/training/admin/projects/${created.body.id}/materials/pdf`, {
      method: 'POST', headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': randomUUID(),
      }, body: wrongMimeForm,
    })).status, 400);

    const previousLimit = process.env.TRAINING_MATERIAL_MAX_BYTES;
    process.env.TRAINING_MATERIAL_MAX_BYTES = '1024';
    const oversizedForm = new FormData();
    oversizedForm.set('title', 'Oversized PDF');
    oversizedForm.set('file', new Blob([pdf], { type: 'application/pdf' }), 'oversized.pdf');
    oversizedForm.set('replaceExistingQuestions', 'true');
    assert.equal((await fetch(`${baseUrl}/training/admin/projects/${created.body.id}/materials/pdf`, {
      method: 'POST', headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': randomUUID(),
      }, body: oversizedForm,
    })).status, 400);
    if (previousLimit === undefined) delete process.env.TRAINING_MATERIAL_MAX_BYTES;
    else process.env.TRAINING_MATERIAL_MAX_BYTES = previousLimit;
  });

  test('official URL creates question drafts and requires confirmation before replacing them', async () => {
    const linkedObject = await prisma.realEstateObject.create({ data: {
      title: 'ЖК URL',
      slug: `stage4-object-url-${randomUUID()}`,
    } });
    const created = await request('/training/admin/projects', {
      token: adminToken, method: 'POST', body: { title: 'Stage 4 URL', allowRetakeAfterPass: false },
    });
    await prisma.trainingProject.update({
      where: { id: created.body.id },
      data: { realEstateObjectId: linkedObject.id },
    });

    const extractor = app.get(TrainingUrlExtractor);
    const originalExtract = extractor.extract;
    let extractCalls = 0;
    extractor.extract = async (sourceUrl) => {
      extractCalls += 1;
      const text = `Официальная страница ${extractCalls}: рядом метро, высота потолков три метра.`;
      return {
        text,
        segments: [{ locator: 'html:main', label: 'Основной текст', text }],
        contentHash: createHash('sha256').update(text).digest('hex'),
        metadata: { method: 'HTTP' },
        finalUrl: sourceUrl,
        fetchedAt: new Date(),
      };
    };

    try {
      const first = await request(`/training/admin/projects/${created.body.id}/materials`, {
        token: adminToken,
        method: 'POST',
        headers: { 'Idempotency-Key': randomUUID() },
        body: {
          type: 'OFFICIAL_URL',
          title: 'Официальный источник',
          url: 'https://developer.example/project',
          officialConfirmed: true,
          replaceExistingQuestions: false,
        },
      });
      assert.equal(first.status, 202, JSON.stringify(first.body));
      const firstCompleted = await finishOperation(first.body);
      assert.equal(firstCompleted.status, 'READY', JSON.stringify(firstCompleted));
      const firstMaterial = (await request(
        `/training/admin/materials/${firstCompleted.result.materialId}`,
        { token: adminToken },
      )).body;
      const initialQuestions = await prisma.trainingQuestion.findMany({
        where: { projectId: created.body.id, isActive: true },
        orderBy: [{ type: 'asc' }, { position: 'asc' }],
      });
      assert.equal(initialQuestions.length, 11);
      assert.equal(initialQuestions.filter((question) => question.type === 'MAIN').length, 1);
      assert.equal(initialQuestions.filter((question) => question.type === 'FOLLOW_UP').length, 10);
      const initialFacts = await assertGeneratedFacts(created.body.id);
      assert.equal(initialFacts.every((fact) => fact.sourceRevisionId === firstMaterial.latestRevision.id), true);

      const replacementRequired = await request(`/training/admin/projects/${created.body.id}/materials`, {
        token: adminToken,
        method: 'POST',
        headers: { 'Idempotency-Key': randomUUID() },
        body: {
          type: 'OFFICIAL_URL',
          title: 'Новый официальный источник',
          url: 'https://developer.example/project-v2',
          officialConfirmed: true,
          replaceExistingQuestions: false,
        },
      });
      assert.equal(replacementRequired.status, 409);
      assert.equal(replacementRequired.body.message, 'PROJECT_QUESTIONS_REPLACE_CONFIRMATION_REQUIRED');
      assert.equal(extractCalls, 1);
      assert.equal(await prisma.trainingMaterial.count({ where: { projectId: created.body.id } }), 1);

      const replaced = await request(`/training/admin/projects/${created.body.id}/materials`, {
        token: adminToken,
        method: 'POST',
        headers: { 'Idempotency-Key': randomUUID() },
        body: {
          type: 'OFFICIAL_URL',
          title: 'Новый официальный источник',
          url: 'https://developer.example/project-v2',
          officialConfirmed: true,
          replaceExistingQuestions: true,
        },
      });
      assert.equal(replaced.status, 202, JSON.stringify(replaced.body));
      const replacedCompleted = await finishOperation(replaced.body);
      assert.equal(replacedCompleted.status, 'READY', JSON.stringify(replacedCompleted));
      const replacedMaterial = (await request(
        `/training/admin/materials/${replacedCompleted.result.materialId}`,
        { token: adminToken },
      )).body;
      assert.equal(extractCalls, 2);
      const replacedQuestions = await prisma.trainingQuestion.findMany({
        where: { projectId: created.body.id, isActive: true },
        orderBy: [{ type: 'asc' }, { position: 'asc' }],
      });
      assert.equal(replacedQuestions.length, 11);
      assert.deepEqual(replacedQuestions.map((question) => question.id), initialQuestions.map((question) => question.id));
      const replacedFacts = await assertGeneratedFacts(created.body.id);
      const replacementSourceRevisionIds = new Set([
        firstMaterial.latestRevision.id,
        replacedMaterial.latestRevision.id,
      ]);
      assert.equal(
        replacedFacts.every((fact) => replacementSourceRevisionIds.has(fact.sourceRevisionId)),
        true,
      );
      assert.equal(await prisma.trainingFact.count({
        where: { id: { in: initialFacts.map((fact) => fact.id) } },
      }), 0);
      const updatedProject = await prisma.trainingProject.findUnique({ where: { id: created.body.id } });
      assert.equal(updatedProject.realEstateObjectId, linkedObject.id);
    } finally {
      extractor.extract = originalExtract;
    }
  });

  test('fact suggestions require existing questions before calling the provider', async () => {
    const created = await request('/training/admin/projects', {
      token: adminToken, method: 'POST', body: { title: 'Stage 4 empty questions', allowRetakeAfterPass: false },
    });
    const material = await request(`/training/admin/projects/${created.body.id}/materials`, {
      token: adminToken,
      method: 'POST',
      body: { type: 'MANUAL_TEXT', title: 'Источник без вопросов', text: 'Проверяемый факт.' },
    });
    assert.equal(material.status, 201);

    const suggester = app.get(TRAINING_MATERIAL_SUGGESTER);
    const originalSuggest = suggester.suggest;
    let suggestCalls = 0;
    suggester.suggest = async (...args) => {
      suggestCalls += 1;
      return originalSuggest.apply(suggester, args);
    };
    try {
      const response = await request(
        `/training/admin/material-revisions/${material.body.latestRevision.id}/suggestions`,
        { token: adminToken, method: 'POST' },
      );
      assert.equal(response.status, 409);
      assert.equal(response.body.message, 'PROJECT_QUESTIONS_REQUIRED_FOR_SUGGESTIONS');
      assert.equal(suggestCalls, 0);
      const revision = await prisma.trainingMaterialRevision.findUnique({
        where: { id: material.body.latestRevision.id },
      });
      assert.equal(revision.suggestionStatus, 'NOT_GENERATED');
    } finally {
      suggester.suggest = originalSuggest;
    }
  });

  test('object import searches with the platform keyboard-layout variants, copies every PDF and creates question drafts', async () => {
    const created = await request('/training/admin/projects', {
      token: adminToken,
      method: 'POST',
      body: { title: 'Stage 4 object import', allowRetakeAfterPass: false },
    });
    assert.equal(created.status, 201);

    const object = await prisma.realEstateObject.create({ data: {
      title: 'ЖК Северный',
      slug: `stage4-object-${randomUUID()}`,
      description: 'Жилой комплекс рядом с парком.',
      ceilingHeight: '3,1 м',
      address: 'Москва, Северная улица, 1',
    } });
    const pdf = await makePdf('Underground parking contains 300 spaces.');
    const sourceKey = `training-v2/stage4-object-source/${randomUUID()}.pdf`;
    await storage.putObject({ key: sourceKey, body: pdf, contentType: 'application/pdf' });
    const sourceFile = await prisma.file.create({ data: {
      storage: 'MINIO',
      bucket: storage.getBucket(),
      key: sourceKey,
      url: storage.getPublicUrl(sourceKey),
      originalName: 'presentation.PDF',
      mimeType: null,
      sizeBytes: BigInt(pdf.length),
      checksum: createHash('sha256').update(pdf).digest('hex'),
      uploadedById: admin.id,
    } });
    await prisma.objectFile.create({ data: {
      objectId: object.id,
      fileId: sourceFile.id,
      title: 'Презентация ЖК',
    } });
    const invalidSourceKey = `training-v2/stage4-object-source/${randomUUID()}-invalid.pdf`;
    const invalidPdf = Buffer.from('not-a-pdf');
    await storage.putObject({ key: invalidSourceKey, body: invalidPdf, contentType: 'application/pdf' });
    const invalidSourceFile = await prisma.file.create({ data: {
      storage: 'MINIO',
      bucket: storage.getBucket(),
      key: invalidSourceKey,
      url: storage.getPublicUrl(invalidSourceKey),
      originalName: 'broken.pdf',
      mimeType: 'application/pdf',
      sizeBytes: BigInt(invalidPdf.length),
      checksum: createHash('sha256').update(invalidPdf).digest('hex'),
      uploadedById: admin.id,
    } });
    await prisma.objectFile.create({ data: {
      objectId: object.id,
      fileId: invalidSourceFile.id,
      title: 'Повреждённое вложение',
    } });

    assert.equal((await request(
      `/training/admin/projects/${created.body.id}/object-options?search=${encodeURIComponent('ctdth')}`,
      { token: employeeToken },
    )).status, 403);
    const options = await request(
      `/training/admin/projects/${created.body.id}/object-options?search=${encodeURIComponent('ctdth')}`,
      { token: adminToken },
    );
    assert.equal(options.status, 200, JSON.stringify(options.body));
    assert.equal(options.body.items.length, 1);
    assert.equal(options.body.items[0].id, object.id);
    assert.equal(options.body.items[0].pdfCount, 2);

    assert.equal((await request(`/training/admin/projects/${created.body.id}/import-object`, {
      token: employeeToken,
      method: 'POST',
      body: { objectId: object.id, replaceExistingQuestions: false },
    })).status, 403);
    const imported = await request(`/training/admin/projects/${created.body.id}/import-object`, {
      token: adminToken,
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID() },
      body: { objectId: object.id, replaceExistingQuestions: false },
    });
    assert.equal(imported.status, 202, JSON.stringify(imported.body));
    const importedCompleted = await finishOperation(imported.body);
    assert.equal(importedCompleted.status, 'READY', JSON.stringify(importedCompleted));
    assert.equal(importedCompleted.result.objectId, object.id);
    assert.equal(importedCompleted.result.importedPdfCount, 1);
    assert.deepEqual(importedCompleted.result.failedPdfTitles, ['Повреждённое вложение']);
    assert.equal(importedCompleted.items.length, 3);
    assert.equal(importedCompleted.items.filter((item) => item.status === 'FAILED').length, 1);

    const project = await prisma.trainingProject.findUnique({ where: { id: created.body.id } });
    assert.equal(project.realEstateObjectId, object.id);
    assert.equal(project.status, 'DRAFT');
    const questions = await prisma.trainingQuestion.findMany({
      where: { projectId: created.body.id, isActive: true },
      orderBy: [{ type: 'asc' }, { position: 'asc' }],
    });
    assert.equal(questions.length, 11);
    assert.equal(questions.filter((question) => question.type === 'MAIN').length, 1);
    assert.equal(questions.filter((question) => question.type === 'FOLLOW_UP').length, 10);
    const materials = await prisma.trainingMaterial.findMany({
      where: { projectId: created.body.id, status: 'ACTIVE' },
      include: { revisions: { include: { file: true } } },
    });
    assert.equal(materials.length, 3);
    const snapshot = materials.find((material) => material.type === 'OBJECT_SNAPSHOT');
    assert.match(snapshot.revisions[0].extractedText, /ЖК Северный/);
    assert.match(snapshot.revisions[0].extractedText, /3,1 м/);
    const importedPdf = materials.find((material) =>
      material.type === 'PDF' && material.revisions[0].status === 'READY',
    );
    const failedPdf = materials.find((material) =>
      material.type === 'PDF' && material.revisions[0].status === 'FAILED',
    );
    assert.ok(failedPdf);
    assert.match(importedPdf.revisions[0].extractedText, /Underground parking/iu);
    assert.equal(importedPdf.revisions[0].file.url, null);
    assert.equal(importedPdf.revisions[0].file.bucket, process.env.TRAINING_MATERIAL_BUCKET ?? 'training-materials');
    const importedFacts = await assertGeneratedFacts(created.body.id);
    const allowedSourceRevisionIds = new Set([snapshot.revisions[0].id, importedPdf.revisions[0].id]);
    assert.equal(importedFacts.every((fact) => allowedSourceRevisionIds.has(fact.sourceRevisionId)), true);
    assert.equal(importedFacts.some((fact) => fact.sourceRevisionId === failedPdf.revisions[0].id), false);

    const confirmationRequired = await request(`/training/admin/projects/${created.body.id}/import-object`, {
      token: adminToken,
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID() },
      body: { objectId: object.id, replaceExistingQuestions: false },
    });
    assert.equal(confirmationRequired.status, 409);
    assert.equal(confirmationRequired.body.message, 'PROJECT_QUESTIONS_REPLACE_CONFIRMATION_REQUIRED');
    const replaced = await request(`/training/admin/projects/${created.body.id}/import-object`, {
      token: adminToken,
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID() },
      body: { objectId: object.id, replaceExistingQuestions: true },
    });
    assert.equal(replaced.status, 202, JSON.stringify(replaced.body));
    assert.equal((await finishOperation(replaced.body)).status, 'READY');
    assert.equal(await prisma.trainingQuestion.count({ where: { projectId: created.body.id, isActive: true } }), 11);
    assert.equal(await prisma.trainingFact.count({
      where: { id: { in: importedFacts.map((fact) => fact.id) } },
    }), importedFacts.length);
    const replacedObjectFacts = await assertGeneratedFacts(created.body.id);
    assert.deepEqual(
      replacedObjectFacts.map((fact) => fact.id),
      importedFacts.map((fact) => fact.id),
    );
    const readyRevisions = await prisma.trainingMaterialRevision.findMany({
      where: {
        material: { projectId: created.body.id, status: 'ACTIVE' },
        status: 'READY',
      },
      select: { id: true },
    });
    const readyRevisionIds = new Set(readyRevisions.map((revision) => revision.id));
    assert.equal(
      replacedObjectFacts.every((fact) => readyRevisionIds.has(fact.sourceRevisionId)),
      true,
    );

    await prisma.objectFile.deleteMany({ where: { objectId: object.id } });
    const withoutRemovedPdf = await request(`/training/admin/projects/${created.body.id}/import-object`, {
      token: adminToken,
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID() },
      body: { objectId: object.id, replaceExistingQuestions: true },
    });
    assert.equal(withoutRemovedPdf.status, 202, JSON.stringify(withoutRemovedPdf.body));
    const withoutRemovedPdfCompleted = await finishOperation(withoutRemovedPdf.body);
    assert.equal(withoutRemovedPdfCompleted.result.importedPdfCount, 0);
    assert.equal(await prisma.trainingMaterial.count({
      where: { projectId: created.body.id, type: 'PDF', status: 'ACTIVE' },
    }), 0);
    const snapshotOnlyFacts = await assertGeneratedFacts(created.body.id);
    assert.equal(snapshotOnlyFacts.every(
      (fact) => fact.sourceRevision.material.type === 'OBJECT_SNAPSHOT',
    ), true);
  });

  async function assertGeneratedFacts(projectId) {
    const facts = await prisma.trainingFact.findMany({
      where: { question: { projectId }, isActive: true },
      include: {
        question: true,
        sourceRevision: { include: { material: true } },
      },
      orderBy: { id: 'asc' },
    });
    assert.ok(facts.length >= 11 && facts.length <= 55);
    const countByQuestion = new Map();
    for (const fact of facts) {
      assert.equal(fact.question.isActive, true);
      assert.equal(fact.sourceType, 'MATERIAL');
      assert.ok(fact.sourceRevision);
      assert.equal(fact.sourceRevision.status, 'READY');
      assert.equal(fact.sourceRevision.material.projectId, projectId);
      assert.equal(fact.sourceLabel, fact.sourceRevision.material.title);
      assert.ok(fact.sourceLocator);
      assert.ok(fact.sourceExcerpt);
      const segments = fact.sourceRevision.segmentsJson;
      assert.ok(Array.isArray(segments));
      const segment = segments.find((item) => item.locator === fact.sourceLocator);
      assert.ok(segment);
      assert.equal(segment.text.includes(fact.sourceExcerpt), true);
      countByQuestion.set(fact.questionId, (countByQuestion.get(fact.questionId) ?? 0) + 1);
    }
    assert.equal(countByQuestion.size, 11);
    assert.equal([...countByQuestion.values()].every((count) => count >= 1 && count <= 5), true);
    return facts;
  }

  function draft() {
    return {
      title: 'Stage 4 HTTP', description: null, realEstateObjectId: null, sortOrder: 0,
      attemptLimit: 3, timeLimitMinutes: 7, passScore: 75, allowRetakeAfterPass: true,
      accessMode: 'ALL_PARTICIPANTS',
      mainQuestion: 'Главный вопрос',
      followUpQuestions: Array.from({ length: 10 }, (_, index) => `Дополнительный вопрос ${index + 1}`),
      facts: Array.from({ length: 11 }, (_, index) => ({
        id: null, questionType: index === 0 ? 'MAIN' : 'FOLLOW_UP',
        questionPosition: index === 0 ? 1 : index, statement: `Ручной факт ${index + 1}`,
        aliases: [], isRequired: true, position: 1,
      })),
      criteria: [
        { id: null, questionType: 'MAIN', code: 'main', title: 'Main', guidance: '', maxPoints: 55, position: 1 },
        { id: null, questionType: 'FOLLOW_UP', code: 'follow', title: 'Follow', guidance: '', maxPoints: 15, position: 1 },
      ],
    };
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
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  }

  async function finishOperation(operation) {
    assert.match(operation.id, /^[0-9a-f-]{36}$/u);
    assert.equal(['QUEUED', 'STORING'].includes(operation.status), true);
    assert.equal(await operationWorker.runOnce(), true);
    const completed = await request(`/training/admin/material-operations/${operation.id}`, {
      token: adminToken,
    });
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.equal(['READY', 'FAILED'].includes(completed.body.status), true);
    return completed.body;
  }

  function sign(user) {
    return jwt.sign({ sub: user.id, email: user.email, type: 'access' }, {
      secret: process.env.JWT_ACCESS_SECRET, expiresIn: '1h',
    });
  }

  async function createUser(label, permissionKeys) {
    const role = await prisma.role.create({ data: { name: `${label}-${randomUUID()}`, description: label } });
    for (const key of permissionKeys) {
      const permission = await prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } });
      await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    }
    return prisma.user.create({ data: {
      email: `${label}-${randomUUID()}@training-s4.test`, passwordHash: 'hash', name: label,
      status: UserStatus.ACTIVE, roleId: role.id,
    } });
  }

  async function clearData() {
    const storedFiles = await prisma.file.findMany({
      where: { OR: [
        { key: { startsWith: 'training-v2/materials/' } },
        { key: { startsWith: 'training-v2/material-operations/' } },
        { key: { startsWith: 'training-v2/stage4-object-source/' } },
      ] },
      select: { key: true, bucket: true },
    });
    if (storage) {
      for (const file of storedFiles) {
        await storage.deleteObject(file.key, file.bucket ?? undefined).catch(() => undefined);
      }
    }
    await prisma.trainingAnswerSegment.deleteMany();
    await prisma.trainingAnswer.deleteMany();
    await prisma.trainingAttemptQuestion.deleteMany();
    await prisma.trainingAttempt.deleteMany();
    await prisma.trainingTelegramLinkToken.deleteMany();
    await prisma.trainingTelegramAccount.deleteMany();
    await prisma.trainingProjectAssignment.deleteMany();
    await prisma.trainingFact.deleteMany();
    await prisma.trainingMaterialOperationItem.deleteMany();
    await prisma.trainingMaterialOperation.deleteMany();
    await prisma.trainingMaterialRevision.deleteMany();
    await prisma.trainingMaterial.deleteMany();
    await prisma.trainingCriterion.deleteMany();
    await prisma.trainingQuestion.deleteMany();
    await prisma.trainingProject.deleteMany();
    await prisma.objectFile.deleteMany({
      where: { file: { key: { startsWith: 'training-v2/stage4-object-source/' } } },
    });
    await prisma.realEstateObject.deleteMany({ where: { slug: { startsWith: 'stage4-object-' } } });
    await prisma.file.deleteMany({ where: { OR: [
      { key: { startsWith: 'training-v2/materials/' } },
      { key: { startsWith: 'training-v2/material-operations/' } },
      { key: { startsWith: 'training-v2/stage4-object-source/' } },
    ] } });
    await prisma.user.deleteMany({ where: { email: { endsWith: '@training-s4.test' } } });
    await prisma.role.deleteMany({ where: { name: { startsWith: 'stage4-' } } });
  }

  function makePdf(text) {
    return new Promise((resolve, reject) => {
      const document = new PDFDocument();
      const chunks = [];
      document.on('data', (chunk) => chunks.push(chunk));
      document.on('end', () => resolve(Buffer.concat(chunks)));
      document.on('error', reject);
      document.text(text);
      document.end();
    });
  }
}
