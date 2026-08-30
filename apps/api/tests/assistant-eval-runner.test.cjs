const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { test } = require('node:test');

const {
  loadAssistantEvalDataset,
  readAssistantEvalArtifactRunIds,
  scoreAssistantEval,
} = require('../dist/assistant/eval/assistant-eval.js');

const dataset = loadAssistantEvalDataset(JSON.parse(readFileSync(resolve(
  __dirname,
  'fixtures/assistant/assistant-eval-v1.json',
), 'utf8')));
const evaluatedAt = new Date('2026-08-30T08:00:00.000Z');
const actorId = uuid(900_001);

test('ZAEBAL6 runner creates exactly one fresh completed run per frozen case through the product path', async () => {
  const events = [];
  const manifestWrites = [];
  const createKeys = new Map();
  const messageKeys = new Map();
  const { product, persistence } = successfulBoundaries({
    events,
    createKeys,
    messageKeys,
    resolveGeo(evalCase) {
      if (evalCase.id !== 'GEOSEARCH-001') return { status: 'NOT_APPLICABLE' };
      return {
        status: 'RESOLVED',
        slotId: 'geo-1',
        sourceSpan: { start: 56, end: 87 },
        candidates: [{
          id: uuid(700_001),
          mode: 'NEAR',
          distanceMeters: 2_000,
        }],
      };
    },
  });
  const environment = {
    ASSISTANT_AI_MODE: 'fake',
    ASSISTANT_EVAL_ACCESS_TOKEN: 'runner-secret-must-not-leak',
  };

  const report = await loadRunner().runAssistantEvalRunner({
    dataset,
    environment,
    limits: { ...validLimits(), maximumCostUsd: '0.00000000' },
    product,
    persistence,
    randomUUID: sequentialUuidFactory(100_000),
    now: () => evaluatedAt,
    sleep: async () => {},
    writeReport: async (value) => {
      assert.equal(value.cleanup.persistenceClosed, true);
      assert.equal(value.cleanup.credentialsScrubbed, true);
      events.push('write:report');
    },
    writeManifest: async (artifact) => {
      events.push('write:manifest');
      manifestWrites.push(structuredClone(artifact));
    },
  });

  assert.equal(report.passed, true);
  assert.equal(report.caseCount, 200);
  assert.equal(report.completedRunCount, 200);
  assert.equal(report.runtimeConfigSha256, 'b'.repeat(64));
  assert.equal(report.releaseSha, '1'.repeat(40));
  assert.equal(report.releaseImageIdentity, null);
  assert.equal(events.filter((event) => event.startsWith('resolve:')).length, 200);
  assert.equal(events.filter((event) => event.startsWith('create:')).length, 200);
  assert.equal(events.filter((event) => event.startsWith('message:')).length, 200);
  assert.equal(events.filter((event) => event.startsWith('terminal:')).length, 200);
  assert.equal(events.filter((event) => event.startsWith('inspect:')).length, 200);
  assert.equal(new Set(createKeys.values()).size, 200);
  assert.deepEqual(createKeys, messageKeys);

  const geoCase = dataset.cases.find(({ id }) => id === 'GEOSEARCH-001');
  const geoMessage = events.find((event) => event.startsWith(`message:${geoCase.id}:`));
  assert.equal(geoMessage, `message:${geoCase.id}:${JSON.stringify({
    content: geoCase.query,
    context: null,
    geo: {
      referenceType: 'LANDMARK',
      landmarkId: uuid(700_001),
      mode: 'NEAR',
      distanceMeters: 2_000,
      slotId: 'geo-1',
      sourceSpan: { start: 56, end: 87 },
    },
  })}`);
  const plainCase = dataset.cases.find(({ id }) => id !== 'GEOSEARCH-001');
  assert.equal(
    events.find((event) => event.startsWith(`message:${plainCase.id}:`)),
    `message:${plainCase.id}:${JSON.stringify({
      content: plainCase.query,
      context: null,
      geo: null,
    })}`,
  );

  assert.equal(manifestWrites.length, 1);
  const [artifact] = manifestWrites;
  assert.deepEqual(Object.keys(artifact).sort(), [
    'datasetSha256',
    'datasetVersion',
    'evaluatedAt',
    'evaluatorVersion',
    'runs',
  ]);
  assert.equal(artifact.runs.length, 200);
  assert.deepEqual(
    artifact.runs.map(({ caseId }) => caseId),
    dataset.cases.map(({ id }) => id),
  );
  assert.equal(new Set(artifact.runs.map(({ runId }) => runId)).size, 200);
  assert.deepEqual(
    readAssistantEvalArtifactRunIds(dataset, artifact, evaluatedAt),
    artifact.runs.map(({ runId }) => runId),
  );
  assert.equal(artifact.datasetSha256, 'dc1c1ca5b52df1a440553b9879e8b10ecebe5c286a10c86d667957132cfcf8aa');
  assert.equal(JSON.stringify(artifact).includes('runner-secret-must-not-leak'), false);
  assert.equal(JSON.stringify(artifact).includes('conversationId'), false);
  assert.equal(JSON.stringify(artifact).includes('query'), false);
  assert.equal(events.indexOf('close') < events.indexOf('write:report'), true);
  assert.equal(events.indexOf('write:report') < events.indexOf('write:manifest'), true);

  for (const evalCase of dataset.cases) {
    const resolveIndex = events.indexOf(`resolve:${evalCase.id}`);
    const createIndex = events.indexOf(`create:${evalCase.id}`);
    const messageIndex = events.findIndex((event) => event.startsWith(`message:${evalCase.id}:`));
    const terminalIndex = events.indexOf(`terminal:${evalCase.id}`);
    const inspectIndex = events.indexOf(`inspect:${evalCase.id}`);
    assert.equal(resolveIndex < createIndex, true);
    assert.equal(createIndex < messageIndex, true);
    assert.equal(messageIndex < terminalIndex, true);
    assert.equal(terminalIndex < inspectIndex, true);
    const nextCase = dataset.cases[dataset.cases.indexOf(evalCase) + 1];
    if (nextCase) assert.equal(inspectIndex < events.indexOf(`resolve:${nextCase.id}`), true);
  }
});

test('ZAEBAL6 runner stops unresolved geo before conversation persistence', async () => {
  let createCalls = 0;
  let manifestWrites = 0;
  const { product, persistence } = successfulBoundaries();
  product.resolveGeo = async () => ({ status: 'REFINE_REQUIRED' });
  product.createConversation = async () => {
    createCalls += 1;
    throw new Error('CREATE_MUST_NOT_RUN');
  };

  await assert.rejects(loadRunner().runAssistantEvalRunner({
    dataset,
    environment: { ASSISTANT_AI_MODE: 'fake', ASSISTANT_EVAL_ACCESS_TOKEN: 'secret' },
    limits: validLimits(),
    product,
    persistence,
    randomUUID: sequentialUuidFactory(110_000),
    now: () => evaluatedAt,
    sleep: async () => {},
    writeManifest: async () => { manifestWrites += 1; },
  }), /ASSISTANT_EVAL_GEO_CONFIRMATION_REQUIRED/u);

  assert.equal(createCalls, 0);
  assert.equal(manifestWrites, 0);
});

test('ZAEBAL6 runner reuses one per-case idempotency key after lost POST responses', async () => {
  const createAttempts = [];
  const messageAttempts = [];
  const conversations = new Map();
  const runs = new Map();
  let firstCreateLost = true;
  let firstMessageLost = true;
  const { product, persistence } = successfulBoundaries();
  product.createConversation = async ({ evalCase, idempotencyKey }) => {
    createAttempts.push({ caseId: evalCase.id, idempotencyKey });
    const stored = conversations.get(idempotencyKey) ?? {
      conversationId: uuid(300_000 + conversations.size + 1),
    };
    conversations.set(idempotencyKey, stored);
    if (firstCreateLost) {
      firstCreateLost = false;
      throw retryableError();
    }
    return stored;
  };
  product.startRun = async ({ evalCase, idempotencyKey }) => {
    messageAttempts.push({ caseId: evalCase.id, idempotencyKey });
    const stored = runs.get(idempotencyKey) ?? {
      runId: uuid(400_000 + runs.size + 1),
      status: 'PENDING',
    };
    runs.set(idempotencyKey, stored);
    if (firstMessageLost) {
      firstMessageLost = false;
      throw retryableError();
    }
    return stored;
  };
  persistence.recoverConversation = async () => null;
  persistence.recoverRun = async () => null;

  const report = await loadRunner().runAssistantEvalRunner({
    dataset,
    environment: { ASSISTANT_AI_MODE: 'fake', ASSISTANT_EVAL_ACCESS_TOKEN: 'secret' },
    limits: validLimits(),
    product,
    persistence,
    randomUUID: sequentialUuidFactory(120_000),
    now: () => evaluatedAt,
    sleep: async () => {},
    writeManifest: async () => {},
  });

  assert.equal(report.passed, true);
  assert.equal(createAttempts.length, 201);
  assert.equal(messageAttempts.length, 201);
  assert.equal(createAttempts[0].idempotencyKey, createAttempts[1].idempotencyKey);
  assert.equal(messageAttempts[0].idempotencyKey, messageAttempts[1].idempotencyKey);
  assert.equal(createAttempts[0].idempotencyKey, messageAttempts[0].idempotencyKey);
  assert.equal(new Set(createAttempts.map(({ idempotencyKey }) => idempotencyKey)).size, 200);
  assert.equal(new Set(messageAttempts.map(({ idempotencyKey }) => idempotencyKey)).size, 200);
});

