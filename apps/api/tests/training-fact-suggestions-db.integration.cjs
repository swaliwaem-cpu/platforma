require('reflect-metadata');

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const test = require('node:test');
const {
  PrismaClient,
  TrainingFactSuggestionRunStatus,
  TrainingJobStatus,
  TrainingProjectStatus,
  TrainingProviderRunStatus,
  TrainingSourceExtractionStatus,
  TrainingVersionStatus,
  UserStatus,
} = require('@prisma/client');

const {
  TrainingFactSuggestionWorkerService,
} = require('../dist/training/fact-suggestions/training-fact-suggestion-worker.service.js');
const {
  TrainingFactSuggestionsService,
} = require('../dist/training/fact-suggestions/training-fact-suggestions.service.js');

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL must point to the runner-created isolated training database',
  );
}

const prismaOptions = {
  transactionOptions: {
    maxWait: 5_000,
    timeout: 20_000,
  },
};
const observerPrisma = new PrismaClient(prismaOptions);
const firstWorkerPrisma = new PrismaClient(prismaOptions);
const secondWorkerPrisma = new PrismaClient(prismaOptions);
const thirdWorkerPrisma = new PrismaClient(prismaOptions);

test.after(async () => {
  await Promise.all([
    observerPrisma.$disconnect(),
    firstWorkerPrisma.$disconnect(),
    secondWorkerPrisma.$disconnect(),
    thirdWorkerPrisma.$disconnect(),
  ]);
});

test('PostgreSQL fact suggestions: concurrent workers call the provider once and heartbeat prevents takeover', async () => {
  const fixture = await createFixture();
  const providerStarted = deferred();
  const providerResult = deferred();
  let providerCalls = 0;
  const provider = {
    async suggest(input) {
      providerCalls += 1;
      providerStarted.resolve(input);
      return providerResult.promise;
    },
  };
  const first = createWorker(firstWorkerPrisma, provider, 'facts-concurrent-a');
  const second = createWorker(secondWorkerPrisma, provider, 'facts-concurrent-b');
  const third = createWorker(thirdWorkerPrisma, provider, 'facts-concurrent-c');

  const firstDrain = first.drainNow();
  const secondDrain = second.drainNow();
  const input = await providerStarted.promise;
  await waitForProviderStatus(
    fixture.providerRun.id,
    TrainingProviderRunStatus.REQUESTING,
  );
  await delay(1_200);
  await third.drainNow();

  assert.equal(providerCalls, 1);
  const duringRequest = await observerPrisma.trainingJob.findUniqueOrThrow({
    where: { id: fixture.job.id },
  });
  assert.equal(duringRequest.status, TrainingJobStatus.RUNNING);
  assert.equal(duringRequest.attempts, 1);

  providerResult.resolve(makeProviderResult(input, fixture.unique));
  await Promise.all([firstDrain, secondDrain]);

  const [job, providerRun, suggestions, audits] = await Promise.all([
    observerPrisma.trainingJob.findUniqueOrThrow({
      where: { id: fixture.job.id },
    }),
    observerPrisma.trainingFactSuggestionProviderRun.findUniqueOrThrow({
      where: { id: fixture.providerRun.id },
    }),
    observerPrisma.trainingFactSuggestion.count({
      where: { providerRunId: fixture.providerRun.id },
    }),
    observerPrisma.auditLog.count({
      where: {
        action: 'training.fact-suggestion-provider.complete',
        entityId: fixture.providerRun.id,
      },
    }),
  ]);
  assert.equal(job.status, TrainingJobStatus.SUCCEEDED);
  assert.equal(job.attempts, 1);
  assert.equal(providerRun.status, TrainingProviderRunStatus.SUCCEEDED);
  assert.equal(suggestions, 1);
  assert.equal(audits, 1);
  assert.equal(providerCalls, 1);
});

