require('reflect-metadata');

const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { RequestMethod } = require('@nestjs/common');
const {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  INTERCEPTORS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} = require('@nestjs/common/constants');

const { PERMISSIONS_KEY } = require('../dist/auth/permissions.decorator.js');
const {
  TrainingAdminController,
} = require('../dist/training/training-admin.controller.js');
const { TrainingModule } = require('../dist/training/training.module.js');

const trainingControllers = Reflect.getMetadata(
  MODULE_METADATA.CONTROLLERS,
  TrainingModule,
);

const routeParamTypeNames = new Map([
  ['0', 'request'],
  ['1', 'response'],
  ['3', 'body'],
  ['4', 'query'],
  ['5', 'param'],
  ['6', 'headers'],
  ['8', 'file'],
]);

const p = (name) => `param:${name}`;
const auditBody = ['body', 'current-user', 'request'];
const versionAuditBody = [p('versionId'), ...auditBody];

const expectedRoutes = [
  ['listRealEstateObjects', RequestMethod.GET, 'real-estate-objects', 200, ['query']],
  ['listProjects', RequestMethod.GET, 'projects', 200, ['query']],
  ['createProject', RequestMethod.POST, 'projects', 201, auditBody],
  ['getProject', RequestMethod.GET, 'projects/:projectId', 200, [p('projectId')]],
  ['updateProject', RequestMethod.PATCH, 'projects/:projectId', 200, [p('projectId'), ...auditBody]],
  ['createDraftVersion', RequestMethod.POST, 'projects/:projectId/draft-version', 201, [p('projectId'), 'current-user', 'request']],
  ['openProject', RequestMethod.POST, 'projects/:projectId/open', 201, [p('projectId'), 'current-user', 'request']],
  ['closeProject', RequestMethod.POST, 'projects/:projectId/close', 201, [p('projectId'), 'current-user', 'request']],
  ['archiveProject', RequestMethod.POST, 'projects/:projectId/archive', 201, [p('projectId'), 'current-user', 'request']],
  ['getVersion', RequestMethod.GET, 'versions/:versionId', 200, [p('versionId')]],
  ['getVersionReadiness', RequestMethod.GET, 'versions/:versionId/readiness', 200, [p('versionId')]],
  ['updateVersion', RequestMethod.PATCH, 'versions/:versionId', 200, versionAuditBody],
  ['deleteDraftVersion', RequestMethod.DELETE, 'versions/:versionId', 204, [p('versionId'), 'current-user', 'request']],
  ['publishVersion', RequestMethod.POST, 'versions/:versionId/publish', 201, [p('versionId'), 'current-user', 'request']],
  ['listDocuments', RequestMethod.GET, 'versions/:versionId/documents', 200, [p('versionId')]],
  ['listOfficialUrlSources', RequestMethod.GET, 'versions/:versionId/official-url-sources', 200, [p('versionId')]],
  ['createOfficialUrlSource', RequestMethod.POST, 'versions/:versionId/official-url-sources', 201, versionAuditBody],
  ['getOfficialUrlSourceText', RequestMethod.GET, 'versions/:versionId/official-url-sources/:sourceId/text', 200, [p('versionId'), p('sourceId')]],
  ['retryOfficialUrlSource', RequestMethod.POST, 'versions/:versionId/official-url-sources/:sourceId/retry', 201, [p('versionId'), p('sourceId'), 'current-user', 'request']],
  ['deleteOfficialUrlSource', RequestMethod.DELETE, 'versions/:versionId/official-url-sources/:sourceId', 204, [p('versionId'), p('sourceId'), 'current-user', 'request']],
  ['createFactSuggestionRun', RequestMethod.POST, 'versions/:versionId/fact-suggestion-runs', 201, [p('versionId'), 'body', 'headers:idempotency-key', 'current-user', 'request']],
  ['getLatestFactSuggestionRun', RequestMethod.GET, 'versions/:versionId/fact-suggestion-runs/latest', 200, [p('versionId')]],
  ['listFactSuggestions', RequestMethod.GET, 'versions/:versionId/fact-suggestions', 200, [p('versionId')]],
  ['acceptFactSuggestion', RequestMethod.POST, 'versions/:versionId/fact-suggestions/:suggestionId/accept', 201, [p('versionId'), p('suggestionId'), ...auditBody]],
  ['rejectFactSuggestion', RequestMethod.POST, 'versions/:versionId/fact-suggestions/:suggestionId/reject', 201, [p('versionId'), p('suggestionId'), ...auditBody]],
  ['uploadDocument', RequestMethod.POST, 'versions/:versionId/documents', 202, [p('versionId'), 'file', 'current-user', 'request'], 1],
  ['getDocumentText', RequestMethod.GET, 'versions/:versionId/documents/:documentId/text', 200, [p('versionId'), p('documentId')]],
  ['updateDocumentText', RequestMethod.PATCH, 'versions/:versionId/documents/:documentId', 200, [p('versionId'), p('documentId'), ...auditBody]],
  ['retryDocument', RequestMethod.POST, 'versions/:versionId/documents/:documentId/retry', 201, [p('versionId'), p('documentId'), 'current-user', 'request']],
  ['deleteDocument', RequestMethod.DELETE, 'versions/:versionId/documents/:documentId', 204, [p('versionId'), p('documentId'), 'current-user', 'request']],
  ['getDocumentContent', RequestMethod.GET, 'versions/:versionId/documents/:documentId/content', 200, [p('versionId'), p('documentId'), 'response']],
  ['listQuestions', RequestMethod.GET, 'versions/:versionId/questions', 200, [p('versionId')]],
  ['createQuestion', RequestMethod.POST, 'versions/:versionId/questions', 201, versionAuditBody],
  ['updateQuestion', RequestMethod.PATCH, 'versions/:versionId/questions/:questionId', 200, [p('versionId'), p('questionId'), ...auditBody]],
  ['deleteQuestion', RequestMethod.DELETE, 'versions/:versionId/questions/:questionId', 204, [p('versionId'), p('questionId'), 'current-user', 'request']],
  ['listFacts', RequestMethod.GET, 'versions/:versionId/facts', 200, [p('versionId')]],
  ['createFact', RequestMethod.POST, 'versions/:versionId/facts', 201, versionAuditBody],
  ['updateFact', RequestMethod.PATCH, 'versions/:versionId/facts/:factId', 200, [p('versionId'), p('factId'), ...auditBody]],
  ['deleteFact', RequestMethod.DELETE, 'versions/:versionId/facts/:factId', 204, [p('versionId'), p('factId'), 'current-user', 'request']],
  ['listCriteria', RequestMethod.GET, 'versions/:versionId/criteria', 200, [p('versionId')]],
  ['createCriterion', RequestMethod.POST, 'versions/:versionId/criteria', 201, versionAuditBody],
  ['updateCriterion', RequestMethod.PATCH, 'versions/:versionId/criteria/:criterionId', 200, [p('versionId'), p('criterionId'), ...auditBody]],
  ['deleteCriterion', RequestMethod.DELETE, 'versions/:versionId/criteria/:criterionId', 204, [p('versionId'), p('criterionId'), 'current-user', 'request']],
];

