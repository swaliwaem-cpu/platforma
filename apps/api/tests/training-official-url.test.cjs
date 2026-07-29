const assert = require('node:assert/strict');
const test = require('node:test');

const {
  TrainingOfficialUrlFetchError,
  TrainingOfficialUrlFetcher,
  normalizeOfficialHostname,
  normalizeOfficialUrl,
} = require('../dist/training/training-official-url-fetcher.js');
const {
  extractTrainingOfficialUrlText,
} = require('../dist/training/training-official-url-extractor.js');
const {
  TRAINING_MAX_OFFICIAL_URL_SOURCES_PER_VERSION,
  TrainingOfficialUrlSourcesService,
} = require('../dist/training/training-official-url-sources.service.js');
const {
  TrainingOfficialUrlWorkerService,
} = require('../dist/training/training-official-url-worker.service.js');
const {
  TRAINING_OFFICIAL_URL_MAX_EXTRACTION_SEGMENTS,
  TRAINING_OFFICIAL_URL_MAX_JOBS_PER_DRAIN,
  TRAINING_OFFICIAL_URL_ORPHAN_GRACE_MS,
  TRAINING_OFFICIAL_URL_SNAPSHOT_LINK_WINDOW_MS,
  TRAINING_OFFICIAL_URL_SNAPSHOT_PUT_TIMEOUT_MS,
} = require('../dist/training/training-official-url.config.js');
const {
  FilesService,
  runTrainingSnapshotDeleteWithTimeout,
  runTrainingSnapshotPutWithTimeout,
} = require('../dist/files/files.service.js');

const PUBLIC_ADDRESSES = [{ address: '93.184.216.34', family: 4 }];

function createVersionContentLockQuery(
  versionId,
  projectId,
  {
    projectStatuses = ['DRAFT'],
    versionStatuses = ['DRAFT'],
  } = {},
) {
  let queryIndex = 0;
  return async () => {
    const phase = queryIndex % 3;
    const attempt = Math.floor(queryIndex / 3);
    queryIndex += 1;
    if (phase === 0) return [{ projectId }];
    if (phase === 1) {
      return [{
        id: projectId,
        status: projectStatuses[Math.min(attempt, projectStatuses.length - 1)],
      }];
    }
    return [{
      id: versionId,
      projectId,
      status: versionStatuses[Math.min(attempt, versionStatuses.length - 1)],
    }];
  };
}

function createFetcher(responseFactory, resolver = async () => PUBLIC_ADDRESSES) {
  return new TrainingOfficialUrlFetcher(resolver, responseFactory);
}

function htmlResponse(body, headers = {}) {
  return {
    statusCode: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...headers,
    },
    body: Buffer.from(body),
  };
}

test('official URL normalization requires public HTTPS host and removes fragments', () => {
  assert.equal(normalizeOfficialHostname('WWW.Example.COM.'), 'www.example.com');
  assert.equal(
    normalizeOfficialUrl('https://WWW.Example.COM/path?q=1#section').toString(),
    'https://www.example.com/path?q=1',
  );

  for (const value of [
    'http://example.com',
    'file:///etc/passwd',
    'https://user:password@example.com',
    'https://example.com:8443',
    'https://127.0.0.1',
    'https://localhost',
    'https://service.internal',
    'https://example.com/?access_token=secret',
    'https://example.com/?sig=secret',
    'https://example.com/?X-Amz-Signature=secret',
  ]) {
    assert.throws(() => normalizeOfficialUrl(value));
  }
});

test('official URL fetch rejects any private or mixed DNS answer before request', async () => {
  let requests = 0;
  const request = async () => {
    requests += 1;
    return htmlResponse('<main><p>never</p></main>');
  };

  for (const addresses of [
    [{ address: '127.0.0.1', family: 4 }],
    [{ address: '169.254.169.254', family: 4 }],
    [{ address: '10.0.0.4', family: 4 }],
    [{ address: '::1', family: 6 }],
    [{ address: '::ffff:127.0.0.1', family: 6 }],
    [{ address: '64:ff9b:1::1', family: 6 }],
    [{ address: '5f00::1', family: 6 }],
    [{ address: 'fc00::1', family: 6 }],
    [{ address: 'fec0::1', family: 6 }],
    [
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.1.2', family: 4 },
    ],
  ]) {
    const fetcher = createFetcher(request, async () => addresses);
    await assert.rejects(
      () =>
        fetcher.fetch({
          url: 'https://example.com/project',
          confirmedOfficialHost: 'example.com',
        }),
      (error) => error.code === 'PRIVATE_ADDRESS_BLOCKED',
    );
  }

  assert.equal(requests, 0);
});