test('PostgreSQL fact suggestions: a worker that lost its lease stops before the provider call', async () => {
  const fixture = await createFixture();
  const workerId = `facts-lost-before-provider-${fixture.unique}`;
  let providerCalls = 0;
  const worker = createWorker(
    firstWorkerPrisma,
    {
      async suggest() {
        providerCalls += 1;
        throw new Error('provider must not be called after lease loss');
      },
    },
    workerId,
  );
  const claimedAt = new Date();
  await observerPrisma.trainingJob.update({
    where: { id: fixture.job.id },
    data: {
      status: TrainingJobStatus.RUNNING,
      attempts: 1,
      lockOwner: `replacement-${fixture.unique}`,
      lockedAt: claimedAt,
      heartbeatAt: claimedAt,
    },
  });

  await worker.processClaimed({
    id: fixture.job.id,
    payloadJson: fixture.job.payloadJson,
    attempts: 1,
    maxAttempts: fixture.job.maxAttempts,
  });

  const [job, providerRun, suggestions] = await Promise.all([
    observerPrisma.trainingJob.findUniqueOrThrow({
      where: { id: fixture.job.id },
    }),
    observerPrisma.trainingFactSuggestionProviderRun.findUniqueOrThrow({
      where: { id: fixture.providerRun.id },
    }),
    observerPrisma.trainingFactSuggestion.count({
      where: { providerRunId: fixture.providerRun.id },
    }),
  ]);
  assert.equal(providerCalls, 0);
  assert.equal(job.status, TrainingJobStatus.RUNNING);
  assert.equal(job.lockOwner, `replacement-${fixture.unique}`);
  assert.equal(providerRun.status, TrainingProviderRunStatus.PENDING);
  assert.equal(suggestions, 0);
});

test('PostgreSQL fact suggestions: stale pending-provider work is reclaimed and completed once', async () => {
  const fixture = await createFixture();
  let providerCalls = 0;
  const provider = {
    async suggest(input) {
      providerCalls += 1;
      return makeProviderResult(input, fixture.unique);
    },
  };
  const recoveryWorker = createWorker(
    secondWorkerPrisma,
    provider,
    `facts-stale-pending-${fixture.unique}`,
  );
  await observerPrisma.trainingJob.update({
    where: { id: fixture.job.id },
    data: {
      status: TrainingJobStatus.RUNNING,
      attempts: 1,
      lockOwner: `crashed-${fixture.unique}`,
      lockedAt: new Date('2000-01-01T00:00:00.000Z'),
      heartbeatAt: new Date('2000-01-01T00:00:00.000Z'),
    },
  });

  await recoveryWorker.drainNow();

  const [job, providerRun, run, suggestions] = await Promise.all([
    observerPrisma.trainingJob.findUniqueOrThrow({
      where: { id: fixture.job.id },
    }),
    observerPrisma.trainingFactSuggestionProviderRun.findUniqueOrThrow({
      where: { id: fixture.providerRun.id },
    }),
    observerPrisma.trainingFactSuggestionRun.findUniqueOrThrow({
      where: { id: fixture.run.id },
    }),
    observerPrisma.trainingFactSuggestion.count({
      where: { providerRunId: fixture.providerRun.id },
    }),
  ]);
  assert.equal(providerCalls, 1);
  assert.equal(job.status, TrainingJobStatus.SUCCEEDED);
  assert.equal(job.attempts, 2);
  assert.equal(providerRun.status, TrainingProviderRunStatus.SUCCEEDED);
  assert.equal(run.status, TrainingFactSuggestionRunStatus.READY);
  assert.equal(suggestions, 1);
});