function routeOwners(methodName) {
  return trainingControllers.filter((controller) => {
    const handler = controller.prototype[methodName];
    return (
      Reflect.getMetadata(PATH_METADATA, controller) === 'training/admin' &&
      Object.prototype.hasOwnProperty.call(controller.prototype, methodName) &&
      Reflect.getMetadata(PATH_METADATA, handler) !== undefined
    );
  });
}

function normalizeRouteArguments(controller, methodName) {
  const metadata =
    Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, methodName) ?? {};

  return Object.entries(metadata)
    .map(([key, value]) => {
      const type = key.includes('__customRouteArgs__')
        ? 'current-user'
        : routeParamTypeNames.get(key.split(':', 1)[0]);
      assert.ok(type, `Unknown route argument metadata ${key}`);
      const data = value.data == null ? '' : `:${value.data}`;
      assert.deepEqual(value.pipes, []);
      return { index: value.index, value: `${type}${data}` };
    })
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.value);
}

function effectiveHttpStatus(handler, requestMethod) {
  return (
    Reflect.getMetadata(HTTP_CODE_METADATA, handler) ??
    (requestMethod === RequestMethod.POST ? 201 : 200)
  );
}

function createClassInstance(ControllerClass, overrides = {}) {
  const dependencyTypes =
    Reflect.getMetadata('design:paramtypes', ControllerClass) ?? [];
  const calls = [];
  const sentinel = { controller: ControllerClass.name };
  const mocks = new Map();

  for (const DependencyType of dependencyTypes) {
    const dependencyName = DependencyType.name;
    const methods = overrides[dependencyName] ?? {};
    mocks.set(
      dependencyName,
      new Proxy(methods, {
        get(target, property) {
          if (property in target) return target[property];
          return (...args) => {
            calls.push([dependencyName, property, args]);
            return sentinel;
          };
        },
      }),
    );
  }

  return {
    calls,
    controller: new ControllerClass(
      ...dependencyTypes.map((type) => mocks.get(type.name)),
    ),
    dependencyNames: dependencyTypes.map((type) => type.name),
    sentinel,
  };
}