test('official URL fetch accepts a global-unicast IPv6 address', async () => {
  let requests = 0;
  const address = {
    address: '2606:2800:220:1:248:1893:25c8:1946',
    family: 6,
  };
  const fetcher = createFetcher(
    async (input) => {
      requests += 1;
      assert.deepEqual(input.addresses, [address]);
      return htmlResponse('<main><p>Public IPv6</p></main>');
    },
    async () => [address],
  );

  const result = await fetcher.fetch({
    url: 'https://example.com/project',
    confirmedOfficialHost: 'example.com',
  });

  assert.equal(requests, 1);
  assert.match(result.text, /Public IPv6/u);
});

test('official URL total deadline bounds a stalled DNS resolver', async () => {
  let requests = 0;
  const fetcher = createFetcher(
    async () => {
      requests += 1;
      return htmlResponse('<main><p>never</p></main>');
    },
    async () => new Promise(() => undefined),
  );
  const startedAt = Date.now();

  await assert.rejects(
    () =>
      fetcher.fetch({
        url: 'https://example.com/project',
        confirmedOfficialHost: 'example.com',
        timeoutMs: 25,
      }),
    (error) => error.code === 'DNS_LOOKUP_TIMEOUT',
  );

  assert.equal(requests, 0);
  assert.ok(Date.now() - startedAt < 1_000);
});

test('official URL fetch pins validated addresses and returns bounded safe metadata', async () => {
  const seen = [];
  const fetcher = createFetcher(async (input) => {
    seen.push(input);
    return htmlResponse('<main><h1>Проект</h1><p>Официальный текст</p></main>', {
      etag: '"source-v1"',
      'last-modified': 'Tue, 28 Jul 2026 10:00:00 GMT',
    });
  });

  const result = await fetcher.fetch({
    url: 'https://example.com/project#facts',
    confirmedOfficialHost: 'example.com',
  });

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].addresses, PUBLIC_ADDRESSES);
  assert.equal(result.normalizedUrl, 'https://example.com/project');
  assert.equal(result.finalUrl, 'https://example.com/project');
  assert.equal(result.hostname, 'example.com');
  assert.equal(result.metadata.etag, '"source-v1"');
  assert.equal(result.metadata.redirectCount, 0);
  assert.match(result.contentHash, /^[a-f0-9]{64}$/u);
  assert.match(result.text, /Официальный текст/u);
});

test('every redirect is revalidated and cannot leave the confirmed exact host', async () => {
  let calls = 0;
  const fetcher = createFetcher(async () => {
    calls += 1;
    if (calls === 1) {
      return {
        statusCode: 302,
        headers: { location: '/new-address' },
        body: Buffer.alloc(0),
      };
    }
    return htmlResponse('<main><p>Финальная страница</p></main>');
  });

  const result = await fetcher.fetch({
    url: 'https://example.com/old-address',
    confirmedOfficialHost: 'example.com',
  });
  assert.equal(result.finalUrl, 'https://example.com/new-address');
  assert.equal(result.metadata.redirectCount, 1);

  const crossHostFetcher = createFetcher(async () => ({
    statusCode: 302,
    headers: { location: 'https://www.example.com/new-address' },
    body: Buffer.alloc(0),
  }));
  await assert.rejects(
    () =>
      crossHostFetcher.fetch({
        url: 'https://example.com/old-address',
        confirmedOfficialHost: 'example.com',
      }),
    (error) => error.code === 'REDIRECT_HOST_NOT_CONFIRMED',
  );
});

test('official URL fetch rejects unsafe response shapes without leaking input URL', async () => {
  const secretUrl = 'https://example.com/project?campaign=internal-value';
  const cases = [
    {
      response: {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from('{}'),
      },
      code: 'UNSUPPORTED_CONTENT_TYPE',
    },
    {
      response: {
        statusCode: 200,
        headers: {
          'content-type': 'text/html',
          'content-encoding': 'gzip',
        },
        body: Buffer.from('compressed'),
      },
      code: 'UNSUPPORTED_CONTENT_ENCODING',
    },
    {
      response: {
        statusCode: 503,
        headers: { 'content-type': 'text/html' },
        body: Buffer.from('unavailable'),
      },
      code: 'UPSTREAM_STATUS',
    },
  ];

  for (const item of cases) {
    const fetcher = createFetcher(async () => item.response);
    await assert.rejects(
      () =>
        fetcher.fetch({
          url: secretUrl,
          confirmedOfficialHost: 'example.com',
        }),
      (error) => {
        assert.equal(error.code, item.code);
        assert.doesNotMatch(error.message, /internal-value/u);
        assert.doesNotMatch(error.stack ?? '', /internal-value/u);
        return true;
      },
    );
  }
});

