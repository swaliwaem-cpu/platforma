const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { readFile, stat, writeFile, mkdtemp } = require('node:fs/promises');
const { createServer } = require('node:net');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { hash } = require('argon2');
const { PrismaClient } = require('@prisma/client');
const { chromium } = require('playwright-core');
const {
  createUnverifiedProviderEvidence,
  installTerminationHandlers,
  runBoundedOperation,
  runCommand: runRuntimeCommand,
  validateLocalDockerDaemon,
  verifyT07ProviderEvidence,
} = require('./assistant-pidafix3-runtime.cjs');

const root = resolve(__dirname, '../../..');
const composeFile = resolve(root, 'docker-compose.assistant-pidafix3.yml');
const taskPaths = [
  '.env.example',
  'apps/api/.env.example',
  'apps/api/scripts/assistant-eval-runner.cjs',
  'apps/api/scripts/assistant-eval-runtime.cjs',
  'apps/api/scripts/assistant-pidafix3-baseline.cjs',
  'apps/api/scripts/assistant-pidafix3-geo-live.cjs',
  'apps/api/scripts/assistant-pidafix3-runtime.cjs',
  'apps/api/scripts/assistant-rollout-preflight.cjs',
  'apps/api/src/assistant/assistant-planner-gateway.ts',
  'apps/api/src/assistant/assistant-runtime-config.ts',
  'apps/api/src/assistant/eval/assistant-eval-runtime-contract.ts',
  'apps/api/src/assistant/geo/assistant-place-resolver.service.ts',
  'apps/api/src/assistant/rollout/assistant-rollout-preflight.ts',
  'apps/api/src/assistant/sources/assistant-current-fact-refresh.service.ts',
  'apps/api/src/assistant/sources/assistant-knowledge-policy.ts',
  'apps/api/src/assistant/sources/assistant-source-connector.registry.ts',
  'apps/api/src/assistant/sources/official-source.extractor.ts',
  'apps/api/src/project-presentations/project-presentations-worker.service.ts',
  'apps/api/tests/assistant-eval-runner.test.cjs',
  'apps/api/tests/assistant-pidafix3-baseline.test.cjs',
  'apps/api/tests/assistant-pidafix3-geo-live.test.cjs',
  'apps/api/tests/assistant-t02-domain.test.cjs',
  'apps/api/tests/assistant-t03-connector.test.cjs',
  'apps/api/tests/assistant-t03-domain.test.cjs',
  'apps/api/tests/assistant-t03-postgres.cjs',
  'apps/api/tests/assistant-t07-domain.test.cjs',
  'apps/api/tests/assistant-t07-e2e.cjs',
  'apps/api/tests/project-presentations-worker-config.test.cjs',
  'apps/web/src/assistant/AssistantChat.tsx',
  'apps/web/src/catalog/CatalogPage.tsx',
  'apps/web/src/map/MapLibreMap.tsx',
  'apps/web/tests/assistant-t05-ui.test.mjs',
  'apps/web/tests/assistant-t05.browser.mjs',
  'docker-compose.assistant-pidafix3.yml',
  'docker-compose.assistant-pidafix3-geo-live.yml',
  'docker-compose.yml',
  'package.json',
];
const taskCheckPaths = [...taskPaths, 'docs/helpar/t07-manual-qa.md'];

if (require.main === module) {
  const execute = process.argv.includes('--execute');
  if (!execute) {
    process.stdout.write(`${JSON.stringify({
      mode: 'dry-run',
      gates: createGatePlan().map(({ id, command, args }) => ({ id, command, args })),
      externalCalls: 0,
      hint: 'Use pnpm test:assistant:pidafix3:baseline to execute the fake-only baseline.',
    }, null, 2)}\n`);
  } else {
    const termination = installTerminationHandlers();
    void runBaseline({ abortSignal: termination.abortSignal }).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = termination.exitCode ?? 1;
    }).finally(() => termination.dispose());
  }
}

function createGatePlan() {
  return [
    gate('zaebal6-unit', 'pnpm', ['test:assistant:zaebal6:unit']),
    gate('t07-domain', 'pnpm', ['test:assistant:t07:domain']),
    gate('t07-targeted', 'pnpm', ['test:assistant:t07:targeted']),
    gate('t07-connected-e2e', 'pnpm', ['test:assistant:t07:e2e'], 12 * 60_000),
    gate('fix-token-unit', 'node', ['apps/api/tests/assistant-fix-token.test.cjs']),
    gate('t03-discovery-unit', 'node', ['apps/api/tests/assistant-t03-discovery.test.cjs']),
    gate('t03-connector-unit', 'node', ['apps/api/tests/assistant-t03-connector.test.cjs']),
    gate('fix-token-postgres', 'pnpm', ['test:assistant:fix-token:postgres'], 8 * 60_000),
    gate('t03-postgres', 'pnpm', ['test:assistant:t03:postgres'], 8 * 60_000),
    gate('t03-browser', 'pnpm', ['test:assistant:t03:browser'], 5 * 60_000),
    gate('fix-geo1-targeted', 'pnpm', ['test:assistant:fix-geo1:targeted'], 10 * 60_000),
    gate('fix-geo1-postgres', 'pnpm', ['test:assistant:fix-geo1:postgres'], 10 * 60_000),
    gate('fix-geo1-browser', 'pnpm', ['test:assistant:fix-geo1:browser'], 5 * 60_000),
    gate('full-test', 'pnpm', ['test'], 15 * 60_000),
    gate('full-build', 'pnpm', ['build'], 15 * 60_000),
  ];
}

