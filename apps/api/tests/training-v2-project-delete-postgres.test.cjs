require('reflect-metadata');

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { readFile, writeFile } = require('node:fs/promises');
const { after, before, beforeEach, test } = require('node:test');
const {
  FileStorage,
  PrismaClient,
  TrainingAiStepStatus,
  TrainingAudioStorageObjectKind,
  TrainingAnswerProcessingStatus,
  TrainingAnswerSource,
  TrainingAttemptQuestionStatus,
  TrainingAttemptStatus,
  TrainingFactSourceType,
  TrainingFakeOutcome,
  TrainingMaterialRevisionStatus,
  TrainingMaterialType,
  TrainingQuestionType,
  TrainingReviewDecision,
  TrainingReviewStatus,
  UserStatus,
} = require('@prisma/client');
const {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} = require('@nestjs/common');

const { FilesService } = require('../dist/files/files.service.js');
const { TrainingAudioService } = require('../dist/training/training-audio.service.js');
const {
  TrainingAudioStorageService,
  upsertTrainingAudioStorageEntry,
} = require('../dist/training/training-audio-storage.service.js');
const { TrainingAttemptStateService } = require('../dist/training/training-attempt-state.service.js');
const { TrainingMaterialService } = require('../dist/training/training-material.service.js');
const { TrainingProjectService } = require('../dist/training/training-project.service.js');