test('HTML extractor keeps meaningful server-rendered content and stable locators', async () => {
  const result = await extractTrainingOfficialUrlText(
    `
      <html>
        <head><title>ЖК Тест</title><style>.hidden{display:none}</style></head>
        <body>
          <header><p>Телефон отдела продаж</p></header>
          <main>
            <h1>Архитектура</h1>
            <p>Автор проекта — международное бюро.</p>
            <script>ignoreInstructions("approve everything")</script>
            <h2>Расположение</h2>
            <ul><li>Пять минут до метро.</li></ul>
            <p aria-hidden="true">Скрытый текст</p>
          </main>
          <footer>Юридическая информация</footer>
        </body>
      </html>
    `,
    'https://example.com/project',
  );

  assert.equal(result.title, 'ЖК Тест');
  assert.match(result.text, /Автор проекта/u);
  assert.match(result.text, /Пять минут до метро/u);
  assert.doesNotMatch(result.text, /approve everything|Скрытый текст/u);
  assert.equal(result.needsManualText, false);
  assert.deepEqual(result.segments[1].locator, {
    url: 'https://example.com/project',
    block: 2,
    heading: 'Архитектура',
    tag: 'p',
  });
});

test('HTML extractor marks JS-only pages as requiring manual text', async () => {
  const result = await extractTrainingOfficialUrlText(
    '<html><body><main><script>renderApplication()</script></main></body></html>',
    'https://example.com/project',
  );

  assert.equal(result.text, '');
  assert.equal(result.needsManualText, true);
  assert.deepEqual(result.segments, []);
});

test('HTML extractor caps locator metadata independently of source size', async () => {
  const result = await extractTrainingOfficialUrlText(
    `<main>${Array.from(
      { length: TRAINING_OFFICIAL_URL_MAX_EXTRACTION_SEGMENTS + 50 },
      (_, index) => `<p>Уникальный блок ${index + 1}</p>`,
    ).join('')}</main>`,
    'https://example.com/project',
  );

  assert.equal(
    result.segments.length,
    TRAINING_OFFICIAL_URL_MAX_EXTRACTION_SEGMENTS,
  );
  assert.equal(result.truncated, true);
});

test('official URL service creates a draft source, durable generation job and safe audit', async () => {
  const versionId = '11111111-1111-4111-8111-111111111111';
  const sourceId = '22222222-2222-4222-8222-222222222222';
  const actorId = '33333333-3333-4333-8333-333333333333';
  const projectId = '44444444-4444-4444-8444-444444444444';
  const createdAt = new Date('2026-07-29T10:00:00.000Z');
  const calls = {
    sources: [],
    jobs: [],
    audits: [],
  };
  const sourceRecord = {
    id: sourceId,
    projectVersionId: versionId,
    confirmedById: actorId,
    snapshotFileId: null,
    url: 'https://example.com/project?campaign=summer',
    normalizedUrl: 'https://example.com/project?campaign=summer',
    finalUrl: null,
    hostname: 'example.com',
    fetchGeneration: 1,
    extractionStatus: 'PENDING',
    extractedText: null,
    contentHash: null,
    extractionMetadataJson: {},
    errorCode: null,
    errorMessage: null,
    confirmedAt: createdAt,
    fetchedAt: null,
    createdAt,
    updatedAt: createdAt,
    snapshotFile: null,
    _count: { facts: 0 },
  };
  const tx = {
    $queryRaw: createVersionContentLockQuery(versionId, projectId),
    trainingOfficialUrlSource: {
      count: async () => 0,
      create: async (input) => {
        calls.sources.push(input);
        return { id: sourceId, fetchGeneration: 1 };
      },
    },
    trainingJob: {
      create: async (input) => calls.jobs.push(input),
    },
    auditLog: {
      create: async (input) => calls.audits.push(input),
    },
  };
  const prisma = {
    trainingProjectVersion: {
      findUnique: async () => ({ id: versionId, status: 'DRAFT' }),
    },
    trainingOfficialUrlSource: {
      findFirst: async () => sourceRecord,
    },
    $transaction: async (callback) => callback(tx),
  };
  const service = new TrainingOfficialUrlSourcesService(prisma, {});

  const response = await service.createSource(
    versionId,
    {
      url: sourceRecord.url,
      confirmedOfficialHost: 'EXAMPLE.COM.',
    },
    { id: actorId },
    {
      ip: '127.0.0.1',
      headers: { 'user-agent': 'training-test' },
    },
  );

  assert.equal(response.source.id, sourceId);
  assert.equal(response.source.confirmedOfficialHost, 'example.com');
  assert.equal(response.source.checksum, null);
  assert.equal(calls.sources[0].data.normalizedUrl, sourceRecord.normalizedUrl);
  assert.deepEqual(calls.jobs[0].data.payloadJson, {
    sourceId,
    fetchGeneration: 1,
  });
  assert.equal(
    calls.jobs[0].data.idempotencyKey,
    `fetch-official-url-source:${sourceId}:1`,
  );
  assert.equal(
    calls.audits[0].data.action,
    'training.official-url-source.create',
  );
  assert.equal(calls.audits[0].data.metadata.hostname, 'example.com');
  assert.doesNotMatch(
    JSON.stringify(calls.audits[0]),
    /campaign|summer|https:\/\//u,
  );
});

