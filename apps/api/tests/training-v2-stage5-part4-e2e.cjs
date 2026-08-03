#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');

const INNER_FLAG = '--inner';
const RESOURCE_PREFIX = 'platforma-training-v2-e2e';

if (process.argv.includes(INNER_FLAG)) {
  runInner().catch(fail);
} else {
  runOuter().catch(fail);
}

async function runOuter() {
  const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
  const resources = {
    network: `${RESOURCE_PREFIX}-${suffix}`,
    postgres: `${RESOURCE_PREFIX}-postgres-${suffix}`,
    minio: `${RESOURCE_PREFIX}-minio-${suffix}`,
    web: `${RESOURCE_PREFIX}-web-${suffix}`,
    e2e: `${RESOURCE_PREFIX}-runner-${suffix}`,
    shutdown: `${RESOURCE_PREFIX}-shutdown-${suffix}`,
    postgresVolume: `${RESOURCE_PREFIX}-postgres-data-${suffix}`,
    minioVolume: `${RESOURCE_PREFIX}-minio-data-${suffix}`,
  };
  let activeChild = null;
  let cleanupPromise = null;
  let interrupted = false;

  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      activeChild?.kill('SIGTERM');
      await runAllowFailure('docker', [
        'rm', '-f',
        resources.e2e,
        resources.shutdown,
        resources.web,
        resources.minio,
        resources.postgres,
      ], { silent: true });
      await runAllowFailure('docker', [
        'volume', 'rm', resources.minioVolume, resources.postgresVolume,
      ], { silent: true });
      await runAllowFailure('docker', ['network', 'rm', resources.network], { silent: true });
    })();
    return cleanupPromise;
  };

  const handleSignal = (signal) => {
    if (interrupted) return;
    interrupted = true;
    process.stderr.write(`TRAINING_V2_E2E_${signal}_CLEANUP\n`);
    void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  try {
    await run('docker', ['version', '--format', '{{.Server.Version}}']);
    await run('docker', ['compose', '--progress', 'plain', 'build', 'api', 'web']);
    await run('docker', ['network', 'create', resources.network]);
    await run('docker', ['volume', 'create', resources.postgresVolume]);
    await run('docker', ['volume', 'create', resources.minioVolume]);
    await run('docker', [
      'run', '-d', '--platform', 'linux/amd64',
      '--name', resources.postgres,
      '--network', resources.network,
      '--network-alias', 'postgres',
      '-e', 'POSTGRES_DB=platforma_e2e',
      '-e', 'POSTGRES_USER=platforma_e2e',
      '-e', 'POSTGRES_PASSWORD=platforma_e2e_password',
      '-v', `${resources.postgresVolume}:/var/lib/postgresql/data`,
      'postgis/postgis:16-3.5',
    ]);
    await run('docker', [
      'run', '-d',
      '--name', resources.minio,
      '--network', resources.network,
      '--network-alias', 'minio',
      '-e', 'MINIO_ROOT_USER=platforma_e2e',
      '-e', 'MINIO_ROOT_PASSWORD=platforma_e2e_password',
      '-v', `${resources.minioVolume}:/data`,
      'minio/minio:latest',
      'server', '/data', '--console-address', ':9001',
    ]);

    await waitForCommand(
      'temporary PostgreSQL',
      'docker',
      ['exec', resources.postgres, 'pg_isready', '-U', 'platforma_e2e', '-d', 'platforma_e2e'],
    );
    await waitForCommand(
      'isolated MinIO',
      'docker',
      ['exec', resources.minio, 'mc', 'ready', 'local'],
    );

    const commonEnvironment = dockerEnvironment();
    await run('docker', [
      'run', '--rm',
      '--network', resources.network,
      ...commonEnvironment,
      'platforma-api:latest',
      'pnpm', '--dir', 'apps/api', 'exec', 'prisma', 'validate', '--schema', 'prisma/schema.prisma',
    ]);
    await run('docker', [
      'run', '--rm',
      '--network', resources.network,
      ...commonEnvironment,
      'platforma-api:latest',
      'pnpm', '--dir', 'apps/api', 'exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma',
    ]);
    await run('docker', [
      'run', '--rm',
      '--network', resources.network,
      ...commonEnvironment,
      'platforma-api:latest',
      'pnpm', '--dir', 'apps/api', 'exec', 'prisma', 'migrate', 'status', '--schema', 'prisma/schema.prisma',
    ]);

    await run('docker', [
      'run', '-d',
      '--name', resources.web,
      '--network', resources.network,
      '--network-alias', 'web',
      'platforma-web:latest',
    ]);
    await waitForCommand(
      'built web',
      'docker',
      ['exec', resources.web, 'node', '-e',
        "fetch('http://127.0.0.1:5173').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"],
    );

    activeChild = await run('docker', [
      'run', '--rm',
      '--name', resources.e2e,
      '--network', resources.network,
      '--network-alias', 'api',
      ...commonEnvironment,
      'platforma-api:latest',
      'node', 'apps/api/tests/training-v2-stage5-part4-e2e.cjs', INNER_FLAG,
    ], { returnChild: true });
    activeChild = null;

    const shutdownStartedAt = Date.now();
    await run('docker', [
      'run', '-d',
      '--name', resources.shutdown,
      '--network', resources.network,
      ...commonEnvironment,
      '-e', 'TRAINING_VOICE_WORKER_ENABLED=false',
      'platforma-api:latest',
    ]);
    await waitForCommand(
      'API graceful-shutdown fixture',
      'docker',
      ['exec', resources.shutdown, 'node', '-e',
        "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"],
    );
    await run('docker', ['stop', '--time', '10', resources.shutdown]);
    const stopped = await capture('docker', [
      'inspect', '-f', '{{.State.ExitCode}} {{.State.Status}}', resources.shutdown,
    ]);
    assert.equal(stopped.trim(), '0 exited');
    process.stdout.write(`graceful_shutdown_ms=${Date.now() - shutdownStartedAt}\n`);
    process.stdout.write('TRAINING_V2_STAGE5_PART4_E2E_OK\n');
  } finally {
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('SIGTERM', handleSignal);
    await cleanup();
  }
}

function dockerEnvironment() {
  const values = {
    NODE_ENV: 'test',
    PORT: '3000',
    DATABASE_URL: 'postgresql://platforma_e2e:platforma_e2e_password@postgres:5432/platforma_e2e?schema=public',
    FEED_AUTO_IMPORT_ENABLED: 'false',
    WEB_ORIGIN: 'http://web:5173',
    PUBLIC_APP_URL: 'http://web:5173',
    S3_ENDPOINT: 'http://minio:9000',
    S3_PUBLIC_ENDPOINT: 'http://minio:9000',
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY_ID: 'platforma_e2e',
    S3_SECRET_ACCESS_KEY: 'platforma_e2e_password',
    MINIO_BUCKET: 'platforma-e2e-general',
    TRAINING_AUDIO_BUCKET: 'platforma-e2e-training-audio',
    TRAINING_MATERIAL_BUCKET: 'platforma-e2e-training-materials',
    TRAINING_MODULE_ENABLED: 'true',
    TRAINING_VOICE_WORKER_ENABLED: 'false',
    TRAINING_VOICE_WORKER_CONCURRENCY: '3',
    TRAINING_VOICE_WORKER_POLL_INTERVAL_MS: '250',
    TRAINING_VOICE_HEARTBEAT_INTERVAL_MS: '250',
    TRAINING_VOICE_STALE_LOCK_MS: '1000',
    TRAINING_VOICE_WORKER_SHUTDOWN_DRAIN_MS: '250',
    TELEGRAM_TRANSPORT_MODE: 'fake',
    TELEGRAM_BOT_USERNAME: 'platforma_e2e_bot',
    TELEGRAM_WEBHOOK_SECRET: 'platforma-e2e-webhook-secret',
    TRAINING_AI_MODE: 'fake',
    OPENAI_API_KEY: '',
    OPENAI_TRANSCRIPTION_MODEL: '',
    OPENAI_EVALUATION_MODEL: '',
    TRAINING_MATERIAL_BROWSER_EXECUTABLE_PATH: '/usr/bin/chromium-browser',
    JWT_ACCESS_SECRET: 'platforma-e2e-access-secret',
    JWT_REFRESH_SECRET: 'platforma-e2e-refresh-secret',
    JWT_MEDIA_SECRET: 'platforma-e2e-media-secret',
  };
  return Object.entries(values).flatMap(([name, value]) => ['-e', `${name}=${value}`]);
}

