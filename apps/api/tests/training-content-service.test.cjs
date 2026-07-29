require('reflect-metadata');

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
} = require('@nestjs/common');
const {
  Prisma,
  TrainingProjectStatus,
  TrainingVersionStatus,
} = require('@prisma/client');

const { PERMISSIONS_KEY } = require('../dist/auth/permissions.decorator.js');
const { TrainingAdminController } = require('../dist/training/training-admin.controller.js');
const { TrainingContentService } = require('../dist/training/training-content.service.js');

const rootDir = path.resolve(__dirname, '../../..');
const controllerSource = fs.readFileSync(
  path.join(rootDir, 'apps/api/src/training/training-admin.controller.ts'),
  'utf8',
);
const serviceSource = fs.readFileSync(
  path.join(rootDir, 'apps/api/src/training/training-content.service.ts'),
  'utf8',
);

const projectId = '11111111-1111-4111-8111-111111111111';
const versionId = '22222222-2222-4222-8222-222222222222';
const previousVersionId = '33333333-3333-4333-8333-333333333333';
const actor = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'admin@example.test',
  name: 'Admin',
  permissions: ['training:projects:manage'],
};
const request = {
  headers: {
    'user-agent': 'node-test',
    'x-forwarded-for': '127.0.0.1, 10.0.0.2',
  },
  ip: '10.0.0.1',
};

function createVersionLockQuery(
  status = TrainingVersionStatus.DRAFT,
  projectStatus = TrainingProjectStatus.DRAFT,
) {
  let queryIndex = 0;

  return async () => {
    const lockStep = queryIndex % 3;
    queryIndex += 1;
    if (lockStep === 0) {
      return [{ projectId }];
    }
    if (lockStep === 1) {
      return [{ id: projectId, status: projectStatus }];
    }
    return [{ id: versionId, projectId, status }];
  };
}