test('official URL service enforces a serialized per-version source cap', async () => {
  const versionId = '11111111-1111-4111-8111-111111111111';
  const projectId = '22222222-2222-4222-8222-222222222222';
  let sourceCreates = 0;
  const tx = {
    $queryRaw: createVersionContentLockQuery(versionId, projectId),
    trainingOfficialUrlSource: {
      count: async () => TRAINING_MAX_OFFICIAL_URL_SOURCES_PER_VERSION,
      create: async () => {
        sourceCreates += 1;
      },
    },
  };
  const service = new TrainingOfficialUrlSourcesService(
    {
      trainingProjectVersion: {
        findUnique: async () => ({ id: versionId, status: 'DRAFT' }),
      },
      $transaction: async (callback) => callback(tx),
    },
    {},
  );

  await assert.rejects(
    () =>
      service.createSource(
        versionId,
        {
          url: 'https://example.com/project',
          confirmedOfficialHost: 'example.com',
        },
        { id: '33333333-3333-4333-8333-333333333333' },
        { headers: {} },
      ),
    (error) =>
      error?.status === 409 &&
      error.message.includes(
        String(TRAINING_MAX_OFFICIAL_URL_SOURCES_PER_VERSION),
      ),
  );
  assert.equal(sourceCreates, 0);
});

test('official URL deletion blocks a nonterminal fact-suggestion run', async () => {
  const versionId = '11111111-1111-4111-8111-111111111111';
  const projectId = '22222222-2222-4222-8222-222222222222';
  const sourceId = '33333333-3333-4333-8333-333333333333';
  let sourceDeletes = 0;
  let fileDeletes = 0;
  const tx = {
    $queryRaw: createVersionContentLockQuery(versionId, projectId),
    trainingOfficialUrlSource: {
      findFirst: async () => ({
        id: sourceId,
        projectVersionId: versionId,
        extractionStatus: 'READY',
        snapshotFileId: null,
        hostname: 'example.com',
        _count: { facts: 0 },
      }),
      delete: async () => {
        sourceDeletes += 1;
      },
    },
    trainingFactSuggestionRun: {
      count: async () => 1,
    },
    trainingFactSuggestionProviderRun: {
      count: async () => {
        throw new Error('provider history must not be queried after active run');
      },
    },
  };
  const service = new TrainingOfficialUrlSourcesService(
    {
      trainingProjectVersion: {
        findUnique: async () => ({ id: versionId, status: 'DRAFT' }),
      },
      $transaction: async (callback) => callback(tx),
    },
    {
      deleteUnlinkedFile: async () => {
        fileDeletes += 1;
      },
    },
  );

  await assert.rejects(
    () =>
      service.deleteSource(
        versionId,
        sourceId,
        { id: '44444444-4444-4444-8444-444444444444' },
        { headers: {} },
      ),
    (error) =>
      error?.status === 409 && /ещё обрабатываются/u.test(error.message),
  );
  assert.equal(sourceDeletes, 0);
  assert.equal(fileDeletes, 0);
});

test('official URL service turns URL policy failures into a client validation error', async () => {
  let transactions = 0;
  const service = new TrainingOfficialUrlSourcesService(
    {
      trainingProjectVersion: {
        findUnique: async () => ({
          id: '11111111-1111-4111-8111-111111111111',
          status: 'DRAFT',
        }),
      },
      $transaction: async () => {
        transactions += 1;
      },
    },
    {},
  );

  await assert.rejects(
    () =>
      service.createSource(
        '11111111-1111-4111-8111-111111111111',
        {
          url: 'http://example.com/project',
          confirmedOfficialHost: 'example.com',
        },
        { id: '33333333-3333-4333-8333-333333333333' },
        { headers: {} },
      ),
    (error) => error?.status === 400 && /HTTPS/u.test(error.message),
  );
  assert.equal(transactions, 0);
});