const databaseUrl = process.env.TRAINING_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('Training project deletion requires the targeted temporary database runner', () => {
    assert.equal(process.env.TRAINING_TEST_DATABASE_URL, undefined);
  });
} else {
  process.env.TRAINING_AUDIO_BUCKET = 'platforma-training-delete-audio';

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  let actor;
  let employee;
  let role;

  before(async () => {
    await prisma.$connect();
    await clearData();
    role = await prisma.role.create({
      data: { name: `training-delete-${randomUUID()}`, description: 'delete test role' },
    });
    actor = await createUser('actor');
    employee = await createUser('employee');
  });

  beforeEach(async () => {
    await clearProjectData();
  });

  after(async () => {
    await clearData();
    await prisma.$disconnect();
  });

  test('full deletion removes the project graph, revision chain and owned files', async () => {
    const storage = new MemoryStorage();
    const projects = new TrainingProjectService(prisma, new FilesService(prisma, storage));
    const project = await createProject('Полный граф');
    const question = await createQuestion(project.id);
    await prisma.trainingCriterion.create({
      data: {
        projectId: project.id,
        questionType: TrainingQuestionType.MAIN,
        code: 'delete-test',
        title: 'Delete test',
        guidance: '',
        maxPoints: 100,
        position: 1,
      },
    });
    await prisma.trainingProjectAssignment.create({
      data: { projectId: project.id, userId: employee.id, assignedById: actor.id },
    });
    await prisma.trainingTelegramLinkToken.create({
      data: {
        projectId: project.id,
        userId: employee.id,
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const account = await prisma.trainingTelegramAccount.create({
      data: {
        userId: employee.id,
        telegramUserId: BigInt(Date.now()),
        chatId: BigInt(Date.now() + 1),
      },
    });

    const firstMaterialFile = await createStoredFile(storage, 'materials/first.pdf');
    const secondMaterialFile = await createStoredFile(storage, 'materials/second.pdf');
    const material = await prisma.trainingMaterial.create({
      data: {
        projectId: project.id,
        type: TrainingMaterialType.PDF,
        title: 'Удаляемый материал',
        createdById: actor.id,
      },
    });
    const firstRevision = await prisma.trainingMaterialRevision.create({
      data: revisionData(material.id, 1, null, firstMaterialFile.id),
    });
    const secondRevision = await prisma.trainingMaterialRevision.create({
      data: revisionData(material.id, 2, firstRevision.id, secondMaterialFile.id),
    });
    await prisma.trainingFact.create({
      data: {
        questionId: question.id,
        statement: 'Факт из удаляемой ревизии',
        aliasesJson: [],
        position: 1,
        sourceType: TrainingFactSourceType.MATERIAL,
        sourceRevisionId: secondRevision.id,
        sourceLabel: material.title,
        sourceLocator: 'page:1',
        sourceExcerpt: 'Факт из удаляемой ревизии',
      },
    });

    const mergedFile = await createStoredFile(storage, 'answers/merged.wav', 'audio/wav');
    const segmentFile = await createStoredFile(storage, 'answers/segment.ogg', 'audio/ogg');
    const attempt = await prisma.trainingAttempt.create({
      data: {
        userId: employee.id,
        projectId: project.id,
        attemptNumber: 1,
        startIdempotencyKey: randomUUID(),
        status: TrainingAttemptStatus.COMPLETED,
        startedAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 60_000),
        completedAt: new Date(),
        calculatedScore: 80,
        finalScore: 85,
        isPassed: true,
        reviewStatus: TrainingReviewStatus.RESOLVED,
        reviewDecision: TrainingReviewDecision.OVERRIDDEN,
        reviewedById: actor.id,
        reviewedAt: new Date(),
        reviewComment: 'Удаляемый результат',
        reviewFinalScore: 85,
        projectSnapshotJson: { schemaVersion: 1, projectTitle: project.title },
        fakeEvaluationVersion: 'delete-test',
      },
    });
    const attemptQuestion = await prisma.trainingAttemptQuestion.create({
      data: {
        attemptId: attempt.id,
        sourceQuestionId: question.id,
        sequence: 1,
        type: TrainingQuestionType.MAIN,
        questionTextSnapshot: question.text,
        maxScore: 55,
        status: TrainingAttemptQuestionStatus.ANSWERED,
        answeredAt: new Date(),
      },
    });
    const answer = await prisma.trainingAnswer.create({
      data: {
        attemptQuestionId: attemptQuestion.id,
        source: TrainingAnswerSource.TELEGRAM,
        processingStatus: TrainingAnswerProcessingStatus.COMPLETED,
        text: 'Удаляемый ответ',
        score: 55,
        fakeOutcome: TrainingFakeOutcome.SCORED,
        safeBreakdownJson: {},
        mergedAudioFileId: mergedFile.id,
        transcriptionStatus: TrainingAiStepStatus.COMPLETED,
        evaluationStatus: TrainingAiStepStatus.COMPLETED,
        submittedAt: new Date(),
      },
    });
    await prisma.trainingAnswerSegment.create({
      data: {
        answerId: answer.id,
        position: 1,
        telegramMessageId: 1n,
        telegramFileId: 'delete-file',
        telegramFileUniqueId: 'delete-unique-file',
        durationSeconds: 5,
        sizeBytes: 8n,
        storedFileId: segmentFile.id,
      },
    });

    const unrelatedProject = await createProject('Соседний проект');
    const unrelatedMaterial = await prisma.trainingMaterial.create({
      data: {
        projectId: unrelatedProject.id,
        type: TrainingMaterialType.PDF,
        title: 'Материал с общим файлом',
        createdById: actor.id,
      },
    });
    await prisma.trainingMaterialRevision.create({
      data: revisionData(unrelatedMaterial.id, 1, null, firstMaterialFile.id),
    });
    const unrelatedFile = await createStoredFile(storage, 'unrelated/keep.pdf');
    const retainedAudioFileIds = [mergedFile.id, segmentFile.id];

    await projects.deleteProject(project.id, actor.id);

    assert.equal(await prisma.trainingProject.count({ where: { id: project.id } }), 0);
    assert.equal(await prisma.trainingProjectAssignment.count({ where: { projectId: project.id } }), 0);
    assert.equal(await prisma.trainingTelegramLinkToken.count({ where: { projectId: project.id } }), 0);
    assert.equal(await prisma.trainingQuestion.count({ where: { projectId: project.id } }), 0);
    assert.equal(await prisma.trainingFact.count({ where: { questionId: question.id } }), 0);
    assert.equal(await prisma.trainingCriterion.count({ where: { projectId: project.id } }), 0);
    assert.equal(await prisma.trainingMaterial.count({ where: { projectId: project.id } }), 0);
    assert.equal(
      await prisma.trainingMaterialRevision.count({ where: { materialId: material.id } }),
      0,
    );
    assert.equal(await prisma.trainingAttempt.count({ where: { projectId: project.id } }), 0);
    assert.equal(
      await prisma.trainingAttemptQuestion.count({ where: { attemptId: attempt.id } }),
      0,
    );
    assert.equal(
      await prisma.trainingAnswer.count({ where: { attemptQuestionId: attemptQuestion.id } }),
      0,
    );
    assert.equal(await prisma.trainingAnswerSegment.count({ where: { answerId: answer.id } }), 0);
    assert.equal(await prisma.file.count({ where: { id: secondMaterialFile.id } }), 0);
    assert.equal(await prisma.file.count({ where: { id: { in: retainedAudioFileIds } } }), 2);
    assert.equal(await prisma.file.count({ where: { id: firstMaterialFile.id } }), 1);
    assert.equal(storage.objects.size, 4);
    assert.equal(storage.has(firstMaterialFile), true);
    assert.equal(storage.has(unrelatedFile), true);
    assert.equal(storage.has(mergedFile), true);
    assert.equal(storage.has(segmentFile), true);
    assert.equal(await prisma.trainingProject.count({ where: { id: unrelatedProject.id } }), 1);
    assert.equal(
      await prisma.trainingMaterialRevision.count({
        where: { materialId: unrelatedMaterial.id, fileId: firstMaterialFile.id },
      }),
      1,
    );
    assert.equal(await prisma.trainingTelegramAccount.count({ where: { id: account.id } }), 1);
    assert.equal(await prisma.user.count({ where: { id: { in: [actor.id, employee.id] } } }), 2);

    const retainedAudio = await prisma.trainingAudioStorageEntry.findMany({
      where: { fileId: { in: retainedAudioFileIds } },
      orderBy: { kind: 'asc' },
    });
    assert.equal(retainedAudio.length, 2);
    for (const entry of retainedAudio) {
      assert.equal(entry.projectIdSnapshot, project.id);
      assert.equal(entry.projectTitleSnapshot, project.title);
      assert.equal(entry.userIdSnapshot, employee.id);
      assert.equal(entry.userNameSnapshot, employee.name);
      assert.equal(entry.userEmailSnapshot, employee.email);
      assert.equal(entry.deletedAt, null);
    }

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'training.project.delete', entityId: project.id },
      orderBy: { createdAt: 'desc' },
    });
    assert.equal(audit.actorUserId, actor.id);
    assert.equal(audit.metadata.title, project.title);
    assert.equal(audit.metadata.attemptsCount, 1);
    assert.equal(audit.metadata.assignmentsCount, 1);
    assert.equal(audit.metadata.materialsCount, 1);
    assert.equal(audit.metadata.cleanupStatus, 'COMPLETED');
    assert.equal(
      audit.metadata.storageObjects.some((object) => object.key === firstMaterialFile.key),
      false,
    );
    assert.equal(
      audit.metadata.storageObjects.some((object) => object.key === secondMaterialFile.key),
      true,
    );
    for (const file of [mergedFile, segmentFile]) {
      assert.equal(
        audit.metadata.storageObjects.some((object) => object.key === file.key),
        false,
      );
    }
    assert.equal(typeof audit.metadata.cleanupCompletedAt, 'string');
    await projects.deleteProject(project.id, actor.id);
  });

  test('storage cleanup failure is durable and a repeated delete finishes it', async () => {
    const storage = new MemoryStorage({ deleteFailuresRemaining: 1 });
    const projects = new TrainingProjectService(prisma, new FilesService(prisma, storage));
    const project = await createProject('Повтор очистки файлов');
    const storedFile = await createStoredFile(storage, 'materials/retry.pdf');
    const material = await prisma.trainingMaterial.create({
      data: {
        projectId: project.id,
        type: TrainingMaterialType.PDF,
        title: 'Материал с повторной очисткой',
        createdById: actor.id,
      },
    });
    await prisma.trainingMaterialRevision.create({
      data: revisionData(material.id, 1, null, storedFile.id),
    });

    await assert.rejects(
      () => projects.deleteProject(project.id, actor.id),
      ServiceUnavailableException,
    );
    assert.equal(await prisma.trainingProject.count({ where: { id: project.id } }), 0);
    assert.equal(await prisma.file.count({ where: { id: storedFile.id } }), 0);
    assert.equal(storage.has(storedFile), true);

    const pendingAudit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'training.project.delete', entityId: project.id },
      orderBy: { createdAt: 'desc' },
    });
    assert.equal(pendingAudit.metadata.cleanupStatus, 'PENDING');
    assert.equal(pendingAudit.metadata.cleanupRevision, 0);
    assert.equal(pendingAudit.metadata.storageObjects.length, 1);

    await projects.deleteProject(project.id, actor.id);
    assert.equal(storage.has(storedFile), false);

    const completedAudit = await prisma.auditLog.findUniqueOrThrow({
      where: { id: pendingAudit.id },
    });
    assert.equal(completedAudit.metadata.cleanupStatus, 'COMPLETED');
    await projects.deleteProject(project.id, actor.id);
  });

  test('manual audio storage deletion filters by deleted snapshots and retries idempotently', async () => {
    const storage = new MemoryStorage();
    const audioStorage = new TrainingAudioStorageService(prisma, storage);
    const formerUser = await createUser('former-owner');
    const formerProject = await createProject('Архивный проект ручного удаления');
    const answerId = randomUUID();
    const storedFile = await createStoredFile(
      storage,
      `training-v2/answers/${answerId}/merged.webm`,
      'audio/webm',
      Buffer.from('manual-delete-audio'),
    );
    const entry = await prisma.trainingAudioStorageEntry.create({
      data: {
        fileId: storedFile.id,
        kind: TrainingAudioStorageObjectKind.MERGED,
        bucket: storedFile.bucket,
        key: storedFile.key,
        checksum: storedFile.checksum,
        sizeBytes: storedFile.sizeBytes,
        mimeType: storedFile.mimeType,
        projectIdSnapshot: formerProject.id,
        projectTitleSnapshot: formerProject.title,
        userIdSnapshot: formerUser.id,
        userNameSnapshot: formerUser.name,
        userEmailSnapshot: formerUser.email,
        answerIdSnapshot: answerId,
        objectCreatedAt: storedFile.createdAt,
      },
    });

    await prisma.trainingProject.delete({ where: { id: formerProject.id } });
    await prisma.user.delete({ where: { id: formerUser.id } });

    const query = {
      page: 1,
      limit: 50,
      project: 'архивный проект',
      user: 'former-owner',
      createdFrom: null,
      createdToExclusive: null,
      state: '',
    };
    const report = await audioStorage.report(query);
    assert.equal(report.readOnly, true);
    assert.equal(report.total, 1);
    assert.equal(report.items[0].storageEntryId, entry.id);
    assert.equal(report.items[0].project.title, formerProject.title);
    assert.equal(report.items[0].user.name, formerUser.name);
    assert.equal(report.items[0].state, 'UNLINKED');
    assert.equal(report.items[0].canDelete, true);

    const manifest = await audioStorage.createDeletionManifest(actor.id, {
      selectionIds: [report.items[0].selectionId],
      reason: 'Подтверждённое ручное удаление архивного аудио',
    });
    await assert.rejects(
      () => prisma.$transaction((transaction) => upsertTrainingAudioStorageEntry(transaction, {
        fileId: storedFile.id,
        kind: TrainingAudioStorageObjectKind.MERGED,
        bucket: storedFile.bucket,
        key: storedFile.key,
      })),
      ConflictException,
    );
    storage.hooks.deleteFailuresRemaining = 1;
    const pending = await audioStorage.executeDeletionManifest(manifest.id, actor.id);
    assert.equal(pending.status, 'PENDING');
    assert.deepEqual(pending.lastErrorCodes, ['STORAGE_DELETE_FAILED']);
    assert.equal(await prisma.file.count({ where: { id: storedFile.id } }), 0);
    assert.equal(storage.has(storedFile), true);

    const completed = await audioStorage.executeDeletionManifest(manifest.id, actor.id);
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.deletedItems, 1);
    assert.equal(storage.has(storedFile), false);
    assert.notEqual(
      (await prisma.trainingAudioStorageEntry.findUniqueOrThrow({ where: { id: entry.id } })).deletedAt,
      null,
    );
    assert.equal(
      await prisma.auditLog.count({
        where: {
          action: 'training.audio_storage.delete_manifest.complete',
          entityId: manifest.id,
        },
      }),
      1,
    );

    const repeated = await audioStorage.executeDeletionManifest(manifest.id, actor.id);
    assert.equal(repeated.status, 'COMPLETED');
    assert.equal(
      await prisma.auditLog.count({
        where: {
          action: 'training.audio_storage.delete_manifest.complete',
          entityId: manifest.id,
        },
      }),
      1,
    );
    assert.equal((await audioStorage.report(query)).total, 0);
    assert.equal(
      (await audioStorage.report({ ...query, state: 'DELETED' })).items[0].user.email,
      formerUser.email,
    );
  });

  test('shared audio file never enters a manual deletion manifest', async () => {
    const storage = new MemoryStorage();
    const audioStorage = new TrainingAudioStorageService(prisma, storage);
    const project = await createProject('Проект с общей ссылкой');
    const material = await prisma.trainingMaterial.create({
      data: {
        projectId: project.id,
        type: TrainingMaterialType.PDF,
        title: 'Материал с общей ссылкой',
        createdById: actor.id,
      },
    });
    const answerId = randomUUID();
    const storedFile = await createStoredFile(
      storage,
      `training-v2/answers/${answerId}/merged.webm`,
      'audio/webm',
    );
    await prisma.trainingMaterialRevision.create({
      data: revisionData(material.id, 1, null, storedFile.id),
    });
    const entry = await prisma.trainingAudioStorageEntry.create({
      data: {
        fileId: storedFile.id,
        kind: TrainingAudioStorageObjectKind.MERGED,
        bucket: storedFile.bucket,
        key: storedFile.key,
        checksum: storedFile.checksum,
        sizeBytes: storedFile.sizeBytes,
        mimeType: storedFile.mimeType,
        projectIdSnapshot: project.id,
        projectTitleSnapshot: project.title,
        answerIdSnapshot: answerId,
        objectCreatedAt: storedFile.createdAt,
      },
    });

    const report = await audioStorage.report({
      page: 1,
      limit: 50,
      project: '',
      user: '',
      createdFrom: null,
      createdToExclusive: null,
      state: '',
    });
    const item = report.items.find((candidate) => candidate.storageEntryId === entry.id);
    assert.equal(item.state, 'LINKED');
    assert.equal(item.canDelete, false);
    await assert.rejects(
      () => audioStorage.createDeletionManifest(actor.id, {
        selectionIds: [item.selectionId],
        reason: 'Попытка удалить shared file',
      }),
      ConflictException,
    );
    assert.equal(await prisma.trainingAudioDeletionManifest.count(), 0);
    assert.equal(storage.has(storedFile), true);
  });

  test('late PDF cleanup failure is appended to the deletion audit and retried', async () => {
    const storage = new MemoryStorage();
    const files = new FilesService(prisma, storage);
    const projects = new TrainingProjectService(prisma, files);
    const materials = new TrainingMaterialService(prisma, storage, {}, {}, {}, {});
    const project = await createProject('Late PDF race');

    await projects.deleteProject(project.id, actor.id);
    const storedFile = await createStoredFile(storage, 'materials/late.pdf');
    storage.hooks.deleteFailuresRemaining = 1;

    await assert.rejects(
      () => materials.cleanupPdfAfterFailedLink(
        project.id,
        storedFile,
        new Error('Project disappeared before PDF link'),
      ),
      AggregateError,
    );
    assert.equal(storage.has(storedFile), true);
    assert.equal(await prisma.file.count({ where: { id: storedFile.id } }), 1);

    const pendingAudit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'training.project.delete', entityId: project.id },
      orderBy: { createdAt: 'desc' },
    });
    assert.equal(pendingAudit.metadata.cleanupStatus, 'PENDING');
    assert.equal(pendingAudit.metadata.cleanupRevision, 1);
    assert.equal(
      pendingAudit.metadata.storageObjects.some(
        (object) => object.key === storedFile.key && object.fileId === storedFile.id,
      ),
      true,
    );

    await projects.deleteProject(project.id, actor.id);
    assert.equal(storage.has(storedFile), false);
    assert.equal(await prisma.file.count({ where: { id: storedFile.id } }), 0);
  });

  test('Telegram start waits behind deletion without a project-token deadlock', async () => {
    const projectLocked = deferred();
    const startReachedProjectLock = deferred();
    const releaseDeletion = deferred();
    const barrierPrisma = createTransactionQueryBarrierPrisma(
      prisma,
      (query) =>
        query.includes('FROM "training_projects"') && query.includes('FOR UPDATE'),
      async () => {
        projectLocked.resolve();
        await releaseDeletion.promise;
      },
    );
    const storage = new MemoryStorage();
    const projects = new TrainingProjectService(
      barrierPrisma,
      new FilesService(barrierPrisma, storage),
    );
    const startPrisma = createTransactionQueryBarrierPrisma(
      prisma,
      (query) =>
        query.includes('FROM "training_projects"') && query.includes('FOR SHARE'),
      async () => startReachedProjectLock.resolve(),
      { beforeQuery: true },
    );
    const attemptState = new TrainingAttemptStateService(startPrisma, {}, {}, {});
    const project = await createProject('Telegram delete race');
    const token = await prisma.trainingTelegramLinkToken.create({
      data: {
        projectId: project.id,
        userId: employee.id,
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
        usedAt: new Date(),
      },
    });

    const deletion = projects.deleteProject(project.id, actor.id);
    await projectLocked.promise;
    const start = attemptState.startAttemptFromTelegramLinkToken(token.id, employee.id);
    await startReachedProjectLock.promise;
    releaseDeletion.resolve();

    const [deletionResult, startResult] = await Promise.allSettled([deletion, start]);
    assert.equal(deletionResult.status, 'fulfilled');
    assert.equal(startResult.status, 'rejected');
    assert.ok(startResult.reason instanceof NotFoundException);
    assert.equal(await prisma.trainingProject.count({ where: { id: project.id } }), 0);
    assert.equal(await prisma.trainingTelegramLinkToken.count({ where: { id: token.id } }), 0);
  });

  test('segment uploaded while a project is deleted is retained for manual cleanup', async () => {
    const barrier = deferred();
    const release = deferred();
    const storage = new MemoryStorage({
      onSegmentPut: async () => {
        barrier.resolve();
        await release.promise;
      },
    });
    const projects = new TrainingProjectService(prisma, new FilesService(prisma, storage));
    const project = await createProject('Segment race');
    const question = await createQuestion(project.id);
    const { answer, segment } = await createProcessingAnswer(project.id, question.id);
    const audio = new TrainingAudioService(
      prisma,
      storage,
      {
        getFile: async () => ({ filePath: 'voice/delete.ogg', sizeBytes: 8 }),
        downloadFile: async () => ({
          body: Buffer.from('OggSrace'),
          mimeType: 'audio/ogg',
          sizeBytes: 8,
        }),
      },
      { run: async () => assert.fail('ffmpeg must not run after project deletion') },
    );

    const processing = audio.prepareAnswerAudio(answer.id);
    await barrier.promise;
    await projects.deleteProject(project.id, actor.id);
    release.resolve();

    await assert.rejects(processing);
    assert.equal(storage.objects.size, 1);
    assert.equal(await prisma.file.count({ where: { key: { contains: segment.id } } }), 0);
    assert.equal(await prisma.trainingProject.count({ where: { id: project.id } }), 0);
    const retained = await prisma.trainingAudioStorageEntry.findUniqueOrThrow({
      where: {
        bucket_key: {
          bucket: process.env.TRAINING_AUDIO_BUCKET,
          key: `training-v2/answers/${answer.id}/segments/${segment.id}.ogg`,
        },
      },
    });
    assert.equal(retained.fileId, null);
    assert.equal(retained.projectIdSnapshot, project.id);
    assert.equal(retained.projectTitleSnapshot, project.title);
    assert.equal(retained.userIdSnapshot, employee.id);
  });

  test('late audio upload stays in storage until an explicit manual deletion', async () => {
    const uploadStarted = deferred();
    const releaseUpload = deferred();
    const storage = new MemoryStorage({
      onSegmentPutBeforeStore: async () => {
        uploadStarted.resolve();
        await releaseUpload.promise;
      },
    });
    const projects = new TrainingProjectService(prisma, new FilesService(prisma, storage));
    const project = await createProject('Late audio race');
    const question = await createQuestion(project.id);
    const { answer, segment } = await createProcessingAnswer(project.id, question.id);
    const audio = new TrainingAudioService(
      prisma,
      storage,
      {
        getFile: async () => ({ filePath: 'voice/late.ogg', sizeBytes: 8 }),
        downloadFile: async () => ({
          body: Buffer.from('OggSlate'),
          mimeType: 'audio/ogg',
          sizeBytes: 8,
        }),
      },
      { run: async () => assert.fail('ffmpeg must not run after project deletion') },
    );

    const processing = audio.prepareAnswerAudio(answer.id);
    await uploadStarted.promise;
    await projects.deleteProject(project.id, actor.id);
    releaseUpload.resolve();

    await assert.rejects(processing);
    assert.equal(storage.objects.size, 1);
    assert.equal(
      storage.objects.has(
        storage.objectId(
          `training-v2/answers/${answer.id}/segments/${segment.id}.ogg`,
          process.env.TRAINING_AUDIO_BUCKET,
        ),
      ),
      true,
    );
    const projectAudit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'training.project.delete', entityId: project.id },
      orderBy: { createdAt: 'desc' },
    });
    assert.equal(projectAudit.metadata.cleanupStatus, 'COMPLETED');
    assert.equal(projectAudit.metadata.storageObjects.length, 0);

    await projects.deleteProject(project.id, actor.id);
    assert.equal(storage.objects.size, 1);
    assert.equal(
      await prisma.trainingAudioStorageEntry.count({
        where: {
          bucket: process.env.TRAINING_AUDIO_BUCKET,
          key: `training-v2/answers/${answer.id}/segments/${segment.id}.ogg`,
          deletedAt: null,
        },
      }),
      1,
    );
  });

  test('merged audio uploaded while a project is deleted is retained with its segment', async () => {
    const barrier = deferred();
    const release = deferred();
    const storage = new MemoryStorage({
      onMergedPut: async () => {
        barrier.resolve();
        await release.promise;
      },
    });
    const projects = new TrainingProjectService(prisma, new FilesService(prisma, storage));
    const project = await createProject('Merged race');
    const question = await createQuestion(project.id);
    const { answer, segment } = await createProcessingAnswer(project.id, question.id);
    const segmentFile = await createStoredFile(
      storage,
      `training-v2/answers/${answer.id}/segments/${segment.id}.ogg`,
      'audio/ogg',
      Buffer.from('OggSrace'),
    );
    await prisma.trainingAnswerSegment.update({
      where: { id: segment.id },
      data: { storedFileId: segmentFile.id },
    });
    const audio = new TrainingAudioService(
      prisma,
      storage,
      {},
      {
        run: async (args) => {
          const outputPath = args.at(-1);
          const webm = Buffer.alloc(64);
          Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).copy(webm);
          await writeFile(outputPath, webm);
        },
      },
    );

    const processing = audio.prepareAnswerAudio(answer.id);
    await barrier.promise;
    await projects.deleteProject(project.id, actor.id);
    release.resolve();

    await assert.rejects(processing);
    assert.equal(storage.objects.size, 2);
    assert.equal(await prisma.file.count({ where: { id: segmentFile.id } }), 1);
    assert.equal(
      await prisma.file.count({ where: { key: `training-v2/answers/${answer.id}/merged.webm` } }),
      0,
    );
    assert.equal(
      await prisma.trainingAudioStorageEntry.count({
        where: {
          projectIdSnapshot: project.id,
          key: { in: [
            segmentFile.key,
            `training-v2/answers/${answer.id}/merged.webm`,
          ] },
        },
      }),
      2,
    );
  });

  async function createUser(label) {
    return prisma.user.create({
      data: {
        email: `training-delete-${label}-${randomUUID()}@training-delete.test`,
        passwordHash: 'test-hash',
        name: `Delete ${label}`,
        status: UserStatus.ACTIVE,
        roleId: role.id,
      },
    });
  }

  async function createProject(title) {
    return prisma.trainingProject.create({
      data: {
        title,
        attemptLimit: 3,
        timeLimitSeconds: 420,
        passScore: 75,
        allowRetakeAfterPass: false,
        contentSchemaVersion: 3,
      },
    });
  }

  async function createQuestion(projectId) {
    return prisma.trainingQuestion.create({
      data: {
        projectId,
        type: TrainingQuestionType.MAIN,
        text: 'Удаляемый вопрос',
        position: 1,
      },
    });
  }

  async function createProcessingAnswer(projectId, questionId) {
    const attempt = await prisma.trainingAttempt.create({
      data: {
        userId: employee.id,
        projectId,
        attemptNumber: 1,
        startIdempotencyKey: randomUUID(),
        status: TrainingAttemptStatus.IN_PROGRESS,
        expiresAt: new Date(Date.now() + 60_000),
        projectSnapshotJson: { schemaVersion: 1, projectTitle: 'Race project' },
        fakeEvaluationVersion: 'delete-race',
      },
    });
    const attemptQuestion = await prisma.trainingAttemptQuestion.create({
      data: {
        attemptId: attempt.id,
        sourceQuestionId: questionId,
        sequence: 1,
        type: TrainingQuestionType.MAIN,
        questionTextSnapshot: 'Удаляемый вопрос',
        maxScore: 55,
      },
    });
    const answer = await prisma.trainingAnswer.create({
      data: {
        attemptQuestionId: attemptQuestion.id,
        source: TrainingAnswerSource.TELEGRAM,
        processingStatus: TrainingAnswerProcessingStatus.PROCESSING,
      },
    });
    const segment = await prisma.trainingAnswerSegment.create({
      data: {
        answerId: answer.id,
        position: 1,
        telegramMessageId: BigInt(Date.now()),
        telegramFileId: `delete-${randomUUID()}`,
        telegramFileUniqueId: `delete-unique-${randomUUID()}`,
        durationSeconds: 5,
        sizeBytes: 8n,
      },
    });
    return { answer, segment };
  }

  function revisionData(materialId, revisionNumber, previousRevisionId, fileId) {
    return {
      materialId,
      revisionNumber,
      previousRevisionId,
      status: TrainingMaterialRevisionStatus.READY,
      fileId,
      extractedText: `Revision ${revisionNumber}`,
      segmentsJson: [{ locator: 'page:1', label: 'Страница 1', text: `Revision ${revisionNumber}` }],
      contentHash: String(revisionNumber).repeat(64),
      extractionMetadataJson: { method: 'DELETE_TEST' },
      diffJson: {
        previousRevisionId,
        added: [],
        removed: [],
        unchangedCount: 0,
        changed: true,
      },
      isChanged: true,
      createdById: actor.id,
    };
  }

  async function createStoredFile(
    storage,
    suffix,
    mimeType = 'application/pdf',
    body = Buffer.from('delete-test'),
  ) {
    const bucket = mimeType.startsWith('audio/')
      ? process.env.TRAINING_AUDIO_BUCKET
      : 'platforma-training-materials';
    const key = suffix.startsWith('training-v2/')
      ? suffix
      : `training-v2/delete-test/${randomUUID()}/${suffix}`;
    const file = await prisma.file.create({
      data: {
        storage: FileStorage.MINIO,
        bucket,
        key,
        url: null,
        originalName: suffix.split('/').at(-1),
        mimeType,
        sizeBytes: BigInt(body.length),
        checksum: createHash('sha256').update(body).digest('hex'),
        uploadedById: actor.id,
      },
    });
    storage.set(file, body);
    return file;
  }

  async function clearProjectData() {
    await prisma.trainingAudioDeletionManifest.deleteMany();
    await prisma.trainingAudioStorageEntry.deleteMany();
    await prisma.trainingAnswerSegment.deleteMany();
    await prisma.trainingAnswer.deleteMany();
    await prisma.trainingAttemptQuestion.deleteMany();
    await prisma.trainingAttempt.deleteMany();
    await prisma.trainingTelegramLinkToken.deleteMany();
    await prisma.trainingProjectAssignment.deleteMany();
    await prisma.trainingFact.deleteMany();
    const revisions = await prisma.trainingMaterialRevision.findMany({
      orderBy: [{ revisionNumber: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    for (const revision of revisions) {
      await prisma.trainingMaterialRevision.delete({ where: { id: revision.id } });
    }
    await prisma.trainingMaterial.deleteMany();
    await prisma.trainingCriterion.deleteMany();
    await prisma.trainingQuestion.deleteMany();
    await prisma.trainingProject.deleteMany();
    await prisma.trainingTelegramAccount.deleteMany();
    await prisma.file.deleteMany({ where: { key: { startsWith: 'training-v2/delete-test/' } } });
    await prisma.file.deleteMany({ where: { key: { startsWith: 'training-v2/answers/' } } });
    await prisma.auditLog.deleteMany({
      where: {
        action: {
          in: [
            'training.project.delete',
            'training.audio_storage.delete_manifest.create',
            'training.audio_storage.delete_manifest.complete',
          ],
        },
      },
    });
  }

  async function clearData() {
    await clearProjectData();
    await prisma.user.deleteMany({ where: { email: { endsWith: '@training-delete.test' } } });
    await prisma.role.deleteMany({ where: { name: { startsWith: 'training-delete-' } } });
  }
}

class MemoryStorage {
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.objects = new Map();
  }

  getBucket() {
    return 'platforma-public-files';
  }

  set(file, body) {
    this.objects.set(this.objectId(file.key, file.bucket), body);
  }

  has(file) {
    return this.objects.has(this.objectId(file.key, file.bucket));
  }

  async getObject(key, bucket) {
    const body = this.objects.get(this.objectId(key, bucket));
    if (!body) throw new Error('Object not found');
    return body;
  }

  async getObjectToFile({ key, bucket, filePath }) {
    const body = await this.getObject(key, bucket);
    await writeFile(filePath, body, { flag: 'wx' });
    return {
      size: body.length,
      checksum: createHash('sha256').update(body).digest('hex'),
    };
  }

  async listObjects({ bucket, prefix, maxObjects }) {
    const objects = [];
    const bucketPrefix = `${bucket}/`;

    for (const [id, body] of this.objects) {
      if (!id.startsWith(bucketPrefix)) continue;
      const key = id.slice(bucketPrefix.length);
      if (!key.startsWith(prefix)) continue;
      objects.push({
        key,
        size: body.length,
        etag: createHash('md5').update(body).digest('hex'),
        lastModified: new Date(),
      });
      if (objects.length > maxObjects) throw new Error('Reconciliation limit exceeded');
    }

    return objects;
  }

  async putObject(input) {
    if (input.key.includes('/segments/')) await this.hooks.onSegmentPutBeforeStore?.();
    this.objects.set(this.objectId(input.key, input.bucket), input.body);
    if (input.key.includes('/segments/')) await this.hooks.onSegmentPut?.();
  }

  async putObjectFromFile(input) {
    if (input.key.includes('/segments/')) await this.hooks.onSegmentPutBeforeStore?.();
    this.objects.set(this.objectId(input.key, input.bucket), await readFile(input.filePath));
    if (input.key.includes('/segments/')) await this.hooks.onSegmentPut?.();
    if (input.key.endsWith('/merged.webm')) await this.hooks.onMergedPut?.();
  }

  async deleteObject(key, bucket) {
    if ((this.hooks.deleteFailuresRemaining ?? 0) > 0) {
      this.hooks.deleteFailuresRemaining -= 1;
      throw new Error('Storage unavailable');
    }
    this.objects.delete(this.objectId(key, bucket));
  }

  objectId(key, bucket) {
    return `${bucket ?? this.getBucket()}/${key}`;
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createTransactionQueryBarrierPrisma(
  prisma,
  matches,
  onMatch,
  { beforeQuery = false } = {},
) {
  let matched = false;

  return new Proxy(prisma, {
    get(target, property, receiver) {
      if (property !== '$transaction') return Reflect.get(target, property, receiver);

      return (callback, options) => target.$transaction(
        (transaction) => callback(new Proxy(transaction, {
          get(transactionTarget, transactionProperty, transactionReceiver) {
            if (transactionProperty !== '$queryRaw') {
              return Reflect.get(transactionTarget, transactionProperty, transactionReceiver);
            }

            return async (...args) => {
              const query = args[0]?.sql ?? '';
              const isMatch = !matched && matches(query);
              if (isMatch && beforeQuery) {
                matched = true;
                await onMatch();
              }
              const result = await transactionTarget.$queryRaw(...args);
              if (isMatch && !beforeQuery) {
                matched = true;
                await onMatch();
              }
              return result;
            };
          },
        })),
        options,
      );
    },
  });
}