async function runInner() {
  require('reflect-metadata');
  const { NestFactory } = require('@nestjs/core');
  const { JwtService } = require('@nestjs/jwt');
  const { Prisma } = require('@prisma/client');
  const PDFDocument = require('pdfkit');
  const { chromium } = require('playwright-core');
  const { AppModule } = require('../dist/app.module.js');
  const { PrismaService } = require('../dist/prisma/prisma.service.js');
  const { S3StorageService } = require('../dist/files/s3-storage.service.js');
  const { TrainingAudioService } = require('../dist/training/training-audio.service.js');
  const { TrainingAttemptStateService } = require('../dist/training/training-attempt-state.service.js');
  const { TRAINING_EVALUATOR } = require('../dist/training/training-evaluator.js');
  const { TrainingMaterialExtractionService } = require('../dist/training/training-material-extraction.js');
  const {
    TrainingMaterialService,
  } = require('../dist/training/training-material.service.js');
  const {
    TRAINING_MATERIAL_SUGGESTER,
  } = require('../dist/training/training-material-suggester.js');
  const { TrainingProjectAccessService } = require('../dist/training/training-project-access.service.js');
  const { TrainingRankingService } = require('../dist/training/training-ranking.service.js');
  const {
    FakeTrainingTelegramClient,
  } = require('../dist/training/training-telegram-client.js');
  const { TrainingTelegramService } = require('../dist/training/training-telegram.service.js');
  const {
    DeterministicFakeTrainingTranscriber,
  } = require('../dist/training/training-transcriber.js');
  const {
    TrainingVoiceWorkerService,
  } = require('../dist/training/training-voice-worker.service.js');
  const { TrainingOpenAIError } = require('../dist/training/training-openai-client.js');

  let app;
  let browser;
  try {
    app = await NestFactory.create(AppModule, { logger: false });
    app.enableCors({ origin: ['http://web:5173'], credentials: true });
    app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
    await app.listen(3000, '0.0.0.0');

    const prisma = app.get(PrismaService);
    const storage = app.get(S3StorageService);
    const fakeTelegram = app.get(FakeTrainingTelegramClient);
    const telegram = app.get(TrainingTelegramService);
    const audio = app.get(TrainingAudioService);
    const attemptState = app.get(TrainingAttemptStateService);
    const evaluator = app.get(TRAINING_EVALUATOR);
    const baseTranscriber = app.get(DeterministicFakeTrainingTranscriber);
    const access = app.get(TrainingProjectAccessService);
    const jwt = new JwtService();
    const identities = await seedIdentities(prisma, jwt);
    const context = {
      app,
      prisma,
      storage,
      fakeTelegram,
      telegram,
      audio,
      attemptState,
      evaluator,
      baseTranscriber,
      access,
      jwt,
      identities,
      Prisma,
      PDFDocument,
      TrainingMaterialExtractionService,
      TrainingMaterialService,
      TRAINING_MATERIAL_SUGGESTER,
      TrainingRankingService,
      TrainingVoiceWorkerService,
      TrainingOpenAIError,
      markers: new Map(),
      updateId: 1000,
      messageId: 10000,
    };

    await runConnectedScenario(context);
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.TRAINING_MATERIAL_BROWSER_EXECUTABLE_PATH,
      args: ['--no-sandbox'],
    });
    await runBrowserChecks(context, browser);
    await runRevokeCloseAndSnapshotChecks(context, browser);
    await runFinalSecurityChecks(context);
    process.stdout.write(JSON.stringify(context.evidence) + '\n');
    process.stdout.write('TRAINING_V2_STAGE5_PART4_CONNECTED_INNER_OK\n');
  } finally {
    await browser?.close().catch(() => undefined);
    await app?.close().catch(() => undefined);
  }
}

async function seedIdentities(prisma, jwt) {
  const permissionKeys = [
    'admin:access',
    'objects:read',
    'training:participate',
    'training:projects:manage',
    'training:results:read',
    'training:results:review',
    'training:audio:read',
  ];
  const permissions = new Map();
  for (const key of permissionKeys) {
    const permission = await prisma.permission.upsert({
      where: { key },
      update: {},
      create: { key, description: `E2E ${key}` },
    });
    permissions.set(key, permission);
  }

  const createRole = async (label, keys) => {
    const role = await prisma.role.create({ data: { name: `e2e-${label}-${randomUUID()}` } });
    if (keys.length) {
      await prisma.rolePermission.createMany({
        data: keys.map((key) => ({ roleId: role.id, permissionId: permissions.get(key).id })),
      });
    }
    return role;
  };
  const roles = {
    admin: await createRole(
      'admin',
      permissionKeys.filter((key) => key !== 'training:participate'),
    ),
    employee: await createRole('employee', ['training:participate']),
    denied: await createRole('denied', []),
    reader: await createRole('reader', ['training:results:read']),
    reviewer: await createRole('reviewer', ['training:results:review']),
    audio: await createRole('audio', ['training:audio:read']),
  };
  const createUser = (label, role, name = label) => prisma.user.create({
    data: {
      email: `${label}-${randomUUID()}@training-e2e.test`,
      passwordHash: 'not-used',
      name,
      status: 'ACTIVE',
      roleId: role.id,
    },
  });
  const admin = await createUser('admin', roles.admin, 'E2E Admin');
  const denied = await createUser('denied', roles.denied, 'E2E Denied');
  const reader = await createUser('reader', roles.reader, 'E2E Results Reader');
  const reviewer = await createUser('reviewer', roles.reviewer, 'E2E Reviewer');
  const audio = await createUser('audio', roles.audio, 'E2E Audio Reader');
  const employees = [];
  for (let index = 0; index < 105; index += 1) {
    employees.push(await createUser(
      `employee-${String(index).padStart(3, '0')}`,
      roles.employee,
      index === 104 ? '=E2E_FORMULA()' : `E2E Employee ${String(index).padStart(3, '0')}`,
    ));
  }
  const sign = (user) => jwt.sign(
    { sub: user.id, email: user.email, type: 'access' },
    { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '30m' },
  );
  const permissionsFor = (roleName) => {
    const mapping = {
      admin: permissionKeys.filter((key) => key !== 'training:participate'),
      employee: ['training:participate'],
      denied: [],
      reader: ['training:results:read'],
      reviewer: ['training:results:review'],
      audio: ['training:audio:read'],
    };
    return mapping[roleName];
  };
  const authUser = (user, roleName) => ({
    id: user.id,
    email: user.email,
    name: user.name,
    brokerPhone: null,
    brokerEmail: null,
    status: 'ACTIVE',
    role: { id: roles[roleName].id, name: roleName },
    profilePhotoFile: null,
    permissions: permissionsFor(roleName),
  });
  return {
    roles,
    admin,
    denied,
    reader,
    reviewer,
    audio,
    employees,
    tokens: {
      admin: sign(admin),
      denied: sign(denied),
      reader: sign(reader),
      reviewer: sign(reviewer),
      audio: sign(audio),
      employees: employees.map(sign),
    },
    authUsers: {
      admin: authUser(admin, 'admin'),
      employees: employees.map((user) => authUser(user, 'employee')),
    },
  };
}