function createController(methodName, overrides = {}) {
  const owners = routeOwners(methodName);
  assert.equal(owners.length, 1, `${methodName} must have exactly one route owner`);
  return createClassInstance(owners[0], overrides);
}

function createCompatibilityFacade(overrides = {}) {
  return createClassInstance(TrainingAdminController, overrides);
}

test('training admin route matrix preserves exact public metadata across registered controllers', () => {
  assert.equal(expectedRoutes.length, 43);
  assert.deepEqual(
    (Reflect.getMetadata('design:paramtypes', TrainingAdminController) ?? []).map(
      (dependency) => dependency.name,
    ),
    [
      'TrainingContentService',
      'TrainingDocumentsService',
      'TrainingDocumentWorkerService',
      'TrainingOfficialUrlSourcesService',
      'TrainingFactSuggestionsService',
    ],
  );
  assert.deepEqual(
    expectedRoutes.filter(
      ([methodName]) =>
        typeof TrainingAdminController.prototype[methodName] === 'function',
    ),
    expectedRoutes,
  );
  const routeKeys = new Set();

  for (const [
    methodName,
    requestMethod,
    routePath,
    status,
    routeArguments,
    interceptorCount = 0,
  ] of expectedRoutes) {
    const owners = routeOwners(methodName);
    assert.equal(owners.length, 1, `${methodName} must be registered exactly once`);
    const ControllerClass = owners[0];
    const handler = ControllerClass.prototype[methodName];

    assert.equal(Reflect.getMetadata(PATH_METADATA, ControllerClass), 'training/admin');
    assert.deepEqual(Reflect.getMetadata(PERMISSIONS_KEY, ControllerClass), [
      'training:projects:manage',
    ]);
    assert.deepEqual(
      Reflect.getMetadata(GUARDS_METADATA, ControllerClass).map(
        (guard) => guard.name,
      ),
      ['JwtAuthGuard', 'PermissionsGuard', 'TrainingFeatureGuard'],
    );
    assert.equal(Reflect.getMetadata(PATH_METADATA, handler), routePath);
    assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), requestMethod);
    assert.equal(effectiveHttpStatus(handler, requestMethod), status);
    assert.equal(
      (Reflect.getMetadata(INTERCEPTORS_METADATA, handler) ?? []).length,
      interceptorCount,
    );
    assert.deepEqual(
      normalizeRouteArguments(ControllerClass, methodName),
      routeArguments,
    );

    const routeKey = `${requestMethod}:${routePath}`;
    assert.equal(routeKeys.has(routeKey), false, `Duplicate route ${routeKey}`);
    routeKeys.add(routeKey);
  }
});