test('ZAEBAL6 runner rejects absent or invalid caps before touching product state', async () => {
  const calls = [];
  const boundary = new Proxy({}, {
    get(_target, property) {
      return async () => calls.push(String(property));
    },
  });
  const invalidLimits = [
    undefined,
    {},
    { ...validLimits(), requestsPerMinute: 0 },
    { ...validLimits(), requestsPerMinute: 1.5 },
    { ...validLimits(), dailyRequestCap: 0 },
    { ...validLimits(), dailyRequestCap: 1.5 },
    { ...validLimits(), maximumCostUsd: '-0.01' },
    { ...validLimits(), maximumCostUsd: 'not-usd' },
  ];

  for (const limits of invalidLimits) {
    await assert.rejects(loadRunner().runAssistantEvalRunner({
      dataset,
      environment: { ASSISTANT_AI_MODE: 'fake', ASSISTANT_EVAL_ACCESS_TOKEN: 'secret' },
      limits,
      product: boundary,
      persistence: boundary,
    }), /ASSISTANT_EVAL_LIMITS_(?:INVALID|REQUIRED)/u);
  }
  assert.deepEqual(calls, []);

  const invalidEnvironment = { ASSISTANT_EVAL_ACCESS_TOKEN: 'must-be-scrubbed' };
  await assert.rejects(loadRunner().runAssistantEvalRunner({
    dataset,
    environment: invalidEnvironment,
    limits: { ...validLimits(), requestsPerMinute: 0 },
    product: boundary,
    persistence: boundary,
  }), /ASSISTANT_EVAL_LIMITS_INVALID/u);
  assert.equal('ASSISTANT_EVAL_ACCESS_TOKEN' in invalidEnvironment, false);
});

test('ZAEBAL6 provider coverage fails closed when OpenAI telemetry has no exact settled receipt', () => {
  const { findAssistantEvalProviderCoverageViolations } = loadRunner();
  const runId = uuid(206_001);
  const runs = [{
    id: runId,
    telemetryJson: [{ model: 'gpt-5-mini', outcome: 'ACCEPTED', totalTokens: 42 }],
  }];
  const attempt = {
    operationRunId: runId,
    executionId: uuid(206_002),
    attemptOrdinal: 1,
    operation: 'PLANNER',
    actualModel: 'gpt-5-mini',
    status: 'SETTLED',
    outcome: 'ACCEPTED',
    totalTokens: 42n,
  };

  assert.deepEqual(findAssistantEvalProviderCoverageViolations(runs, [attempt], 'openai'), []);
  assert.deepEqual(findAssistantEvalProviderCoverageViolations(runs, [], 'openai'), [
    'ASSISTANT_EVAL_PROVIDER_RECEIPTS_INCOMPLETE',
  ]);
  assert.deepEqual(findAssistantEvalProviderCoverageViolations(runs, [{
    ...attempt,
    totalTokens: 41n,
  }], 'openai'), ['ASSISTANT_EVAL_PROVIDER_RECEIPTS_INCOMPLETE']);
  assert.deepEqual(findAssistantEvalProviderCoverageViolations(runs, [attempt], 'fake'), [
    'ASSISTANT_EVAL_PROVIDER_RECEIPTS_UNEXPECTED',
  ]);
  assert.deepEqual(findAssistantEvalProviderCoverageViolations(runs, [], 'fake'), []);
});

test('ZAEBAL6 persisted inspection binds every run to its actor, conversation and idempotency key', () => {
  const { validateAssistantEvalPersistedRunIsolation } = loadRunner();
  const idempotencyKey = uuid(207_001);
  const conversationId = uuid(207_002);
  const runId = uuid(207_003);
  const rows = [{
    id: runId,
    ownerUserId: actorId,
    conversationId,
    idempotencyKey,
    conversation: {
      ownerUserId: actorId,
      creationKey: idempotencyKey,
    },
  }];
  const expected = [{ runId, conversationId, idempotencyKey }];

  assert.doesNotThrow(() => validateAssistantEvalPersistedRunIsolation(rows, expected, actorId));
  for (const mismatch of [
    { ownerUserId: uuid(207_010) },
    { conversationId: uuid(207_011) },
    { idempotencyKey: uuid(207_012) },
    { conversation: { ownerUserId: actorId, creationKey: uuid(207_013) } },
  ]) {
    assert.throws(() => validateAssistantEvalPersistedRunIsolation([
      { ...rows[0], ...mismatch },
    ], expected, actorId), /ASSISTANT_EVAL_PERSISTED_RUN_ISOLATION_INVALID/u);
  }
});

test('ZAEBAL6 execute runtime accepts only a local disposable database and forbids deployed environments', () => {
  const {
    assertAssistantEvalRuntimeHandshake,
    assertAssistantEvalRuntimeSafety,
  } = loadRunner();
  assert.doesNotThrow(() => assertAssistantEvalRuntimeSafety({
    DATABASE_URL: 'postgresql://localhost/platforma_eval_disposable?schema=public',
    ASSISTANT_EVAL_API_ORIGIN: 'http://localhost:3000',
    NODE_ENV: 'test',
    ASSISTANT_EVAL_EMAIL: 'eval@example.test',
    ASSISTANT_EVAL_PASSWORD: 'password',
  }));
  for (const environment of [
    {
      DATABASE_URL: 'postgresql://db.internal/platforma_eval_disposable?schema=public',
      ASSISTANT_EVAL_API_ORIGIN: 'http://localhost:3000',
    },
    {
      DATABASE_URL: 'postgresql://localhost/platforma?schema=public',
      ASSISTANT_EVAL_API_ORIGIN: 'http://localhost:3000',
    },
    {
      DATABASE_URL: 'postgresql://localhost/platforma_contest?schema=public',
      ASSISTANT_EVAL_API_ORIGIN: 'http://localhost:3000',
      NODE_ENV: 'test',
      ASSISTANT_EVAL_EMAIL: 'eval@example.test',
      ASSISTANT_EVAL_PASSWORD: 'password',
    },
    {
      DATABASE_URL: 'postgresql://localhost/latest_platforma?schema=public',
      ASSISTANT_EVAL_API_ORIGIN: 'http://localhost:3000',
      NODE_ENV: 'test',
      ASSISTANT_EVAL_EMAIL: 'eval@example.test',
      ASSISTANT_EVAL_PASSWORD: 'password',
    },
    {
      DATABASE_URL: 'postgresql://localhost/platforma_eval_disposable?schema=public',
      ASSISTANT_EVAL_API_ORIGIN: 'http://localhost:3000',
      DEPLOYMENT_ENV: 'staging',
    },
    {
      DATABASE_URL: 'postgresql://localhost/platforma_eval_disposable?schema=public',
      ASSISTANT_EVAL_API_ORIGIN: 'https://staging.example.com',
    },
  ]) {
    assert.throws(() => assertAssistantEvalRuntimeSafety(environment),
      /ASSISTANT_EVAL_DISPOSABLE_RUNTIME_REQUIRED/u);
  }
  assert.doesNotThrow(() => assertAssistantEvalRuntimeHandshake(
    fakeRuntimeContract(),
    'a'.repeat(64),
    validLimits(),
  ));
  assert.throws(() => assertAssistantEvalRuntimeHandshake({
    ...fakeRuntimeContract(),
    runtime: { ...fakeRuntimeContract().runtime, currentFactRefreshMode: 'disabled' },
  }, 'a'.repeat(64), validLimits()), /ASSISTANT_EVAL_CURRENT_FACT_FIXTURE_REQUIRED/u);
  assert.throws(() => assertAssistantEvalRuntimeHandshake(
    { ...fakeRuntimeContract(), databaseFingerprint: 'b'.repeat(64) },
    'a'.repeat(64),
    validLimits(),
  ), /ASSISTANT_EVAL_RUNTIME_HANDSHAKE_INVALID/u);
  assert.throws(() => assertAssistantEvalRuntimeHandshake({
    ...fakeRuntimeContract(),
    runtimeConfigSha256: null,
  }, 'a'.repeat(64), validLimits()), /ASSISTANT_EVAL_RUNTIME_BINDING_INVALID/u);
  assert.throws(() => assertAssistantEvalRuntimeHandshake({
    ...fakeRuntimeContract(),
    releaseIdentity: { releaseSha: '1'.repeat(12), releaseImageIdentity: null },
  }, 'a'.repeat(64), validLimits()), /ASSISTANT_EVAL_RELEASE_IDENTITY_INVALID/u);
  assert.throws(() => assertAssistantEvalRuntimeHandshake({
    ...fakeRuntimeContract(),
    provider: { ...fakeRuntimeContract().provider, requestsPerDay: 1_001 },
  }, 'a'.repeat(64), validLimits()), /ASSISTANT_EVAL_RUNTIME_BUDGET_EXCEEDS_CAP/u);
  assert.throws(() => assertAssistantEvalRuntimeHandshake({
    ...fakeRuntimeContract(),
    runtime: { ...fakeRuntimeContract().runtime, geoProviderEnabled: true },
  }, 'a'.repeat(64), validLimits()), /ASSISTANT_EVAL_UNBOUNDED_PROVIDER_ENABLED/u);
  assert.throws(() => assertAssistantEvalRuntimeHandshake({
    ...fakeRuntimeContract(),
    runtime: { ...fakeRuntimeContract().runtime, nodeEnvironment: 'Production' },
  }, 'a'.repeat(64), validLimits()), /ASSISTANT_EVAL_UNBOUNDED_PROVIDER_ENABLED/u);
  assert.throws(() => assertAssistantEvalRuntimeHandshake({
    ...fakeRuntimeContract(),
    provider: { ...fakeRuntimeContract().provider, queryPlannerLive: true },
  }, 'a'.repeat(64), validLimits()), /ASSISTANT_EVAL_RUNTIME_HANDSHAKE_INVALID/u);
  const openAiContract = {
    ...fakeRuntimeContract(),
    provider: {
      ...fakeRuntimeContract().provider,
      aiMode: 'openai',
      dailyBudgetUsd: '1.00000000',
      queryPlannerLive: true,
      paidCallsConfirmed: true,
      apiKeyPresent: true,
    },
  };
  assert.doesNotThrow(() => assertAssistantEvalRuntimeHandshake(
    openAiContract,
    'a'.repeat(64),
    validLimits(),
  ));
  assert.throws(() => assertAssistantEvalRuntimeHandshake({
    ...openAiContract,
    provider: { ...openAiContract.provider, dailyBudgetUsd: '1.00000001' },
  }, 'a'.repeat(64), validLimits()), /ASSISTANT_EVAL_RUNTIME_BUDGET_EXCEEDS_CAP/u);
  assert.throws(() => assertAssistantEvalRuntimeHandshake({
    ...openAiContract,
    runtime: { ...openAiContract.runtime, openAiBaseUrlOfficial: false },
  }, 'a'.repeat(64), validLimits()), /ASSISTANT_EVAL_RUNTIME_HANDSHAKE_INVALID/u);
  assert.throws(() => assertAssistantEvalRuntimeHandshake({
    ...openAiContract,
    provider: { ...openAiContract.provider, dailyBudgetUsd: 'not-usd' },
  }, 'a'.repeat(64), validLimits()), /ASSISTANT_EVAL_RUNTIME_HANDSHAKE_INVALID/u);
});