async function runConnectedScenario(context) {
  const { prisma, storage, identities } = context;
  const pdf = await makePdf(context.PDFDocument, [
    'Platforma E2E residential project source.',
    'Stable project facts for employee training.',
  ]);
  const object = await prisma.realEstateObject.create({
    data: {
      title: 'E2E ЖК Северный',
      slug: `e2e-object-${randomUUID()}`,
      status: 'PUBLISHED',
      description: 'Связанный объект для connected Training E2E.',
      architectureDescription: 'Современная архитектура.',
      infrastructureDescription: 'Школа, детский сад и метро рядом.',
      propertyClass: 'Бизнес',
      floorRange: '8-24',
      completionYear: 2028,
      completionQuarter: 2,
      address: 'Москва, E2E улица, 1',
    },
  });
  const objectPdfKey = `training-v2/e2e/object/${object.id}/source.pdf`;
  await storage.putObject({
    key: objectPdfKey,
    body: pdf,
    contentType: 'application/pdf',
  });
  const objectPdfFile = await prisma.file.create({
    data: {
      storage: 'MINIO',
      bucket: storage.getBucket(),
      key: objectPdfKey,
      url: null,
      originalName: 'e2e-object-source.pdf',
      mimeType: 'application/pdf',
      sizeBytes: BigInt(pdf.length),
      checksum: createHash('sha256').update(pdf).digest('hex'),
      uploadedById: identities.admin.id,
    },
  });
  await prisma.objectFile.create({
    data: {
      objectId: object.id,
      fileId: objectPdfFile.id,
      type: 'PRESENTATION',
      title: 'E2E PDF вложение',
      sortOrder: 0,
    },
  });

  const projects = [];
  for (let index = 0; index < 10; index += 1) {
    const response = await apiRequest('/training/admin/projects', {
      method: 'POST',
      token: identities.tokens.admin,
      body: {
        title: `E2E Training Project ${String(index + 1).padStart(2, '0')}`,
        description: `Connected project ${index + 1}`,
        realEstateObjectId: null,
        sortOrder: index,
        attemptLimit: 5,
        timeLimitMinutes: 7,
        passScore: 75,
        allowRetakeAfterPass: true,
        accessMode: index % 2 === 0 ? 'ASSIGNED_USERS' : 'ALL_PARTICIPANTS',
      },
    });
    assert.equal(response.status, 201);
    projects.push(response.body);
  }
  const project = projects[0];

  const allEmployeeIds = identities.employees.map((user) => user.id);
  for (const candidate of projects) {
    const assignedIds = candidate.accessMode === 'ASSIGNED_USERS'
      ? allEmployeeIds.filter((_, index) => index % 2 === candidate.sortOrder % 2 || candidate.id === project.id)
      : allEmployeeIds.slice(0, 35);
    const assignment = await apiRequest(
      `/training/admin/projects/${candidate.id}/assignments/bulk`,
      {
        method: 'POST',
        token: identities.tokens.admin,
        body: { action: 'ASSIGN', userIds: assignedIds },
      },
    );
    assert.equal(assignment.status, 201);
  }
  const deniedAssignment = await apiRequest(
    `/training/admin/projects/${project.id}/assignments/bulk`,
    {
      method: 'POST',
      token: identities.tokens.admin,
      body: { action: 'ASSIGN', userIds: [identities.denied.id] },
    },
  );
  assert.equal(deniedAssignment.status, 201);

  const imported = await apiRequest(`/training/admin/projects/${project.id}/import-object`, {
    method: 'POST',
    token: identities.tokens.admin,
    body: { objectId: object.id, replaceExistingQuestions: false },
  });
  assert.equal(imported.status, 201);
  assert.equal(imported.body.importedPdfCount, 1);
  assert.equal(imported.body.failedPdfTitles.length, 0);
  assert.equal(imported.body.followUpQuestions.length, 10);

  const extraction = context.app.get(context.TrainingMaterialExtractionService);
  const suggester = context.app.get(context.TRAINING_MATERIAL_SUGGESTER);
  const urlExtractor = {
    async extract(url) {
      return {
        text: 'Официальный E2E источник подтверждает метро, школу и бизнес-класс проекта.',
        segments: [{
          locator: 'html:main:1',
          label: 'Основной текст',
          text: 'Официальный E2E источник подтверждает метро, школу и бизнес-класс проекта.',
        }],
        contentHash: createHash('sha256')
          .update('Официальный E2E источник подтверждает метро, школу и бизнес-класс проекта.')
          .digest('hex'),
        metadata: { method: 'HTTP_FIXTURE', contentType: 'text/html' },
        finalUrl: url,
        fetchedAt: new Date('2026-08-03T00:00:00.000Z'),
      };
    },
  };
  const fixtureMaterials = new context.TrainingMaterialService(
    prisma,
    storage,
    extraction,
    urlExtractor,
    suggester,
  );
  const manualMaterial = await fixtureMaterials.createManual(
    project.id,
    identities.admin.id,
    'E2E ручной источник',
    'Ручной источник сохраняется вместе с PDF, URL и карточкой ЖК.',
  );
  const urlMaterial = await fixtureMaterials.createOfficialUrl(
    project.id,
    identities.admin.id,
    'E2E официальный URL fixture',
    'https://official.fixture.test/project',
    true,
    true,
  );
  assert.equal(urlMaterial.type, 'OFFICIAL_URL');
  assert.equal(manualMaterial.type, 'MANUAL_TEXT');

  const suggested = await fixtureMaterials.generateSuggestions(urlMaterial.latestRevision.id);
  assert.equal(suggested.latestRevision.suggestionStatus, 'READY');
  assert.ok(suggested.latestRevision.suggestions.length > 0);
  const applied = await fixtureMaterials.applySuggestions(
    urlMaterial.latestRevision.id,
    {
      suggestions: suggested.latestRevision.suggestions.map((suggestion) => ({
        suggestionId: suggestion.id,
        targetQuestionId: suggestion.targetQuestionId,
        statement: suggestion.statement,
        aliases: suggestion.aliases,
        isRequired: suggestion.isRequired,
        sourceLocator: suggestion.sourceLocator,
        sourceExcerpt: suggestion.sourceExcerpt,
      })),
    },
  );
  assert.equal(applied.createdFactIds.length, suggested.latestRevision.suggestions.length);

  const richDraft = await apiRequest(`/training/admin/projects/${project.id}`, {
    token: identities.tokens.admin,
  });
  assert.equal(richDraft.status, 200);
  const richQuestions = [
    { questionType: 'MAIN', questionPosition: 1 },
    ...richDraft.body.followUpQuestions.map((_, index) => ({
      questionType: 'FOLLOW_UP',
      questionPosition: index + 1,
    })),
  ];
  const completeFacts = richQuestions.flatMap((question) => {
    const existing = richDraft.body.facts.filter((fact) => (
      fact.questionType === question.questionType &&
      fact.questionPosition === question.questionPosition
    ));
    if (existing.length) return existing;
    return [{
      id: null,
      ...question,
      statement: question.questionType === 'MAIN'
        ? 'Главный подтверждённый факт connected E2E'
        : `Подтверждённый факт connected E2E ${question.questionPosition}`,
      aliases: [],
      isRequired: true,
      position: 1,
    }];
  });
  const completedRichProject = await apiRequest(`/training/admin/projects/${project.id}`, {
    method: 'PATCH',
    token: identities.tokens.admin,
    body: {
      title: richDraft.body.title,
      description: richDraft.body.description,
      realEstateObjectId: richDraft.body.realEstateObjectId,
      sortOrder: richDraft.body.sortOrder,
      attemptLimit: richDraft.body.attemptLimit,
      timeLimitMinutes: richDraft.body.timeLimitSeconds / 60,
      passScore: richDraft.body.passScore,
      allowRetakeAfterPass: richDraft.body.allowRetakeAfterPass,
      accessMode: richDraft.body.accessMode,
      mainQuestion: richDraft.body.mainQuestion,
      followUpQuestions: richDraft.body.followUpQuestions,
      facts: completeFacts,
      criteria: richDraft.body.criteria,
    },
  });
  assert.equal(completedRichProject.status, 200, JSON.stringify(completedRichProject.body));

  const published = await apiRequest(`/training/admin/projects/${project.id}/publish`, {
    method: 'POST',
    token: identities.tokens.admin,
  });
  assert.equal(published.status, 201, JSON.stringify(published.body));
  const opened = await apiRequest(`/training/admin/projects/${project.id}`, {
    method: 'PATCH',
    token: identities.tokens.admin,
    body: { isOpen: true },
  });
  assert.equal(opened.status, 200);

  for (const candidate of projects.slice(1)) {
    const mainQuestion = `Главный вопрос проекта ${candidate.sortOrder + 1}`;
    const followUpQuestions = Array.from(
      { length: 10 },
      (_, index) => `Дополнительный вопрос ${index + 1} проекта ${candidate.sortOrder + 1}`,
    );
    const facts = [
      {
        id: null,
        questionType: 'MAIN',
        questionPosition: 1,
        statement: `Главный факт проекта ${candidate.sortOrder + 1}`,
        aliases: [],
        isRequired: true,
        position: 1,
      },
      ...followUpQuestions.map((_, index) => ({
        id: null,
        questionType: 'FOLLOW_UP',
        questionPosition: index + 1,
        statement: `Факт ${index + 1} проекта ${candidate.sortOrder + 1}`,
        aliases: [],
        isRequired: true,
        position: 1,
      })),
    ];
    const updated = await apiRequest(`/training/admin/projects/${candidate.id}`, {
      method: 'PATCH',
      token: identities.tokens.admin,
      body: {
        title: candidate.title,
        description: candidate.description,
        realEstateObjectId: null,
        sortOrder: candidate.sortOrder,
        attemptLimit: 5,
        timeLimitMinutes: 7,
        passScore: 75,
        allowRetakeAfterPass: true,
        accessMode: candidate.accessMode,
        mainQuestion,
        followUpQuestions,
        facts,
        criteria: candidate.criteria,
      },
    });
    assert.equal(updated.status, 200);
    assert.equal((await apiRequest(`/training/admin/projects/${candidate.id}/publish`, {
      method: 'POST', token: identities.tokens.admin,
    })).status, 201);
    assert.equal((await apiRequest(`/training/admin/projects/${candidate.id}`, {
      method: 'PATCH', token: identities.tokens.admin, body: { isOpen: true },
    })).status, 200);
  }

  for (let index = 0; index < 3; index += 1) {
    const visible = await apiRequest('/training/projects', {
      token: identities.tokens.employees[index],
    });
    assert.equal(visible.status, 200);
    assert.equal(visible.body.items.some((item) => item.id === project.id), true);
  }
  assert.equal((await apiRequest('/training/projects')).status, 401);
  assert.equal((await apiRequest('/training/projects', {
    token: identities.tokens.denied,
  })).status, 403, 'assignment must not grant participation permission');

  context.projects = projects;
  context.project = project;
  context.object = object;
  context.manualMaterial = manualMaterial;
  context.urlMaterial = urlMaterial;
  context.objectPdfFile = objectPdfFile;
  await runTelegramConcurrency(context);
  await runReviewAndPerformance(context);
}

