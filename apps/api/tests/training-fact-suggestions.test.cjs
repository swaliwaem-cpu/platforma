const assert = require('node:assert/strict');
const test = require('node:test');
const { BadRequestException, ConflictException } = require('@nestjs/common');

const {
  buildTrainingFactSuggestionChunks,
} = require('../dist/training/fact-suggestions/training-fact-suggestion.chunking.js');
const {
  DeterministicFakeTrainingFactSuggestionProvider,
  OpenAiTrainingFactSuggestionProvider,
  TRAINING_FACT_SUGGESTION_JSON_SCHEMA,
  validateFactSuggestionOutput,
} = require('../dist/training/fact-suggestions/training-fact-suggestion.provider.js');
const {
  resolveFactSuggestionRunStatus,
  resolveStaleFactSuggestionRecovery,
  TrainingFactSuggestionWorkerService,
} = require('../dist/training/fact-suggestions/training-fact-suggestion-worker.service.js');
const {
  TrainingOpenAiHttpClient,
} = require('../dist/training/openai/training-openai.http.js');
const {
  Prisma,
  TrainingFactSuggestionRunStatus,
  TrainingJobStatus,
  TrainingProviderRunStatus,
} = require('@prisma/client');
const {
  TrainingFactSuggestionsService,
} = require('../dist/training/fact-suggestions/training-fact-suggestions.service.js');

const sourceId = '11111111-1111-4111-8111-111111111111';

function createInput() {
  return {
    runId: 'run-1',
    chunkId: 'chunk-1',
    segments: [
      {
        id: `${sourceId}:1:1`,
        sourceId,
        locator: { page: 3 },
        text: 'Девелопером проекта является компания TATE Development.',
      },
    ],
    existingFacts: [],
  };
}

test('fact suggestion schema is strict and does not allow approval or scoring fields', () => {
  assert.equal(TRAINING_FACT_SUGGESTION_JSON_SCHEMA.additionalProperties, false);
  assert.equal(
    TRAINING_FACT_SUGGESTION_JSON_SCHEMA.properties.facts.items
      .additionalProperties,
    false,
  );
  const fields =
    TRAINING_FACT_SUGGESTION_JSON_SCHEMA.properties.facts.items.properties;
  assert.equal('is_approved' in fields, false);
  assert.equal('score' in fields, false);
  assert.equal('question_ids' in fields, false);
});

test('validator resolves locator server-side and requires an exact source quote', () => {
  const input = createInput();
  const output = {
    schema_version: 'training-fact-suggestions-v1',
    facts: [
      {
        suggested_code: 'identity.developer',
        topic_code: 'identity',
        statement: 'Девелопером проекта является TATE Development.',
        accepted_aliases: ['TATE Development'],
        importance: 1,
        source_segment_id: input.segments[0].id,
        source_quote:
          'Девелопером проекта является компания TATE Development.',
      },
    ],
  };

  const result = validateFactSuggestionOutput(input, output);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].sourceLocator, { page: 3 });
  assert.equal(result[0].sourceId, sourceId);
  assert.equal(result[0].statementHash.length, 64);

  assert.throws(
    () =>
      validateFactSuggestionOutput(input, {
        ...output,
        facts: [
          {
            ...output.facts[0],
            source_quote: 'Этой цитаты нет в материале.',
          },
        ],
      }),
    /exact source substring/u,
  );
});

test('validator rejects unknown fields and segment identifiers', () => {
  const input = createInput();
  const base = {
    suggested_code: 'identity.developer',
    topic_code: 'identity',
    statement: 'Девелопером проекта является TATE Development.',
    accepted_aliases: [],
    importance: 1,
    source_segment_id: input.segments[0].id,
    source_quote: 'TATE Development',
  };

  assert.throws(
    () =>
      validateFactSuggestionOutput(input, {
        schema_version: 'training-fact-suggestions-v1',
        facts: [{ ...base, is_approved: true }],
      }),
    /unexpected fields/u,
  );
  assert.throws(
    () =>
      validateFactSuggestionOutput(input, {
        schema_version: 'training-fact-suggestions-v1',
        facts: [{ ...base, source_segment_id: 'invented' }],
      }),
    /unknown source segment/u,
  );
});