test('ZAEBAL6 runner reauthenticates once on 401 and scrubs every in-memory credential', async () => {
  const tokens = [];
  const environment = {
    ASSISTANT_EVAL_ACCESS_TOKEN: 'expired-access-secret',
    ASSISTANT_EVAL_EMAIL: 'eval@example.test',
    ASSISTANT_EVAL_PASSWORD: 'login-password-secret',
  };
  const boundaries = successfulBoundaries();
  let expired = true;
  boundaries.product.getActor = async ({ accessToken }) => {
    tokens.push(accessToken);
    if (expired) {
      expired = false;
      throw new Error('ASSISTANT_EVAL_API_HTTP_401');
    }
    return { id: actorId };
  };
  boundaries.product.refreshAccessToken = async () => ({
    accessToken: 'fresh-access-secret',
    actorId,
  });
  boundaries.product.scrubAuth = () => tokens.push('auth:scrubbed');
  const originalCheckConfig = boundaries.product.checkConfig;
  boundaries.product.checkConfig = async ({ accessToken }) => {
    tokens.push(accessToken);
    return originalCheckConfig({ accessToken });
  };

  const report = await loadRunner().runAssistantEvalRunner({
    dataset,
    environment,
    limits: validLimits(),
    product: boundaries.product,
    persistence: boundaries.persistence,
    randomUUID: sequentialUuidFactory(205_000),
    now: () => evaluatedAt,
    sleep: async () => {},
    writeManifest: async () => {},
  });

  assert.equal(report.passed, true);
  assert.deepEqual(tokens.slice(0, 2), ['expired-access-secret', 'fresh-access-secret']);
  assert.equal(tokens.at(-1), 'auth:scrubbed');
  assert.equal('ASSISTANT_EVAL_ACCESS_TOKEN' in environment, false);
  assert.equal('ASSISTANT_EVAL_EMAIL' in environment, false);
  assert.equal('ASSISTANT_EVAL_PASSWORD' in environment, false);
  assert.equal(JSON.stringify(report).includes('secret'), false);
});

test('ZAEBAL6 runner and evaluator CLIs require complete, non-colliding evidence paths', () => {
  const { parseCliArguments } = loadRunner();
  const runnerOptions = parseCliArguments([
    '--execute',
    '--rpm', '10',
    '--daily-request-cap', '220',
    '--max-cost-usd', '1.00000000',
    '--report', 'runner-report.json',
    '--manifest', 'manifest.json',
  ]);
  assert.equal(runnerOptions.execute, true);
  assert.equal(runnerOptions.limits.maximumCostUsd, '1.00000000');
  assert.notEqual(runnerOptions.reportPath, runnerOptions.manifestPath);
  assert.throws(() => parseCliArguments([
    '--execute',
    '--rpm', '10',
    '--daily-request-cap', '220',
    '--max-cost-usd', '1.00000000',
    '--manifest', 'manifest.json',
  ]), /ASSISTANT_EVAL_LIMITS_REQUIRED/u);
  assert.throws(() => parseCliArguments([
    '--execute',
    '--rpm', '10',
    '--daily-request-cap', '220',
    '--max-cost-usd', '1.00000000',
    '--report', 'same.json',
    '--manifest', 'same.json',
  ]), /ASSISTANT_EVAL_OUTPUT_PATHS_COLLIDE/u);

  const { parseArguments } = require('../scripts/assistant-eval.cjs');
  const evaluatorOptions = parseArguments([
    '--results', 'manifest.json',
    '--runner-report', 'runner-report.json',
    '--evidence', 'evidence.json',
  ], {});
  assert.notEqual(evaluatorOptions.resultsPath, evaluatorOptions.runnerReportPath);
  assert.notEqual(evaluatorOptions.resultsPath, evaluatorOptions.evidencePath);
  assert.throws(() => parseArguments([
    '--results', 'manifest.json',
    '--evidence', 'evidence.json',
  ], {}), /ASSISTANT_EVAL_EVIDENCE_ARGUMENTS_REQUIRED/u);
  assert.throws(() => parseArguments([
    '--results', 'manifest.json',
    '--runner-report', 'same.json',
    '--evidence', 'same.json',
  ], {}), /ASSISTANT_EVAL_OUTPUT_PATHS_COLLIDE/u);

  assert.throws(() => parseArguments([
    '--finalize-evidence',
    '--evidence-draft', 'evidence-draft.json',
    '--cleanup-attestation', 'cleanup.json',
    '--evidence', 'evidence-final.json',
  ], {}), /ASSISTANT_EVAL_ARGUMENT_INVALID/u);

  const {
    parseAssistantEvalCleanupArguments,
  } = require('../scripts/assistant-eval-cleanup.cjs');
  const cleanupOptions = parseAssistantEvalCleanupArguments([
    '--execute',
    '--evidence-draft', 'evidence-draft.json',
    '--evidence', 'evidence-final.json',
    '--compose-project', 'platforma-assistant-eval-a1b2c3d4',
  ]);
  assert.equal(cleanupOptions.execute, true);
  assert.notEqual(cleanupOptions.evidenceDraftPath, cleanupOptions.evidencePath);

  const {
    parseAssistantRolloutPreflightArguments,
  } = require('../scripts/assistant-rollout-preflight.cjs');
  assert.throws(() => parseAssistantRolloutPreflightArguments([
    '--eval-results', 'manifest.json',
    '--eval-runner-report', 'runner-report.json',
    '--eval-evidence', 'evidence-draft.json',
    '--target-stage', 'PILOT',
  ], {}), /ASSISTANT_ROLLOUT_ARGUMENT_INVALID/u);
  const preflightOptions = parseAssistantRolloutPreflightArguments([
    '--eval-evidence', 'evidence-final.json',
    '--target-stage', 'PILOT',
  ], {});
  assert.equal(preflightOptions.targetStage, 'PILOT');
  assert.equal(preflightOptions.evidencePath.endsWith('evidence-final.json'), true);
});