async function runTelegramConcurrency(context) {
  const { prisma, identities, fakeTelegram, project } = context;
  const flowUsers = identities.employees.slice(0, 10);
  const accounts = [];
  const attempts = [];
  const oggByUser = [];

  for (let index = 0; index < flowUsers.length; index += 1) {
    const link = await apiRequest(`/training/projects/${project.id}/telegram-link`, {
      method: 'POST',
      token: identities.tokens.employees[index],
    });
    assert.equal(link.status, 201);
    const rawToken = new URL(link.body.url).searchParams.get('start');
    assert.ok(rawToken);
    const telegramUserId = 700_000 + index;
    const chatId = 800_000 + index;
    const startMessage = telegramMessage(context, telegramUserId, chatId, {
      text: `/start ${rawToken}`,
    });
    assert.equal((await webhook(startMessage)).status, 200);
    const usedToken = await prisma.trainingTelegramLinkToken.findFirstOrThrow({
      where: { userId: flowUsers[index].id, projectId: project.id, usedAt: { not: null } },
      orderBy: { createdAt: 'desc' },
    });
    accounts.push({ telegramUserId, chatId, tokenId: usedToken.id });
  }

  await Promise.all(accounts.map(async (account, index) => {
    const callback = telegramCallback(
      context,
      account.telegramUserId,
      account.chatId,
      `tr:start:${account.tokenId}`,
    );
    assert.equal((await webhook(callback)).status, 200);
    attempts[index] = await waitFor(async () => prisma.trainingAttempt.findFirst({
      where: {
        userId: flowUsers[index].id,
        projectId: project.id,
        status: 'IN_PROGRESS',
      },
      orderBy: { attemptNumber: 'desc' },
    }));
  }));
  assert.equal(new Set(attempts.map((attempt) => attempt.id)).size, 10);

  for (let index = 0; index < flowUsers.length; index += 1) {
    oggByUser[index] = makeOgg(440 + index * 25);
  }
  const mainAnswerIds = [];
  await Promise.all(attempts.map(async (attempt, index) => {
    const current = await currentQuestion(prisma, attempt.id);
    for (let segment = 0; segment < 2; segment += 1) {
      const fileId = `e2e-main-${index}-${segment}`;
      fakeTelegram.registerFile(fileId, {
        body: oggByUser[index],
        mimeType: 'audio/ogg',
      });
      const update = telegramMessage(
        context,
        accounts[index].telegramUserId,
        accounts[index].chatId,
        {
          voice: {
            file_id: fileId,
            file_unique_id: `e2e-main-unique-${index}-${segment}`,
            duration: 1,
            file_size: oggByUser[index].length,
          },
        },
      );
      assert.equal((await webhook(update)).status, 200);
      if (index === 0 && segment === 0) {
        assert.equal((await webhook(update)).status, 200, 'duplicate webhook is safe');
      }
    }
    const finish = telegramCallback(
      context,
      accounts[index].telegramUserId,
      accounts[index].chatId,
      `tr:finish:${current.id}`,
    );
    assert.equal((await webhook(finish)).status, 200);
    if (index === 0) assert.equal((await webhook(finish)).status, 200);
    const answer = await prisma.trainingAnswer.findUniqueOrThrow({
      where: { attemptQuestionId: current.id },
    });
    mainAnswerIds[index] = answer.id;
  }));
  assert.equal(await prisma.trainingAnswerSegment.count({
    where: { answerId: mainAnswerIds[0] },
  }), 2, 'duplicate voice must not add a third segment');

  const bounded = createMarkerTranscriber(context, { delayMs: 80 });
  await processAnswersWithPool(context, mainAnswerIds, bounded);
  assert.ok(bounded.peakActive > 1, `expected parallel provider work, got ${bounded.peakActive}`);
  assert.ok(bounded.peakActive <= 3, `provider concurrency exceeded bound: ${bounded.peakActive}`);

  const mainAnswers = await prisma.trainingAnswer.findMany({
    where: { id: { in: mainAnswerIds } },
    include: {
      mergedAudioFile: true,
      segments: true,
      attemptQuestion: { include: { attempt: true } },
    },
  });
  assert.equal(mainAnswers.length, 10);
  assert.equal(new Set(mainAnswers.map((answer) => answer.attemptQuestion.attempt.userId)).size, 10);
  assert.equal(new Set(mainAnswers.map((answer) => answer.mergedAudioFile.key)).size, 10);
  assert.equal(new Set(mainAnswers.map((answer) => answer.mergedAudioFile.checksum)).size, 10);
  assert.equal(mainAnswers.every((answer) => answer.segments.length === 2), true);

  const selected = await prisma.trainingAttemptQuestion.findMany({
    where: { attemptId: { in: attempts.slice(0, 3).map((attempt) => attempt.id) }, sequence: { gt: 1 } },
    select: { attemptId: true, sourceQuestionId: true },
  });
  for (const attempt of attempts.slice(0, 3)) {
    const own = selected.filter((question) => question.attemptId === attempt.id);
    assert.equal(own.length, 3);
    assert.equal(new Set(own.map((question) => question.sourceQuestionId)).size, 3);
  }

  for (let wave = 0; wave < 3; wave += 1) {
    const waveAnswerIds = [];
    for (let index = 0; index < 3; index += 1) {
      const answer = await submitCurrentVoice(context, attempts[index], accounts[index], oggByUser[index], `first-${wave}-${index}`);
      waveAnswerIds.push(answer.id);
      if (index === 1 && wave === 0) context.markers.set(answer.id, '[fake:fail]');
    }
    await processAnswersWithPool(context, waveAnswerIds, createMarkerTranscriber(context));
  }
  const completed = await prisma.trainingAttempt.findMany({
    where: { id: { in: attempts.slice(0, 3).map((attempt) => attempt.id) } },
    orderBy: { userId: 'asc' },
  });
  assert.equal(completed.every((attempt) => attempt.status === 'COMPLETED'), true);
  const firstByUser = new Map(completed.map((attempt) => [attempt.userId, attempt]));
  assert.equal(firstByUser.get(flowUsers[0].id).finalScore, 100);
  assert.equal(firstByUser.get(flowUsers[1].id).finalScore, 85);
  assert.equal(firstByUser.get(flowUsers[2].id).finalScore, 100);

  await runWorkerRecoveryBranches(context, {
    flowUsers,
    accounts,
    attempts,
    oggByUser,
  });

  for (let index = 0; index < 3; index += 1) {
    const history = await apiRequest('/training/attempts', {
      token: identities.tokens.employees[index],
    });
    assert.equal(history.status, 200);
    assert.equal(history.body.items.every((attempt) => attempt.userId === undefined), true);
    assert.doesNotMatch(
      JSON.stringify(history.body),
      /transcript|evaluationJson|provider|requestId|bucket|storage|audioFile/iu,
    );
  }
  const foreignProbe = await apiRequest(`/training/attempts/${attempts[1].id}`, {
    token: identities.tokens.employees[0],
  });
  assert.equal(foreignProbe.status, 404);

  context.flowUsers = flowUsers;
  context.accounts = accounts;
  context.attempts = attempts;
  context.oggByUser = oggByUser;
  context.mainAnswerIds = mainAnswerIds;
  context.firstAttemptsByUser = firstByUser;
  context.evidence = {
    projects: 10,
    users: 105,
    connectedUsers: 10,
    providerPeak: bounded.peakActive,
    mainAnswers: mainAnswerIds.length,
  };
}