test('training admin routes delegate exact arguments and preserve return semantics', async () => {
  const query = { search: 'alpha' };
  const body = { title: 'Example' };
  const actor = { id: 'actor-id' };
  const request = { ip: '127.0.0.1' };
  const projectId = 'project-id';
  const versionId = 'version-id';
  const documentId = 'document-id';
  const sourceId = 'source-id';
  const suggestionId = 'suggestion-id';
  const questionId = 'question-id';
  const factId = 'fact-id';
  const criterionId = 'criterion-id';
  const idempotencyKey = 'idempotency-key';

  const cases = [
    ['listRealEstateObjects', 'TrainingDocumentsService', 'listRealEstateObjects', [query]],
    ['listProjects', 'TrainingContentService', 'listProjects', [query]],
    ['createProject', 'TrainingContentService', 'createProject', [body, actor, request]],
    ['getProject', 'TrainingContentService', 'getProject', [projectId]],
    ['updateProject', 'TrainingContentService', 'updateProject', [projectId, body, actor, request]],
    ['createDraftVersion', 'TrainingContentService', 'createDraftVersion', [projectId, actor, request]],
    ['openProject', 'TrainingContentService', 'openProject', [projectId, actor, request]],
    ['closeProject', 'TrainingContentService', 'closeProject', [projectId, actor, request]],
    ['archiveProject', 'TrainingContentService', 'archiveProject', [projectId, actor, request]],
    ['getVersion', 'TrainingContentService', 'getVersion', [versionId]],
    ['getVersionReadiness', 'TrainingContentService', 'getVersionReadiness', [versionId]],
    ['updateVersion', 'TrainingContentService', 'updateVersion', [versionId, body, actor, request]],
    ['deleteDraftVersion', 'TrainingContentService', 'deleteDraftVersion', [versionId, actor, request], true],
    ['publishVersion', 'TrainingContentService', 'publishVersion', [versionId, actor, request]],
    ['listDocuments', 'TrainingDocumentsService', 'listDocuments', [versionId]],
    ['listOfficialUrlSources', 'TrainingOfficialUrlSourcesService', 'listSources', [versionId]],
    ['createOfficialUrlSource', 'TrainingOfficialUrlSourcesService', 'createSource', [versionId, body, actor, request]],
    ['getOfficialUrlSourceText', 'TrainingOfficialUrlSourcesService', 'getSourceText', [versionId, sourceId]],
    ['retryOfficialUrlSource', 'TrainingOfficialUrlSourcesService', 'retrySource', [versionId, sourceId, actor, request]],
    ['deleteOfficialUrlSource', 'TrainingOfficialUrlSourcesService', 'deleteSource', [versionId, sourceId, actor, request], true],
    ['createFactSuggestionRun', 'TrainingFactSuggestionsService', 'createRun', [versionId, body, actor, request, idempotencyKey]],
    ['getLatestFactSuggestionRun', 'TrainingFactSuggestionsService', 'getLatestRun', [versionId]],
    ['listFactSuggestions', 'TrainingFactSuggestionsService', 'listSuggestions', [versionId]],
    ['acceptFactSuggestion', 'TrainingFactSuggestionsService', 'acceptSuggestion', [versionId, suggestionId, body, actor, request]],
    ['rejectFactSuggestion', 'TrainingFactSuggestionsService', 'rejectSuggestion', [versionId, suggestionId, body, actor, request]],
    ['getDocumentText', 'TrainingDocumentsService', 'getDocumentText', [versionId, documentId]],
    ['updateDocumentText', 'TrainingDocumentsService', 'updateManualText', [versionId, documentId, body, actor, request]],
    ['deleteDocument', 'TrainingDocumentsService', 'deleteDocument', [versionId, documentId, actor, request], true],
    ['listQuestions', 'TrainingContentService', 'listQuestions', [versionId]],
    ['createQuestion', 'TrainingContentService', 'createQuestion', [versionId, body, actor, request]],
    ['updateQuestion', 'TrainingContentService', 'updateQuestion', [versionId, questionId, body, actor, request]],
    ['deleteQuestion', 'TrainingContentService', 'deleteQuestion', [versionId, questionId, actor, request], true],
    ['listFacts', 'TrainingContentService', 'listFacts', [versionId]],
    ['createFact', 'TrainingContentService', 'createFact', [versionId, body, actor, request]],
    ['updateFact', 'TrainingContentService', 'updateFact', [versionId, factId, body, actor, request]],
    ['deleteFact', 'TrainingContentService', 'deleteFact', [versionId, factId, actor, request], true],
    ['listCriteria', 'TrainingContentService', 'listCriteria', [versionId]],
    ['createCriterion', 'TrainingContentService', 'createCriterion', [versionId, body, actor, request]],
    ['updateCriterion', 'TrainingContentService', 'updateCriterion', [versionId, criterionId, body, actor, request]],
    ['deleteCriterion', 'TrainingContentService', 'deleteCriterion', [versionId, criterionId, actor, request], true],
  ];

  for (const [
    methodName,
    dependencyName,
    serviceMethod,
    serviceArguments,
    returnsUndefined = false,
  ] of cases) {
    const handlerArguments = {
      acceptFactSuggestion: [versionId, suggestionId, body, actor, request],
      archiveProject: [projectId, actor, request],
      closeProject: [projectId, actor, request],
      createCriterion: [versionId, body, actor, request],
      createDraftVersion: [projectId, actor, request],
      createFact: [versionId, body, actor, request],
      createFactSuggestionRun: [versionId, body, idempotencyKey, actor, request],
      createOfficialUrlSource: [versionId, body, actor, request],
      createProject: [body, actor, request],
      createQuestion: [versionId, body, actor, request],
      deleteCriterion: [versionId, criterionId, actor, request],
      deleteDocument: [versionId, documentId, actor, request],
      deleteDraftVersion: [versionId, actor, request],
      deleteFact: [versionId, factId, actor, request],
      deleteOfficialUrlSource: [versionId, sourceId, actor, request],
      deleteQuestion: [versionId, questionId, actor, request],
      getDocumentText: [versionId, documentId],
      getLatestFactSuggestionRun: [versionId],
      getOfficialUrlSourceText: [versionId, sourceId],
      getProject: [projectId],
      getVersion: [versionId],
      getVersionReadiness: [versionId],
      listCriteria: [versionId],
      listDocuments: [versionId],
      listFactSuggestions: [versionId],
      listFacts: [versionId],
      listOfficialUrlSources: [versionId],
      listProjects: [query],
      listQuestions: [versionId],
      listRealEstateObjects: [query],
      openProject: [projectId, actor, request],
      publishVersion: [versionId, actor, request],
      rejectFactSuggestion: [versionId, suggestionId, body, actor, request],
      retryOfficialUrlSource: [versionId, sourceId, actor, request],
      updateCriterion: [versionId, criterionId, body, actor, request],
      updateDocumentText: [versionId, documentId, body, actor, request],
      updateFact: [versionId, factId, body, actor, request],
      updateProject: [projectId, body, actor, request],
      updateQuestion: [versionId, questionId, body, actor, request],
      updateVersion: [versionId, body, actor, request],
    }[methodName];

    for (const createInstance of [
      () => createController(methodName),
      () => createCompatibilityFacade(),
    ]) {
      const { calls, controller, dependencyNames, sentinel } = createInstance();
      assert.equal(dependencyNames.includes(dependencyName), true);
      const result = await controller[methodName](...handlerArguments);
      assert.deepEqual(calls, [[dependencyName, serviceMethod, serviceArguments]]);
      assert.equal(result, returnsUndefined ? undefined : sentinel);
    }
  }
});