function createBaselineGateManifest() {
  return [
    ...createGatePlan().map(({ id, command, args }) => ({ id, command: [command, ...args] })),
    {
      id: 'git-diff-check',
      command: ['git', ...createTaskDiffCheckPlan().trackedArgs],
    },
  ];
}

function gate(id, command, args, timeoutMs = 5 * 60_000) {
  return { id, command, args, timeoutMs };
}

function createSafeEnvironment(baseEnvironment, overrides = {}) {
  const environment = { ...baseEnvironment };
  for (const key of Object.keys(environment)) {
    if (isSensitiveOrLiveKey(key)) delete environment[key];
  }
  Object.assign(environment, {
    NODE_ENV: 'test',
    FEED_AUTO_IMPORT_ENABLED: 'false',
    TRAINING_MODULE_ENABLED: 'false',
    TRAINING_AI_MODE: 'fake',
    TRAINING_VOICE_WORKER_ENABLED: 'false',
    TRAINING_MATERIAL_WORKER_ENABLED: 'false',
    TRAINING_TELEGRAM_OUTBOX_WORKER_ENABLED: 'false',
    TELEGRAM_TRANSPORT_MODE: 'fake',
    PROJECT_PRESENTATIONS_WORKER_ENABLED: 'false',
    ASSISTANT_MODULE_ENABLED: 'true',
    ASSISTANT_ROLLOUT_STAGE: 'ADMINS',
    ASSISTANT_AI_MODE: 'fake',
    ASSISTANT_QUERY_PLANNER_LIVE: 'false',
    ASSISTANT_PAID_CALLS_CONFIRMED: 'false',
    ASSISTANT_EMBEDDING_MODE: 'fake',
    ASSISTANT_EMBEDDING_LIVE: 'false',
    ASSISTANT_GEO_PROVIDER_ENABLED: 'true',
    ASSISTANT_GEO_PROVIDER_MODE: 'fake',
    ASSISTANT_GEO_PROVIDER_MAX_RETRIES: '0',
    ASSISTANT_OVERPASS_ENABLED: 'false',
    ASSISTANT_EXTERNAL_CONNECTORS_ENABLED: 'false',
    ASSISTANT_CURRENT_FACT_REFRESH_MODE: 'disabled',
    ASSISTANT_SOURCE_WORKER_ENABLED: 'false',
    ASSISTANT_SOURCE_BROWSER_FALLBACK_ENABLED: 'false',
    LOCATIONIQ_API_URL: 'http://127.0.0.1:9/locationiq',
    ASSISTANT_OVERPASS_URL: 'http://127.0.0.1:9/overpass',
    ASSISTANT_OPENAI_BASE_URL: 'http://127.0.0.1:9/openai',
    OPENROUTESERVICE_API_URL: 'http://127.0.0.1:9/openrouteservice',
    MAP_PROVIDER_ENABLED: 'false',
    S3_ENDPOINT: 'http://127.0.0.1:9',
    S3_PUBLIC_ENDPOINT: 'http://127.0.0.1:9',
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY_ID: 'pidafix3-disabled',
    S3_SECRET_ACCESS_KEY: 'pidafix3-disabled',
    MINIO_BUCKET: 'pidafix3-disabled',
    TRAINING_AUDIO_BUCKET: 'platforma-training-audio',
  }, overrides);
  return environment;
}

function isSensitiveOrLiveKey(key) {
  return /(?:^|_)(?:OPENAI_API_KEY|LOCATIONIQ_API_KEY|TELEGRAM_BOT_TOKEN|SMTP_PASSWORD|DATABASE_URL|ASSISTANT_.*LIVE|ASSISTANT_PAID_CALLS_CONFIRMED|ASSISTANT_FIX_GEO1_LIVE_ALLOW_REMOTE|AWS_.*|.*SECRET|.*PASSWORD|.*ACCESS_TOKEN)$/iu.test(key)
    || /(?:TOKEN|API_KEY)$/iu.test(key)
    || /^(?:S3_|MINIO_|TRAINING_AUDIO_BUCKET$)/iu.test(key);
}

function redact(value, secrets = []) {
  let output = String(value ?? '');
  for (const secret of secrets.filter(Boolean)) output = output.split(secret).join('<redacted>');
  return output
    .replace(/(postgres(?:ql)?:\/\/)[^\s@]+@/giu, '$1<redacted>@')
    .replace(/(Bearer\s+)[^\s]+/giu, '$1<redacted>');
}

function composeResourceFilters(project) {
  assert.match(project, /^platforma-pidafix3-[a-f0-9]{8}$/u);
  return {
    containers: ['ps', '--all', '--quiet', '--filter', `label=com.docker.compose.project=${project}`],
    networks: ['network', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${project}`],
    volumes: ['volume', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${project}`],
  };
}