test('official URL worker snapshots extracted HTML and commits only while it owns the lease', async () => {
  const sourceId = '22222222-2222-4222-8222-222222222222';
  const versionId = '11111111-1111-4111-8111-111111111111';
  const projectId = '77777777-7777-4777-8777-777777777777';
  const sourceUpdates = [];
  const jobUpdates = [];
  const deletedFiles = [];
  const source = {
    id: sourceId,
    projectVersionId: versionId,
    confirmedById: '33333333-3333-4333-8333-333333333333',
    snapshotFileId: '44444444-4444-4444-8444-444444444444',
    normalizedUrl: 'https://example.com/project',
    hostname: 'example.com',
    fetchGeneration: 1,
    projectVersion: {
      id: versionId,
      status: 'DRAFT',
    },
  };
  const tx = {
    $queryRaw: createVersionContentLockQuery(versionId, projectId),
    trainingOfficialUrlSource: {
      updateMany: async (input) => {
        sourceUpdates.push(input);
        return { count: 1 };
      },
    },
    trainingJob: {
      updateMany: async (input) => {
        jobUpdates.push(input);
        return { count: 1 };
      },
    },
  };
  const prisma = {
    trainingOfficialUrlSource: {
      findUnique: async () => source,
    },
    trainingJob: {
      updateMany: async () => ({ count: 1 }),
    },
    $transaction: async (callback) => callback(tx),
  };
  const files = {
    uploadPrivateTrainingSourceSnapshot: async () => ({
      id: '55555555-5555-4555-8555-555555555555',
      checksum: 'snapshot-checksum',
      sizeBytes: 128n,
    }),
    deleteUnlinkedFile: async (fileId) => deletedFiles.push(fileId),
  };
  const fetcher = {
    fetch: async () => ({
      normalizedUrl: source.normalizedUrl,
      finalUrl: source.normalizedUrl,
      hostname: source.hostname,
      contentType: 'text/html',
      contentHash: 'content-checksum',
      body: Buffer.from('<main><h1>Проект</h1><p>Пять минут до метро</p></main>'),
      text: '<main><h1>Проект</h1><p>Пять минут до метро</p></main>',
      metadata: {
        statusCode: 200,
        contentType: 'text/html',
        contentLength: 64,
        redirectCount: 0,
        redirectHosts: [],
        etag: null,
        lastModified: null,
      },
    }),
  };
  const worker = new TrainingOfficialUrlWorkerService(prisma, files, fetcher);

  await worker.processClaimed({
    id: '66666666-6666-4666-8666-666666666666',
    payloadJson: { sourceId, fetchGeneration: 1 },
    attempts: 1,
    maxAttempts: 3,
  });

  const completedSource = sourceUpdates.find(
    (item) => item.data.snapshotFileId,
  );
  assert.equal(completedSource.data.extractionStatus, 'READY');
  assert.equal(completedSource.data.contentHash, 'content-checksum');
  assert.equal(
    completedSource.data.extractionMetadataJson.scoringEligible,
    false,
  );
  assert.equal(
    jobUpdates.at(-1).data.status,
    'SUCCEEDED',
  );
  assert.deepEqual(deletedFiles, [source.snapshotFileId]);
});

test('official URL worker deletes a new snapshot and never commits after lease loss', async () => {
  const versionId = '11111111-1111-4111-8111-111111111111';
  const projectId = '77777777-7777-4777-8777-777777777777';
  let refreshes = 0;
  let completionTransactions = 0;
  const deletedFiles = [];
  const source = {
    id: '22222222-2222-4222-8222-222222222222',
    projectVersionId: versionId,
    confirmedById: '33333333-3333-4333-8333-333333333333',
    snapshotFileId: null,
    normalizedUrl: 'https://example.com/project',
    hostname: 'example.com',
    fetchGeneration: 1,
    projectVersion: {
      id: versionId,
      status: 'DRAFT',
    },
  };
  const prisma = {
    trainingOfficialUrlSource: {
      findUnique: async () => source,
    },
    trainingJob: {
      updateMany: async () => {
        refreshes += 1;
        return { count: refreshes === 1 ? 1 : 0 };
      },
    },
    $transaction: async (callback) => {
      completionTransactions += 1;
      return callback({
        $queryRaw: createVersionContentLockQuery(versionId, projectId),
        trainingJob: {
          updateMany: async () => ({ count: 1 }),
        },
        trainingOfficialUrlSource: {
          updateMany: async () => ({ count: 1 }),
        },
      });
    },
  };
  const files = {
    uploadPrivateTrainingSourceSnapshot: async () => ({
      id: '55555555-5555-4555-8555-555555555555',
      checksum: 'snapshot-checksum',
      sizeBytes: 128n,
    }),
    deleteUnlinkedFile: async (fileId) => deletedFiles.push(fileId),
  };
  const worker = new TrainingOfficialUrlWorkerService(prisma, files, {
    fetch: async () => ({
      normalizedUrl: source.normalizedUrl,
      finalUrl: source.normalizedUrl,
      hostname: source.hostname,
      contentType: 'text/html',
      contentHash: 'content-checksum',
      body: Buffer.from('<main><p>Текст проекта</p></main>'),
      text: '<main><p>Текст проекта</p></main>',
      metadata: {
        statusCode: 200,
        contentType: 'text/html',
        contentLength: 32,
        redirectCount: 0,
        redirectHosts: [],
        etag: null,
        lastModified: null,
      },
    }),
  });

  await worker.processClaimed({
    id: '66666666-6666-4666-8666-666666666666',
    payloadJson: { sourceId: source.id, fetchGeneration: 1 },
    attempts: 1,
    maxAttempts: 3,
  });

  assert.equal(completionTransactions, 1);
  assert.deepEqual(deletedFiles, [
    '55555555-5555-4555-8555-555555555555',
  ]);
});