test('document upload and retry kick the worker only after a successful service result', async () => {
  for (const [methodName, serviceMethod, handlerArguments] of [
    ['uploadDocument', 'uploadDocument', ['version-id', { buffer: Buffer.from('file') }, { id: 'actor' }, { ip: '127.0.0.1' }]],
    ['retryDocument', 'retryDocument', ['version-id', 'document-id', { id: 'actor' }, { ip: '127.0.0.1' }]],
  ]) {
    for (const createInstance of [
      (overrides) => createController(methodName, overrides),
      (overrides) => createCompatibilityFacade(overrides),
    ]) {
      const events = [];
      let releaseService;
      const serviceResult = { methodName };
      const serviceGate = new Promise((resolve) => {
        releaseService = resolve;
      });
      const { controller } = createInstance({
        TrainingDocumentsService: {
          [serviceMethod]: async () => {
            events.push('service:start');
            await serviceGate;
            events.push('service:resolved');
            return serviceResult;
          },
        },
        TrainingDocumentWorkerService: {
          kick: () => events.push('worker:kick'),
        },
      });

      const resultPromise = controller[methodName](...handlerArguments);
      assert.deepEqual(events, ['service:start']);
      releaseService();
      assert.equal(await resultPromise, serviceResult);
      assert.deepEqual(events, ['service:start', 'service:resolved', 'worker:kick']);

      const serviceError = new Error(`${methodName} failed`);
      let failedKickCount = 0;
      const failed = createInstance({
        TrainingDocumentsService: {
          [serviceMethod]: async () => {
            throw serviceError;
          },
        },
        TrainingDocumentWorkerService: {
          kick: () => {
            failedKickCount += 1;
          },
        },
      });
      await assert.rejects(
        () => failed.controller[methodName](...handlerArguments),
        (error) => error === serviceError,
      );
      assert.equal(failedKickCount, 0);
    }
  }
});