async function runWorkerRecoveryBranches(context, fixture) {
  const { prisma } = context;
  const restartAnswer = await submitCurrentVoice(
    context,
    fixture.attempts[3],
    fixture.accounts[3],
    fixture.oggByUser[3],
    'restart',
  );
  const barrier = createBarrierTranscriber(context);
  const firstWorker = createWorker(context, barrier);
  process.env.TRAINING_VOICE_WORKER_ENABLED = 'true';
  await firstWorker.onModuleInit();
  await barrier.started;
  const shutdownStartedAt = Date.now();
  await firstWorker.shutdown();
  assert.ok(Date.now() - shutdownStartedAt < 2_000);
  barrier.release();
  await barrier.finished;
  const released = await prisma.trainingAnswer.findUniqueOrThrow({ where: { id: restartAnswer.id } });
  assert.equal(released.processingLockedBy, null);
  const restartedWorker = createWorker(context, createMarkerTranscriber(context));
  assert.equal(await restartedWorker.runOnce(), true);
  assert.equal((await prisma.trainingAnswer.findUniqueOrThrow({
    where: { id: restartAnswer.id },
  })).processingStatus, 'COMPLETED');

  const disabledAnswer = await submitCurrentVoice(
    context,
    fixture.attempts[4],
    fixture.accounts[4],
    fixture.oggByUser[4],
    'feature-flag',
  );
  const disabledTranscriber = createMarkerTranscriber(context);
  process.env.TRAINING_MODULE_ENABLED = 'false';
  const disabledWorker = createWorker(context, disabledTranscriber);
  assert.equal(await disabledWorker.runOnce(), false);
  assert.equal(disabledTranscriber.calls, 0);
  assert.equal((await prisma.trainingAnswer.findUniqueOrThrow({
    where: { id: disabledAnswer.id },
  })).processingAttempts, 0);
  process.env.TRAINING_MODULE_ENABLED = 'true';
  assert.equal(await disabledWorker.runOnce(), true);
  assert.equal((await prisma.trainingAnswer.findUniqueOrThrow({
    where: { id: disabledAnswer.id },
  })).processingStatus, 'COMPLETED');

  const failedAnswer = await submitCurrentVoice(
    context,
    fixture.attempts[5],
    fixture.accounts[5],
    fixture.oggByUser[5],
    'technical-failure',
  );
  const failingTranscriber = {
    async transcribe() {
      throw new context.TrainingOpenAIError('E2E_PERMANENT_PROVIDER_FAILURE', false, 1);
    },
  };
  assert.equal(await createWorker(context, failingTranscriber).runOnce(), true);
  const failedAttempt = await prisma.trainingAttempt.findUniqueOrThrow({
    where: { id: fixture.attempts[5].id },
  });
  assert.equal(failedAttempt.status, 'TECHNICAL_FAILED');
  assert.equal(failedAttempt.countsTowardAttemptLimit, false);
  assert.equal(failedAttempt.finalScore, null);
  assert.equal((await prisma.trainingAnswer.findUniqueOrThrow({
    where: { id: failedAnswer.id },
  })).processingStatus, 'FAILED');

  await prisma.trainingAttempt.update({
    where: { id: fixture.attempts[6].id },
    data: { expiresAt: new Date(Date.now() - 1_000) },
  });
  const timedOut = await apiRequest(`/training/attempts/${fixture.attempts[6].id}`, {
    token: context.identities.tokens.employees[6],
  });
  assert.equal(timedOut.status, 200);
  assert.equal(timedOut.body.status, 'TIMED_OUT');
}

async function runReviewAndPerformance(context) {
  const { prisma, identities, project, flowUsers, accounts, oggByUser } = context;
  const reviewAttempts = [];
  for (let index = 0; index < 2; index += 1) {
    const started = await apiRequest(`/training/projects/${project.id}/attempts`, {
      method: 'POST',
      token: identities.tokens.employees[index],
      headers: { 'Idempotency-Key': randomUUID() },
      body: { confirmed: true },
    });
    assert.equal(started.status, 201);
    reviewAttempts[index] = await prisma.trainingAttempt.findUniqueOrThrow({
      where: { id: started.body.id },
    });
  }

  for (let wave = 0; wave < 4; wave += 1) {
    const ids = [];
    for (let index = 0; index < 2; index += 1) {
      const answer = await submitCurrentVoice(
        context,
        reviewAttempts[index],
        accounts[index],
        oggByUser[index],
        `review-${wave}-${index}`,
      );
      ids.push(answer.id);
      if (wave === 0) context.markers.set(answer.id, '[fake:review]');
    }
    await processAnswersWithPool(context, ids, createMarkerTranscriber(context));
  }
  const pending = await prisma.trainingAttempt.findMany({
    where: { id: { in: reviewAttempts.map((attempt) => attempt.id) } },
  });
  assert.equal(pending.every((attempt) => attempt.status === 'REQUIRES_REVIEW'), true);
  assert.equal(pending.every((attempt) => attempt.finalScore === null), true);

  const rankingBefore = await apiRequest(
    `/training/admin/ranking?page=1&limit=100&project=${encodeURIComponent(project.id)}`,
    { token: identities.tokens.admin },
  );
  assert.equal(rankingBefore.status, 200);
  const user0Before = rankingBefore.body.items.find((item) => item.user.id === flowUsers[0].id);
  const user1Before = rankingBefore.body.items.find((item) => item.user.id === flowUsers[1].id);
  assert.equal(user0Before.averageBestScore, '100.00');
  assert.equal(user1Before.averageBestScore, '85.00');

  assert.equal((await apiRequest(
    `/training/admin/attempts/${reviewAttempts[0].id}/review`,
    {
      method: 'POST',
      token: identities.tokens.reader,
      body: { decision: 'APPROVE', comment: 'Forbidden reader review' },
    },
  )).status, 403);
  assert.equal((await apiRequest(
    `/training/admin/attempts/${reviewAttempts[0].id}`,
    { token: identities.tokens.reviewer },
  )).status, 403);

  const overridden = await apiRequest(`/training/admin/attempts/${reviewAttempts[1].id}/review`, {
    method: 'POST',
    token: identities.tokens.admin,
    body: {
      decision: 'OVERRIDE',
      finalScore: 99,
      comment: 'Connected E2E override',
    },
  });
  assert.equal(overridden.status, 201);
  assert.equal(overridden.body.finalScore, 99);
  assert.equal(overridden.body.reviewDecision, 'OVERRIDDEN');
  const rankingAfter = await apiRequest(
    `/training/admin/ranking?page=1&limit=100&project=${encodeURIComponent(project.id)}`,
    { token: identities.tokens.admin },
  );
  assert.equal(
    rankingAfter.body.items.find((item) => item.user.id === flowUsers[1].id).averageBestScore,
    '99.00',
  );

  const ownPending = await apiRequest(`/training/attempts/${reviewAttempts[0].id}`, {
    token: identities.tokens.employees[0],
  });
  assert.equal(ownPending.status, 200);
  assert.equal(ownPending.body.status, 'REQUIRES_REVIEW');
  assert.ok(ownPending.body.finalScore == null);
  assert.doesNotMatch(
    JSON.stringify(ownPending.body),
    /transcript|evaluation|unsupported|provider|requestId|audio|bucket|storage/iu,
  );

  const adminResults = await apiRequest(
    `/training/admin/results?page=1&limit=20&projectId=${project.id}`,
    { token: identities.tokens.admin },
  );
  assert.equal(adminResults.status, 200);
  assert.equal(adminResults.body.items.some((item) => item.id === reviewAttempts[0].id), true);
  assert.doesNotMatch(JSON.stringify(adminResults.body), /evaluationJson|projectSnapshotJson|bucket|key/iu);
  const adminDetail = await apiRequest(`/training/admin/attempts/${reviewAttempts[0].id}`, {
    token: identities.tokens.admin,
  });
  assert.equal(adminDetail.status, 200);
  const audioAnswer = adminDetail.body.questions.find((question) => question.answer?.audioAvailable)?.answer;
  assert.ok(audioAnswer);
  assert.equal((await apiRequest(`/training/admin/answers/${audioAnswer.id}/audio`, {
    token: identities.tokens.reader,
  })).status, 403);
  const audioRead = await apiRequest(`/training/admin/answers/${audioAnswer.id}/audio`, {
    token: identities.tokens.audio,
    binary: true,
  });
  assert.equal(audioRead.status, 200);
  assert.equal(audioRead.headers.get('cache-control'), 'private, no-store');
  assert.equal(audioRead.body.subarray(0, 4).toString('ascii'), 'RIFF');
  const mergedFile = await prisma.file.findUniqueOrThrow({
    where: { id: (await prisma.trainingAnswer.findUniqueOrThrow({
      where: { id: audioAnswer.id }, select: { mergedAudioFileId: true },
    })).mergedAudioFileId },
  });
  assert.equal((await apiRequest(`/files/${mergedFile.id}/content`, {
    token: identities.tokens.admin,
    binary: true,
  })).status, 404);
  assert.equal((await apiRequest(`/files/${context.objectPdfFile.id}/content`, {
    token: identities.tokens.admin,
    binary: true,
  })).status, 200, 'linked source PDF is generic object content, not a private training revision');
  const privateMaterialFile = await prisma.file.findFirstOrThrow({
    where: {
      trainingMaterialRevisions: { some: { material: { projectId: project.id } } },
      key: { startsWith: 'training-v2/materials/' },
    },
  });
  assert.equal((await apiRequest(`/files/${privateMaterialFile.id}/content`, {
    token: identities.tokens.admin,
    binary: true,
  })).status, 404);

  await runPerformanceEvidence(context);
  context.reviewAttempts = reviewAttempts;
  context.pendingReviewAttempt = reviewAttempts[0];
  context.overriddenAttempt = reviewAttempts[1];
  context.audioAnswerId = audioAnswer.id;
  context.evidence.resultsRows = adminResults.body.total;
}