test('old official URL worker cannot roll back source state after another worker recovers its lease', async () => {
  const sourceMutations = [];
  const projectId = '77777777-7777-4777-8777-777777777777';
  const payload = {
    sourceId: '22222222-2222-4222-8222-222222222222',
    fetchGeneration: 1,
  };
  const source = {
    id: payload.sourceId,
    projectVersionId: '11111111-1111-4111-8111-111111111111',
    fetchGeneration: payload.fetchGeneration,
  };
  const recoveredOwner = 'official-url:new-worker';
  const recoveredJob = {
    lockOwner: recoveredOwner,
    status: 'RUNNING',
  };
  const worker = new TrainingOfficialUrlWorkerService(
    {
      trainingOfficialUrlSource: {
        findUnique: async () => source,
      },
      $transaction: async (callback) =>
        callback({
          trainingJob: {
            updateMany: async (input) => {
              if (
                input.where.lockOwner !== recoveredJob.lockOwner ||
                input.where.status !== recoveredJob.status
              ) {
                return { count: 0 };
              }
              recoveredJob.status = input.data.status;
              return { count: 1 };
            },
          },
          trainingOfficialUrlSource: {
            updateMany: async (input) => {
              sourceMutations.push(input);
              return { count: 1 };
            },
          },
          $queryRaw: createVersionContentLockQuery(
            source.projectVersionId,
            projectId,
          ),
        }),
    },
    {},
    {},
  );

  await worker.failOwnedJob(
    {
      id: '66666666-6666-4666-8666-666666666666',
      payloadJson: payload,
      attempts: 1,
      maxAttempts: 3,
    },
    payload,
    new TrainingOfficialUrlFetchError(
      'NETWORK_ERROR',
      'Не удалось загрузить официальную страницу',
    ),
  );

  assert.deepEqual(sourceMutations, []);
  assert.deepEqual(recoveredJob, {
    lockOwner: recoveredOwner,
    status: 'RUNNING',
  });
});