for (const outcome of ['result', 'rejection']) {
  test(`PostgreSQL fact suggestions: stale REQUESTING fences a late provider ${outcome}`, async () => {
    const fixture = await createFixture();
    const providerStarted = deferred();
    const providerOutcome = deferred();
    let providerCalls = 0;
    const provider = {
      async suggest(input) {
        providerCalls += 1;
        providerStarted.resolve(input);
        return providerOutcome.promise;
      },
    };
    const oldWorker = createWorker(
      firstWorkerPrisma,
      provider,
      `facts-old-${outcome}`,
    );
    const recoveryWorker = createWorker(
      secondWorkerPrisma,
      provider,
      `facts-recovery-${outcome}`,
    );

    const oldDrain = oldWorker.drainNow();
    const input = await providerStarted.promise;
    await waitForProviderStatus(
      fixture.providerRun.id,
      TrainingProviderRunStatus.REQUESTING,
    );
    await observerPrisma.trainingJob.update({
      where: { id: fixture.job.id },
      data: {
        lockOwner: `replacement-${outcome}`,
        lockedAt: new Date('2000-01-01T00:00:00.000Z'),
        heartbeatAt: new Date('2000-01-01T00:00:00.000Z'),
      },
    });

    await recoveryWorker.drainNow();
    await waitForProviderStatus(
      fixture.providerRun.id,
      TrainingProviderRunStatus.AMBIGUOUS,
    );
    if (outcome === 'result') {
      providerOutcome.resolve(makeProviderResult(input, fixture.unique));
    } else {
      providerOutcome.reject(new Error('late provider rejection'));
    }
    await oldDrain;

    const [job, providerRun, run, suggestions, audits] = await Promise.all([
      observerPrisma.trainingJob.findUniqueOrThrow({
        where: { id: fixture.job.id },
      }),
      observerPrisma.trainingFactSuggestionProviderRun.findUniqueOrThrow({
        where: { id: fixture.providerRun.id },
      }),
      observerPrisma.trainingFactSuggestionRun.findUniqueOrThrow({
        where: { id: fixture.run.id },
      }),
      observerPrisma.trainingFactSuggestion.count({
        where: { providerRunId: fixture.providerRun.id },
      }),
      observerPrisma.auditLog.count({
        where: {
          action: 'training.fact-suggestion-provider.complete',
          entityId: fixture.providerRun.id,
        },
      }),
    ]);
    assert.equal(providerCalls, 1);
    assert.equal(job.status, TrainingJobStatus.DEAD);
    assert.equal(job.lockOwner, null);
    assert.equal(
      job.lastErrorCode,
      'OPENAI_RECOVERED_REQUEST_AMBIGUOUS',
    );
    assert.equal(providerRun.status, TrainingProviderRunStatus.AMBIGUOUS);
    assert.equal(providerRun.ambiguousOutcome, true);
    assert.equal(
      providerRun.errorCode,
      'OPENAI_RECOVERED_REQUEST_AMBIGUOUS',
    );
    assert.equal(run.status, TrainingFactSuggestionRunStatus.AMBIGUOUS);
    assert.equal(suggestions, 0);
    assert.equal(audits, 0);
  });
}

test('PostgreSQL fact suggestions: exhausted pending job terminalizes its provider and does not dead-end the version', async () => {
  const fixture = await createFixture();
  let providerCalls = 0;
  const worker = createWorker(
    firstWorkerPrisma,
    {
      async suggest() {
        providerCalls += 1;
        throw new Error('provider must not be called');
      },
    },
    'facts-exhausted',
  );
  await observerPrisma.trainingJob.update({
    where: { id: fixture.job.id },
    data: {
      attempts: fixture.job.maxAttempts,
    },
  });

  await worker.drainNow();

  const [job, providerRun, run] = await Promise.all([
    observerPrisma.trainingJob.findUniqueOrThrow({
      where: { id: fixture.job.id },
    }),
    observerPrisma.trainingFactSuggestionProviderRun.findUniqueOrThrow({
      where: { id: fixture.providerRun.id },
    }),
    observerPrisma.trainingFactSuggestionRun.findUniqueOrThrow({
      where: { id: fixture.run.id },
    }),
  ]);
  assert.equal(providerCalls, 0);
  assert.equal(job.status, TrainingJobStatus.DEAD);
  assert.equal(
    job.lastErrorCode,
    'FACT_SUGGESTION_ATTEMPTS_EXHAUSTED',
  );
  assert.equal(providerRun.status, TrainingProviderRunStatus.FAILED);
  assert.equal(
    providerRun.errorCode,
    'FACT_SUGGESTION_ATTEMPTS_EXHAUSTED',
  );
  assert.equal(run.status, TrainingFactSuggestionRunStatus.FAILED);

  const nextRun = await fixture.service.createRun(
    fixture.version.id,
    {
      sourceIds: [{ kind: 'OFFICIAL_URL', id: fixture.source.id }],
    },
    fixture.actor,
    fixture.request,
    `fact-db-next-${fixture.unique}`,
  );
  assert.notEqual(nextRun.run.id, fixture.run.id);
  assert.equal(nextRun.run.status, TrainingFactSuggestionRunStatus.PENDING);
});