test('validator marks exact and safe containment duplicates for administrator review', () => {
  const input = createInput();
  input.existingFacts = [
    {
      id: '22222222-2222-4222-8222-222222222222',
      code: 'identity.developer',
      statement: 'Девелопером проекта является TATE Development.',
      acceptedAliases: [],
    },
  ];
  const result = validateFactSuggestionOutput(input, {
    schema_version: 'training-fact-suggestions-v1',
    facts: [
      {
        suggested_code: 'identity.developer.new',
        topic_code: 'identity',
        statement: 'Девелопером проекта является TATE Development.',
        accepted_aliases: [],
        importance: 1,
        source_segment_id: input.segments[0].id,
        source_quote: 'TATE Development',
      },
    ],
  });

  assert.equal(
    result[0].duplicateOfFactId,
    '22222222-2222-4222-8222-222222222222',
  );
});

test('chunking uses extraction locators, bounds chunks and creates a text-sensitive hash', () => {
  const text = `${'A'.repeat(1_500)}\n\n${'B'.repeat(1_500)}`;
  const first = buildTrainingFactSuggestionChunks(
    [
      {
        id: sourceId,
        checksum: 'file-checksum',
        extractedText: text,
        extractionMetadata: {
          segments: [
            { locator: { page: 1 }, start: 0, end: 1_500 },
            { locator: { page: 2 }, start: 1_502, end: text.length },
          ],
        },
      },
    ],
    2_000,
  );

  assert.equal(first.chunks.length, 2);
  assert.deepEqual(first.chunks[0].segments[0].locator, { page: 1 });
  assert.deepEqual(first.chunks[1].segments[0].locator, { page: 2 });
  assert.ok(
    first.chunks.every(
      (chunk) =>
        chunk.segments.reduce((sum, segment) => sum + segment.text.length, 0) <=
        2_000,
    ),
  );

  const changed = buildTrainingFactSuggestionChunks(
    [
      {
        id: sourceId,
        checksum: 'file-checksum',
        extractedText: `${text}!`,
        extractionMetadata: { segments: [] },
      },
    ],
    2_000,
  );
  assert.notEqual(first.inputHash, changed.inputHash);
});

test('manual text without extraction segments receives a synthetic locator', () => {
  const result = buildTrainingFactSuggestionChunks([
    {
      id: sourceId,
      checksum: 'manual',
      extractedText: 'Проверенный администратором текст.',
      extractionMetadata: { source: 'admin_manual', segments: [] },
    },
  ]);

  assert.deepEqual(result.chunks[0].segments[0].locator, {
    section: 'Внесённый текст',
    paragraph: 1,
  });
});

test('fake provider is deterministic and requires explicit source markers', async () => {
  const provider = new DeterministicFakeTrainingFactSuggestionProvider();
  const input = createInput();
  input.segments[0].text =
    '[[fact|identity.developer|identity|2|TATE Development является девелопером проекта|девелопер TATE]]';

  const result = await provider.suggest(input);
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].suggestedCode, 'identity.developer');
  assert.deepEqual(result.suggestions[0].acceptedAliases, ['девелопер TATE']);
  assert.equal(result.requestedModelId, 'fake-fact-suggestion-v1');
});

test('real provider request is structured, stateless and has no tool access', async () => {
  let requestUrl = '';
  let requestBody = null;
  const config = {
    apiKey: 'not-a-real-key',
    reviewModel: 'review-model',
    reviewReasoning: 'high',
    evaluationTimeoutMs: 10_000,
    evaluationMaxRetries: 0,
    evaluationMaxOutputTokens: 1_000,
    maxResponseBytes: 100_000,
  };
  const http = new TrainingOpenAiHttpClient(config, {
    baseUrl: 'https://openai.invalid',
    fetchImpl: async (url, init) => {
      requestUrl = String(url);
      requestBody = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          status: 'completed',
          model: 'review-model',
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    schema_version: 'training-fact-suggestions-v1',
                    facts: [],
                  }),
                },
              ],
            },
          ],
          usage: {},
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-request-id': 'req_fake',
          },
        },
      );
    },
  });
  const provider = new OpenAiTrainingFactSuggestionProvider(config, http);

  const result = await provider.suggest(createInput());

  assert.equal(requestUrl, 'https://openai.invalid/v1/responses');
  assert.equal(requestBody.store, false);
  assert.equal('tools' in requestBody, false);
  assert.equal(requestBody.text.format.strict, true);
  assert.equal(
    requestBody.text.format.schema.additionalProperties,
    false,
  );
  assert.equal(result.requestId, 'req_fake');
  assert.deepEqual(result.suggestions, []);
});