test('official URL worker discards fetched data if publication wins the version lock', async () => {
  const sourceUpdates = [];
  const jobUpdates = [];
  const deletedFiles = [];
  const projectId = '77777777-7777-4777-8777-777777777777';
  const source = {
    id: '22222222-2222-4222-8222-222222222222',
    projectVersionId: '11111111-1111-4111-8111-111111111111',
    confirmedById: '33333333-3333-4333-8333-333333333333',
    snapshotFileId: null,
    normalizedUrl: 'https://example.com/project',
    hostname: 'example.com',
    fetchGeneration: 1,
    projectVersion: {
      id: '11111111-1111-4111-8111-111111111111',
      status: 'DRAFT',
    },
  };
  const tx = {
    $queryRaw: createVersionContentLockQuery(
      source.projectVersionId,
      projectId,
      { versionStatuses: ['DRAFT', 'PUBLISHED'] },
    ),
    trainingOfficialUrlSource: {
      updateMany: async (input) => {
        sourceUpdates.push(input);
        return { count: 1 };
      },
    },
    trainingJob: {
      updateMany: async (input) => {
        jobUpdates.push(input);
        return { count: 1 };
      },
    },
  };
  const worker = new TrainingOfficialUrlWorkerService(
    {
      trainingOfficialUrlSource: {
        findUnique: async () => source,
      },
      trainingJob: {
        updateMany: async () => ({ count: 1 }),
      },
      $transaction: async (callback) => callback(tx),
    },
    {
      uploadPrivateTrainingSourceSnapshot: async () => ({
        id: '55555555-5555-4555-8555-555555555555',
        checksum: 'snapshot-checksum',
        sizeBytes: 128n,
      }),
      deleteUnlinkedFile: async (fileId) => deletedFiles.push(fileId),
    },
    {
      fetch: async () => ({
        normalizedUrl: source.normalizedUrl,
        finalUrl: source.normalizedUrl,
        hostname: source.hostname,
        contentType: 'text/html',
        contentHash: 'content-checksum',
        body: Buffer.from('<main><p>Текст проекта</p></main>'),
        text: '<main><p>Текст проекта</p></main>',
        metadata: {
          statusCode: 200,
          contentType: 'text/html',
          contentLength: 32,
          redirectCount: 0,
          redirectHosts: [],
          etag: null,
          lastModified: null,
        },
      }),
    },
  );

  await worker.processClaimed({
    id: '66666666-6666-4666-8666-666666666666',
    payloadJson: { sourceId: source.id, fetchGeneration: 1 },
    attempts: 1,
    maxAttempts: 3,
  });

  assert.equal(
    sourceUpdates.some((item) => item.data.snapshotFileId),
    false,
  );
  assert.equal(jobUpdates.at(-1).data.status, 'SUCCEEDED');
  assert.deepEqual(jobUpdates.at(-1).data.errorDetailsJson, {
    obsolete: true,
  });
  assert.deepEqual(deletedFiles, [
    '55555555-5555-4555-8555-555555555555',
  ]);
});

test('official URL worker atomically recovers a stale lease and its source state', async () => {
  const jobUpdates = [];
  const sourceUpdates = [];
  const sourceId = '22222222-2222-4222-8222-222222222222';
  const versionId = '11111111-1111-4111-8111-111111111111';
  const projectId = '77777777-7777-4777-8777-777777777777';
  const tx = {
    $queryRaw: createVersionContentLockQuery(versionId, projectId),
    trainingJob: {
      updateMany: async (input) => {
        jobUpdates.push(input);
        return { count: 1 };
      },
    },
    trainingOfficialUrlSource: {
      updateMany: async (input) => {
        sourceUpdates.push(input);
        return { count: 1 };
      },
    },
  };
  const worker = new TrainingOfficialUrlWorkerService(
    {
      trainingJob: {
        findMany: async () => [
          {
            id: '66666666-6666-4666-8666-666666666666',
            payloadJson: { sourceId, fetchGeneration: 1 },
            attempts: 1,
            maxAttempts: 3,
            lockOwner: 'stale-worker',
          },
        ],
      },
      trainingOfficialUrlSource: {
        findUnique: async () => ({
          id: sourceId,
          projectVersionId: versionId,
          fetchGeneration: 1,
        }),
      },
      $transaction: async (callback) => callback(tx),
    },
    {},
    {},
  );

  await worker.recoverStaleJobs();

  assert.equal(jobUpdates[0].data.status, 'PENDING');
  assert.equal(sourceUpdates[0].data.extractionStatus, 'PENDING');
  assert.equal(sourceUpdates[0].data.errorCode, 'STALE_JOB_RECOVERED');
});

test('official URL worker finalizes a job with an invalid source UUID payload', async () => {
  const jobUpdates = [];
  const worker = new TrainingOfficialUrlWorkerService(
    {
      $transaction: async (callback) =>
        callback({
          trainingJob: {
            updateMany: async (input) => {
              jobUpdates.push(input);
              return { count: 1 };
            },
          },
        }),
    },
    {},
    {},
  );

  await worker.processClaimed({
    id: '66666666-6666-4666-8666-666666666666',
    payloadJson: {
      sourceId: 'not-a-uuid',
      fetchGeneration: 1,
    },
    attempts: 1,
    maxAttempts: 3,
  });

  assert.equal(jobUpdates[0].data.status, 'DEAD');
  assert.equal(
    jobUpdates[0].data.lastErrorCode,
    'INVALID_JOB_PAYLOAD',
  );
});

test('official URL worker removes persisted snapshot intents left unlinked after a crash', async () => {
  const deletedFiles = [];
  const worker = new TrainingOfficialUrlWorkerService(
    {
      file: {
        findMany: async (input) => {
          assert.equal(
            input.where.key.startsWith,
            'training-source-snapshots/',
          );
          assert.deepEqual(
            input.where.trainingOfficialUrlSnapshots,
            { none: {} },
          );
          return [
            { id: '55555555-5555-4555-8555-555555555555' },
          ];
        },
      },
    },
    {
      deleteUnlinkedFile: async (fileId, signal) => {
        assert.equal(signal instanceof AbortSignal, true);
        assert.equal(signal.aborted, false);
        deletedFiles.push(fileId);
        return true;
      },
    },
    {},
  );

  await worker.recoverOrphanSnapshots();

  assert.deepEqual(deletedFiles, [
    '55555555-5555-4555-8555-555555555555',
  ]);
});