async function runBaseline(options = {}) {
  options.abortSignal?.throwIfAborted();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  const project = `platforma-pidafix3-${suffix}`;
  const postgresPassword = `p${randomUUID().replaceAll('-', '')}`;
  const apiPort = await reservePort();
  const webPort = await reservePort();
  const postgresPort = await reservePort();
  const secrets = [postgresPassword];
  const initialComposeEnvironment = createSafeEnvironment(process.env, {
    PIDAFIX3_POSTGRES_IMAGE: `platforma-pidafix3-postgres:${suffix}`,
    PIDAFIX3_API_IMAGE: `platforma-pidafix3-api:${suffix}`,
    PIDAFIX3_WEB_IMAGE: `platforma-pidafix3-web:${suffix}`,
    PIDAFIX3_POSTGRES_PASSWORD: postgresPassword,
    PIDAFIX3_POSTGRES_PORT: String(postgresPort),
    PIDAFIX3_API_PORT: String(apiPort),
    PIDAFIX3_WEB_PORT: String(webPort),
    PIDAFIX3_JWT_ACCESS_SECRET: `pidafix3-access-${randomUUID()}`,
    PIDAFIX3_JWT_REFRESH_SECRET: `pidafix3-refresh-${randomUUID()}`,
    PIDAFIX3_JWT_MEDIA_SECRET: `pidafix3-media-${randomUUID()}`,
    PIDAFIX3_EMAIL_AUTH_SECRET: `pidafix3-email-${randomUUID()}`,
  });
  const dockerTarget = await validateLocalDockerDaemon(initialComposeEnvironment);
  const composeEnvironment = dockerTarget.environment;
  const qaDirectory = await mkdtemp(join(tmpdir(), `platforma-pidafix3-qa-${suffix}-`));
  const providerEvidenceNonce = randomUUID().replaceAll('-', '').slice(0, 16);
  const providerEvidencePath = join(qaDirectory, 't07-provider-evidence.json');
  secrets.push(
    composeEnvironment.PIDAFIX3_JWT_ACCESS_SECRET,
    composeEnvironment.PIDAFIX3_JWT_REFRESH_SECRET,
    composeEnvironment.PIDAFIX3_JWT_MEDIA_SECRET,
    composeEnvironment.PIDAFIX3_EMAIL_AUTH_SECRET,
  );
  const compose = [
    'compose', '--env-file', '/dev/null', '--file', composeFile, '--project-name', project,
  ];
  const hostDatabaseUrl = databaseUrl({ postgresPassword, postgresPort, name: 'platforma_pidafix3' });
  const report = {
    version: 1,
    project,
    startedAt: new Date().toISOString(),
    head: await readCommand('git', ['rev-parse', 'HEAD'], { env: composeEnvironment }),
    taskDiffSha256: await calculateTaskDiffSha(composeEnvironment),
    taskPaths,
    dockerTarget: dockerTarget.facts,
    images: {},
    readiness: {},
    setup: [],
    gates: [],
    screenshots: { directory: qaDirectory, files: [] },
    externalProviderEvidence: createUnverifiedProviderEvidence(),
    currentFactFixtureEvidence: {
      status: 'not-measured',
      scope: 't07-connected-e2e',
      caseCount: null,
    },
    costUsd: null,
    costBasis: 'not-calculated',
    skippedExternalGates: [
      { gate: 'OpenAI smoke', reason: 'requires a new explicit command with 2/4/$0.50 caps' },
      { gate: 'Geo Provider smoke', reason: 'requires a new explicit command with approved provider caps' },
    ],
    manualQa: {
      requested: process.env.ASSISTANT_PIDAFIX3_MANUAL_QA === 'true',
      runtimeReady: false,
      completed: false,
    },
    cleanup: { completed: false, residualResources: null, preexistingContainersPreserved: null },
  };
  const beforeContainers = new Set(splitLines(await readCommand('docker', ['ps', '--quiet'], {
    env: composeEnvironment,
  })));
  let primaryError = null;
  let cleanupError = null;

  try {
    await runRecorded(report.setup, 'compose-config', 'docker', [...compose, 'config', '--quiet'], {
      env: composeEnvironment, secrets,
    });
    await runRecorded(report.setup, 'compose-build', 'docker', [...compose, 'build', 'postgres', 'api', 'web'], {
      env: composeEnvironment, secrets, timeoutMs: 15 * 60_000,
    });
    for (const [key, image] of Object.entries({
      postgres: composeEnvironment.PIDAFIX3_POSTGRES_IMAGE,
      api: composeEnvironment.PIDAFIX3_API_IMAGE,
      web: composeEnvironment.PIDAFIX3_WEB_IMAGE,
    })) {
      report.images[key] = {
        name: image,
        id: await readCommand('docker', ['image', 'inspect', '--format', '{{.Id}}', image], {
          env: composeEnvironment,
        }),
      };
    }
    await runRecorded(report.setup, 'postgres-up', 'docker', [...compose, 'up', '--detach', '--wait', 'postgres'], {
      env: composeEnvironment, secrets, timeoutMs: 3 * 60_000,
    });
    await migrateDatabase({ compose, composeEnvironment, name: 'platforma_pidafix3', report, secrets });
    await seedMigrationBaseline(hostDatabaseUrl, { abortSignal: options.abortSignal });

    const gateDatabases = ['fix_token_test', 't03_test', 't05_test', 'pidafix2_test'];
    for (const name of gateDatabases) {
      await runRecorded(report.setup, `create-db-${name}`, 'docker', [
        ...compose, 'exec', '--no-TTY', 'postgres', 'createdb', '--username', 'platforma', name,
      ], { env: composeEnvironment, secrets });
      await migrateDatabase({ compose, composeEnvironment, name, report, secrets });
    }

    await runRecorded(report.setup, 'api-web-up', 'docker', [
      ...compose, 'up', '--detach', '--wait', 'api', 'web',
    ], { env: composeEnvironment, secrets, timeoutMs: 5 * 60_000 });
    report.readiness = await verifyRuntimeReadiness({
      apiOrigin: `http://127.0.0.1:${apiPort}`,
      abortSignal: options.abortSignal,
      databaseUrl: hostDatabaseUrl,
      webOrigin: `http://127.0.0.1:${webPort}`,
    });

    const gateEnvironment = createSafeEnvironment(composeEnvironment, {
      DATABASE_URL: hostDatabaseUrl,
      ASSISTANT_FIX_TOKEN_TEST_DATABASE_URL: databaseUrl({
        postgresPassword, postgresPort, name: 'fix_token_test',
      }),
      ASSISTANT_T03_TEST_DATABASE_URL: databaseUrl({
        postgresPassword, postgresPort, name: 't03_test',
      }),
      ASSISTANT_T05_TEST_DATABASE_URL: databaseUrl({
        postgresPassword, postgresPort, name: 't05_test',
      }),
      ASSISTANT_PIDAFIX2_TEST_DATABASE_URL: databaseUrl({
        postgresPassword, postgresPort, name: 'pidafix2_test',
      }),
      ASSISTANT_T05_API_TEST_URL: `http://127.0.0.1:${apiPort}`,
      ASSISTANT_T05_WEB_TEST_URL: `http://127.0.0.1:${webPort}`,
      ASSISTANT_SOURCE_BROWSER_EXECUTABLE_PATH: chromium.executablePath(),
      ASSISTANT_T07_SKIP_DOCKER_BUILD: 'true',
      ASSISTANT_T07_API_IMAGE: composeEnvironment.PIDAFIX3_API_IMAGE,
      ASSISTANT_T07_POSTGRES_IMAGE: composeEnvironment.PIDAFIX3_POSTGRES_IMAGE,
      ASSISTANT_T07_QA_ARTIFACT_DIR: qaDirectory,
      ASSISTANT_T07_PARENT_PROJECT: project,
      ASSISTANT_T07_RESOURCE_SUFFIX: suffix,
      ASSISTANT_T07_PROVIDER_EVIDENCE_NONCE: providerEvidenceNonce,
      ASSISTANT_T07_PROVIDER_EVIDENCE_PATH: providerEvidencePath,
      ASSISTANT_T07_MANUAL_QA_HOLD: process.env.ASSISTANT_PIDAFIX3_MANUAL_QA === 'true' ? 'true' : 'false',
    });
    secrets.push(
      gateEnvironment.DATABASE_URL,
      gateEnvironment.ASSISTANT_FIX_TOKEN_TEST_DATABASE_URL,
      gateEnvironment.ASSISTANT_T03_TEST_DATABASE_URL,
      gateEnvironment.ASSISTANT_T05_TEST_DATABASE_URL,
      gateEnvironment.ASSISTANT_PIDAFIX2_TEST_DATABASE_URL,
    );
    for (const plannedGate of createGatePlan()) {
      const gateResult = await runRecorded(report.gates, plannedGate.id, plannedGate.command, plannedGate.args, {
        env: gateEnvironment,
        secrets,
        timeoutMs: plannedGate.id === 't07-connected-e2e' && report.manualQa.requested
          ? 30 * 60_000
          : plannedGate.timeoutMs,
        ...(plannedGate.id === 't07-connected-e2e' && report.manualQa.requested ? {
          onStdout: (chunk) => process.stdout.write(chunk),
          onStderr: (chunk) => process.stderr.write(redact(chunk, secrets)),
        } : {}),
      });
      if (plannedGate.id === 't07-connected-e2e') {
        report.currentFactFixtureEvidence = verifyT07CurrentFactFixtureEvidence(
          gateResult.stdout,
        );
        report.manualQa.runtimeReady = gateResult.stdout.includes('ASSISTANT_T07_MANUAL_QA_READY ');
        report.manualQa.completed = report.manualQa.requested && report.manualQa.runtimeReady;
        if (report.manualQa.requested && !report.manualQa.completed) {
          throw new Error('PIDAFIX3_MANUAL_QA_HOLD_NOT_REACHED');
        }
        report.externalProviderEvidence = verifyT07ProviderEvidence(
          JSON.parse(await readFile(providerEvidencePath, 'utf8')),
          providerEvidenceNonce,
        );
      }
    }
    await runTaskDiffCheck(report.gates, gateEnvironment, secrets);
    report.screenshots.files = splitLines(await readCommand('find', [
      qaDirectory, '-maxdepth', '1', '-type', 'f', '-name', '*.png', '-print',
    ], { env: gateEnvironment })).sort();
    report.costUsd = 0;
    report.costBasis = 'policy-derived: fake modes, paid confirmation false, provider credentials removed';
  } catch (error) {
    const runtimeLogs = await runCommand('docker', [
      ...compose, 'logs', '--no-color', '--tail', '200', 'postgres', 'api', 'web',
    ], { env: composeEnvironment, timeoutMs: 30_000, allowDuringShutdown: true });
    const safeRuntimeLogs = redact(`${runtimeLogs.stdout}\n${runtimeLogs.stderr}`.trim(), secrets);
    report.runtimeLogs = safeRuntimeLogs;
    const originalMessage = error instanceof Error ? error.message : String(error);
    primaryError = new Error(`${originalMessage}${safeRuntimeLogs ? `\nRuntime logs:\n${safeRuntimeLogs}` : ''}`);
    report.failure = redact(primaryError.message, secrets);
  } finally {
    try {
      await cleanupComposeProject({
        beforeContainers,
        compose,
        composeEnvironment,
        project,
        report,
        secrets,
        taskImages: [
          composeEnvironment.PIDAFIX3_POSTGRES_IMAGE,
          composeEnvironment.PIDAFIX3_API_IMAGE,
          composeEnvironment.PIDAFIX3_WEB_IMAGE,
        ],
      });
    } catch (error) {
      cleanupError = error;
      report.cleanup.error = redact(error instanceof Error ? error.message : error, secrets);
    }
    report.finishedAt = new Date().toISOString();
    const reportPath = join(qaDirectory, 'pidafix3-baseline-report.json');
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`PIDAFIX3_REPORT=${reportPath}\n`);
  }

  if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError], 'PIDAFIX3_BASELINE_AND_CLEANUP_FAILED');
  if (cleanupError) throw cleanupError;
  if (primaryError) throw primaryError;
  process.stdout.write('ASSISTANT_PIDAFIX3_BASELINE_OK\n');
}