async function runPerformanceEvidence(context) {
  const { prisma, project, identities } = context;
  let queryCount = 0;
  const measuredPrisma = {
    $queryRaw: (...args) => {
      queryCount += 1;
      return prisma.$queryRaw(...args);
    },
  };
  const ranking = new context.TrainingRankingService(
    measuredPrisma,
    context.attemptState,
    context.access,
  );
  const query = {
    page: 1,
    limit: 20,
    search: null,
    project: null,
    accessMode: null,
    currentlyAssigned: null,
    currentlyEligible: null,
  };
  const firstPage = await ranking.listRanking(query);
  assert.equal(firstPage.total, 105);
  assert.equal(firstPage.items.length, 20);
  assert.equal(queryCount, 2, 'one core and one page-detail query');
  queryCount = 0;
  const secondPage = await ranking.listRanking({ ...query, page: 2 });
  assert.equal(secondPage.items.length, 20);
  assert.equal(queryCount, 2);
  assert.equal(
    firstPage.items.some((first) => secondPage.items.some((second) => second.user.id === first.user.id)),
    false,
  );
  assert.doesNotMatch(
    JSON.stringify(firstPage),
    /projectSnapshotJson|evaluationJson|transcript|audio|provider|requestId|bucket|storage/iu,
  );

  queryCount = 0;
  const csv = await ranking.exportCsv(query);
  assert.equal(csv.codePointAt(0), 0xfeff);
  assert.equal(csv.trimEnd().split('\r\n').length, 106);
  assert.equal(queryCount, 4, 'two bounded SQL queries per 100-row CSV batch');
  assert.match(csv, /"'=E2E_FORMULA\(\)"/u);
  const rankingHttp = await apiRequest('/training/admin/ranking?page=1&limit=100', {
    token: identities.tokens.admin,
  });
  const csvHttp = await apiRequest('/training/admin/ranking/export.csv', {
    token: identities.tokens.admin,
    text: true,
  });
  assert.equal(csvHttp.status, 200);
  const csvNames = parseCsvColumn(csvHttp.body, 1).slice(1);
  assert.deepEqual(
    csvNames.slice(0, rankingHttp.body.items.length),
    rankingHttp.body.items.map((item) => {
      const value = item.user.name ?? item.user.email;
      return /^[=+\-@]/u.test(value) ? `'${value}` : value;
    }),
  );

  let captured;
  const capture = new context.TrainingRankingService(
    { $queryRaw: async (sql) => { captured = sql; return []; } },
    context.attemptState,
    context.access,
  );
  await capture.listRanking(query);
  assert.ok(captured);
  const planRows = await prisma.$queryRaw(
    context.Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${captured}`,
  );
  const plan = planRows[0]['QUERY PLAN'][0];
  assert.ok(Number.isFinite(plan['Execution Time']));
  assert.ok(plan.Plan['Actual Rows'] <= 20);
  process.stdout.write(
    `ranking_explain_execution_ms=${plan['Execution Time']} planning_ms=${plan['Planning Time']} rows=${plan.Plan['Actual Rows']}\n`,
  );
  context.evidence.rankingTotal = firstPage.total;
  context.evidence.rankingQueryCount = 2;
  context.evidence.csvQueryCount = 4;
  context.evidence.queryPlanRows = plan.Plan['Actual Rows'];
  context.evidence.projectScope = project.id;
}

async function runBrowserChecks(context, browser) {
  const { identities, project, pendingReviewAttempt, overriddenAttempt } = context;

  const employeeContext = await browser.newContext();
  try {
    await installAuthFixture(
      employeeContext,
      identities.tokens.employees[0],
      identities.authUsers.employees[0],
    );
    const page = await employeeContext.newPage();
    await page.goto('http://web:5173/training', { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Учебные проекты' }).waitFor();
    await page.getByText('Результат проверяется.').waitFor();
    assert.equal(await page.getByText('[fake:review]', { exact: true }).count(), 0);
    assert.equal(await page.getByText('unsupported_claims', { exact: true }).count(), 0);
  } finally {
    await employeeContext.close();
  }

  const technicalContext = await browser.newContext();
  try {
    await installAuthFixture(
      technicalContext,
      identities.tokens.employees[5],
      identities.authUsers.employees[5],
    );
    const page = await technicalContext.newPage();
    await page.goto('http://web:5173/training', { waitUntil: 'domcontentloaded' });
    await page.getByText('Произошла техническая ошибка. Попытка возвращена.').waitFor();
    assert.equal(await page.getByText('E2E_PERMANENT_PROVIDER_FAILURE').count(), 0);
  } finally {
    await technicalContext.close();
  }

  const adminContext = await browser.newContext({ acceptDownloads: true });
  try {
    await adminContext.addInitScript(() => {
      const create = URL.createObjectURL.bind(URL);
      const revoke = URL.revokeObjectURL.bind(URL);
      window.__e2eBlobLifecycle = { created: 0, revoked: 0 };
      URL.createObjectURL = (blob) => {
        window.__e2eBlobLifecycle.created += 1;
        return create(blob);
      };
      URL.revokeObjectURL = (url) => {
        window.__e2eBlobLifecycle.revoked += 1;
        return revoke(url);
      };
    });
    await installAuthFixture(adminContext, identities.tokens.admin, identities.authUsers.admin);
    let failResults = false;
    let reviewPosted = false;
    let failedReviewRefresh = false;
    let reviewPosts = 0;
    await adminContext.route('http://localhost:3000/training/admin/results**', async (route) => {
      const url = new URL(route.request().url());
      if (failResults && url.searchParams.get('search') === 'e2e-error') {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'E2E_RESULTS_ERROR' }),
        });
        return;
      }
      await route.continue();
    });
    await adminContext.route(
      `http://localhost:3000/training/admin/attempts/${pendingReviewAttempt.id}`,
      async (route) => {
        if (reviewPosted && !failedReviewRefresh && route.request().method() === 'GET') {
          failedReviewRefresh = true;
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ message: 'E2E_DETAIL_REFRESH_FAILED' }),
          });
          return;
        }
        await route.continue();
      },
    );
    const page = await adminContext.newPage();
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        request.url().endsWith(`/training/admin/attempts/${pendingReviewAttempt.id}/review`)
      ) {
        reviewPosted = true;
        reviewPosts += 1;
      }
    });

    await page.goto('http://web:5173/admin/training/results', { waitUntil: 'domcontentloaded' });
    await page.getByText('Результаты сотрудников').waitFor();
    await page.getByText('E2E Employee 000').first().waitFor();
    await page.getByLabel('Сотрудник').fill('no-such-e2e-user');
    await page.getByRole('button', { name: 'Показать' }).click();
    await page.getByText('Результаты не найдены').waitFor();
    failResults = true;
    await page.getByLabel('Сотрудник').fill('e2e-error');
    await page.getByRole('button', { name: 'Показать' }).click();
    await page.getByText('E2E_RESULTS_ERROR').waitFor();
    failResults = false;
    await page.getByRole('button', { name: 'Сбросить' }).click();
    await page.getByText('E2E Employee 000').first().waitFor();
    await page.setViewportSize({ width: 500, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

    await page.goto(`http://web:5173/admin/training/projects/${project.id}`);
    await page.getByRole('heading', { name: project.title }).waitFor();
    await page.getByRole('tab', { name: 'Материалы' }).click();
    await page.getByText('E2E официальный URL fixture').first().waitFor();
    await page.getByText('E2E PDF вложение').first().waitFor();
    await page.getByRole('tab', { name: 'Доступ сотрудников' }).click();
    await page.getByText('E2E Employee 000').first().waitFor();

    await page.goto(`http://web:5173/admin/training/attempts/${pendingReviewAttempt.id}`);
    await page.getByRole('heading', { name: 'Подтвердить или скорректировать итог' }).waitFor();
    await page.getByRole('button', { name: 'Прослушать запись' }).first().click();
    await page.locator('audio').waitFor();
    await page.getByRole('button', { name: 'Закрыть запись' }).click();
    assert.equal(await page.locator('audio').count(), 0);
    const lifecycle = await page.evaluate(() => window.__e2eBlobLifecycle);
    assert.ok(lifecycle.created >= 1);
    assert.ok(lifecycle.revoked >= 1);
    await page.getByRole('button', { name: 'Подтвердить расчёт' }).click();
    await page.getByText(/Решение сохранено, но detail не обновился/u).waitFor();
    assert.equal(reviewPosts, 1);
    assert.equal(failedReviewRefresh, true);
    assert.equal(await page.getByRole('button', { name: 'Подтвердить расчёт' }).count(), 0);

    await page.goto('http://web:5173/admin/training/ranking');
    await page.getByText('Рейтинг сотрудников').waitFor();
    await page.getByText('E2E Employee 001').first().waitFor();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Скачать CSV' }).click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /training-ranking\.csv/iu);

    await page.goto(`http://web:5173/admin/training/attempts/${overriddenAttempt.id}`);
    await page.getByText('99 / 100', { exact: true }).waitFor();
  } finally {
    await adminContext.close();
  }

  const approved = await context.prisma.trainingAttempt.findUniqueOrThrow({
    where: { id: pendingReviewAttempt.id },
  });
  assert.equal(approved.reviewDecision, 'APPROVED');
  context.evidence.browser = 'live-api-web-ok';
}