test('ZAEBAL6 HTTP client rejects redirects before a login body can leave loopback', async () => {
  const { requestBoundedJson } = loadRunner();
  let requestOptions = null;
  const result = await requestBoundedJson(async (_url, options) => {
    requestOptions = options;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }, 'http://127.0.0.1:3000/auth/login', {
    method: 'POST',
    body: { email: 'eval@example.test', password: 'secret' },
    expectedStatuses: [200],
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(requestOptions.redirect, 'error');
});

test('ZAEBAL6 cleanup harness attests only resources it inventories, removes and rechecks', async () => {
  const {
    containerMatchesDatabaseIdentity,
    runAssistantEvalCleanup,
  } = require('../scripts/assistant-eval-cleanup.cjs');
  const databaseFingerprint = 'a'.repeat(64);
  const draft = {
    schemaVersion: 1,
    generatedAt: '2026-08-30T08:00:00.000Z',
    runner: { databaseFingerprint },
    cases: [],
    cleanup: {
      persistenceClosed: true,
      credentialsScrubbed: true,
      persistedEvidenceRetained: true,
      runnerOwnedResources: [{
        type: 'DATABASE_CONNECTION',
        identifier: databaseFingerprint,
        disposition: 'CLOSED',
      }, {
        type: 'IN_MEMORY_CREDENTIALS',
        identifier: 'assistant-eval-auth',
        disposition: 'SCRUBBED',
      }],
      externalDisposableDatabase: {
        fingerprint: databaseFingerprint,
        owner: 'CALLER',
        disposition: 'RETAINED_FOR_EVALUATOR',
      },
    },
  };
  const resources = {
    databases: [databaseFingerprint],
    containers: ['eval-container'],
    networks: ['eval-network'],
    volumes: ['eval-volume'],
    images: ['platforma-assistant-eval-a1b2c3d4-api:a1b2c3d4'],
  };
  const events = [];
  const databaseIdentity = {
    fingerprint: databaseFingerprint,
    serverAddress: '172.18.0.2',
    serverPort: 5432,
  };
  const databaseEndpoint = { hostname: '127.0.0.1', port: 55_432 };
  const ownedVolumes = ['eval-volume'];
  const databaseContainer = {
    State: { Running: true },
    Config: {
      Labels: { 'com.docker.compose.service': 'postgres' },
      ExposedPorts: { '5432/tcp': {} },
      Env: ['PGDATA=/var/lib/postgresql/data/pgdata'],
    },
    NetworkSettings: {
      Networks: { default: { IPAddress: '172.18.0.2' } },
      Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '55432' }] },
    },
    Mounts: [{
      Type: 'volume',
      Name: 'eval-volume',
      Destination: '/var/lib/postgresql/data',
    }],
  };
  assert.equal(containerMatchesDatabaseIdentity(
    databaseContainer,
    databaseIdentity,
    databaseEndpoint,
    ownedVolumes,
  ), true);
  assert.equal(containerMatchesDatabaseIdentity({
    ...databaseContainer,
    NetworkSettings: {
      ...databaseContainer.NetworkSettings,
      Networks: { default: { IPAddress: '172.18.0.3' } },
    },
  }, databaseIdentity, databaseEndpoint, ownedVolumes), false);
  assert.equal(containerMatchesDatabaseIdentity({
    ...databaseContainer,
    Config: {
      ...databaseContainer.Config,
      Labels: { 'com.docker.compose.service': 'api' },
    },
  }, databaseIdentity, databaseEndpoint, ownedVolumes), false);
  assert.equal(containerMatchesDatabaseIdentity({
    ...databaseContainer,
    NetworkSettings: {
      ...databaseContainer.NetworkSettings,
      Ports: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '55432' }] },
    },
  }, databaseIdentity, databaseEndpoint, ownedVolumes), false);
  assert.equal(containerMatchesDatabaseIdentity({
    ...databaseContainer,
    Mounts: [{
      Type: 'volume',
      Name: 'other-project-volume',
      Destination: '/var/lib/postgresql/data',
    }],
  }, databaseIdentity, databaseEndpoint, ownedVolumes), false);
  const boundary = {
    async getDatabaseIdentity() {
      events.push('fingerprint');
      return databaseIdentity;
    },
    async inventoryOwnedResources() {
      events.push('inventory');
      return {
        databaseEndpointBound: true,
        resources: structuredClone(resources),
      };
    },
    async snapshotOrdinaryResources() {
      events.push('ordinary:before');
      return ['ordinary-container'];
    },
    async closeDatabase() { events.push('database:close'); },
    async removeOwnedResources(value) {
      events.push('remove');
      assert.deepEqual(value, resources);
    },
    async inspectResidualResources() {
      events.push('residual');
      return { databases: [], containers: [], networks: [], volumes: [], images: [] };
    },
    async findMissingOrdinaryResources(before) {
      events.push('ordinary:after');
      assert.deepEqual(before, ['ordinary-container']);
      return [];
    },
  };

  const finalized = await runAssistantEvalCleanup({
    boundary,
    composeProject: 'platforma-assistant-eval-a1b2c3d4',
    draft,
    now: sequentialDateFactory([
      '2026-08-30T08:01:00.000Z',
      '2026-08-30T08:02:00.000Z',
    ]),
    validateDraft: () => {},
  });

  assert.deepEqual(events, [
    'fingerprint',
    'inventory',
    'ordinary:before',
    'database:close',
    'remove',
    'residual',
    'ordinary:after',
  ]);
  assert.equal(finalized.cleanup.phase, 'FINALIZED');
  assert.equal(finalized.cleanup.external.completedAt, '2026-08-30T08:02:00.000Z');
  assert.deepEqual(finalized.cleanup.external.ownedResources, resources);
  assert.deepEqual(finalized.cleanup.external.removedResources, resources);

  await assert.rejects(runAssistantEvalCleanup({
    boundary: {
      ...boundary,
      async inspectResidualResources() {
        return { databases: [], containers: ['eval-container'], networks: [], volumes: [], images: [] };
      },
    },
    composeProject: 'platforma-assistant-eval-a1b2c3d4',
    draft,
    now: sequentialDateFactory([
      '2026-08-30T08:01:00.000Z',
      '2026-08-30T08:02:00.000Z',
    ]),
    validateDraft: () => {},
  }), /ASSISTANT_EVAL_CLEANUP_INCOMPLETE/u);

  let destructiveCalls = 0;
  await assert.rejects(runAssistantEvalCleanup({
    boundary: {
      ...boundary,
      async inventoryOwnedResources() {
        const wrongProjectDatabase = {
          ...databaseContainer,
          NetworkSettings: {
            ...databaseContainer.NetworkSettings,
            Networks: { default: { IPAddress: '172.18.0.3' } },
          },
        };
        return {
          databaseEndpointBound: containerMatchesDatabaseIdentity(
            wrongProjectDatabase,
            databaseIdentity,
            databaseEndpoint,
            ownedVolumes,
          ),
          resources,
        };
      },
      async removeOwnedResources() { destructiveCalls += 1; },
    },
    composeProject: 'platforma-assistant-eval-a1b2c3d4',
    draft,
    now: sequentialDateFactory([
      '2026-08-30T08:01:00.000Z',
      '2026-08-30T08:02:00.000Z',
    ]),
    validateDraft: () => {},
  }), /ASSISTANT_EVAL_CLEANUP_PROJECT_DATABASE_MISMATCH/u);
  assert.equal(destructiveCalls, 0);
});

test('ZAEBAL6 CLI reserves both 0600 outputs before work and removes every partial artifact', async () => {
  const { reserveAssistantEvalOutputPair } = loadRunner();
  const directory = mkdtempSync(join(tmpdir(), 'platforma-zaebal6-'));
  const reportPath = join(directory, 'runner-report.json');
  const manifestPath = join(directory, 'manifest.json');
  try {
    writeFileSync(manifestPath, 'occupied', { mode: 0o600 });
    await assert.rejects(
      reserveAssistantEvalOutputPair(reportPath, manifestPath),
      /ASSISTANT_EVAL_OUTPUT_RESERVATION_FAILED/u,
    );
    assert.equal(existsSync(reportPath), false);
    unlinkSync(manifestPath);

    const outputs = await reserveAssistantEvalOutputPair(reportPath, manifestPath);
    assert.equal(statSync(reportPath).mode & 0o777, 0o600);
    assert.equal(statSync(manifestPath).mode & 0o777, 0o600);
    await outputs.report.write({ passed: true });
    await outputs.manifest.write({ runs: [] });
    assert.deepEqual(JSON.parse(readFileSync(reportPath, 'utf8')), { passed: true });
    assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')), { runs: [] });
    await outputs.discard();
    assert.equal(existsSync(reportPath), false);
    assert.equal(existsSync(manifestPath), false);
  } finally {
    for (const path of [reportPath, manifestPath]) {
      if (existsSync(path)) unlinkSync(path);
    }
    rmdirSync(directory);
  }
});