test('PostgreSQL fact suggestions: terminal owned failure cannot leave provider and run active', async () => {
  const fixture = await createFixture();
  const workerId = `facts-owned-terminal-${fixture.unique}`;
  const worker = createWorker(firstWorkerPrisma, {}, workerId);
  const claimedAt = new Date();
  await observerPrisma.trainingJob.update({
    where: { id: fixture.job.id },
    data: {
      status: TrainingJobStatus.RUNNING,
      attempts: fixture.job.maxAttempts,
      lockOwner: workerId,
      lockedAt: claimedAt,
      heartbeatAt: claimedAt,
    },
  });

  await worker.failUnclaimedProviderRun(
    {
      id: fixture.job.id,
      payloadJson: fixture.job.payloadJson,
      attempts: fixture.job.maxAttempts,
      maxAttempts: fixture.job.maxAttempts,
    },
    'FACT_SUGGESTION_DB_TEST_FAILURE',
    'Deterministic pre-provider failure',
  );

  const [job, providerRun, run] = await Promise.all([
    observerPrisma.trainingJob.findUniqueOrThrow({
      where: { id: fixture.job.id },
    }),
    observerPrisma.trainingFactSuggestionProviderRun.findUniqueOrThrow({
      where: { id: fixture.providerRun.id },
    }),
    observerPrisma.trainingFactSuggestionRun.findUniqueOrThrow({
      where: { id: fixture.run.id },
    }),
  ]);
  assert.equal(job.status, TrainingJobStatus.DEAD);
  assert.equal(job.lastErrorCode, 'FACT_SUGGESTION_DB_TEST_FAILURE');
  assert.equal(providerRun.status, TrainingProviderRunStatus.FAILED);
  assert.equal(providerRun.errorCode, 'FACT_SUGGESTION_DB_TEST_FAILURE');
  assert.equal(run.status, TrainingFactSuggestionRunStatus.FAILED);
});

function createWorker(prisma, provider, workerId) {
  return new TrainingFactSuggestionWorkerService(
    prisma,
    provider,
    undefined,
    undefined,
    {
      workerId,
      leaseMs: 1_000,
      heartbeatMs: 100,
      drainTimeoutMs: 1_000,
    },
  );
}