test('run status reducer distinguishes ready, partial and ambiguous outcomes', () => {
  assert.equal(
    resolveFactSuggestionRunStatus([
      TrainingProviderRunStatus.SUCCEEDED,
      TrainingProviderRunStatus.SUCCEEDED,
    ]),
    TrainingFactSuggestionRunStatus.READY,
  );
  assert.equal(
    resolveFactSuggestionRunStatus([
      TrainingProviderRunStatus.SUCCEEDED,
      TrainingProviderRunStatus.FAILED,
    ]),
    TrainingFactSuggestionRunStatus.PARTIAL,
  );
  assert.equal(
    resolveFactSuggestionRunStatus([
      TrainingProviderRunStatus.AMBIGUOUS,
      TrainingProviderRunStatus.AMBIGUOUS,
    ]),
    TrainingFactSuggestionRunStatus.AMBIGUOUS,
  );
  assert.equal(
    resolveFactSuggestionRunStatus([
      TrainingProviderRunStatus.REQUESTING,
      TrainingProviderRunStatus.PENDING,
    ]),
    TrainingFactSuggestionRunStatus.RUNNING,
  );
});

test('accepting a suggestion maps a duplicate fact code to an explicit 409 conflict', async () => {
  const prismaError = new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed',
    {
      code: 'P2002',
      clientVersion: '6.19.3',
      meta: {
        modelName: 'TrainingFact',
        target: ['project_version_id', 'code'],
      },
    },
  );
  const service = new TrainingFactSuggestionsService(
    {
      $transaction: async () => {
        throw prismaError;
      },
    },
    {},
  );

  await assert.rejects(
    () =>
      service.acceptSuggestion(
        '33333333-3333-4333-8333-333333333333',
        '44444444-4444-4444-8444-444444444444',
        {
          code: 'identity.developer',
          topicCode: 'identity',
          statement: 'Девелопером проекта является TATE Development.',
          acceptedAliases: [],
          importance: 1,
          questionIds: ['66666666-6666-4666-8666-666666666666'],
        },
        { id: '55555555-5555-4555-8555-555555555555' },
        { headers: {} },
      ),
    (error) => {
      assert.ok(error instanceof ConflictException);
      assert.equal(error.getStatus(), 409);
      assert.match(error.message, /Факт с таким кодом уже существует/u);
      return true;
    },
  );
});

test('accepting a suggestion requires at least one linked question', async () => {
  const service = new TrainingFactSuggestionsService(
    {
      $transaction: async () => {
        throw new Error('transaction must not start');
      },
    },
    {},
  );

  await assert.rejects(
    () =>
      service.acceptSuggestion(
        '33333333-3333-4333-8333-333333333333',
        '44444444-4444-4444-8444-444444444444',
        {
          code: 'identity.developer',
          topicCode: 'identity',
          statement: 'Девелопером проекта является TATE Development.',
          acceptedAliases: [],
          importance: 1,
          questionIds: [],
        },
        { id: '55555555-5555-4555-8555-555555555555' },
        { headers: {} },
      ),
    (error) => {
      assert.ok(error instanceof BadRequestException);
      assert.equal(error.getStatus(), 400);
      assert.match(error.message, /минимум с одним вопросом/u);
      return true;
    },
  );
});

test('a new run is blocked while any older suggestion is still pending', async () => {
  const service = new TrainingFactSuggestionsService(
    {
      trainingFactSuggestionRun: {
        findUnique: async () => null,
        count: async () => 0,
      },
      trainingProjectVersion: {
        findUnique: async () => ({ status: 'DRAFT' }),
      },
      trainingFactSuggestion: {
        count: async () => 1,
      },
      trainingFactSuggestionProviderRun: {
        count: async () => 0,
      },
      $queryRaw: async () => [{ count: 0n }],
    },
    { providerMode: 'fake' },
  );

  await assert.rejects(
    () =>
      service.createRun(
        '33333333-3333-4333-8333-333333333333',
        {
          sourceIds: [
            {
              kind: 'DOCUMENT',
              id: '11111111-1111-4111-8111-111111111111',
            },
          ],
        },
        { id: '55555555-5555-4555-8555-555555555555' },
        { headers: {} },
        'pending-run-block-1',
      ),
    (error) => {
      assert.ok(error instanceof ConflictException);
      assert.equal(error.getStatus(), 409);
      assert.match(error.message, /обработайте все предложенные факты/u);
      return true;
    },
  );
});