test('ZAEBAL6 runner enforces rolling RPM, daily attempts and effective USD before the next case', async () => {
  let nowMs = evaluatedAt.getTime();
  const startTimes = [];
  const { product, persistence } = successfulBoundaries();
  product.startRun = async ({ evalCase }) => {
    startTimes.push(nowMs);
    return { runId: runIdForCase(evalCase.id), status: 'PENDING' };
  };

  await loadRunner().runAssistantEvalRunner({
    dataset,
    environment: { ASSISTANT_AI_MODE: 'fake', ASSISTANT_EVAL_ACCESS_TOKEN: 'secret' },
    limits: { ...validLimits(), requestsPerMinute: 2 },
    product,
    persistence,
    randomUUID: sequentialUuidFactory(130_000),
    now: () => new Date(nowMs),
    sleep: async (durationMs) => { nowMs += durationMs; },
    writeManifest: async () => {},
  });
  for (let index = 0; index < startTimes.length; index += 1) {
    const inWindow = startTimes.filter((value) => value > startTimes[index] - 60_000
      && value <= startTimes[index]);
    assert.equal(inWindow.length <= 2, true);
  }

  for (const capScenario of [
    { kind: 'daily', limits: { ...validLimits(), dailyRequestCap: 1 } },
    { kind: 'usd', limits: { ...validLimits(), maximumCostUsd: '0.10000000' } },
  ]) {
    let resolveCalls = 0;
    const scenario = successfulBoundaries();
    scenario.product.resolveGeo = async () => {
      resolveCalls += 1;
      return { status: 'NOT_APPLICABLE' };
    };
    scenario.persistence.inspectRuns = async ({ runIds }) => ({
      runs: runIds.map((id) => ({ id, status: 'COMPLETED', qualityFlags: [] })),
      modelRequestCount: capScenario.kind === 'daily' ? runIds.length : 0,
      effectiveCostUsd: capScenario.kind === 'usd' ? '0.10000000' : '0.00000000',
      criticalViolations: [],
    });
    await assert.rejects(loadRunner().runAssistantEvalRunner({
      dataset,
      environment: { ASSISTANT_AI_MODE: 'fake', ASSISTANT_EVAL_ACCESS_TOKEN: 'secret' },
      limits: capScenario.limits,
      product: scenario.product,
      persistence: scenario.persistence,
      randomUUID: sequentialUuidFactory(capScenario.kind === 'daily' ? 140_000 : 150_000),
      now: () => evaluatedAt,
      sleep: async () => {},
      writeManifest: async () => {},
    }), capScenario.kind === 'daily'
      ? /ASSISTANT_EVAL_DAILY_REQUEST_CAP_EXHAUSTED/u
      : /ASSISTANT_EVAL_USD_CAP_EXHAUSTED/u);
    assert.equal(resolveCalls, 1);
  }
});

test('ZAEBAL6 runner stops on the first persisted critical violation or failed run', async () => {
  for (const scenario of ['critical', 'failed']) {
    let resolveCalls = 0;
    let manifestWrites = 0;
    const boundaries = successfulBoundaries();
    boundaries.product.resolveGeo = async () => {
      resolveCalls += 1;
      return { status: 'NOT_APPLICABLE' };
    };
    if (scenario === 'critical') {
      boundaries.persistence.inspectRuns = async ({ runIds }) => ({
        runs: runIds.map((id) => ({ id, status: 'COMPLETED', qualityFlags: [] })),
        modelRequestCount: runIds.length,
        effectiveCostUsd: '0.00000000',
        criticalViolations: ['HARD_FILTER_VIOLATION'],
      });
    } else {
      boundaries.product.getRun = async ({ runId }) => ({
        runId,
        status: 'FAILED',
        errorCode: 'ASSISTANT_PROVIDER_TIMEOUT',
      });
    }

    await assert.rejects(loadRunner().runAssistantEvalRunner({
      dataset,
      environment: { ASSISTANT_AI_MODE: 'fake', ASSISTANT_EVAL_ACCESS_TOKEN: 'secret' },
      limits: validLimits(),
      product: boundaries.product,
      persistence: boundaries.persistence,
      randomUUID: sequentialUuidFactory(scenario === 'critical' ? 160_000 : 170_000),
      now: () => evaluatedAt,
      sleep: async () => {},
      writeManifest: async () => { manifestWrites += 1; },
    }), scenario === 'critical'
      ? /HARD_FILTER_VIOLATION/u
      : /ASSISTANT_PROVIDER_TIMEOUT/u);
    assert.equal(resolveCalls, 1);
    assert.equal(manifestWrites, 0);
  }
});

test('ZAEBAL6 runner always closes owned persistence and scrubs credentials', async () => {
  for (const scenario of ['success', 'failure']) {
    let closeCalls = 0;
    const environment = {
      ASSISTANT_AI_MODE: 'fake',
      ASSISTANT_EVAL_ACCESS_TOKEN: 'cleanup-secret',
    };
    const boundaries = successfulBoundaries();
    boundaries.persistence.close = async () => { closeCalls += 1; };
    if (scenario === 'failure') {
      boundaries.product.resolveGeo = async () => { throw new Error('ASSISTANT_EVAL_TEST_PRIMARY'); };
    }
    let report = null;
    let failure = null;
    try {
      report = await loadRunner().runAssistantEvalRunner({
        dataset,
        environment,
        limits: validLimits(),
        product: boundaries.product,
        persistence: boundaries.persistence,
        randomUUID: sequentialUuidFactory(scenario === 'success' ? 180_000 : 190_000),
        now: () => evaluatedAt,
        sleep: async () => {},
        writeManifest: async () => {},
      });
    } catch (error) {
      failure = error;
    }
    assert.equal(closeCalls, 1);
    assert.equal('ASSISTANT_EVAL_ACCESS_TOKEN' in environment, false);
    assert.equal(JSON.stringify(report ?? failure).includes('cleanup-secret'), false);
    assert.equal(scenario === 'success' ? report?.passed : failure instanceof Error, true);
  }

  const boundaries = successfulBoundaries();
  boundaries.product.resolveGeo = async () => { throw new Error('ASSISTANT_EVAL_TEST_PRIMARY'); };
  boundaries.persistence.close = async () => { throw new Error('ASSISTANT_EVAL_TEST_CLEANUP'); };
  await assert.rejects(loadRunner().runAssistantEvalRunner({
    dataset,
    environment: { ASSISTANT_AI_MODE: 'fake', ASSISTANT_EVAL_ACCESS_TOKEN: 'secret' },
    limits: validLimits(),
    product: boundaries.product,
    persistence: boundaries.persistence,
    randomUUID: sequentialUuidFactory(200_000),
    now: () => evaluatedAt,
    sleep: async () => {},
    writeManifest: async () => {},
  }), (error) => error instanceof AggregateError
    && error.errors.some((item) => item.message === 'ASSISTANT_EVAL_TEST_PRIMARY')
    && error.errors.some((item) => item.message === 'ASSISTANT_EVAL_TEST_CLEANUP'));

  let closeAfterScrubFailure = 0;
  const aggregate = successfulBoundaries();
  aggregate.product.resolveGeo = async () => { throw new Error('ASSISTANT_EVAL_TEST_PRIMARY'); };
  aggregate.product.scrubAuth = () => { throw new Error('ASSISTANT_EVAL_TEST_SCRUB'); };
  aggregate.persistence.close = async () => {
    closeAfterScrubFailure += 1;
    throw new Error('ASSISTANT_EVAL_TEST_CLOSE');
  };
  await assert.rejects(loadRunner().runAssistantEvalRunner({
    dataset,
    environment: { ASSISTANT_AI_MODE: 'fake', ASSISTANT_EVAL_ACCESS_TOKEN: 'secret' },
    limits: validLimits(),
    product: aggregate.product,
    persistence: aggregate.persistence,
    randomUUID: sequentialUuidFactory(201_000),
    now: () => evaluatedAt,
    sleep: async () => {},
    writeManifest: async () => {},
  }), (error) => error instanceof AggregateError
    && error.errors.some((item) => item.message === 'ASSISTANT_EVAL_TEST_PRIMARY')
    && error.errors.some((item) => item.message === 'ASSISTANT_EVAL_TEST_SCRUB')
    && error.errors.some((item) => item.message === 'ASSISTANT_EVAL_TEST_CLOSE'));
  assert.equal(closeAfterScrubFailure, 1);

  const missingScrubber = successfulBoundaries();
  delete missingScrubber.product.scrubAuth;
  await assert.rejects(loadRunner().runAssistantEvalRunner({
    dataset,
    environment: { ASSISTANT_AI_MODE: 'fake', ASSISTANT_EVAL_ACCESS_TOKEN: 'secret' },
    limits: validLimits(),
    product: missingScrubber.product,
    persistence: missingScrubber.persistence,
    randomUUID: sequentialUuidFactory(202_000),
    now: () => evaluatedAt,
    sleep: async () => {},
    writeManifest: async () => {},
  }), /ASSISTANT_EVAL_AUTH_SCRUBBER_REQUIRED/u);
});