test('document content preserves private headers, filename sanitization and send order', async () => {
  for (const createInstance of [
    (overrides) => createController('getDocumentContent', overrides),
    (overrides) => createCompatibilityFacade(overrides),
  ]) {
    const events = [];
    const buffer = Buffer.from('private document');
    const { controller } = createInstance({
      TrainingDocumentsService: {
        getDocumentContent: async () => {
          events.push(['service']);
          return {
            buffer,
            file: {
              mimeType: null,
              originalName: 'x"\r\n/\\я.pdf',
            },
          };
        },
      },
    });
    const response = {
      setHeader: (name, value) => events.push(['header', name, value]),
      send: (body) => events.push(['send', body]),
    };

    await controller.getDocumentContent('version-id', 'document-id', response);

    assert.deepEqual(events, [
      ['service'],
      ['header', 'Content-Type', 'application/octet-stream'],
      ['header', 'Content-Length', buffer.length],
      ['header', 'Cache-Control', 'private, no-store'],
      [
        'header',
        'Content-Disposition',
        'attachment; filename="x______.pdf"; filename*=UTF-8\'\'x_____%D1%8F.pdf',
      ],
      ['send', buffer],
    ]);
  }
});

test('document upload keeps the exact file interceptor field and size-limit contract', () => {
  const trainingDir = path.resolve(__dirname, '../src/training');
  const controllerSource = readdirSync(trainingDir)
    .filter(
      (name) =>
        name.startsWith('training-admin') && name.endsWith('.controller.ts'),
    )
    .map((name) => readFileSync(path.join(trainingDir, name), 'utf8'))
    .join('\n');
  const normalizedSource = controllerSource.replace(/\s+/gu, ' ');

  assert.equal(
    normalizedSource.split("FileInterceptor('file'").length - 1,
    1,
  );
  assert.equal(
    normalizedSource.includes(
      "FileInterceptor('file', { limits: { fileSize: TRAINING_MAX_DOCUMENT_BYTES } })",
    ),
    true,
  );
});