async function migrateDatabase({ compose, composeEnvironment, name, report, secrets }) {
  const environment = {
    ...composeEnvironment,
    DATABASE_URL: `postgresql://platforma:${composeEnvironment.PIDAFIX3_POSTGRES_PASSWORD}@postgres:5432/${name}?schema=public`,
  };
  await runRecorded(report.setup, `migrate-${name}`, 'docker', [
    ...compose, 'run', '--rm', '--no-deps', '--env', 'DATABASE_URL', 'api',
    'pnpm', '--dir', 'apps/api', 'exec', 'prisma', 'migrate', 'deploy',
    '--schema', '/app/apps/api/prisma/schema.prisma',
  ], { env: environment, secrets, timeoutMs: 3 * 60_000 });
  await runRecorded(report.setup, `migration-status-${name}`, 'docker', [
    ...compose, 'run', '--rm', '--no-deps', '--env', 'DATABASE_URL', 'api',
    'pnpm', '--dir', 'apps/api', 'exec', 'prisma', 'migrate', 'status',
    '--schema', '/app/apps/api/prisma/schema.prisma',
  ], { env: environment, secrets, timeoutMs: 2 * 60_000 });
}

async function verifyRuntimeReadiness({
  apiOrigin,
  abortSignal,
  databaseUrl: runtimeDatabaseUrl,
  webOrigin,
}) {
  const prisma = new PrismaClient({ datasources: { db: { url: runtimeDatabaseUrl } } });
  const loginPassword = `Local-${randomUUID()}`;
  const readinessStep = (id, operation, timeoutMs = 15_000) => runBoundedOperation(
    `READINESS_${id}`,
    operation,
    { abortSignal, timeoutMs },
  );
  try {
    await readinessStep('DATABASE_CONNECT', () => prisma.$connect());
    const [databaseFacts] = await readinessStep('DATABASE_FACTS', () => prisma.$queryRawUnsafe(`
      SELECT
        PostGIS_Version() AS "postgisVersion",
        to_regclass('public.assistant_geo_landmarks')::text AS "landmarkTable"
    `));
    assert.ok(databaseFacts.postgisVersion);
    assert.equal(databaseFacts.landmarkTable, 'assistant_geo_landmarks');
    assert.equal(await readinessStep('BACKLOG', () => prisma.assistantRun.count({
      where: { status: { in: ['PENDING', 'RUNNING'] } },
    })), 0);

    const permissionIds = [];
    for (const key of ['objects:read', 'admin:access']) {
      const permission = await readinessStep('PERMISSION_UPSERT', () => prisma.permission.upsert({
        where: { key },
        update: {},
        create: { key, description: `PIDAFIX3 local ${key}` },
      }));
      permissionIds.push(permission.id);
    }
    const role = await readinessStep('ROLE_CREATE', () => prisma.role.create({
      data: {
        name: `pidafix3-local-${randomUUID().slice(0, 8)}`,
        permissions: { create: permissionIds.map((permissionId) => ({ permissionId })) },
      },
    }));
    const passwordHash = await readinessStep('PASSWORD_HASH', () => hash(loginPassword), 30_000);
    const user = await readinessStep('USER_CREATE', () => prisma.user.create({
      data: {
        email: `pidafix3-${randomUUID().slice(0, 8)}@example.test`,
        name: 'PIDAFIX3 Local User',
        passwordHash,
        roleId: role.id,
        status: 'ACTIVE',
      },
    }));
    assert.equal((await readinessStep('API_HEALTH', (signal) => fetch(
      `${apiOrigin}/health`, { signal },
    ), 10_000)).status, 200);
    assert.equal((await readinessStep('WEB_HEALTH', (signal) => fetch(
      webOrigin, { signal },
    ), 10_000)).status, 200);
    assert.equal((await readinessStep('UNAUTHENTICATED_CONFIG', (signal) => fetch(
      `${apiOrigin}/assistant/config`, { signal },
    ), 10_000)).status, 401);
    const loginResponse = await readinessStep('LOGIN', (signal) => fetch(`${apiOrigin}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: user.email, password: loginPassword }),
      signal,
    }), 10_000);
    assert.equal(loginResponse.status, 200);
    const session = await readinessStep('LOGIN_JSON', () => loginResponse.json(), 5_000);
    const configResponse = await readinessStep('AUTHENTICATED_CONFIG', (signal) => fetch(
      `${apiOrigin}/assistant/config`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
        signal,
      },
    ), 10_000);
    assert.equal(configResponse.status, 200);
    const config = await readinessStep('CONFIG_JSON', () => configResponse.json(), 5_000);
    assert.equal(config.enabled, true);
    return {
      healthStatus: 200,
      webStatus: 200,
      unauthenticatedAssistantStatus: 401,
      authenticatedAssistantStatus: 200,
      assistantEnabled: true,
      permissionKeys: ['objects:read', 'admin:access'],
      seedMode: 'minimal-rbac-without-db-seed',
      assistantBacklog: 0,
      postgisVersion: databaseFacts.postgisVersion,
      landmarkTable: databaseFacts.landmarkTable,
    };
  } finally {
    await runBoundedOperation('READINESS_DATABASE_DISCONNECT', () => prisma.$disconnect(), {
      timeoutMs: 5_000,
    });
  }
}

async function seedMigrationBaseline(runtimeDatabaseUrl, options = {}) {
  const prisma = new PrismaClient({ datasources: { db: { url: runtimeDatabaseUrl } } });
  const seedStep = (id, operation) => runBoundedOperation(`SEED_${id}`, operation, {
    abortSignal: options.abortSignal,
    timeoutMs: 15_000,
  });
  try {
    await seedStep('DATABASE_CONNECT', () => prisma.$connect());
    const existing = await seedStep('ROLLOUT_READ', () => prisma.assistantRolloutEvent.findUnique({
      where: { stage: 'ADMINS' },
    }));
    if (existing) {
      assert.equal(existing.gateDigest, '0'.repeat(64));
      assert.deepEqual(existing.approvalJson, {
        kind: 'MIGRATION_BASELINE', passed: true, targetStage: 'ADMINS',
      });
      return;
    }
    await seedStep('ROLLOUT_CREATE', () => prisma.assistantRolloutEvent.create({
      data: {
        stage: 'ADMINS',
        gateDigest: '0'.repeat(64),
        approvalJson: { kind: 'MIGRATION_BASELINE', passed: true, targetStage: 'ADMINS' },
      },
    }));
  } finally {
    await runBoundedOperation('SEED_DATABASE_DISCONNECT', () => prisma.$disconnect(), {
      timeoutMs: 5_000,
    });
  }
}

async function cleanupComposeProject({
  beforeContainers,
  compose,
  composeEnvironment,
  project,
  report,
  secrets,
  taskImages,
}) {
  const cleanupFailures = [];
  const nestedLabel = `label=com.platforma.assistant-t07.parent=${project}`;
  const nestedContainers = splitLines(await readCommand('docker', [
    'ps', '--all', '--quiet', '--filter', nestedLabel,
  ], { env: composeEnvironment, allowDuringShutdown: true }));
  if (nestedContainers.length > 0) {
    const result = await runRecorded(report.setup, 'nested-t07-containers-rm', 'docker', [
      'rm', '--force', ...nestedContainers,
    ], {
      env: composeEnvironment, secrets, timeoutMs: 60_000, allowFailure: true,
      allowDuringShutdown: true,
    });
    if (result.status !== 0) cleanupFailures.push(new Error('PIDAFIX3_NESTED_CONTAINER_CLEANUP_FAILED'));
  }
  const nestedNetworks = splitLines(await readCommand('docker', [
    'network', 'ls', '--quiet', '--filter', nestedLabel,
  ], { env: composeEnvironment, allowDuringShutdown: true }));
  if (nestedNetworks.length > 0) {
    const result = await runRecorded(report.setup, 'nested-t07-networks-rm', 'docker', [
      'network', 'rm', ...nestedNetworks,
    ], {
      env: composeEnvironment, secrets, timeoutMs: 60_000, allowFailure: true,
      allowDuringShutdown: true,
    });
    if (result.status !== 0) cleanupFailures.push(new Error('PIDAFIX3_NESTED_NETWORK_CLEANUP_FAILED'));
  }
  const down = await runRecorded(report.setup, 'compose-down', 'docker', [
    ...compose, 'down', '--volumes', '--remove-orphans',
  ], {
    env: composeEnvironment, secrets, timeoutMs: 5 * 60_000, allowFailure: true,
    allowDuringShutdown: true,
  });
  if (down.status !== 0) cleanupFailures.push(new Error('PIDAFIX3_COMPOSE_DOWN_FAILED'));
  for (const image of taskImages) {
    const inspect = await runCommand('docker', ['image', 'inspect', image], {
      env: composeEnvironment,
      timeoutMs: 30_000,
      allowDuringShutdown: true,
    });
    if (inspect.status !== 0) continue;
    const removed = await runRecorded(report.setup, `image-rm-${image.split(':')[0].split('-').at(-1)}`, 'docker', [
      'image', 'rm', '--force', image,
    ], {
      env: composeEnvironment, secrets, timeoutMs: 60_000, allowFailure: true,
      allowDuringShutdown: true,
    });
    if (removed.status !== 0) cleanupFailures.push(new Error(`PIDAFIX3_IMAGE_CLEANUP_FAILED:${image}`));
  }
  const filters = composeResourceFilters(project);
  const residual = {
    containers: splitLines(await readCommand('docker', filters.containers, {
      env: composeEnvironment, allowDuringShutdown: true,
    })),
    networks: splitLines(await readCommand('docker', filters.networks, {
      env: composeEnvironment, allowDuringShutdown: true,
    })),
    volumes: splitLines(await readCommand('docker', filters.volumes, {
      env: composeEnvironment, allowDuringShutdown: true,
    })),
    nestedContainers: splitLines(await readCommand('docker', [
      'ps', '--all', '--quiet', '--filter', nestedLabel,
    ], { env: composeEnvironment, allowDuringShutdown: true })),
    nestedNetworks: splitLines(await readCommand('docker', [
      'network', 'ls', '--quiet', '--filter', nestedLabel,
    ], { env: composeEnvironment, allowDuringShutdown: true })),
    images: [],
  };
  for (const image of taskImages) {
    const inspect = await runCommand('docker', ['image', 'inspect', '--format', '{{.Id}}', image], {
      env: composeEnvironment,
      timeoutMs: 30_000,
      allowDuringShutdown: true,
    });
    if (inspect.status === 0) residual.images.push(image);
  }
  const afterContainers = new Set(splitLines(await readCommand('docker', ['ps', '--quiet'], {
    env: composeEnvironment, allowDuringShutdown: true,
  })));
  const missingPreexisting = [...beforeContainers].filter((id) => !afterContainers.has(id));
  report.cleanup = {
    completed: cleanupFailures.length === 0
      && Object.values(residual).every((items) => items.length === 0)
      && missingPreexisting.length === 0,
    residualResources: residual,
    preexistingContainersPreserved: missingPreexisting.length === 0,
    exactImageTagsRemoved: residual.images.length === 0,
  };
  assert.deepEqual(residual, {
    containers: [], networks: [], volumes: [], nestedContainers: [], nestedNetworks: [], images: [],
  });
  assert.deepEqual(missingPreexisting, []);
  if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures, 'PIDAFIX3_CLEANUP_COMMAND_FAILED');
}

async function runRecorded(target, id, command, args, options = {}) {
  process.stdout.write(`[PIDAFIX3] START ${id}\n`);
  const startedAt = Date.now();
  const result = await runCommand(command, args, options);
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  const tapTestCount = parseTestCount(combinedOutput);
  const okMarkers = [...combinedOutput.matchAll(/\b[A-Z][A-Z0-9_]+_OK\b/gu)].map(([marker]) => marker);
  const record = {
    id,
    command: [command, ...args],
    exitCode: result.status,
    durationMs: Date.now() - startedAt,
    testCount: tapTestCount ?? okMarkers.length,
    testCountSource: tapTestCount !== null
      ? 'tap-summary'
      : okMarkers.length > 0 ? 'suite-ok-markers' : 'not-a-test-summary',
    okMarkers,
  };
  target.push(record);
  process.stdout.write(`[PIDAFIX3] ${result.status === 0 ? 'OK' : 'FAIL'} ${id} (${record.durationMs}ms)\n`);
  if (result.status !== 0 && !options.allowFailure) {
    const tail = combinedOutput.split('\n').slice(-80).join('\n');
    throw new Error(`${id} failed with exit code ${result.status}\n${redact(tail, options.secrets)}`);
  }
  return result;
}

function createTaskDiffCheckPlan() {
  return {
    paths: [...taskCheckPaths],
    trackedArgs: ['diff', '--check', 'HEAD', '--', ...taskCheckPaths],
    listTrackedArgs: ['ls-files', '--cached', '--', ...taskCheckPaths],
    untrackedArgs: (path) => ['diff', '--no-index', '--check', '--', '/dev/null', path],
  };
}

async function runTaskDiffCheck(target, environment, secrets) {
  const id = 'git-diff-check';
  const plan = createTaskDiffCheckPlan();
  const startedAt = Date.now();
  process.stdout.write(`[PIDAFIX3] START ${id}\n`);
  let exitCode = 0;
  let diagnostic = '';
  const checkedUntrackedPaths = [];
  try {
    const trackedDiff = await runCommand('git', plan.trackedArgs, { env: environment });
    if (trackedDiff.status !== 0) {
      exitCode = trackedDiff.status;
      diagnostic = `${trackedDiff.stdout}\n${trackedDiff.stderr}`.trim();
      throw new Error('PIDAFIX3_TRACKED_DIFF_CHECK_FAILED');
    }
    const trackedFilesResult = await runCommand('git', plan.listTrackedArgs, { env: environment });
    if (trackedFilesResult.status !== 0) {
      exitCode = trackedFilesResult.status;
      diagnostic = `${trackedFilesResult.stdout}\n${trackedFilesResult.stderr}`.trim();
      throw new Error('PIDAFIX3_TRACKED_FILE_LIST_FAILED');
    }
    const trackedFiles = new Set(splitLines(trackedFilesResult.stdout));
    for (const path of plan.paths.filter((candidate) => !trackedFiles.has(candidate))) {
      const file = await stat(resolve(root, path));
      assert.equal(file.isFile(), true, `PIDAFIX3_DIFF_CHECK_NOT_A_FILE:${path}`);
      const result = await runCommand('git', plan.untrackedArgs(path), { env: environment });
      checkedUntrackedPaths.push(path);
      const output = `${result.stdout}${result.stderr}`;
      if (![0, 1].includes(result.status) || output.length > 0) {
        exitCode = result.status;
        diagnostic = output.trim();
        throw new Error(`PIDAFIX3_UNTRACKED_DIFF_CHECK_FAILED:${path}`);
      }
    }
  } catch (error) {
    if (exitCode === 0) exitCode = 1;
    diagnostic ||= error instanceof Error ? error.message : String(error);
  }
  const record = {
    id,
    command: ['git', ...plan.trackedArgs],
    exitCode,
    durationMs: Date.now() - startedAt,
    testCount: 0,
    testCountSource: 'not-a-test-summary',
    okMarkers: [],
    checkedUntrackedPaths,
  };
  target.push(record);
  process.stdout.write(`[PIDAFIX3] ${exitCode === 0 ? 'OK' : 'FAIL'} ${id} (${record.durationMs}ms)\n`);
  if (exitCode !== 0) {
    throw new Error(`${id} failed with exit code ${exitCode}\n${redact(diagnostic, secrets)}`);
  }
}

function runCommand(command, args, options = {}) {
  return runRuntimeCommand(command, args, { cwd: options.cwd ?? root, ...options });
}

async function readCommand(command, args, options = {}) {
  const result = await runCommand(command, args, options);
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
  return result.stdout.trim();
}

function parseTestCount(output) {
  const counts = [...output.matchAll(/^(?:[^\n]*? test: )?(?:#|ℹ) tests (\d+)$/gmu)]
    .map((match) => Number(match[1]));
  return counts.length > 0 ? counts.reduce((total, count) => total + count, 0) : null;
}

function verifyT07CurrentFactFixtureEvidence(stdout) {
  const matches = [...String(stdout).matchAll(/^ASSISTANT_T07_MORTGAGE_FIXTURE_OK:(\d+)$/gmu)];
  if (matches.length !== 1 || Number(matches[0][1]) !== 20
    || !String(stdout).includes('ASSISTANT_T07_E2E_OK')) {
    throw new Error('PIDAFIX3_CURRENT_FACT_FIXTURE_EVIDENCE_INVALID');
  }
  return {
    status: 'verified',
    scope: 't07-connected-e2e',
    caseCount: 20,
    mode: 'fixture',
    externalConnectorsEnabled: false,
  };
}

function splitLines(value) {
  return value.split('\n').map((line) => line.trim()).filter(Boolean);
}

function databaseUrl({ postgresPassword, postgresPort, name }) {
  return `postgresql://platforma:${encodeURIComponent(postgresPassword)}@127.0.0.1:${postgresPort}/${name}?schema=public`;
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.equal(typeof address, 'object');
  const port = address.port;
  await new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
  return port;
}

async function calculateTaskDiffSha(environment) {
  const diff = await readCommand('git', ['diff', '--binary', 'HEAD', '--', ...taskPaths], { env: environment });
  const status = await readCommand('git', ['status', '--porcelain=v1', '--', ...taskPaths], { env: environment });
  const hashState = createHash('sha256').update(diff);
  for (const line of splitLines(status)) {
    if (!line.startsWith('?? ')) continue;
    const relativePath = line.slice(3);
    hashState.update(`\nUNTRACKED:${relativePath}\n`);
    hashState.update(await readFile(resolve(root, relativePath)));
  }
  return hashState.digest('hex');
}

module.exports = {
  calculateTaskDiffSha,
  cleanupComposeProject,
  composeResourceFilters,
  createBaselineGateManifest,
  createGatePlan,
  createSafeEnvironment,
  createTaskDiffCheckPlan,
  isSensitiveOrLiveKey,
  migrateDatabase,
  parseTestCount,
  redact,
  reservePort,
  runCommand,
  runRecorded,
  runTaskDiffCheck,
  seedMigrationBaseline,
  verifyT07CurrentFactFixtureEvidence,
};