test('ZAEBAL6 geo usage attribution consumes each operation once for sequential runs', () => {
  const { attributeAssistantEvalGeoProviderCalls } = require('../scripts/assistant-eval-runtime.cjs');
  const runs = [
    {
      id: uuid(600_001), ownerUserId: actorId,
      createdAt: new Date('2026-08-30T08:00:10.000Z'), expectedGeoOperationCount: 1,
      expectedGeoOperationQueries: ['павелецкая плаза'],
    },
    {
      id: uuid(600_002), ownerUserId: actorId,
      createdAt: new Date('2026-08-30T08:00:20.000Z'), expectedGeoOperationCount: 1,
      expectedGeoOperationQueries: ['белорусский вокзал'],
    },
  ];
  const operations = [
    {
      actorUserId: actorId, normalizedQuery: 'павелецкая плаза', providerCallCount: 1,
      createdAt: new Date('2026-08-30T08:00:09.000Z'),
    },
    {
      actorUserId: actorId, normalizedQuery: 'белорусский вокзал', providerCallCount: 2,
      createdAt: new Date('2026-08-30T08:00:19.000Z'),
    },
  ];

  assert.deepEqual(attributeAssistantEvalGeoProviderCalls(runs, operations), new Map([
    [uuid(600_001), 1],
    [uuid(600_002), 2],
  ]));
  assert.throws(() => attributeAssistantEvalGeoProviderCalls(runs, [
    ...operations,
    {
      actorUserId: actorId, normalizedQuery: 'чужая операция', providerCallCount: 0,
      createdAt: new Date('2026-08-30T08:00:09.500Z'),
    },
  ]), /ASSISTANT_EVAL_GEO_ATTRIBUTION_AMBIGUOUS/u);
  assert.throws(() => attributeAssistantEvalGeoProviderCalls(runs, [{
    ...operations[0], normalizedQuery: 'чужая операция',
  }, operations[1]]), /ASSISTANT_EVAL_GEO_ATTRIBUTION_AMBIGUOUS/u);
});

