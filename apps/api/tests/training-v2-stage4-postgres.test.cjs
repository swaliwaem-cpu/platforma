require('reflect-metadata');

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
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
const {
  DeterministicFakeTrainingMaterialSuggester,
  prepareTrainingQuestionKnowledge,
} = require('../dist/training/training-material-suggester.js');
const {
  createTrainingQuestionGenerationPlan,
  hashTrainingQuestionGenerationKey,
} = require('../dist/training/training-question-generation-artifact.js');
const {
  TrainingProjectKnowledgeService,
} = require('../dist/training/training-project-knowledge.service.js');

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

  test('project knowledge reuses source hash, versions changes and claims concurrent generation once', async () => {
    const project = await createProject('knowledge');
    const deterministic = new DeterministicFakeTrainingMaterialSuggester();
    let calls = 0;
    const counted = {
      suggest: (input) => deterministic.suggest(input),
      generateQuestionDrafts: async (input) => {
        calls += 1;
        return deterministic.generateQuestionDrafts(input);
      },
    };
    const service = new TrainingProjectKnowledgeService(prisma, counted);
    const initial = knowledgeInput(project.id, 'Стабильный факт проекта.');
    const first = await service.compile(initial);
    const repeated = await service.compile(initial);

    assert.equal(calls, 1);
    assert.equal(first.reused, false);
    assert.equal(repeated.reused, true);
    assert.equal(repeated.sourceHash, first.sourceHash);
    assert.equal(repeated.compilationVersion, first.compilationVersion);

    const changed = await service.compile(knowledgeInput(project.id, 'Материал проекта изменён.'));
    assert.equal(calls, 2);
    assert.notEqual(changed.sourceHash, first.sourceHash);
    assert.ok(changed.compilationVersion > first.compilationVersion);

    const concurrentProject = await createProject('knowledge-race');
    let releaseProvider;
    let providerStarted;
    const started = new Promise((resolve) => { providerStarted = resolve; });
    const release = new Promise((resolve) => { releaseProvider = resolve; });
    let concurrentCalls = 0;
    const concurrent = new TrainingProjectKnowledgeService(prisma, {
      suggest: (input) => deterministic.suggest(input),
      generateQuestionDrafts: async (input) => {
        concurrentCalls += 1;
        providerStarted();
        await release;
        return deterministic.generateQuestionDrafts(input);
      },
    });
    const concurrentInput = knowledgeInput(concurrentProject.id, 'Один конкурентный источник.');
    const winner = concurrent.compile(concurrentInput);
    await started;
    const waiter = concurrent.compile(concurrentInput);
    releaseProvider();
    const results = await Promise.all([winner, waiter]);

    assert.equal(concurrentCalls, 1);
    assert.equal(results.filter((result) => result.reused).length, 1);
    assert.equal(await prisma.trainingProjectKnowledgeVersion.count({
      where: { projectId: concurrentProject.id },
    }), 1);

    const staleProject = await createProject('knowledge-stale-source');
    const staleInput = {
      ...knowledgeInput(staleProject.id, 'Устаревший снимок источников.'),
      expectedProjectKnowledgeVersion: staleProject.knowledgeVersion,
    };
    await prisma.trainingProject.update({
      where: { id: staleProject.id },
      data: { knowledgeVersion: { increment: 1 } },
    });
    const callsBeforeStale = calls;
    await assert.rejects(
      () => service.compile(staleInput),
      (error) => error.code === 'QUESTION_KNOWLEDGE_SOURCE_STALE',
    );
    assert.equal(calls, callsBeforeStale);
  });

  test('project knowledge can reuse A after applying A plus B and returning to A', async () => {
    const project = await createProject('knowledge-return');
    const deterministic = new DeterministicFakeTrainingMaterialSuggester();
    let calls = 0;
    const counted = {
      suggest: (input) => deterministic.suggest(input),
      generateQuestionDrafts: async (input) => {
        calls += 1;
        return deterministic.generateQuestionDrafts(input);
      },
    };
    const knowledge = new TrainingProjectKnowledgeService(prisma, counted);
    const materials = new TrainingMaterialService(
      prisma,
      {},
      new TrainingMaterialExtractionService(),
      {},
      counted,
      knowledge,
    );
    const materialA = await materials.createManual(
      project.id,
      user.id,
      'Источник A',
      'Стабильный факт источника A.',
    );
    const sourceA = materialSource(materialA);
    const compilationA = await knowledge.compile(questionInput(project.id, [sourceA]));
    await materials.applyGeneratedQuestionDrafts(project.id, null, compilationA, true);

    const materialB = await materials.createManual(
      project.id,
      user.id,
      'Источник B',
      'Дополнительный факт источника B.',
    );
    const compilationAB = await knowledge.compile(questionInput(
      project.id,
      [sourceA, materialSource(materialB)],
    ));
    await materials.applyGeneratedQuestionDrafts(project.id, null, compilationAB, true);
    await materials.archive(materialB.id);

    const reusedA = await knowledge.compile(questionInput(project.id, [sourceA]));
    assert.equal(reusedA.reused, true);
    assert.equal(reusedA.sourceHash, compilationA.sourceHash);
    assert.equal(calls, 2);
    await materials.applyGeneratedQuestionDrafts(project.id, null, reusedA, true);

    const finalProject = await prisma.trainingProject.findUniqueOrThrow({
      where: { id: project.id },
      select: { knowledgeSourceHash: true },
    });
    assert.equal(finalProject.knowledgeSourceHash, compilationA.sourceHash);
  });

  test('shared artifact serves two concurrent projects once and keeps criteria plus provenance local', async () => {
    await withEnv({ TRAINING_CROSS_PROJECT_GENERATION_REUSE_ENABLED: 'true' }, async () => {
      const object = await createObject('shared-concurrent');
      const firstProject = await createProject('shared-first', object.id);
      const secondProject = await createProject('shared-second', object.id);
      await Promise.all([
        createCriterion(firstProject.id, 'first-project-only'),
        createCriterion(secondProject.id, 'second-project-only'),
      ]);
      const text = 'В объекте предусмотрен закрытый двор без машин.';
      const firstMaterial = await createSnapshotMaterial(
        firstProject.id,
        object.id,
        text,
        'object-field:description:first',
      );
      const secondMaterial = await createSnapshotMaterial(
        secondProject.id,
        object.id,
        text,
        'object-field:description:second',
      );
      const firstInput = questionInput(firstProject.id, [
        reusableMaterialSource(firstMaterial, object.id),
      ], object);
      const secondInput = questionInput(secondProject.id, [
        reusableMaterialSource(secondMaterial, object.id),
      ], object);
      const deterministic = new DeterministicFakeTrainingMaterialSuggester();
      let calls = 0;
      let releaseProvider;
      let providerStarted;
      const started = new Promise((resolve) => { providerStarted = resolve; });
      const release = new Promise((resolve) => { releaseProvider = resolve; });
      const counted = {
        suggest: (input) => deterministic.suggest(input),
        generateQuestionDrafts: async (input, options) => {
          calls += 1;
          providerStarted();
          await release;
          return deterministic.generateQuestionDrafts(input, options);
        },
      };
      const knowledge = new TrainingProjectKnowledgeService(prisma, counted);
      let waiterEntered;
      const waiterStarted = new Promise((resolve) => { waiterEntered = resolve; });
      const waitForSharedArtifact = knowledge.waitForSharedArtifact.bind(knowledge);
      knowledge.waitForSharedArtifact = async (...args) => {
        waiterEntered();
        return waitForSharedArtifact(...args);
      };
      const firstCompilationPromise = knowledge.compile(firstInput);
      await started;
      const secondCompilationPromise = knowledge.compile(secondInput);
      await waiterStarted;
      releaseProvider();
      const [firstCompilation, secondCompilation] = await Promise.all([
        firstCompilationPromise,
        secondCompilationPromise,
      ]);

      assert.equal(calls, 1);
      assert.equal(
        [firstCompilation, secondCompilation].filter((item) => item.reused).length,
        1,
      );
      const artifacts = await prisma.trainingQuestionGenerationArtifact.findMany({
        where: { realEstateObjectId: object.id },
      });
      assert.equal(artifacts.length, 1);
      const knowledgeRows = await prisma.trainingProjectKnowledgeVersion.findMany({
        where: { projectId: { in: [firstProject.id, secondProject.id] } },
        orderBy: { projectId: 'asc' },
      });
      assert.equal(knowledgeRows.length, 2);
      assert.equal(knowledgeRows.every((row) => row.generationArtifactId === artifacts[0].id), true);
      const artifactJson = JSON.stringify(artifacts[0].artifactJson);
      assert.doesNotMatch(artifactJson, new RegExp(
        `${firstProject.id}|${secondProject.id}|${firstMaterial.latestRevision.id}|${secondMaterial.latestRevision.id}|first-project-only|second-project-only`,
        'u',
      ));
      const firstKnowledge = knowledgeRows.find((row) => row.projectId === firstProject.id);
      const secondKnowledge = knowledgeRows.find((row) => row.projectId === secondProject.id);
      assert.deepEqual(
        firstKnowledge.compiledKnowledgeJson.criteria.map((criterion) => criterion.code),
        ['first-project-only'],
      );
      assert.deepEqual(
        secondKnowledge.compiledKnowledgeJson.criteria.map((criterion) => criterion.code),
        ['second-project-only'],
      );
      assert.equal(
        [...firstCompilation.references.values()].every(
          (reference) => reference.sourceRevisionId === firstMaterial.latestRevision.id,
        ),
        true,
      );
      assert.equal(
        [...secondCompilation.references.values()].every(
          (reference) => reference.sourceRevisionId === secondMaterial.latestRevision.id,
        ),
        true,
      );

      const materials = new TrainingMaterialService(
        prisma,
        {},
        new TrainingMaterialExtractionService(),
        {},
        counted,
        knowledge,
      );
      await materials.applyGeneratedQuestionDrafts(
        firstProject.id,
        object.id,
        firstCompilation,
        true,
      );
      await materials.applyGeneratedQuestionDrafts(
        secondProject.id,
        object.id,
        secondCompilation,
        true,
      );
      const persistedProvenance = await prisma.trainingFact.findMany({
        where: { question: { projectId: { in: [firstProject.id, secondProject.id] } } },
        select: { sourceRevisionId: true, question: { select: { projectId: true } } },
      });
      assert.equal(persistedProvenance.length > 0, true);
      assert.equal(persistedProvenance.every((fact) =>
        fact.sourceRevisionId === (
          fact.question.projectId === firstProject.id
            ? firstMaterial.latestRevision.id
            : secondMaterial.latestRevision.id
        )
      ), true);

      await deleteProjectGraph(firstProject.id);
      assert.equal(await prisma.trainingQuestionGenerationArtifact.count({
        where: { id: artifacts[0].id },
      }), 1);
      assert.equal(await prisma.trainingFact.count({
        where: {
          question: { projectId: secondProject.id },
          sourceRevisionId: secondMaterial.latestRevision.id,
        },
      }) > 0, true);
      const secondAgain = await knowledge.compile(secondInput);
      assert.equal(secondAgain.reused, true);
      assert.equal(calls, 1);
    });
  });

  test('every generation key component produces a PostgreSQL artifact cache miss', async () => {
    await withEnv({ TRAINING_CROSS_PROJECT_GENERATION_REUSE_ENABLED: 'true' }, async () => {
      const object = await createObject('key-components');
      const project = await createProject('key-components', object.id);
      const input = reusableKnowledgeInput(project.id, object, 'Неизменяемый факт ключа.');
      const prepared = prepareTrainingQuestionKnowledge(input);
      const basePlan = createTrainingQuestionGenerationPlan(input, prepared, object.id);
      assert.ok(basePlan);
      const deterministic = new DeterministicFakeTrainingMaterialSuggester();
      let calls = 0;
      const service = new TrainingProjectKnowledgeService(prisma, {
        suggest: (suggestionInput) => deterministic.suggest(suggestionInput),
        generateQuestionDrafts: async (generationInput, options) => {
          calls += 1;
          return deterministic.generateQuestionDrafts(generationInput, options);
        },
      });
      const differentHash = createHash('sha256').update('different-content').digest('hex');
      const variants = [
        basePlan,
        changeGenerationPlan(basePlan, 'sourceFingerprint', differentHash, {
          sourceFingerprint: differentHash,
          contentHashes: [differentHash],
        }),
        changeGenerationPlan(basePlan, 'generationModel', 'different-model', {
          generationModel: 'different-model',
        }),
        changeGenerationPlan(basePlan, 'generationReasoning', 'high', {
          generationReasoning: 'high',
        }),
        changeGenerationPlan(basePlan, 'promptVersion', 'different-prompt', {
          promptVersion: 'different-prompt',
        }),
        changeGenerationPlan(basePlan, 'compilerVersion', 'different-compiler', {
          compilerVersion: 'different-compiler',
        }),
        changeGenerationPlan(basePlan, 'chosenBudget', basePlan.chosenBudget + 1, {
          chosenBudget: basePlan.chosenBudget + 1,
        }),
        changeGenerationPlan(basePlan, 'budgetPolicyVersion', 'different-policy', {
          budgetPolicyVersion: 'different-policy',
        }),
        changeGenerationPlan(basePlan, 'routingStrategy', 'different-routing', {
          routingStrategy: 'different-routing',
        }),
        changeGenerationPlan(basePlan, 'maxOutputTokens', basePlan.maxOutputTokens + 1, {
          maxOutputTokens: basePlan.maxOutputTokens + 1,
        }),
      ];

      for (const plan of variants) {
        const result = await service.obtainSharedArtifact(input, prepared, plan);
        assert.equal(result.reused, false);
      }
      const repeated = await service.obtainSharedArtifact(input, prepared, basePlan);
      assert.equal(repeated.reused, true);
      assert.equal(calls, variants.length);
      assert.equal(await prisma.trainingQuestionGenerationArtifact.count({
        where: { realEstateObjectId: object.id },
      }), variants.length);
      assert.equal(new Set(variants.map((plan) => plan.generationKeyHash)).size, variants.length);
    });
  });

  test('failed and stale shared claims recover with fencing', async () => {
    await withEnv({ TRAINING_CROSS_PROJECT_GENERATION_REUSE_ENABLED: 'true' }, async () => {
      const deterministic = new DeterministicFakeTrainingMaterialSuggester();
      const failedObject = await createObject('failed-claim');
      const failedProject = await createProject('failed-claim', failedObject.id);
      const failedInput = reusableKnowledgeInput(
        failedProject.id,
        failedObject,
        'Факт для повторной генерации после ошибки.',
      );
      let failedCalls = 0;
      const failedService = new TrainingProjectKnowledgeService(prisma, {
        suggest: (input) => deterministic.suggest(input),
        generateQuestionDrafts: async (input, options) => {
          failedCalls += 1;
          if (failedCalls === 1) throw new Error('bounded provider failure');
          return deterministic.generateQuestionDrafts(input, options);
        },
      });
      await assert.rejects(() => failedService.compile(failedInput), /bounded provider failure/u);
      const failedArtifact = await prisma.trainingQuestionGenerationArtifact.findFirstOrThrow({
        where: { realEstateObjectId: failedObject.id },
      });
      assert.equal(failedArtifact.status, 'FAILED');
      const recovered = await failedService.compile(failedInput);
      assert.equal(recovered.reused, false);
      assert.equal(failedCalls, 2);
      assert.equal((await prisma.trainingQuestionGenerationArtifact.findUniqueOrThrow({
        where: { id: failedArtifact.id },
      })).status, 'READY');

      const staleObject = await createObject('stale-claim');
      const staleProject = await createProject('stale-claim', staleObject.id);
      const staleInput = reusableKnowledgeInput(
        staleProject.id,
        staleObject,
        'Факт для восстановления просроченной аренды.',
      );
      const stalePrepared = prepareTrainingQuestionKnowledge(staleInput);
      const stalePlan = createTrainingQuestionGenerationPlan(
        staleInput,
        stalePrepared,
        staleObject.id,
      );
      assert.ok(stalePlan);
      const staleToken = randomUUID();
      const staleArtifact = await prisma.trainingQuestionGenerationArtifact.create({
        data: {
          realEstateObjectId: staleObject.id,
          generationKeyHash: stalePlan.generationKeyHash,
          generationKeyJson: stalePlan.generationKey,
          sourceFingerprint: stalePlan.sourceFingerprint,
          artifactSchemaVersion: stalePlan.artifactSchemaVersion,
          compilerVersion: stalePlan.compilerVersion,
          promptVersion: stalePlan.promptVersion,
          generationModel: stalePlan.generationModel,
          generationReasoning: stalePlan.generationReasoning,
          routingStrategy: stalePlan.routingStrategy,
          chosenBudget: stalePlan.chosenBudget,
          budgetPolicyVersion: stalePlan.budgetPolicyVersion,
          maxOutputTokens: stalePlan.maxOutputTokens,
          status: 'GENERATING',
          generationToken: staleToken,
          lockedAt: new Date(Date.now() - 15 * 60_000),
        },
      });
      let staleCalls = 0;
      let staleProviderStarted;
      let releaseStaleProvider;
      const staleStarted = new Promise((resolve) => { staleProviderStarted = resolve; });
      const staleRelease = new Promise((resolve) => { releaseStaleProvider = resolve; });
      const staleService = new TrainingProjectKnowledgeService(prisma, {
        suggest: (input) => deterministic.suggest(input),
        generateQuestionDrafts: async (input, options) => {
          staleCalls += 1;
          staleProviderStarted();
          await staleRelease;
          return deterministic.generateQuestionDrafts(input, options);
        },
      });
      const staleRecovery = staleService.compile(staleInput);
      await staleStarted;
      const activeReclaim = await prisma.trainingQuestionGenerationArtifact.findUniqueOrThrow({
        where: { id: staleArtifact.id },
      });
      assert.equal(activeReclaim.status, 'GENERATING');
      assert.notEqual(activeReclaim.generationToken, staleToken);
      const staleOwnerWrite = await prisma.trainingQuestionGenerationArtifact.updateMany({
        where: { id: staleArtifact.id, status: 'GENERATING', generationToken: staleToken },
        data: { errorCode: 'STALE_OWNER_MUST_NOT_WRITE' },
      });
      assert.equal(staleOwnerWrite.count, 0);
      releaseStaleProvider();
      const staleRecovered = await staleRecovery;
      assert.equal(staleRecovered.reused, false);
      assert.equal(staleCalls, 1);
      const readyArtifact = await prisma.trainingQuestionGenerationArtifact.findUniqueOrThrow({
        where: { id: staleArtifact.id },
      });
      assert.equal(readyArtifact.status, 'READY');
      assert.notEqual(readyArtifact.generationToken, staleToken);
    });
  });

  test('feature flag off and ineligible sources preserve project-local generation', async () => {
    const deterministic = new DeterministicFakeTrainingMaterialSuggester();
    let calls = 0;
    const service = new TrainingProjectKnowledgeService(prisma, {
      suggest: (input) => deterministic.suggest(input),
      generateQuestionDrafts: async (input, options) => {
        calls += 1;
        return deterministic.generateQuestionDrafts(input, options);
      },
    });
    const flagOffObject = await createObject('flag-off');
    const flagOffProjects = await Promise.all([
      createProject('flag-off-first', flagOffObject.id),
      createProject('flag-off-second', flagOffObject.id),
    ]);
    await withEnv({ TRAINING_CROSS_PROJECT_GENERATION_REUSE_ENABLED: 'false' }, async () => {
      await Promise.all(flagOffProjects.map((project) => service.compile(
        reusableKnowledgeInput(project.id, flagOffObject, 'Одинаковый eligible факт при flag off.'),
      )));
    });
    assert.equal(calls, 2);
    assert.equal(await prisma.trainingQuestionGenerationArtifact.count({
      where: { realEstateObjectId: flagOffObject.id },
    }), 0);

    await withEnv({ TRAINING_CROSS_PROJECT_GENERATION_REUSE_ENABLED: 'true' }, async () => {
      for (const materialType of ['MANUAL_TEXT', 'OFFICIAL_URL', 'PDF']) {
        const object = await createObject(`local-${materialType.toLowerCase()}`);
        const projects = await Promise.all([
          createProject(`${materialType}-first`, object.id),
          createProject(`${materialType}-second`, object.id),
        ]);
        await Promise.all(projects.map((project) => service.compile(
          projectLocalKnowledgeInput(
            project.id,
            object,
            `Одинаковый project-local факт ${materialType}.`,
            materialType,
          ),
        )));
        assert.equal(await prisma.trainingQuestionGenerationArtifact.count({
          where: { realEstateObjectId: object.id },
        }), 0);
      }

      const importedPdfObject = await createObject('imported-pdf');
      const importedPdfProjects = await Promise.all([
        createProject('imported-pdf-first', importedPdfObject.id),
        createProject('imported-pdf-second', importedPdfObject.id),
      ]);
      await Promise.all(importedPdfProjects.map((project) => service.compile(
        reusableKnowledgeInput(
          project.id,
          importedPdfObject,
          'Одинаковый PDF, импортированный из Platforma-объекта.',
          {
            materialType: 'PDF',
            reuseKind: 'PLATFORMA_OBJECT_PDF',
          },
        ),
      )));
      assert.equal(await prisma.trainingQuestionGenerationArtifact.count({
        where: { realEstateObjectId: importedPdfObject.id },
      }), 1);
    });
    assert.equal(calls, 9);
  });

  test('shared artifact survives project deletion and is removed with its RealEstateObject', async () => {
    await withEnv({ TRAINING_CROSS_PROJECT_GENERATION_REUSE_ENABLED: 'true' }, async () => {
      const object = await createObject('retention');
      const project = await createProject('retention', object.id);
      const deterministic = new DeterministicFakeTrainingMaterialSuggester();
      const service = new TrainingProjectKnowledgeService(prisma, deterministic);
      await service.compile(reusableKnowledgeInput(
        project.id,
        object,
        'Artifact хранится до физического удаления объекта.',
      ));
      const artifact = await prisma.trainingQuestionGenerationArtifact.findFirstOrThrow({
        where: { realEstateObjectId: object.id },
      });
      const knowledge = await prisma.trainingProjectKnowledgeVersion.findFirstOrThrow({
        where: { projectId: project.id },
      });
      assert.equal(knowledge.generationArtifactId, artifact.id);

      await prisma.realEstateObject.delete({ where: { id: object.id } });
      assert.equal(await prisma.trainingQuestionGenerationArtifact.count({
        where: { id: artifact.id },
      }), 0);
      const retainedKnowledge = await prisma.trainingProjectKnowledgeVersion.findUniqueOrThrow({
        where: { id: knowledge.id },
      });
      assert.equal(retainedKnowledge.generationArtifactId, null);
      assert.equal((await prisma.trainingProject.findUniqueOrThrow({
        where: { id: project.id },
      })).realEstateObjectId, null);
      assert.equal(retainedKnowledge.status, 'READY');
    });
  });

  async function createProject(label, realEstateObjectId = null) {
    return prisma.trainingProject.create({ data: {
      title: `Stage 4 ${label}`, attemptLimit: 3, timeLimitSeconds: 420,
      passScore: 75, allowRetakeAfterPass: false, contentSchemaVersion: 3,
      realEstateObjectId,
    } });
  }

  async function createObject(label) {
    return prisma.realEstateObject.create({ data: {
      title: `Stage 4 object ${label}`,
      slug: `stage4-${label}-${randomUUID()}`,
    } });
  }

  async function createCriterion(projectId, code) {
    return prisma.trainingCriterion.create({ data: {
      projectId,
      questionType: TrainingQuestionType.MAIN,
      code,
      title: code,
      guidance: `Guidance ${code}`,
      maxPoints: 10,
      position: 1,
    } });
  }

  async function createQuestion(projectId, label) {
    return prisma.trainingQuestion.create({ data: {
      projectId, type: TrainingQuestionType.MAIN, text: `Question ${label}`, position: 1,
    } });
  }

  function knowledgeInput(projectId, text) {
    return {
      projectId,
      objectId: 'object',
      objectTitle: 'Knowledge object',
      sources: [{
        materialId: 'material',
        revisionId: randomUUID(),
        materialTitle: 'Knowledge source',
        materialType: 'MANUAL_TEXT',
        contentHash: createHash('sha256').update(text.trim()).digest('hex'),
        segments: [{ locator: 'paragraph:1', label: 'Абзац 1', text }],
      }],
    };
  }

  function questionInput(projectId, sources, object = null) {
    return {
      projectId,
      objectId: object?.id ?? 'object',
      objectTitle: object?.title ?? 'Knowledge object',
      sources,
    };
  }

  function reusableKnowledgeInput(projectId, object, text, options = {}) {
    const materialType = options.materialType ?? 'OBJECT_SNAPSHOT';
    const reuseKind = options.reuseKind ?? 'PLATFORMA_OBJECT_SNAPSHOT';
    return questionInput(projectId, [{
      materialId: randomUUID(),
      revisionId: randomUUID(),
      materialTitle: `Reusable ${materialType}`,
      materialType,
      contentHash: createHash('sha256').update(text.trim()).digest('hex'),
      segments: [{ locator: 'source:1', label: 'Источник', text }],
      reuseMetadata: {
        kind: reuseKind,
        realEstateObjectId: object.id,
      },
    }], object);
  }

  function projectLocalKnowledgeInput(projectId, object, text, materialType) {
    return questionInput(projectId, [{
      materialId: randomUUID(),
      revisionId: randomUUID(),
      materialTitle: `Project-local ${materialType}`,
      materialType,
      contentHash: createHash('sha256').update(text.trim()).digest('hex'),
      segments: [{ locator: 'source:1', label: 'Источник', text }],
    }], object);
  }

  async function createSnapshotMaterial(projectId, objectId, text, locator) {
    return prisma.trainingMaterial.create({
      data: {
        projectId,
        type: TrainingMaterialType.OBJECT_SNAPSHOT,
        title: 'Object snapshot',
        createdById: user.id,
        revisions: {
          create: {
            revisionNumber: 1,
            status: TrainingMaterialRevisionStatus.READY,
            extractedText: text,
            segmentsJson: [{ locator, label: 'Описание', text }],
            contentHash: createHash('sha256').update(text.trim()).digest('hex'),
            extractionMetadataJson: {
              method: 'OBJECT_SNAPSHOT',
              objectId,
              fieldCodes: ['description'],
            },
            diffJson: {
              previousRevisionId: null,
              added: [],
              removed: [],
              unchangedCount: 0,
              changed: true,
            },
            isChanged: true,
            createdById: user.id,
          },
        },
      },
      include: { revisions: true },
    }).then((material) => ({
      ...material,
      latestRevision: {
        ...material.revisions[0],
        segments: material.revisions[0].segmentsJson,
      },
    }));
  }

  function reusableMaterialSource(material, objectId) {
    return {
      ...materialSource(material),
      reuseMetadata: {
        kind: 'PLATFORMA_OBJECT_SNAPSHOT',
        realEstateObjectId: objectId,
      },
    };
  }

  function changeGenerationPlan(plan, field, value, updates) {
    const generationKey = { ...plan.generationKey, ...updates, [field]: value };
    return {
      ...plan,
      ...updates,
      generationKey,
      generationKeyHash: hashTrainingQuestionGenerationKey(generationKey),
    };
  }

  function materialSource(material) {
    return {
      materialId: material.id,
      revisionId: material.latestRevision.id,
      materialTitle: material.title,
      materialType: material.type,
      contentHash: material.latestRevision.contentHash,
      segments: material.latestRevision.segments,
    };
  }

  async function deleteProjectGraph(projectId) {
    await prisma.trainingFact.deleteMany({ where: { question: { projectId } } });
    await prisma.trainingMaterialRevision.deleteMany({ where: { material: { projectId } } });
    await prisma.trainingMaterial.deleteMany({ where: { projectId } });
    await prisma.trainingQuestion.deleteMany({ where: { projectId } });
    await prisma.trainingCriterion.deleteMany({ where: { projectId } });
    await prisma.trainingProject.delete({ where: { id: projectId } });
  }

  async function withEnv(values, operation) {
    const previous = Object.fromEntries(
      Object.keys(values).map((key) => [key, process.env[key]]),
    );
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    try {
      return await operation();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
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
    await prisma.trainingCriterion.deleteMany();
    await prisma.trainingProject.deleteMany();
    await prisma.realEstateObject.deleteMany({ where: { slug: { startsWith: 'stage4-' } } });
    await prisma.file.deleteMany({ where: { key: { startsWith: 'training-v2/materials/' } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: '@training-s4.test' } } });
    await prisma.role.deleteMany({ where: { name: { startsWith: 'stage4-pg-' } } });
  }
}