async function createFixture() {
  const unique = randomUUID();
  const role = await observerPrisma.role.create({
    data: {
      name: `fact-db-role-${unique}`,
      description: 'Fact suggestion PostgreSQL integration role',
    },
  });
  const user = await observerPrisma.user.create({
    data: {
      email: `fact-db-${unique}@example.test`,
      passwordHash: 'not-used-in-fact-suggestion-db-test',
      name: 'Fact suggestion DB actor',
      status: UserStatus.ACTIVE,
      roleId: role.id,
    },
  });
  const project = await observerPrisma.trainingProject.create({
    data: {
      slug: `fact-db-${unique}`,
      title: `Fact suggestion DB ${unique}`,
      status: TrainingProjectStatus.DRAFT,
    },
  });
  const version = await observerPrisma.trainingProjectVersion.create({
    data: {
      projectId: project.id,
      versionNumber: 1,
      status: TrainingVersionStatus.DRAFT,
    },
  });
  const sourceText =
    'Официальный материал подтверждает, что девелопером проекта является TATE Development.';
  const sourceUrl = `https://official.example.test/projects/${unique}`;
  const sourceChecksum = sha256(sourceText);
  const sourceTimestamp = new Date();
  const snapshot = await observerPrisma.file.create({
    data: {
      bucket: 'training-source-snapshots',
      key: `training/snapshots/${unique}.html`,
      originalName: `official-${unique}.html`,
      mimeType: 'text/html',
      sizeBytes: BigInt(Buffer.byteLength(sourceText)),
      checksum: sourceChecksum,
      uploadedById: user.id,
    },
  });
  const source = await observerPrisma.trainingOfficialUrlSource.create({
    data: {
      projectVersionId: version.id,
      confirmedById: user.id,
      snapshotFileId: snapshot.id,
      url: sourceUrl,
      normalizedUrl: sourceUrl,
      finalUrl: sourceUrl,
      hostname: 'official.example.test',
      extractionStatus: TrainingSourceExtractionStatus.READY,
      extractedText: sourceText,
      contentHash: sourceChecksum,
      extractionMetadataJson: {
        segments: [
          {
            locator: { url: sourceUrl, section: 'project' },
            start: 0,
            end: sourceText.length,
          },
        ],
      },
      confirmedAt: sourceTimestamp,
      fetchedAt: sourceTimestamp,
    },
  });
  const actor = {
    id: user.id,
    email: user.email,
    name: user.name,
    permissions: ['training:projects:manage'],
  };
  const request = {
    headers: { 'user-agent': 'training-fact-suggestions-db-test' },
    ip: '127.0.0.1',
  };
  const service = new TrainingFactSuggestionsService(observerPrisma, {
    providerMode: 'fake',
  });
  const response = await service.createRun(
    version.id,
    {
      sourceIds: [{ kind: 'OFFICIAL_URL', id: source.id }],
    },
    actor,
    request,
    `fact-db-run-${unique}`,
  );
  const providerRun =
    await observerPrisma.trainingFactSuggestionProviderRun.findFirstOrThrow({
      where: { suggestionRunId: response.run.id },
    });
  const job = await observerPrisma.trainingJob.findUniqueOrThrow({
    where: {
      idempotencyKey: `fact-suggest:${response.run.id}:${providerRun.id}`,
    },
  });
  return {
    unique,
    actor,
    request,
    service,
    project,
    version,
    source,
    run: response.run,
    providerRun,
    job,
  };
}

function makeProviderResult(input, unique) {
  const segment = input.segments[0];
  return {
    requestedModelId: 'fact-db-provider',
    actualModelId: 'fact-db-provider',
    reasoningEffort: null,
    requestId: `fact-db-request-${unique}`,
    latencyMs: 1,
    retryCount: 0,
    responseStatus: 'completed',
    suggestions: [
      {
        suggestedCode: `identity.developer.${unique}`,
        topicCode: 'identity',
        statement: 'Девелопером проекта является TATE Development.',
        acceptedAliases: ['TATE Development'],
        importance: 1,
        sourceId: segment.sourceId,
        sourceSegmentId: segment.id,
        sourceLocator: segment.locator,
        sourceQuote:
          'девелопером проекта является TATE Development',
        statementHash: sha256(
          'Девелопером проекта является TATE Development.',
        ),
        duplicateOfFactId: null,
      },
    ],
  };
}

async function waitForProviderStatus(providerRunId, status) {
  await waitFor(async () => {
    const providerRun =
      await observerPrisma.trainingFactSuggestionProviderRun.findUnique({
        where: { id: providerRunId },
        select: { status: true },
      });
    return providerRun?.status === status;
  }, `provider run ${providerRunId} to become ${status}`);
}

async function waitFor(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