test('ZAEBAL6 evidence bundle correlates run, revision, receipt and quality provenance without raw payloads', () => {
  const {
    computeAssistantEvalEvidenceCoreSha256,
    computeAssistantEvalFinalizedEvidenceSha256,
    createAssistantEvalEvidenceBundle,
    finalizeAssistantEvalEvidenceBundle,
    readAssistantEvalFinalizedEvidenceBundle,
  } = require('../scripts/assistant-eval-runtime.cjs');
  const artifact = {
    datasetVersion: dataset.version,
    datasetSha256: 'dc1c1ca5b52df1a440553b9879e8b10ecebe5c286a10c86d667957132cfcf8aa',
    evaluatorVersion: 'assistant-evaluator-v1',
    evaluatedAt: evaluatedAt.toISOString(),
    runs: dataset.cases.map((evalCase, index) => ({
      caseId: evalCase.id,
      runId: uuid(500_000 + index),
    })),
  };
  const evaluation = {
    datasetVersion: dataset.version,
    results: dataset.cases.map((evalCase, index) => ({
      id: evalCase.id,
      passed: index !== 0,
      qualityScore: index === 0 ? 0.75 : 1,
      latencyMs: 100 + index,
      modelAttempts: 1,
      totalTokens: 50,
      geoProviderCalls: 0,
      violations: index === 0 ? ['UNSUPPORTED_LINK'] : [],
      rawAnswer: 'must-not-leak',
    })),
    provenance: artifact.runs.map(({ caseId, runId }, index) => ({
      id: caseId,
      runId,
      answerDigest: sha256(`answer-${String(index).padStart(3, '0')}`),
      evidenceDigest: sha256(`evidence-${String(index).padStart(3, '0')}`),
    })),
  };
  const records = artifact.runs.map(({ runId }, index) => ({
    id: runId,
    status: 'COMPLETED',
    createdAt: new Date(evaluatedAt.getTime() - 2_000 + index).toISOString(),
    completedAt: new Date(evaluatedAt.getTime() - 1_000 + index).toISOString(),
    qualityFlags: index === 0 ? ['BROKEN_LINK'] : [],
    query: 'must-not-leak',
    answer: { content: 'must-not-leak' },
    evidence: index === 0 ? [{
      factId: uuid(610_001),
      sourceRevisionId: uuid(610_002),
      fetchedAt: '2026-08-30T07:59:00.000Z',
      rawPayload: 'must-not-leak',
    }] : [],
    audit: {
      evidenceRevisions: index === 0 ? [{
        kind: 'KNOWLEDGE_SOURCE',
        evidenceId: uuid(610_001),
        revisionId: uuid(610_002),
        observedAt: '2026-08-30T07:59:00.000Z',
        rawPayload: 'must-not-leak',
      }] : [],
    },
  }));
  const providerReceiptsByRun = new Map(artifact.runs.map(({ runId }, index) => [runId, [{
    receiptType: 'AI',
    receiptId: uuid(620_000 + (index * 2) + 1),
    executionId: uuid(620_000 + (index * 2) + 2),
    attemptOrdinal: 1,
    provider: 'openai',
    operation: 'PLANNER',
    requestedModel: 'gpt-5.6-luna',
    actualModel: 'gpt-5.6-luna',
    status: 'SETTLED',
    outcome: 'ACCEPTED',
    errorCode: null,
    pricingStatus: 'PRICED',
    reservedCostUsd: '0.00000000',
    chargedCostUsd: '0.00000000',
    totalTokens: '50',
    webSearchCalls: 0,
    durationMs: 100,
    createdAt: '2026-08-30T07:59:59.000Z',
    settledAt: '2026-08-30T08:00:00.000Z',
    prompt: 'must-not-leak',
    rawPayload: 'must-not-leak',
  }]]));
  const summary = scoreAssistantEval(dataset, evaluation);
  const runnerReport = {
    runnerVersion: 'assistant-eval-runner-v1',
    passed: true,
    datasetVersion: dataset.version,
    datasetSha256: artifact.datasetSha256,
    evaluatorVersion: artifact.evaluatorVersion,
    evaluatedAt: artifact.evaluatedAt,
    caseCount: 200,
    completedRunCount: 200,
    modelRequestCount: 200,
    effectiveCostUsd: '0.00000000',
    providerMode: 'openai',
    runtimeConfigSha256: 'b'.repeat(64),
    releaseSha: '1'.repeat(40),
    releaseImageIdentity: `sha256:${'c'.repeat(64)}`,
    databaseFingerprint: 'a'.repeat(64),
    manifestRunMappingSha256: sha256(JSON.stringify(artifact.runs)),
    limits: validLimits(),
    cleanup: {
      persistenceClosed: true,
      credentialsScrubbed: true,
      persistedEvidenceRetained: true,
      runnerOwnedResources: [{
        type: 'DATABASE_CONNECTION',
        identifier: 'a'.repeat(64),
        disposition: 'CLOSED',
      }, {
        type: 'IN_MEMORY_CREDENTIALS',
        identifier: 'assistant-eval-auth',
        disposition: 'SCRUBBED',
      }],
      externalDisposableDatabase: {
        fingerprint: 'a'.repeat(64),
        owner: 'CALLER',
        disposition: 'RETAINED_FOR_EVALUATOR',
      },
    },
    accessToken: 'must-not-leak',
  };

  const bundle = createAssistantEvalEvidenceBundle({
    dataset,
    artifact,
    evaluation,
    summary,
    records,
    providerReceiptsByRun,
    runnerReport,
    databaseFingerprint: 'a'.repeat(64),
    generatedAt: evaluatedAt,
  });

  assert.deepEqual(Object.keys(bundle), [
    'schemaVersion',
    'generatedAt',
    'dataset',
    'evaluator',
    'runner',
    'verdict',
    'cases',
    'cleanup',
  ]);
  assert.equal(bundle.cases.length, 200);
  assert.equal(bundle.runner.datasetSha256, artifact.datasetSha256);
  assert.equal(bundle.runner.runtimeConfigSha256, 'b'.repeat(64));
  assert.equal(bundle.runner.releaseSha, '1'.repeat(40));
  assert.equal(bundle.runner.releaseImageIdentity, `sha256:${'c'.repeat(64)}`);
  assert.deepEqual(bundle.cases[0], {
    caseId: dataset.cases[0].id,
    runId: artifact.runs[0].runId,
    status: 'COMPLETED',
    createdAt: records[0].createdAt,
    completedAt: records[0].completedAt,
    provenance: {
      answerDigest: sha256('answer-000'),
      evidenceDigest: sha256('evidence-000'),
    },
    evidenceRevisions: [{
      kind: 'KNOWLEDGE_SOURCE',
      evidenceId: uuid(610_001),
      revisionId: uuid(610_002),
      observedAt: '2026-08-30T07:59:00.000Z',
    }],
    providerReceipts: [{
      receiptType: 'AI',
      receiptId: uuid(620_001),
      executionId: uuid(620_002),
      attemptOrdinal: 1,
      provider: 'openai',
      operation: 'PLANNER',
      requestedModel: 'gpt-5.6-luna',
      actualModel: 'gpt-5.6-luna',
      status: 'SETTLED',
      outcome: 'ACCEPTED',
      errorCodeDigest: null,
      pricingStatus: 'PRICED',
      reservedCostUsd: '0.00000000',
      chargedCostUsd: '0.00000000',
      totalTokens: '50',
      webSearchCalls: 0,
      durationMs: 100,
      createdAt: '2026-08-30T07:59:59.000Z',
      settledAt: '2026-08-30T08:00:00.000Z',
    }],
    quality: {
      passed: false,
      qualityScore: 0.75,
      qualityFlags: ['BROKEN_LINK'],
      violations: ['UNSUPPORTED_LINK'],
      latencyMs: 100,
      modelAttempts: 1,
      totalTokens: 50,
      geoProviderCalls: 0,
    },
  });
  assert.deepEqual(bundle.cleanup, runnerReport.cleanup);

  assert.throws(() => createAssistantEvalEvidenceBundle({
    dataset,
    artifact,
    evaluation,
    summary,
    records,
    providerReceiptsByRun,
    runnerReport,
    databaseFingerprint: 'b'.repeat(64),
    generatedAt: evaluatedAt,
  }), /ASSISTANT_EVAL_EVIDENCE_DATABASE_MISMATCH/u);
  assert.throws(() => createAssistantEvalEvidenceBundle({
    dataset,
    artifact,
    evaluation,
    summary,
    records,
    providerReceiptsByRun,
    runnerReport: { ...runnerReport, effectiveCostUsd: '0.00000001' },
    databaseFingerprint: 'a'.repeat(64),
    generatedAt: evaluatedAt,
  }), /ASSISTANT_EVAL_EVIDENCE_RUNNER_COST_MISMATCH/u);
  for (const missingField of [
    'runtimeConfigSha256',
    'releaseSha',
    'releaseImageIdentity',
  ]) {
    const legacyRunnerReport = { ...runnerReport };
    delete legacyRunnerReport[missingField];
    assert.throws(() => createAssistantEvalEvidenceBundle({
      dataset,
      artifact,
      evaluation,
      summary,
      records,
      providerReceiptsByRun,
      runnerReport: legacyRunnerReport,
      databaseFingerprint: 'a'.repeat(64),
      generatedAt: evaluatedAt,
    }), /ASSISTANT_EVAL_EVIDENCE_RUNNER_REPORT_INVALID/u);
  }

  const cleanupAttestation = {
    schemaVersion: 1,
    completedAt: '2026-08-30T08:01:00.000Z',
    evidenceCoreSha256: computeAssistantEvalEvidenceCoreSha256(bundle),
    databaseFingerprint: 'a'.repeat(64),
    ordinaryLocalResourcesPreserved: true,
    ownedResources: {
      databases: ['a'.repeat(64)],
      containers: ['platforma-eval-api'],
      networks: ['platforma-eval-network'],
      volumes: ['platforma-eval-data'],
      images: ['platforma-eval-api:local'],
    },
    removedResources: {
      databases: ['a'.repeat(64)],
      containers: ['platforma-eval-api'],
      networks: ['platforma-eval-network'],
      volumes: ['platforma-eval-data'],
      images: ['platforma-eval-api:local'],
    },
    residualResources: [],
  };
  const finalized = finalizeAssistantEvalEvidenceBundle(
    bundle,
    cleanupAttestation,
    new Date('2026-08-30T08:02:00.000Z'),
  );
  assert.equal(finalized.cleanup.phase, 'FINALIZED');
  assert.equal(finalized.cleanup.external.ordinaryLocalResourcesPreserved, true);
  assert.deepEqual(finalized.cleanup.external.residualResources, []);
  const validatedFinal = readAssistantEvalFinalizedEvidenceBundle(
    finalized,
    dataset,
    new Date('2026-08-30T08:02:00.000Z'),
  );
  assert.equal(validatedFinal.verdict.passed, summary.passed);
  assert.equal(validatedFinal.runner.runtimeConfigSha256, 'b'.repeat(64));
  assert.equal(validatedFinal.runner.releaseSha, '1'.repeat(40));
  assert.equal(validatedFinal.evidenceCoreSha256, cleanupAttestation.evidenceCoreSha256);
  assert.equal(
    validatedFinal.finalizedEvidenceSha256,
    computeAssistantEvalFinalizedEvidenceSha256(finalized),
  );
  assert.notEqual(validatedFinal.finalizedEvidenceSha256, validatedFinal.evidenceCoreSha256);
  assert.throws(() => readAssistantEvalFinalizedEvidenceBundle(
    bundle,
    dataset,
    new Date('2026-08-30T08:02:00.000Z'),
  ), /ASSISTANT_EVAL_FINAL_EVIDENCE_INVALID/u);
  assert.throws(() => finalizeAssistantEvalEvidenceBundle(bundle, {
    ...cleanupAttestation,
    residualResources: ['platforma-eval-api'],
  }, new Date('2026-08-30T08:02:00.000Z')), /ASSISTANT_EVAL_CLEANUP_ATTESTATION_INVALID/u);
  const serialized = JSON.stringify(bundle);
  for (const privateValue of ['must-not-leak', 'rawPayload', '"query":', '"answer":', '"evidence":']) {
    assert.equal(serialized.includes(privateValue), false, privateValue);
  }
  assert.throws(() => createAssistantEvalEvidenceBundle({
    dataset,
    artifact,
    evaluation,
    summary,
    records,
    providerReceiptsByRun,
    runnerReport: { ...runnerReport, datasetSha256: 'wrong-sha' },
    databaseFingerprint: 'a'.repeat(64),
    generatedAt: evaluatedAt,
  }), /ASSISTANT_EVAL_EVIDENCE_RUNNER_REPORT_INVALID/u);

  const missingReceipts = new Map(providerReceiptsByRun);
  missingReceipts.delete(artifact.runs.at(-1).runId);
  assert.throws(() => createAssistantEvalEvidenceBundle({
    dataset,
    artifact,
    evaluation,
    summary,
    records,
    providerReceiptsByRun: missingReceipts,
    runnerReport,
    databaseFingerprint: 'a'.repeat(64),
    generatedAt: evaluatedAt,
  }), /ASSISTANT_EVAL_EVIDENCE_INCOMPLETE/u);

  const taintedReceipts = new Map(providerReceiptsByRun);
  taintedReceipts.set(artifact.runs[0].runId, [{
    ...providerReceiptsByRun.get(artifact.runs[0].runId)[0],
    errorCode: 'must-not-leak',
  }]);
  assert.throws(() => createAssistantEvalEvidenceBundle({
    dataset,
    artifact,
    evaluation,
    summary,
    records,
    providerReceiptsByRun: taintedReceipts,
    runnerReport,
    databaseFingerprint: 'a'.repeat(64),
    generatedAt: evaluatedAt,
  }), /ASSISTANT_EVAL_EVIDENCE_RECEIPT_INVALID/u);

  const secretCodeReceipts = new Map(providerReceiptsByRun);
  secretCodeReceipts.set(artifact.runs[0].runId, [{
    ...providerReceiptsByRun.get(artifact.runs[0].runId)[0],
    outcome: 'PROVIDER_ERROR',
    actualModel: null,
    totalTokens: null,
    errorCode: 'ASSISTANT_SECRET_MUST_NOT_LEAK',
  }]);
  const secretCodeBundle = createAssistantEvalEvidenceBundle({
    dataset,
    artifact,
    evaluation,
    summary,
    records,
    providerReceiptsByRun: secretCodeReceipts,
    runnerReport,
    databaseFingerprint: 'a'.repeat(64),
    generatedAt: evaluatedAt,
  });
  assert.equal(
    secretCodeBundle.cases[0].providerReceipts[0].errorCodeDigest,
    sha256('ASSISTANT_SECRET_MUST_NOT_LEAK'),
  );
  assert.equal(JSON.stringify(secretCodeBundle).includes('ASSISTANT_SECRET_MUST_NOT_LEAK'), false);

  const incompleteGeoEvaluation = structuredClone(evaluation);
  incompleteGeoEvaluation.results[0].geoProviderCalls = 2;
  const incompleteGeoReceipts = new Map(providerReceiptsByRun);
  incompleteGeoReceipts.set(artifact.runs[0].runId, [
    providerReceiptsByRun.get(artifact.runs[0].runId)[0],
    {
      receiptType: 'GEO_OPERATION',
      operationId: uuid(625_001),
      provider: 'locationiq',
      status: 'RESOLVED',
      errorCode: null,
      durationMs: 80,
      cacheHit: false,
      providerCallCount: 2,
      createdAt: '2026-08-30T07:59:58.000Z',
    },
    {
      receiptType: 'GEO',
      receiptId: uuid(625_002),
      operationId: uuid(625_001),
      attemptOrdinal: 1,
      provider: 'locationiq',
      status: 'SETTLED',
      outcome: 'SUCCESS',
      errorCode: null,
      durationMs: 80,
      cacheHit: false,
      providerCallCount: 2,
      createdAt: '2026-08-30T07:59:58.000Z',
      settledAt: '2026-08-30T07:59:58.080Z',
    },
  ]);
  assert.throws(() => createAssistantEvalEvidenceBundle({
    dataset,
    artifact,
    evaluation: incompleteGeoEvaluation,
    summary: scoreAssistantEval(dataset, incompleteGeoEvaluation),
    records,
    providerReceiptsByRun: incompleteGeoReceipts,
    runnerReport,
    databaseFingerprint: 'a'.repeat(64),
    generatedAt: evaluatedAt,
  }), /ASSISTANT_EVAL_EVIDENCE_RECEIPTS_INCOMPLETE/u);

  const mismatchedRecords = structuredClone(records);
  mismatchedRecords[0].audit.evidenceRevisions[0].revisionId = uuid(610_099);
  assert.throws(() => createAssistantEvalEvidenceBundle({
    dataset,
    artifact,
    evaluation,
    summary,
    records: mismatchedRecords,
    providerReceiptsByRun,
    runnerReport,
    databaseFingerprint: 'a'.repeat(64),
    generatedAt: evaluatedAt,
  }), /ASSISTANT_EVAL_EVIDENCE_REVISIONS_INVALID/u);

  assert.throws(() => createAssistantEvalEvidenceBundle({
    dataset,
    artifact,
    evaluation,
    summary,
    records,
    providerReceiptsByRun,
    runnerReport: { ...runnerReport, manifestRunMappingSha256: 'b'.repeat(64) },
    databaseFingerprint: 'a'.repeat(64),
    generatedAt: evaluatedAt,
  }), /ASSISTANT_EVAL_EVIDENCE_RUNNER_REPORT_INVALID/u);
  assert.throws(() => createAssistantEvalEvidenceBundle({
    dataset,
    artifact,
    evaluation,
    summary,
    records,
    providerReceiptsByRun,
    runnerReport: {
      ...runnerReport,
      cleanup: { ...runnerReport.cleanup, persistenceClosed: false },
    },
    databaseFingerprint: 'a'.repeat(64),
    generatedAt: evaluatedAt,
  }), /ASSISTANT_EVAL_EVIDENCE_CLEANUP_INVALID/u);
});