test('a new run is blocked while an older fact-suggestion job is active', async () => {
  const service = new TrainingFactSuggestionsService(
    {
      trainingFactSuggestionRun: {
        findUnique: async () => null,
        count: async () => 0,
      },
      trainingProjectVersion: {
        findUnique: async () => ({ status: 'DRAFT' }),
      },
      trainingFactSuggestion: {
        count: async () => 0,
      },
      trainingFactSuggestionProviderRun: {
        count: async () => 0,
      },
      $queryRaw: async () => [{ count: 1n }],
    },
    { providerMode: 'fake' },
  );

  await assert.rejects(
    () =>
      service.createRun(
        '33333333-3333-4333-8333-333333333333',
        {
          sourceIds: [
            {
              kind: 'DOCUMENT',
              id: '11111111-1111-4111-8111-111111111111',
            },
          ],
        },
        { id: '55555555-5555-4555-8555-555555555555' },
        { headers: {} },
        'active-job-block-1',
      ),
    (error) => {
      assert.ok(error instanceof ConflictException);
      assert.equal(error.getStatus(), 409);
      assert.match(error.message, /завершения текущего анализа/u);
      return true;
    },
  );
});

test('suggestion listing keeps pending items from every run resolvable', async () => {
  const rows = ['run-old', 'run-new'].map((runId, index) => ({
    id: `suggestion-${index + 1}`,
    suggestionRunId: runId,
    status: 'PENDING',
    suggestedCode: `fact.${index + 1}`,
    topicCode: 'fact',
    statement: `Факт ${index + 1}`,
    acceptedAliasesJson: [],
    importance: 1,
    sourceLocatorJson: { page: index + 1 },
    sourceQuote: `Факт ${index + 1}`,
    acceptedFactId: null,
    reviewComment: null,
    providerRun: {
      sourceDocumentId: sourceId,
      sourceOfficialUrlId: null,
    },
  }));
  const service = new TrainingFactSuggestionsService(
    {
      trainingProjectVersion: {
        findUnique: async () => ({ id: 'version-1' }),
      },
      trainingFactSuggestion: {
        findMany: async () => rows,
      },
    },
    {},
  );

  const response = await service.listSuggestions(
    '33333333-3333-4333-8333-333333333333',
  );

  assert.deepEqual(
    response.items.map((item) => item.runId),
    ['run-old', 'run-new'],
  );
  assert.equal(
    response.items.filter((item) => item.status === 'PENDING').length,
    2,
  );
});

test('two workers honor one lease owner and the old owner stays fenced out', async () => {
  const state = {
    status: TrainingJobStatus.RUNNING,
    lockOwner: 'worker-a',
    attempts: 1,
  };
  const prisma = {
    trainingJob: {
      updateMany: async ({ where, data }) => {
        const matches =
          where.id === 'job-1' &&
          where.status === state.status &&
          where.lockOwner === state.lockOwner &&
          where.attempts === state.attempts;
        if (!matches) return { count: 0 };
        if (data.heartbeatAt) state.heartbeatAt = data.heartbeatAt;
        return { count: 1 };
      },
    },
  };
  const provider = { suggest: async () => ({ suggestions: [] }) };
  const workerA = new TrainingFactSuggestionWorkerService(
    prisma,
    provider,
    undefined,
    undefined,
    {
      workerId: 'worker-a',
      leaseMs: 1_000,
      heartbeatMs: 100,
    },
  );
  const workerB = new TrainingFactSuggestionWorkerService(
    prisma,
    provider,
    undefined,
    undefined,
    {
      workerId: 'worker-b',
      leaseMs: 1_000,
      heartbeatMs: 100,
    },
  );

  assert.equal(await workerA.refreshOwnership('job-1', 1), true);
  state.lockOwner = 'worker-b';
  assert.equal(await workerA.refreshOwnership('job-1', 1), false);
  assert.equal(await workerB.refreshOwnership('job-1', 1), true);
  assert.equal(await workerA.refreshOwnership('job-1', 1), false);
});

test('stale REQUESTING is ambiguous and never automatically billable again', () => {
  assert.equal(
    resolveStaleFactSuggestionRecovery(
      TrainingProviderRunStatus.REQUESTING,
      1,
      3,
    ),
    'AMBIGUOUS',
  );
  assert.equal(
    resolveStaleFactSuggestionRecovery(
      TrainingProviderRunStatus.PENDING,
      1,
      3,
    ),
    'RETRY_PENDING',
  );
  assert.equal(
    resolveStaleFactSuggestionRecovery(
      TrainingProviderRunStatus.PENDING,
      3,
      3,
    ),
    'DEAD',
  );
});