async function runRevokeCloseAndSnapshotChecks(context, browser) {
  const { identities, project, prisma, accounts, oggByUser } = context;
  const userIndex = 2;
  const started = await apiRequest(`/training/projects/${project.id}/attempts`, {
    method: 'POST',
    token: identities.tokens.employees[userIndex],
    headers: { 'Idempotency-Key': randomUUID() },
    body: { confirmed: true },
  });
  assert.equal(started.status, 201);
  const attempt = await prisma.trainingAttempt.findUniqueOrThrow({ where: { id: started.body.id } });
  const snapshotBefore = structuredClone(attempt.projectSnapshotJson);

  const revoked = await apiRequest(`/training/admin/projects/${project.id}/assignments/bulk`, {
    method: 'POST',
    token: identities.tokens.admin,
    body: { action: 'REVOKE', userIds: [identities.employees[userIndex].id] },
  });
  assert.equal(revoked.status, 201);
  assert.equal((await apiRequest(`/training/admin/projects/${project.id}`, {
    method: 'PATCH', token: identities.tokens.admin, body: { isOpen: false },
  })).status, 200);
  await runRevokedEmployeeBrowserCheck(context, browser);

  for (let wave = 0; wave < 4; wave += 1) {
    const answer = await submitCurrentVoice(
      context,
      attempt,
      accounts[userIndex],
      oggByUser[userIndex],
      `revoke-${wave}`,
    );
    await processAnswersWithPool(context, [answer.id], createMarkerTranscriber(context));
  }
  const completed = await prisma.trainingAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
  assert.equal(completed.status, 'COMPLETED');
  assert.deepEqual(completed.projectSnapshotJson, snapshotBefore);

  assert.equal((await apiRequest(`/training/admin/projects/${project.id}`, {
    method: 'PATCH', token: identities.tokens.admin, body: { isOpen: true },
  })).status, 200);
  const blocked = await apiRequest(`/training/projects/${project.id}/attempts`, {
    method: 'POST',
    token: identities.tokens.employees[userIndex],
    headers: { 'Idempotency-Key': randomUUID() },
    body: { confirmed: true },
  });
  assert.equal(blocked.status, 403);
  assert.equal((await apiRequest(`/training/admin/projects/${project.id}`, {
    method: 'PATCH', token: identities.tokens.admin, body: { isOpen: false },
  })).status, 200);

  const materialService = context.app.get(context.TrainingMaterialService);
  await materialService.refresh(context.manualMaterial.id, identities.admin.id, {
    text: 'Обновлённый ручной материал после завершения connected attempt.',
  });
  const adminProject = (await apiRequest(`/training/admin/projects/${project.id}`, {
    token: identities.tokens.admin,
  })).body;
  const changed = await apiRequest(`/training/admin/projects/${project.id}`, {
    method: 'PATCH',
    token: identities.tokens.admin,
    body: {
      title: `${adminProject.title} updated`,
      description: adminProject.description,
      realEstateObjectId: adminProject.realEstateObjectId,
      sortOrder: adminProject.sortOrder,
      attemptLimit: adminProject.attemptLimit,
      timeLimitMinutes: adminProject.timeLimitSeconds / 60,
      passScore: adminProject.passScore,
      allowRetakeAfterPass: adminProject.allowRetakeAfterPass,
      accessMode: adminProject.accessMode,
      mainQuestion: `${adminProject.mainQuestion} updated`,
      followUpQuestions: adminProject.followUpQuestions.map((question, index) =>
        index === 0 ? `${question} updated` : question,
      ),
      facts: adminProject.facts,
      criteria: adminProject.criteria,
    },
  });
  assert.equal(changed.status, 200);
  const afterChanges = await prisma.trainingAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
  assert.deepEqual(afterChanges.projectSnapshotJson, snapshotBefore);
  const oldDetail = await apiRequest(`/training/admin/attempts/${attempt.id}`, {
    token: identities.tokens.admin,
  });
  assert.equal(oldDetail.status, 200);
  assert.equal(oldDetail.body.project.title, snapshotBefore.projectTitle);
  assert.equal(oldDetail.body.questions[0].text, snapshotBefore.questions[0].text);
  context.revokedAttempt = attempt;
  context.evidence.revokeActiveCompleted = true;
  context.evidence.snapshotImmutable = true;
}

async function runRevokedEmployeeBrowserCheck(context, browser) {
  const employeeContext = await browser.newContext();
  try {
    await installAuthFixture(
      employeeContext,
      context.identities.tokens.employees[2],
      context.identities.authUsers.employees[2],
    );
    const page = await employeeContext.newPage();
    await page.goto('http://web:5173/training', { waitUntil: 'domcontentloaded' });
    await page.getByText(
      'Доступ к новым попыткам отозван. Текущую попытку можно завершить.',
    ).first().waitFor();
    assert.equal(await page.getByText('[fake:pass]', { exact: true }).count(), 0);
  } finally {
    await employeeContext.close();
  }
}