test('ZAEBAL6 evidence receipt loader assigns safe AI and geo attempts to their exact eval runs', async () => {
  const {
    loadAssistantEvalProviderReceipts,
  } = require('../scripts/assistant-eval-runtime.cjs');
  const runs = [
    {
      id: uuid(630_001),
      ownerUserId: actorId,
      createdAt: '2026-08-30T08:00:10.000Z',
      completedAt: '2026-08-30T08:00:15.000Z',
      query: 'Покажи все доступные квартиры',
      geoContext: null,
    },
    {
      id: uuid(630_002),
      ownerUserId: actorId,
      createdAt: '2026-08-30T08:00:20.000Z',
      completedAt: '2026-08-30T08:00:25.000Z',
      query: 'Найди квартиры рядом с Белорусским вокзалом',
      geoContext: { kind: 'POINT', mode: 'NEAR' },
    },
  ];
  const prisma = {
    assistantAiUsageAttempt: {
      async findMany() {
        return [{
          id: uuid(640_001),
          operationRunId: runs[0].id,
          executionId: uuid(640_002),
          attemptOrdinal: 1,
          operation: 'PLANNER',
          provider: 'openai',
          requestedModel: 'fake-model',
          actualModel: 'fake-model',
          status: 'SETTLED',
          outcome: 'ACCEPTED',
          errorCode: null,
          pricingStatus: 'PRICED',
          reservedCostUsd: decimal('0.01000000'),
          chargedCostUsd: decimal('0.00900000'),
          totalTokens: 50n,
          webSearchCalls: 0,
          durationMs: 120,
          createdAt: new Date('2026-08-30T08:00:11.000Z'),
          settledAt: new Date('2026-08-30T08:00:12.000Z'),
        }];
      },
    },
    assistantGeoOperation: {
      async findMany() {
        return [{
          id: uuid(650_001),
          actorUserId: actorId,
          normalizedQuery: 'белорусский вокзал',
          provider: 'locationiq',
          status: 'RESOLVED',
          durationMs: 80,
          cacheHit: false,
          providerCallCount: 1,
          errorCode: null,
          createdAt: new Date('2026-08-30T08:00:19.000Z'),
          usageAttempts: [{
            id: uuid(650_002),
            attemptOrdinal: 1,
            provider: 'locationiq',
            status: 'SETTLED',
            outcome: 'RESOLVED',
            errorCode: null,
            durationMs: 80,
            createdAt: new Date('2026-08-30T08:00:19.000Z'),
            settledAt: new Date('2026-08-30T08:00:19.080Z'),
          }],
        }];
      },
    },
  };

  const receipts = await loadAssistantEvalProviderReceipts(
    prisma,
    runs,
    new Date('2026-08-30T08:01:00.000Z'),
  );

  assert.deepEqual(receipts.get(runs[0].id), [{
    receiptType: 'AI',
    receiptId: uuid(640_001),
    executionId: uuid(640_002),
    attemptOrdinal: 1,
    provider: 'openai',
    operation: 'PLANNER',
    requestedModel: 'fake-model',
    actualModel: 'fake-model',
    status: 'SETTLED',
    outcome: 'ACCEPTED',
    errorCode: null,
    pricingStatus: 'PRICED',
    reservedCostUsd: '0.01000000',
    chargedCostUsd: '0.00900000',
    totalTokens: '50',
    webSearchCalls: 0,
    durationMs: 120,
    createdAt: '2026-08-30T08:00:11.000Z',
    settledAt: '2026-08-30T08:00:12.000Z',
  }]);
  assert.deepEqual(receipts.get(runs[1].id), [{
    receiptType: 'GEO_OPERATION',
    operationId: uuid(650_001),
    provider: 'locationiq',
    status: 'RESOLVED',
    errorCode: null,
    durationMs: 80,
    cacheHit: false,
    providerCallCount: 1,
    createdAt: '2026-08-30T08:00:19.000Z',
  }, {
    receiptType: 'GEO',
    receiptId: uuid(650_002),
    operationId: uuid(650_001),
    attemptOrdinal: 1,
    provider: 'locationiq',
    status: 'SETTLED',
    outcome: 'RESOLVED',
    errorCode: null,
    durationMs: 80,
    cacheHit: false,
    providerCallCount: 1,
    createdAt: '2026-08-30T08:00:19.000Z',
    settledAt: '2026-08-30T08:00:19.080Z',
  }]);
});

function loadRunner() {
  return require('../scripts/assistant-eval-runner.cjs');
}

function successfulBoundaries(options = {}) {
  const events = options.events ?? [];
  const createKeys = options.createKeys ?? new Map();
  const messageKeys = options.messageKeys ?? new Map();
  const product = {
    async getActor() { return { id: actorId }; },
    async checkConfig() { return { enabled: true }; },
    async checkEvalRuntime() { return fakeRuntimeContract(); },
    async resolveGeo({ evalCase }) {
      events.push(`resolve:${evalCase.id}`);
      return options.resolveGeo?.(evalCase) ?? { status: 'NOT_APPLICABLE' };
    },
    async createConversation({ evalCase, idempotencyKey }) {
      events.push(`create:${evalCase.id}`);
      createKeys.set(evalCase.id, idempotencyKey);
      return { conversationId: conversationIdForCase(evalCase.id) };
    },
    async startRun({ evalCase, idempotencyKey, body }) {
      events.push(`message:${evalCase.id}:${JSON.stringify(body)}`);
      messageKeys.set(evalCase.id, idempotencyKey);
      return { runId: runIdForCase(evalCase.id), status: 'PENDING' };
    },
    async getRun({ evalCase, runId }) {
      events.push(`terminal:${evalCase.id}`);
      return { runId, status: 'COMPLETED', errorCode: null };
    },
    scrubAuth() {},
  };
  const persistence = {
    async getDatabaseFingerprint() { return 'a'.repeat(64); },
    async recoverConversation() { return null; },
    async recoverRun() { return null; },
    async inspectRuns({ evalCase, runIds }) {
      events.push(`inspect:${evalCase.id}`);
      return {
        runs: runIds.map((id) => ({ id, status: 'COMPLETED', qualityFlags: [] })),
        modelRequestCount: runIds.length,
        effectiveCostUsd: '0.00000000',
        criticalViolations: [],
      };
    },
    async close() { events.push('close'); },
  };
  return { product, persistence };
}

function validLimits() {
  return {
    requestsPerMinute: 1_000,
    dailyRequestCap: 1_000,
    maximumCostUsd: '1.00000000',
  };
}

function fakeRuntimeContract() {
  return {
    version: 'assistant-eval-runtime-v2',
    databaseFingerprint: 'a'.repeat(64),
    runtimeConfigSha256: 'b'.repeat(64),
    releaseIdentity: {
      releaseSha: '1'.repeat(40),
      releaseImageIdentity: null,
    },
    provider: {
      readinessPassed: true,
      missing: [],
      aiMode: 'fake',
      requestsPerMinute: 1,
      requestsPerDay: 1,
      dailyBudgetUsd: null,
      queryPlannerLive: false,
      paidCallsConfirmed: false,
      apiKeyPresent: false,
    },
    runtime: {
      nodeEnvironment: 'test',
      deploymentEnvironment: 'local',
      geoProviderEnabled: false,
      externalConnectorsEnabled: false,
      currentFactRefreshMode: 'fixture',
      sourceDiscoveryLive: false,
      embeddingMode: 'fake',
      embeddingLive: false,
      openAiBaseUrlOfficial: true,
    },
  };
}

function retryableError() {
  return Object.assign(new Error('ASSISTANT_EVAL_API_RESPONSE_LOST'), { retryable: true });
}

function sequentialUuidFactory(start) {
  let value = start;
  return () => uuid(value++);
}

function sequentialDateFactory(values) {
  let index = 0;
  return () => new Date(values[Math.min(index++, values.length - 1)]);
}

function conversationIdForCase(caseId) {
  return uuid(300_000 + dataset.cases.findIndex(({ id }) => id === caseId) + 1);
}

function runIdForCase(caseId) {
  return uuid(400_000 + dataset.cases.findIndex(({ id }) => id === caseId) + 1);
}

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}

function decimal(value) {
  return { toFixed: () => value };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