test('provider result obtained after lease loss cannot create suggestions', async () => {
  let createCalls = 0;
  const worker = new TrainingFactSuggestionWorkerService(
    {},
    {},
    undefined,
    undefined,
    {
      workerId: 'old-worker',
      leaseMs: 1_000,
      heartbeatMs: 100,
    },
  );
  worker.runSerializable = async (operation) =>
    operation({
      trainingFactSuggestion: {
        createMany: async () => {
          createCalls += 1;
        },
      },
    });
  worker.lockGenerationContext = async () => ({
    valid: true,
    projectVersionId: '33333333-3333-4333-8333-333333333333',
    sourceContentHash: 'a'.repeat(64),
  });
  worker.assertOwnedJob = async () => {
    throw new Error('lost lease');
  };

  await assert.rejects(() =>
    worker.persistProviderResult(
      {
        id: 'job-1',
        payloadJson: {},
        attempts: 1,
        maxAttempts: 3,
      },
      'provider-1',
      'run-1',
      {
        requestedModelId: 'fake',
        actualModelId: 'fake',
        reasoningEffort: null,
        requestId: 'request-1',
        latencyMs: 0,
        retryCount: 0,
        responseStatus: 'completed',
        suggestions: [
          {
            suggestedCode: 'fact.one',
            topicCode: 'fact',
            statement: 'Факт',
            acceptedAliases: [],
            importance: 1,
            sourceId,
            sourceSegmentId: `${sourceId}:1:1`,
            sourceLocator: { page: 1 },
            sourceQuote: 'Факт',
            statementHash: 'b'.repeat(64),
            duplicateOfFactId: null,
          },
        ],
      },
    ),
  );
  assert.equal(createCalls, 0);
});

test('lost lease before provider request makes zero billable calls', async () => {
  let providerCalls = 0;
  const worker = new TrainingFactSuggestionWorkerService(
    {
      trainingJob: {
        updateMany: async () => ({ count: 0 }),
      },
    },
    {
      suggest: async () => {
        providerCalls += 1;
      },
    },
    undefined,
    undefined,
    {
      workerId: 'lost-before-provider',
      leaseMs: 1_000,
      heartbeatMs: 100,
    },
  );

  await worker.processClaimed({
    id: 'job-1',
    payloadJson: {
      suggestionRunId: 'run-1',
      providerRunId: 'provider-1',
    },
    attempts: 1,
    maxAttempts: 3,
  });

  assert.equal(providerCalls, 0);
});

test('provider rejection after lease loss cannot mutate provider or run state', async () => {
  let providerMutations = 0;
  const worker = new TrainingFactSuggestionWorkerService(
    {},
    {},
    undefined,
    undefined,
    {
      workerId: 'lost-provider-failure',
      leaseMs: 1_000,
      heartbeatMs: 100,
    },
  );
  worker.runSerializable = async (operation) =>
    operation({
      trainingFactSuggestionProviderRun: {
        updateMany: async () => {
          providerMutations += 1;
          return { count: 1 };
        },
      },
    });
  worker.lockVersionForProviderRun = async () => ({ status: 'DRAFT' });
  worker.lockRunAndProvider = async () => {};
  worker.assertOwnedJob = async () => {
    throw new Error('lost lease');
  };

  await assert.rejects(() =>
    worker.recordProviderFailure(
      {
        id: 'job-1',
        payloadJson: {},
        attempts: 1,
        maxAttempts: 3,
      },
      'provider-1',
      'run-1',
      new Error('provider rejected'),
    ),
  );
  assert.equal(providerMutations, 0);
});

test('shutdown is bounded when drain and lease release are both blocked', async () => {
  const worker = new TrainingFactSuggestionWorkerService(
    {},
    {},
    undefined,
    undefined,
    {
      workerId: 'shutdown-worker',
      leaseMs: 1_000,
      heartbeatMs: 100,
      drainTimeoutMs: 100,
    },
  );
  worker.drainPromise = new Promise(() => {});
  worker.releaseOwnedJobsAfterShutdown = async () => new Promise(() => {});
  const startedAt = Date.now();

  await worker.onModuleDestroy();

  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs >= 180, `shutdown was unexpectedly early: ${elapsedMs}`);
  assert.ok(elapsedMs < 600, `shutdown was not bounded: ${elapsedMs}`);
});