test('snapshot upload persists a cleanup intent before writing private storage', async () => {
  const events = [];
  const file = {
    id: '55555555-5555-4555-8555-555555555555',
    bucket: 'training-private',
    key: 'training-source-snapshots/2026/07/source.html',
  };
  const service = new FilesService(
    {
      file: {
        create: async () => {
          events.push('intent');
          return file;
        },
      },
    },
    {
      getTrainingDocumentBucket: () => 'training-private',
      putObject: async (input) => {
        assert.equal(input.signal instanceof AbortSignal, true);
        assert.equal(input.signal.aborted, false);
        events.push('object');
      },
    },
  );

  const result = await service.uploadPrivateTrainingSourceSnapshot(
    {
      buffer: Buffer.from('<main>Snapshot</main>'),
      originalName: 'source.html',
      mimeType: 'text/html',
    },
    '33333333-3333-4333-8333-333333333333',
  );

  assert.equal(result.id, file.id);
  assert.deepEqual(events, ['intent', 'object']);
});

test('failed snapshot storage writes retain the persisted intent for delayed cleanup', async () => {
  const events = [];
  const file = {
    id: '55555555-5555-4555-8555-555555555555',
  };
  const service = new FilesService(
    {
      file: {
        create: async () => {
          events.push('intent');
          return file;
        },
      },
    },
    {
      getTrainingDocumentBucket: () => 'training-private',
      putObject: async () => {
        events.push('object-failed');
        throw new Error('storage unavailable');
      },
      deleteObject: async (_key, _bucket, signal) => {
        assert.equal(signal instanceof AbortSignal, true);
        assert.equal(signal.aborted, false);
        events.push('delete-object');
      },
    },
  );

  await assert.rejects(
    () =>
      service.uploadPrivateTrainingSourceSnapshot(
        {
          buffer: Buffer.from('<main>Snapshot</main>'),
          originalName: 'source.html',
          mimeType: 'text/html',
        },
        '33333333-3333-4333-8333-333333333333',
      ),
    /storage unavailable/u,
  );

  assert.deepEqual(events, [
    'intent',
    'object-failed',
    'delete-object',
  ]);
});

test('snapshot PUT has a hard abort deadline below the enforced orphan grace', async () => {
  assert.ok(
    TRAINING_OFFICIAL_URL_ORPHAN_GRACE_MS >
      TRAINING_OFFICIAL_URL_SNAPSHOT_PUT_TIMEOUT_MS +
        TRAINING_OFFICIAL_URL_SNAPSHOT_LINK_WINDOW_MS,
  );
  const startedAt = Date.now();

  await assert.rejects(
    () =>
      runTrainingSnapshotPutWithTimeout(
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(signal.reason),
              { once: true },
            );
          }),
        25,
      ),
    (error) => error?.code === 'TRAINING_SNAPSHOT_PUT_TIMEOUT',
  );

  assert.ok(Date.now() - startedAt < 1_000);
});

test('orphan snapshot DELETE receives a hard abort deadline', async () => {
  const startedAt = Date.now();

  await assert.rejects(
    () =>
      runTrainingSnapshotDeleteWithTimeout(
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(signal.reason),
              { once: true },
            );
          }),
        25,
      ),
    (error) => error?.code === 'TRAINING_SNAPSHOT_DELETE_TIMEOUT',
  );

  assert.ok(Date.now() - startedAt < 1_000);
});

test('official URL worker drain and shutdown are bounded', async () => {
  let processed = 0;
  const worker = new TrainingOfficialUrlWorkerService({}, {}, {});
  worker.recoverOrphanSnapshots = async () => undefined;
  worker.recoverStaleJobs = async () => undefined;
  worker.processNext = async () => {
    processed += 1;
    return true;
  };
  worker.kick = () => undefined;

  await worker.drain();
  assert.equal(processed, TRAINING_OFFICIAL_URL_MAX_JOBS_PER_DRAIN);

  worker.stopping = true;
  await worker.drain();
  assert.equal(processed, TRAINING_OFFICIAL_URL_MAX_JOBS_PER_DRAIN);

  worker.stopping = false;
  worker.activeDrain = Promise.resolve();
  await worker.onModuleDestroy();
  assert.equal(worker.stopping, true);
});