function validQuestions() {
  return [
    {
      id: '44444444-4444-4444-8444-444444444444',
      type: 'MAIN',
      text: 'Расскажите о проекте',
      position: 1,
      isActive: true,
      maxScore: 55,
    },
    ...Array.from({ length: 10 }, (_, index) => ({
      id: `50000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      type: 'FOLLOW_UP',
      text: `Дополнительный вопрос ${index + 1}`,
      position: index + 1,
      isActive: true,
      maxScore: 15,
    })),
  ];
}

function validPublishableVersion(overrides = {}) {
  return {
    id: versionId,
    projectId,
    versionNumber: 2,
    status: TrainingVersionStatus.DRAFT,
    passScore: 75,
    attemptLimit: 3,
    cooldownMinutes: 60,
    totalTimeLimitSeconds: 420,
    finishGraceSeconds: 90,
    warningSecondsJson: [60, 20],
    allowRetakeAfterPass: false,
    mainMaxScore: 55,
    followUpMaxScore: 15,
    questions: validQuestions(),
    facts: [
      {
        id: '66666666-6666-4666-8666-666666666666',
        code: 'project.fact',
        isApproved: true,
      },
    ],
    criteria: [
      {
        id: '77777777-7777-4777-8777-777777777777',
        questionType: 'MAIN',
        code: 'main',
        sortOrder: 0,
        maxPoints: new Prisma.Decimal(55),
        anchorsJson: [
          { id: 'main-full', points: 55, description: 'Полный ответ' },
        ],
      },
      {
        id: '88888888-8888-4888-8888-888888888888',
        questionType: 'FOLLOW_UP',
        code: 'follow',
        sortOrder: 0,
        maxPoints: new Prisma.Decimal(15),
        anchorsJson: [
          { id: 'follow-full', points: 15, description: 'Полный ответ' },
        ],
      },
    ],
    project: {
      id: projectId,
      status: TrainingProjectStatus.DRAFT,
      activeVersionId: previousVersionId,
      availableFrom: null,
      deadlineAt: null,
    },
    ...overrides,
  };
}

test('admin content controller is guarded by the approved management permission and exposes stage 3 routes', () => {
  assert.deepEqual(Reflect.getMetadata(PERMISSIONS_KEY, TrainingAdminController), [
    'training:projects:manage',
  ]);
  for (const route of [
    "@Get('projects')",
    "@Post('projects')",
    "@Patch('projects/:projectId')",
    "@Post('projects/:projectId/draft-version')",
    "@Post('versions/:versionId/publish')",
    "@Post('projects/:projectId/open')",
    "@Post('projects/:projectId/close')",
    "@Post('projects/:projectId/archive')",
    "@Get('versions/:versionId/questions')",
    "@Post('versions/:versionId/questions')",
    "@Get('versions/:versionId/facts')",
    "@Post('versions/:versionId/facts')",
    "@Get('versions/:versionId/criteria')",
    "@Post('versions/:versionId/criteria')",
  ]) {
    assert.equal(controllerSource.includes(route), true, `Missing route ${route}`);
  }
  assert.match(
    controllerSource,
    /@UseGuards\(JwtAuthGuard, PermissionsGuard, TrainingFeatureGuard\)/,
  );
});

test('project and version detail keep full official URL text behind the dedicated text endpoint', async () => {
  let versionQuery;
  let projectQuery;
  const service = new TrainingContentService({
    trainingProjectVersion: {
      findUnique: async (query) => {
        versionQuery = query;
        return null;
      },
    },
    trainingProject: {
      findUnique: async (query) => {
        projectQuery = query;
        return null;
      },
    },
  });

  await assert.rejects(() => service.getVersion(versionId), /not found/iu);
  await assert.rejects(() => service.getProject(projectId), /not found/iu);

  assert.equal(
    versionQuery.include.officialUrlSources.select.extractedText,
    undefined,
  );
  assert.equal(
    versionQuery.include.officialUrlSources.select.extractionMetadataJson,
    undefined,
  );
  assert.equal(
    projectQuery.include.versions.include.officialUrlSources.select
      .extractedText,
    undefined,
  );
});

test('project creation atomically creates draft defaults and an AuditLog record', async () => {
  const calls = {
    projectCreate: null,
    versionCreate: null,
    auditCreate: null,
  };
  const tx = {
    trainingProject: {
      create: async (args) => {
        calls.projectCreate = args;
        return { id: projectId };
      },
    },
    trainingProjectVersion: {
      create: async (args) => {
        calls.versionCreate = args;
        return { id: versionId };
      },
    },
    auditLog: {
      create: async (args) => {
        calls.auditCreate = args;
        return { id: 'audit-id' };
      },
    },
  };
  const prisma = {
    realEstateObject: {
      findUnique: async () => assert.fail('Null catalog link must not query an object'),
    },
    $transaction: async (callback) => callback(tx),
    trainingProject: {
      findUnique: async () => ({ id: projectId, title: 'Проект', versions: [] }),
    },
  };
  const service = new TrainingContentService(prisma);

  const response = await service.createProject(
    {
      title: 'Проект',
      slug: 'project',
      draft: {
        passScore: 80,
        attemptLimit: 4,
        cooldownMinutes: 120,
        totalTimeLimitSeconds: 360,
        warningSeconds: [60, 20],
      },
    },
    actor,
    request,
  );

  assert.equal(response.project.id, projectId);
  assert.equal(calls.projectCreate.data.realEstateObjectId, null);
  assert.equal(calls.projectCreate.data.status, undefined);
  assert.equal(calls.versionCreate.data.versionNumber, 1);
  assert.equal(calls.versionCreate.data.passScore, 80);
  assert.equal(calls.versionCreate.data.attemptLimit, 4);
  assert.equal(calls.versionCreate.data.totalTimeLimitSeconds, 360);
  assert.deepEqual(calls.versionCreate.data.warningSecondsJson, [60, 20]);
  assert.equal(calls.auditCreate.data.action, 'training.project.create');
  assert.equal(calls.auditCreate.data.entityId, projectId);
  assert.equal(calls.auditCreate.data.ipAddress, '127.0.0.1');
});

test('project detail includes fact question links required by the admin facts editor', async () => {
  let query = null;
  const service = new TrainingContentService({
    trainingProject: {
      findUnique: async (args) => {
        query = args;
        return { id: projectId, versions: [] };
      },
    },
  });

  await service.getProject(projectId);

  assert.deepEqual(
    query.include.versions.include.facts.include.questionLinks,
    { orderBy: { createdAt: 'asc' } },
  );
});

test('publication supersedes the old version and switches the active version in one transaction', async () => {
  const version = validPublishableVersion();
  const versionUpdates = [];
  const projectUpdates = [];
  const auditRows = [];
  const tx = {
    $queryRaw: createVersionLockQuery(),
    trainingProjectVersion: {
      findUnique: async (args) => {
        if (args.where.id === versionId) {
          return version;
        }
        if (args.where.id === previousVersionId) {
          return { status: TrainingVersionStatus.PUBLISHED };
        }
        return null;
      },
      update: async (args) => {
        versionUpdates.push(args);
        return {};
      },
    },
    trainingProject: {
      update: async (args) => {
        projectUpdates.push(args);
        return {};
      },
    },
    auditLog: {
      create: async (args) => {
        auditRows.push(args);
        return {};
      },
    },
  };
  const prisma = {
    $transaction: async (callback) => callback(tx),
    trainingProject: {
      findUnique: async () => ({ id: projectId, activeVersionId: versionId, versions: [] }),
    },
  };
  const service = new TrainingContentService(prisma);

  await service.publishVersion(versionId, actor, request);

  assert.deepEqual(versionUpdates[0], {
    where: { id: previousVersionId },
    data: { status: TrainingVersionStatus.SUPERSEDED },
  });
  assert.equal(versionUpdates[1].where.id, versionId);
  assert.equal(versionUpdates[1].data.status, TrainingVersionStatus.PUBLISHED);
  assert.equal(versionUpdates[1].data.publishedById, actor.id);
  assert.equal(versionUpdates[1].data.publishedAt instanceof Date, true);
  assert.deepEqual(projectUpdates[0], {
    where: { id: projectId },
    data: {
      activeVersionId: versionId,
      status: TrainingProjectStatus.CLOSED,
    },
  });
  assert.equal(auditRows[0].data.action, 'training.version.publish');
  assert.equal(auditRows[0].data.metadata.previousActiveVersionId, previousVersionId);
});

test('invalid publication does not update a version, project or AuditLog', async () => {
  const version = validPublishableVersion({
    questions: validQuestions().slice(0, 10),
  });
  let writes = 0;
  const tx = {
    $queryRaw: createVersionLockQuery(),
    trainingProjectVersion: {
      findUnique: async () => version,
      update: async () => {
        writes += 1;
      },
    },
    trainingProject: {
      update: async () => {
        writes += 1;
      },
    },
    auditLog: {
      create: async () => {
        writes += 1;
      },
    },
  };
  const service = new TrainingContentService({
    $transaction: async (callback) => callback(tx),
  });

  await assert.rejects(
    () => service.publishVersion(versionId, actor, request),
    UnprocessableEntityException,
  );
  assert.equal(writes, 0);
});

test('published versions are rejected before content settings can be changed', async () => {
  let transactionStarted = false;
  const service = new TrainingContentService({
    $transaction: async (callback) => {
      transactionStarted = true;
      return callback({
        $queryRaw: createVersionLockQuery(TrainingVersionStatus.PUBLISHED),
      });
    },
  });

  await assert.rejects(
    () => service.updateVersion(versionId, { passScore: 80 }, actor, request),
    ConflictException,
  );
  assert.equal(transactionStarted, true);
});

test('new draft clones immutable content and question-fact links from the latest version', async () => {
  const sourceDocumentId = '99999999-9999-4999-8999-999999999999';
  const sourceOfficialUrlId = 'abababab-abab-4bab-8bab-abababababac';
  const sourceQuestionId = '44444444-4444-4444-8444-444444444444';
  const sourceFactId = '66666666-6666-4666-8666-666666666666';
  const cloned = {
    documents: [],
    officialUrls: [],
    questions: [],
    facts: [],
    criteria: [],
    links: [],
    audit: [],
  };
  const source = {
    ...validPublishableVersion({
      status: TrainingVersionStatus.PUBLISHED,
      versionNumber: 1,
      project: undefined,
      questions: [
        {
          id: sourceQuestionId,
          type: 'MAIN',
          text: 'Главный вопрос',
          position: 1,
          isActive: true,
          maxScore: 55,
          topicCodesJson: [],
          factLinks: [
            {
              questionId: sourceQuestionId,
              factId: sourceFactId,
              weight: null,
              isRequired: true,
              createdAt: new Date(),
            },
          ],
        },
      ],
      facts: [
        {
          id: sourceFactId,
          code: 'fact',
          topicCode: 'project',
          statement: 'Факт',
          acceptedAliasesJson: [],
          importance: 1,
          sourceDocumentId,
          sourceLocatorJson: { page: 1 },
          isApproved: true,
        },
        {
          id: '67676767-6767-4767-8767-676767676767',
          code: 'fact.url',
          topicCode: 'project',
          statement: 'Факт из официальной страницы',
          acceptedAliasesJson: [],
          importance: 1,
          sourceDocumentId: null,
          sourceOfficialUrlId,
          sourceLocatorJson: { selector: 'main' },
          isApproved: true,
        },
      ],
      criteria: [
        {
          id: '77777777-7777-4777-8777-777777777777',
          questionType: 'MAIN',
          code: 'main',
          title: 'Критерий',
          maxPoints: new Prisma.Decimal(55),
          description: null,
          anchorsJson: [],
          sortOrder: 0,
        },
      ],
      sourceDocuments: [
        {
          id: sourceDocumentId,
          fileId: 'abababab-abab-4bab-8bab-abababababab',
          documentType: 'PDF',
          checksum: 'checksum',
          extractionStatus: 'READY',
          extractedText: 'Текст',
          extractionMetadataJson: {},
          errorMessage: null,
          createdAt: new Date(),
        },
      ],
      officialUrlSources: [
        {
          id: sourceOfficialUrlId,
          confirmedById: actor.id,
          snapshotFileId: 'acacacac-acac-4cac-8cac-acacacacacac',
          url: 'https://developer.example/project',
          normalizedUrl: 'https://developer.example/project',
          finalUrl: 'https://developer.example/project',
          hostname: 'developer.example',
          fetchGeneration: 1,
          extractionStatus: 'READY',
          extractedText: 'Официальный текст',
          contentHash: 'a'.repeat(64),
          extractionMetadataJson: {},
          errorCode: null,
          errorMessage: null,
          confirmedAt: new Date(),
          fetchedAt: new Date(),
        },
      ],
      warningSecondsJson: [60, 20],
      scoringConfigJson: {},
      promptVersion: '1',
      schemaVersion: '1',
    }),
  };
  delete source.project;

  const tx = {
    $queryRaw: async () => [{ id: projectId }],
    trainingProject: {
      findUnique: async () => ({
        id: projectId,
        status: TrainingProjectStatus.CLOSED,
        activeVersionId: previousVersionId,
      }),
    },
    trainingProjectVersion: {
      findFirst: async (args) =>
        args.where.status === TrainingVersionStatus.DRAFT ? null : source,
      create: async () => ({ id: versionId }),
    },
    trainingSourceDocument: {
      create: async (args) => {
        cloned.documents.push(args);
        return { id: '12121212-1212-4212-8212-121212121212' };
      },
    },
    trainingOfficialUrlSource: {
      create: async (args) => {
        cloned.officialUrls.push(args);
        return { id: 'adadadad-adad-4dad-8dad-adadadadadad' };
      },
    },
    trainingQuestion: {
      create: async (args) => {
        cloned.questions.push(args);
        return { id: '13131313-1313-4313-8313-131313131313' };
      },
    },
    trainingFact: {
      create: async (args) => {
        cloned.facts.push(args);
        return { id: '14141414-1414-4414-8414-141414141414' };
      },
    },
    trainingEvaluationCriterion: {
      create: async (args) => {
        cloned.criteria.push(args);
        return {};
      },
    },
    trainingQuestionFactLink: {
      create: async (args) => {
        cloned.links.push(args);
        return {};
      },
    },
    auditLog: {
      create: async (args) => {
        cloned.audit.push(args);
        return {};
      },
    },
  };
  const service = new TrainingContentService({
    $transaction: async (callback) => callback(tx),
    $queryRaw: async () => [
      {
        activeFactSuggestionRunCount: 0n,
        activeFactSuggestionProviderCount: 0n,
        activeFactSuggestionJobCount: 0n,
      },
    ],
    trainingProjectVersion: {
      findUnique: async () =>
        validPublishableVersion({
          sourceDocuments: [],
          officialUrlSources: [],
          _count: { factSuggestions: 0 },
        }),
    },
  });

  await service.createDraftVersion(projectId, actor, request);

  assert.equal(cloned.documents.length, 1);
  assert.equal(cloned.officialUrls.length, 1);
  assert.equal(cloned.questions.length, 1);
  assert.equal(cloned.facts.length, 2);
  assert.equal(cloned.criteria.length, 1);
  assert.equal(cloned.links.length, 1);
  assert.equal(
    cloned.facts[0].data.sourceDocumentId,
    '12121212-1212-4212-8212-121212121212',
  );
  assert.equal(
    cloned.facts[1].data.sourceOfficialUrlId,
    'adadadad-adad-4dad-8dad-adadadadadad',
  );
  assert.deepEqual(cloned.links[0].data, {
    questionId: '13131313-1313-4313-8313-131313131313',
    factId: '14141414-1414-4414-8414-141414141414',
    weight: null,
    isRequired: true,
  });
  assert.equal(cloned.audit[0].data.action, 'training.version.draft.create');
});

test('ensure editable version returns the existing working version without cloning', async () => {
  let projectLocks = 0;
  let creates = 0;
  const existingVersion = validPublishableVersion({
    sourceDocuments: [],
    officialUrlSources: [],
    _count: { factSuggestions: 0 },
  });
  const tx = {
    $queryRaw: async () => {
      projectLocks += 1;
      return [{ id: projectId }];
    },
    trainingProject: {
      findUnique: async () => ({
        id: projectId,
        status: TrainingProjectStatus.CLOSED,
        activeVersionId: previousVersionId,
      }),
    },
    trainingProjectVersion: {
      findFirst: async (args) => {
        if (args.where.status === TrainingVersionStatus.DRAFT) {
          return { id: versionId };
        }
        return null;
      },
      create: async () => {
        creates += 1;
        return { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' };
      },
    },
  };
  const service = new TrainingContentService({
    $transaction: async (callback) => callback(tx),
    $queryRaw: async () => [
      {
        activeFactSuggestionRunCount: 0n,
        activeFactSuggestionProviderCount: 0n,
        activeFactSuggestionJobCount: 0n,
      },
    ],
    trainingProjectVersion: {
      findUnique: async () => existingVersion,
    },
  });

  const response = await service.ensureEditableVersion(projectId, actor, request);

  assert.equal(projectLocks, 1);
  assert.equal(creates, 0);
  assert.equal(response.created, false);
  assert.equal(response.version.id, versionId);
  assert.equal(response.readiness.readyToPublish, true);
});

test('question, fact and criterion CRUD writes only to a draft and records audit actions', async () => {
  const questionId = '44444444-4444-4444-8444-444444444444';
  const factId = '66666666-6666-4666-8666-666666666666';
  const criterionId = '77777777-7777-4777-8777-777777777777';
  const writes = {
    question: [],
    fact: [],
    criterion: [],
    links: [],
    audit: [],
  };
  const tx = {
    $queryRaw: createVersionLockQuery(),
    trainingProjectVersion: {
      findUnique: async () => ({ id: versionId, status: TrainingVersionStatus.DRAFT }),
    },
    trainingQuestion: {
      create: async (args) => {
        writes.question.push(args);
        return { id: questionId };
      },
      count: async () => 1,
    },
    trainingFact: {
      create: async (args) => {
        writes.fact.push(args);
        return { id: factId };
      },
    },
    trainingQuestionFactLink: {
      deleteMany: async (args) => {
        writes.links.push({ deleteMany: args });
        return { count: 0 };
      },
      create: async (args) => {
        writes.links.push({ create: args });
        return {};
      },
    },
    trainingEvaluationCriterion: {
      create: async (args) => {
        writes.criterion.push(args);
        return { id: criterionId };
      },
    },
    auditLog: {
      create: async (args) => {
        writes.audit.push(args);
        return {};
      },
    },
  };
  const prisma = {
    $transaction: async (callback) => callback(tx),
    trainingQuestion: {
      findFirst: async () => ({ id: questionId, projectVersionId: versionId }),
    },
    trainingFact: {
      findFirst: async () => ({ id: factId, projectVersionId: versionId, questionLinks: [] }),
    },
    trainingEvaluationCriterion: {
      findFirst: async () => ({ id: criterionId, projectVersionId: versionId }),
    },
  };
  const service = new TrainingContentService(prisma);

  await service.createQuestion(
    versionId,
    {
      type: 'MAIN',
      text: 'Главный вопрос',
      position: 1,
      maxScore: 55,
      topicCodes: ['project'],
    },
    actor,
    request,
  );
  await service.createFact(
    versionId,
    {
      code: 'project.fact',
      topicCode: 'project',
      statement: 'Утверждённый факт',
      isApproved: true,
      questionIds: [questionId],
    },
    actor,
    request,
  );
  await service.createCriterion(
    versionId,
    {
      questionType: 'MAIN',
      code: 'main.accuracy',
      title: 'Точность',
      maxPoints: 55,
      sortOrder: 0,
    },
    actor,
    request,
  );

  assert.equal(writes.question[0].data.maxScore, 55);
  assert.deepEqual(writes.question[0].data.topicCodesJson, ['project']);
  assert.equal(writes.fact[0].data.isApproved, true);
  assert.equal(writes.links.some((entry) => entry.create?.data.questionId === questionId), true);
  assert.equal(writes.criterion[0].data.maxPoints.toString(), '55');
  assert.deepEqual(
    writes.audit.map((entry) => entry.data.action),
    ['training.question.create', 'training.fact.create', 'training.criterion.create'],
  );
});

test('question CRUD rejects a main score other than 55 before writing', async () => {
  let writes = 0;
  const service = new TrainingContentService({
    $transaction: async (callback) =>
      callback({
        $queryRaw: createVersionLockQuery(),
        trainingProjectVersion: {
          findUnique: async () => ({ id: versionId, status: TrainingVersionStatus.DRAFT }),
        },
        trainingQuestion: {
          create: async () => {
            writes += 1;
          },
        },
      }),
  });

  await assert.rejects(
    () =>
      service.createQuestion(
        versionId,
        {
          type: 'MAIN',
          text: 'Главный вопрос',
          position: 1,
          maxScore: 54,
        },
        actor,
        request,
      ),
    BadRequestException,
  );
  assert.equal(writes, 0);
});

test('only an unused draft version can be hard-deleted', async () => {
  const deleted = [];
  const audit = [];
  const service = new TrainingContentService({
    $transaction: async (callback) =>
      callback({
        $queryRaw: createVersionLockQuery(),
        trainingProjectVersion: {
          findUnique: async () => ({
            id: versionId,
            projectId,
            versionNumber: 2,
            status: TrainingVersionStatus.DRAFT,
            activeForProject: null,
            _count: { attempts: 0 },
          }),
          delete: async (args) => {
            deleted.push(args);
            return {};
          },
        },
        auditLog: {
          create: async (args) => {
            audit.push(args);
            return {};
          },
        },
      }),
  });

  await service.deleteDraftVersion(versionId, actor, request);

  assert.deepEqual(deleted, [{ where: { id: versionId } }]);
  assert.equal(audit[0].data.action, 'training.version.draft.delete');

  const usedService = new TrainingContentService({
    $transaction: async (callback) =>
      callback({
        $queryRaw: createVersionLockQuery(),
        trainingProjectVersion: {
          findUnique: async () => ({
            id: versionId,
            projectId,
            versionNumber: 2,
            status: TrainingVersionStatus.DRAFT,
            activeForProject: null,
            _count: { attempts: 1 },
          }),
        },
      }),
  });
  await assert.rejects(
    () => usedService.deleteDraftVersion(versionId, actor, request),
    ConflictException,
  );

  const publishedService = new TrainingContentService({
    $transaction: async (callback) =>
      callback({
        $queryRaw: createVersionLockQuery(TrainingVersionStatus.PUBLISHED),
        trainingProjectVersion: {
          findUnique: async () => ({
            id: versionId,
            projectId,
            versionNumber: 1,
            status: TrainingVersionStatus.PUBLISHED,
            activeForProject: { id: projectId },
            _count: { attempts: 0 },
          }),
        },
      }),
  });
  await assert.rejects(
    () => publishedService.deleteDraftVersion(versionId, actor, request),
    ConflictException,
  );
});

test('every privileged stage 3 mutation writes a named AuditLog action', () => {
  for (const action of [
    'training.project.create',
    'training.project.update',
    'training.version.draft.create',
    'training.version.update',
    'training.version.draft.delete',
    'training.version.publish',
    'training.project.open',
    'training.project.close',
    'training.project.archive',
    'training.question.create',
    'training.question.update',
    'training.question.delete',
    'training.fact.create',
    'training.fact.update',
    'training.fact.delete',
    'training.criterion.create',
    'training.criterion.update',
    'training.criterion.delete',
  ]) {
    assert.equal(serviceSource.includes(`'${action}'`), true, `Missing AuditLog action ${action}`);
  }
  assert.match(serviceSource, /await tx\.auditLog\.create\(/);
});