async function runFinalSecurityChecks(context) {
  const { identities, prisma } = context;
  assert.equal((await apiRequest('/training/admin/results')).status, 401);
  assert.equal((await apiRequest('/training/admin/results', {
    token: identities.tokens.denied,
  })).status, 403);
  assert.equal((await apiRequest(`/training/admin/attempts/${randomUUID()}`, {
    token: identities.tokens.admin,
  })).status, 404);
  assert.equal((await apiRequest(`/training/attempts/${randomUUID()}`, {
    token: identities.tokens.employees[0],
  })).status, 404);
  const health = await apiRequest('/health');
  assert.equal(health.status, 200);
  assert.deepEqual(Object.keys(health.body).sort(), ['database', 'status', 'training']);
  assert.doesNotMatch(JSON.stringify(health.body), /token|secret|model|bucket|provider|user|transcript/iu);
  const audit = await prisma.auditLog.findFirst({
    where: { action: 'training.audio.read', entityId: context.audioAnswerId },
  });
  assert.ok(audit);
  assert.doesNotMatch(JSON.stringify(audit.metadata), /bucket|key|checksum|transcript|provider/iu);
  context.evidence.health = health.body.training;
  context.evidence.security = '401-403-404-redaction-ok';
}

function createWorker(context, transcriber) {
  return new context.TrainingVoiceWorkerService(
    context.prisma,
    context.audio,
    transcriber,
    context.evaluator,
    context.attemptState,
    context.telegram,
  );
}

function createMarkerTranscriber(context, options = {}) {
  let active = 0;
  const state = {
    calls: 0,
    peakActive: 0,
    async transcribe(input) {
      state.calls += 1;
      active += 1;
      state.peakActive = Math.max(state.peakActive, active);
      try {
        if (options.delayMs) await delay(options.delayMs);
        const result = await context.baseTranscriber.transcribe(input);
        return {
          ...result,
          text: context.markers.get(input.answerId) ?? '[fake:pass]',
        };
      } finally {
        active -= 1;
      }
    },
  };
  return state;
}

function createBarrierTranscriber(context) {
  let resolveStarted;
  let resolveRelease;
  let resolveFinished;
  const started = new Promise((resolve) => { resolveStarted = resolve; });
  const released = new Promise((resolve) => { resolveRelease = resolve; });
  const finished = new Promise((resolve) => { resolveFinished = resolve; });
  return {
    started,
    finished,
    release: () => resolveRelease(),
    async transcribe(input) {
      resolveStarted();
      await released;
      const result = await context.baseTranscriber.transcribe(input);
      resolveFinished();
      return result;
    },
  };
}

async function processAnswersWithPool(context, answerIds, transcriber) {
  process.env.TRAINING_MODULE_ENABLED = 'true';
  process.env.TRAINING_VOICE_WORKER_ENABLED = 'true';
  const worker = createWorker(context, transcriber);
  await worker.onModuleInit();
  try {
    await waitFor(async () => {
      const completed = await context.prisma.trainingAnswer.count({
        where: { id: { in: answerIds }, processingStatus: 'COMPLETED' },
      });
      return completed === answerIds.length ? true : null;
    }, 45_000);
  } finally {
    await worker.shutdown();
  }
}

async function submitCurrentVoice(context, attempt, account, ogg, label) {
  const current = await currentQuestion(context.prisma, attempt.id);
  const fileId = `e2e-${label}-${randomUUID()}`;
  context.fakeTelegram.registerFile(fileId, { body: ogg, mimeType: 'audio/ogg' });
  const voice = telegramMessage(context, account.telegramUserId, account.chatId, {
    voice: {
      file_id: fileId,
      file_unique_id: `unique-${label}-${randomUUID()}`,
      duration: 1,
      file_size: ogg.length,
    },
  });
  assert.equal((await webhook(voice)).status, 200);
  assert.equal((await webhook(telegramCallback(
    context,
    account.telegramUserId,
    account.chatId,
    `tr:finish:${current.id}`,
  ))).status, 200);
  return context.prisma.trainingAnswer.findUniqueOrThrow({
    where: { attemptQuestionId: current.id },
  });
}

async function currentQuestion(prisma, attemptId) {
  return prisma.trainingAttemptQuestion.findFirstOrThrow({
    where: { attemptId, status: 'PRESENTED' },
    orderBy: { sequence: 'asc' },
  });
}

function telegramMessage(context, telegramUserId, chatId, input) {
  context.updateId += 1;
  context.messageId += 1;
  return {
    update_id: context.updateId,
    message: {
      message_id: context.messageId,
      from: { id: telegramUserId, username: `e2e_user_${telegramUserId}` },
      chat: { id: chatId, type: 'private' },
      ...(input.text ? { text: input.text } : {}),
      ...(input.voice ? { voice: input.voice } : {}),
    },
  };
}

function telegramCallback(context, telegramUserId, chatId, data) {
  context.updateId += 1;
  context.messageId += 1;
  return {
    update_id: context.updateId,
    callback_query: {
      id: `callback-${context.updateId}`,
      from: { id: telegramUserId, username: `e2e_user_${telegramUserId}` },
      message: {
        message_id: context.messageId,
        chat: { id: chatId, type: 'private' },
      },
      data,
    },
  };
}

function webhook(body) {
  return apiRequest('/training/telegram/webhook', {
    method: 'POST',
    headers: {
      'X-Telegram-Bot-Api-Secret-Token': process.env.TELEGRAM_WEBHOOK_SECRET,
    },
    body,
  });
}

async function apiRequest(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`http://127.0.0.1:3000${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const contentType = response.headers.get('content-type') ?? '';
  let body;
  if (options.binary) {
    body = Buffer.from(await response.arrayBuffer());
  } else if (options.text || !contentType.includes('application/json')) {
    body = await response.text();
  } else {
    body = await response.json();
  }
  return { status: response.status, headers: response.headers, body };
}

async function installAuthFixture(browserContext, accessToken, user) {
  await browserContext.route('http://localhost:3000/auth/refresh', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ accessToken, user }),
    });
  });
}

function makePdf(PDFDocument, pages) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ autoFirstPage: false });
    const chunks = [];
    document.on('data', (chunk) => chunks.push(chunk));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);
    for (const text of pages) {
      document.addPage();
      document.fontSize(16).text(text);
    }
    document.end();
  });
}

function makeOgg(frequency) {
  const result = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', `sine=frequency=${frequency}:duration=0.25`,
    '-c:a', 'libopus',
    '-f', 'ogg',
    'pipe:1',
  ], { encoding: null, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`ffmpeg fixture failed: ${Buffer.from(result.stderr ?? '').toString('utf8')}`);
  }
  assert.equal(result.stdout.subarray(0, 4).toString('ascii'), 'OggS');
  return result.stdout;
}

function parseCsvColumn(csv, columnIndex) {
  return csv
    .replace(/^\uFEFF/u, '')
    .trimEnd()
    .split('\r\n')
    .map((line) => {
      const values = [];
      let value = '';
      let quoted = false;
      for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (character === '"') {
          if (quoted && line[index + 1] === '"') {
            value += '"';
            index += 1;
          } else {
            quoted = !quoted;
          }
        } else if (character === ',' && !quoted) {
          values.push(value);
          value = '';
        } else {
          value += character;
        }
      }
      values.push(value);
      return values[columnIndex] ?? '';
    });
}

async function waitFor(check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  if (lastError) throw lastError;
  throw new Error(`Timed out after ${timeoutMs} ms`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCommand(label, command, args) {
  await waitFor(async () => {
    const result = await runAllowFailure(command, args, { silent: true });
    return result === 0 ? true : null;
  }, 60_000).catch((error) => {
    throw new Error(`${label} did not become ready`, { cause: error });
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: options.silent ? 'ignore' : 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve(options.returnChild ? child : code);
      else reject(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}

async function runAllowFailure(command, args, options = {}) {
  try {
    await run(command, args, options);
    return 0;
  } catch {
    return 1;
  }
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env: process.env });
    const output = [];
    const errors = [];
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => errors.push(chunk));
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve(Buffer.concat(output).toString('utf8'));
      else reject(new Error(
        `${command} exited with ${code ?? signal}: ${Buffer.concat(errors).toString('utf8')}`,
      ));
    });
  });
}

function fail(error) {
  console.error(error);
  process.exitCode = 1;
}
