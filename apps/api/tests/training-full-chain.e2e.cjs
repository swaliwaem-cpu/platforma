require('reflect-metadata');

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const argon2 = require('argon2');
const PDFDocument = require('pdfkit');
const {
  FileStorage,
  ObjectFileType,
  PrismaClient,
  TrainingAttemptQuestionStatus,
  TrainingAttemptStatus,
  TrainingJobKind,
  TrainingPassStatus,
  TrainingPolicyAcceptanceSource,
  TrainingProjectAudienceMode,
  TrainingProjectStatus,
  TrainingQuestionType,
  TrainingReviewStatus,
  TrainingSourceExtractionStatus,
  TrainingSourceOriginKind,
  TrainingVersionStatus,
  UserStatus,
} = require('@prisma/client');

const {
  FilesService,
} = require('../dist/files/files.service.js');
const {
  S3StorageService,
} = require('../dist/files/s3-storage.service.js');
const {
  TrainingAssignmentsService,
} = require('../dist/training/training-assignments.service.js');
const {
  TrainingAudioConfig,
} = require('../dist/training/audio/training-audio.config.js');
const {
  TrainingAttemptEngineService,
} = require('../dist/training/training-attempt-engine.service.js');
const {
  DeterministicFakeTrainingEvaluationProvider,
  DeterministicFakeTrainingTranscriptionProvider,
  SystemTrainingAttemptClock,
} = require('../dist/training/training-attempt.providers.js');
const {
  TrainingPolicyService,
} = require('../dist/training/training-policy.service.js');
const {
  TrainingDocumentsService,
} = require('../dist/training/training-documents.service.js');
const {
  TrainingRankingService,
} = require('../dist/training/training-ranking.service.js');
const {
  TrainingResultsService,
} = require('../dist/training/training-results.service.js');
const {
  buildTrainingRankingCsv,
} = require('../dist/training/training-csv.js');
const {
  TrainingTelegramConfig,
} = require('../dist/training/telegram/training-telegram.config.js');
const {
  TrainingTelegramLinkService,
  hashTrainingLinkToken,
} = require('../dist/training/telegram/training-telegram-link.service.js');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required for training full-chain E2E');
}

const apiPort = readPort('TRAINING_E2E_API_PORT');
const webPort = readPort('TRAINING_E2E_WEB_PORT');
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const webOrigin = `http://127.0.0.1:${webPort}`;
const rootDir = path.resolve(__dirname, '../../..');
const requireFromWeb = createRequire(
  path.join(rootDir, 'apps/web/package.json'),
);
const { chromium } = requireFromWeb('@playwright/test');
const prisma = new PrismaClient();
const processes = new Set();

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const tempDirectory = await mkdtemp(
    path.join(tmpdir(), 'platforma-training-full-chain-'),
  );
  process.env.TRAINING_AUDIO_TEMP_DIR = path.join(
    tempDirectory,
    'audio-worker',
  );

  const storage = new S3StorageService();
  const audioConfig = new TrainingAudioConfig();
  let browser;

  try {
    await prisma.$connect();
    await storage.onModuleInit();
    await waitForTrainingWorkers();

    const fixture = await createFixture(storage);
    const assignments = new TrainingAssignmentsService(prisma);
    const initialAssignments = await assignments.getAssignments(
      fixture.project.id,
    );
    assert.equal(
      initialAssignments.audienceMode,
      TrainingProjectAudienceMode.ASSIGNED_ONLY,
    );
    assert.equal(initialAssignments.eligibleTotal, 1);
    assert.equal(initialAssignments.items[0]?.userId, fixture.employee.id);
    const candidates = await assignments.listCandidates({
      search: fixture.employee.email,
      page: 1,
      limit: 10,
    });
    assert.deepEqual(
      candidates.items.map((candidate) => candidate.id),
      [fixture.employee.id],
    );

    const policy = new TrainingPolicyService(prisma);
    const currentPolicy = await policy.getCurrentPolicy(fixture.employee.id);
    assert.equal(currentPolicy.accepted, false);
    const acceptedPolicy = await policy.accept(
      fixture.employee.id,
      TrainingPolicyAcceptanceSource.PLATFORM,
    );
    assert.equal(acceptedPolicy.accepted, true);
    assert.equal(acceptedPolicy.id, currentPolicy.id);

    const telegramLinks = new TrainingTelegramLinkService(
      prisma,
      new TrainingTelegramConfig(process.env),
    );
    await assert.rejects(
      () =>
        telegramLinks.issueLinkToken(
          fixture.unassignedEmployee.id,
          fixture.project.id,
        ),
      /Training project not found/u,
    );
    const link = await telegramLinks.issueLinkToken(
      fixture.employee.id,
      fixture.project.id,
    );
    const linked = await telegramLinks.consumeHashedToken(
      hashTrainingLinkToken(link.token),
      {
        telegramUserId: 9_001_000_001n,
        chatId: 9_001_000_002n,
        username: 'training_full_chain_employee',
        firstName: 'E2E',
        lastName: 'Employee',
      },
    );
    assert.equal(linked.userId, fixture.employee.id);
    assert.equal(linked.projectId, fixture.project.id);

    const featureConfig = {
      isEnabled: () => true,
      assertEnabled: () => undefined,
    };
    const createAttemptEngine = () =>
      new TrainingAttemptEngineService(
        prisma,
        new SystemTrainingAttemptClock(),
        new FirstQuestionsSelector(),
        new DeterministicFakeTrainingTranscriptionProvider(),
        new DeterministicFakeTrainingEvaluationProvider(),
        audioConfig,
        undefined,
        false,
        featureConfig,
        policy,
      );

    let engine = createAttemptEngine();
    const startCorrelationId = 'telegram-update:9001000001';
    const started = await engine.confirmStart({
      userId: fixture.employee.id,
      projectId: fixture.project.id,
      confirmed: true,
      correlationId: startCorrelationId,
    });
    const attemptId = started.attempt.id;
    assert.equal(started.attempt.userId, fixture.employee.id);
    assert.equal(started.attempt.projectId, fixture.project.id);
    const pinnedAttempt = await prisma.trainingAttempt.findUniqueOrThrow({
      where: { id: attemptId },
      select: { assignmentId: true },
    });
    assert.equal(pinnedAttempt.assignmentId, fixture.assignment.id);

    const revokedAssignments = await assignments.replaceAssignments(
      fixture.project.id,
      {
        userIds: [fixture.unassignedEmployee.id],
        expectedRevision: initialAssignments.audienceRevision,
      },
      fixture.admin,
      { headers: {} },
    );
    assert.equal(revokedAssignments.total, 1);
    assert.equal(
      revokedAssignments.items[0]?.userId,
      fixture.unassignedEmployee.id,
    );
    await assert.rejects(
      () =>
        telegramLinks.issueLinkToken(
          fixture.employee.id,
          fixture.project.id,
        ),
      /Training project not found/u,
    );
    const resultsWhileRevoked = await new TrainingResultsService(
      prisma,
    ).listEmployeeProjects(fixture.employee.id);
    assert.equal(resultsWhileRevoked.items.length, 0);

    const answerCorrelations = [];
    for (let index = 0; index < 4; index += 1) {
      const current = (await engine.getAttempt(attemptId)).attempt;
      const question = current.attemptQuestions.find((candidate) =>
        [
          TrainingAttemptQuestionStatus.PRESENTED,
          TrainingAttemptQuestionStatus.COLLECTING,
        ].includes(candidate.status),
      );
      assert.ok(question, `question ${index + 1} must be presented`);
      const correlationId = `telegram-update:${9_001_000_010 + index}`;
      answerCorrelations.push(correlationId);
      const transcript =
        index === 0
          ? 'Полный главный ответ [[unsupported:вымышленный факт]]'
          : `Полный дополнительный ответ ${index}`;
      await engine.appendVoiceSegment({
        attemptId,
        kind: 'VOICE',
        updateId: BigInt(9_001_000_010 + index),
        telegramMessageId: BigInt(9_001_000_110 + index),
        telegramChatId: 9_001_000_002n,
        telegramFileId: `training-full-chain-file-${index}`,
        fileUniqueId: transcript,
        fakeTranscript: transcript,
        recordingStartedAt: new Date(),
        receivedAt: new Date(),
        durationSeconds: 1,
        correlationId,
      });
      await engine.finishAnswer({
        attemptId,
        attemptQuestionId: question.id,
        correlationId,
      });

      engine.onModuleDestroy();
      engine = createAttemptEngine();
      await waitForAnswerProcessing({
        attemptId,
        completedQuestionSequence: index + 1,
      });
    }

    const pendingReview = (await engine.getAttempt(attemptId)).attempt;
    assert.equal(
      pendingReview.status,
      TrainingAttemptStatus.REQUIRES_REVIEW,
    );
    assert.equal(Number(pendingReview.serverScore), 100);
    const unsupported =
      await prisma.trainingScoreComponent.findFirstOrThrow({
        where: {
          factVerdict: 'UNSUPPORTED',
          evaluation: {
            answer: {
              attemptQuestion: { attemptId },
            },
          },
        },
      });
    const reviewed = (
      await engine.reviewAttempt({
        attemptId,
        reviewerId: fixture.admin.id,
        idempotencyKey: 'training-full-chain-review-0001',
        decision: 'APPROVED',
        comment: 'E2E: утверждение отмечено как ошибка сотрудника',
        unsupportedClaimsDecisions: [
          {
            componentKey: unsupported.componentKey,
            decision: 'INCORRECT',
          },
        ],
      })
    ).attempt;
    assert.equal(Number(reviewed.finalScore), 95);
    assert.equal(reviewed.passStatus, TrainingPassStatus.PASSED);
    assert.equal(reviewed.reviewStatus, TrainingReviewStatus.APPROVED);

    await assert.rejects(
      () =>
        assignments.replaceAssignments(
          fixture.project.id,
          {
            userIds: [fixture.employee.id],
            expectedRevision: initialAssignments.audienceRevision,
          },
          fixture.admin,
          { headers: {} },
        ),
      /revision conflict/u,
    );
    const restoredAssignments = await assignments.replaceAssignments(
      fixture.project.id,
      {
        userIds: [fixture.employee.id],
        expectedRevision: revokedAssignments.audienceRevision,
      },
      fixture.admin,
      { headers: {} },
    );
    assert.equal(restoredAssignments.eligibleTotal, 1);

    await assertConnectedDatabaseState({
      attemptId,
      fixture,
      storage,
      startCorrelationId,
      answerCorrelations,
    });
    const connectedResult = await assertResultRankingAndCsv({
      attemptId,
      fixture,
    });

    const api = spawnManaged(process.execPath, ['apps/api/dist/main.js']);
    await waitForHttp(`${apiOrigin}/health`, api);
    const web = spawnManaged(
      'pnpm',
      [
        '--filter',
        '@platforma/web',
        'exec',
        'vite',
        'preview',
        '--host',
        '127.0.0.1',
        '--port',
        String(webPort),
        '--strictPort',
      ],
    );
    await waitForHttp(webOrigin, web);

    browser = await chromium.launch({ headless: true });
    await assertEmployeeUi({
      browser,
      attemptId,
      fixture,
    });
    await assertAdminUiAndCsv({
      browser,
      attemptId,
      fixture,
      csv: connectedResult.unfilteredCsv,
    });

    console.log(
      `Training full-chain E2E passed for user=${fixture.employee.id} project=${fixture.project.id} attempt=${attemptId}`,
    );
    engine.onModuleDestroy();
  } finally {
    await browser?.close().catch(() => undefined);
    await stopManagedProcesses();
    await prisma.$disconnect().catch(() => undefined);
    await rm(tempDirectory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

async function createFixture(storage) {
  const unique = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const [admin, trainingPilotRole] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { email: process.env.TRAINING_E2E_ADMIN_EMAIL },
    }),
    prisma.role.findUniqueOrThrow({ where: { name: 'training_pilot' } }),
  ]);
  const employeePassword = 'TrainingE2E!1';
  const employee = await prisma.user.create({
    data: {
      email: `training-full-chain-${unique}@example.test`,
      name: 'Training Full Chain Employee',
      passwordHash: await argon2.hash(employeePassword, {
        type: argon2.argon2id,
      }),
      roleId: trainingPilotRole.id,
      status: UserStatus.ACTIVE,
    },
  });
  const unassignedEmployee = await prisma.user.create({
    data: {
      email: `training-unassigned-${unique}@example.test`,
      name: 'Training Unassigned Employee',
      passwordHash: await argon2.hash(employeePassword, {
        type: argon2.argon2id,
      }),
      roleId: trainingPilotRole.id,
      status: UserStatus.ACTIVE,
    },
  });
  const realEstateObject = await prisma.realEstateObject.create({
    data: {
      slug: `training-linked-object-${unique}`,
      title: 'ЖК для linked PDF E2E',
      status: 'PUBLISHED',
    },
  });
  const pdf = await createPdf('Linked object PDF training fact');
  const pdfChecksum = createHash('sha256').update(pdf).digest('hex');
  const pdfKey = `training-linked-e2e/${unique}.pdf`;
  await storage.putObject({
    key: pdfKey,
    body: pdf,
    contentType: 'application/pdf',
  });
  const linkedFile = await prisma.file.create({
    data: {
      storage: FileStorage.MINIO,
      bucket: storage.getBucket(),
      key: pdfKey,
      url: null,
      originalName: 'linked-training-e2e.pdf',
      mimeType: 'application/pdf',
      sizeBytes: BigInt(pdf.length),
      checksum: pdfChecksum,
      uploadedById: admin.id,
    },
  });
  const objectFile = await prisma.objectFile.create({
    data: {
      objectId: realEstateObject.id,
      fileId: linkedFile.id,
      type: ObjectFileType.PRESENTATION,
      title: 'Презентация linked PDF E2E',
      sortOrder: 1,
    },
  });
  const project = await prisma.trainingProject.create({
    data: {
      slug: `training-full-chain-${unique}`,
      title: 'Единый E2E-проект обучения',
      description: 'Связанный сценарий этапа 10',
      status: TrainingProjectStatus.DRAFT,
      realEstateObjectId: realEstateObject.id,
      audienceMode: TrainingProjectAudienceMode.ASSIGNED_ONLY,
    },
  });
  const version = await prisma.trainingProjectVersion.create({
    data: {
      projectId: project.id,
      versionNumber: 1,
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
    },
  });
  const mainQuestion = await prisma.trainingQuestion.create({
    data: {
      projectVersionId: version.id,
      type: TrainingQuestionType.MAIN,
      text: 'Главный вопрос единого E2E',
      position: 1,
      maxScore: 55,
    },
  });
  await prisma.trainingQuestion.createMany({
    data: Array.from({ length: 10 }, (_, index) => ({
      projectVersionId: version.id,
      type: TrainingQuestionType.FOLLOW_UP,
      text: `Дополнительный вопрос единого E2E ${index + 1}`,
      position: index + 1,
      maxScore: 15,
    })),
  });
  const fact = await prisma.trainingFact.create({
    data: {
      projectVersionId: version.id,
      code: 'e2e.approved.fact',
      topicCode: 'e2e',
      statement: 'Утверждённый факт единого E2E',
      acceptedAliasesJson: [],
      isApproved: true,
    },
  });
  await prisma.trainingQuestionFactLink.create({
    data: {
      questionId: mainQuestion.id,
      factId: fact.id,
      isRequired: true,
    },
  });
  await prisma.trainingEvaluationCriterion.createMany({
    data: [
      {
        projectVersionId: version.id,
        questionType: TrainingQuestionType.MAIN,
        code: 'e2e-main',
        title: 'Главный ответ',
        maxPoints: 55,
        anchorsJson: [
          {
            id: 'e2e-main-full',
            points: 55,
            description: 'Полный ответ',
          },
        ],
        sortOrder: 1,
      },
      {
        projectVersionId: version.id,
        questionType: TrainingQuestionType.FOLLOW_UP,
        code: 'e2e-follow',
        title: 'Дополнительный ответ',
        maxPoints: 15,
        anchorsJson: [
          {
            id: 'e2e-follow-full',
            points: 15,
            description: 'Полный ответ',
          },
        ],
        sortOrder: 1,
      },
    ],
  });
  const documents = new TrainingDocumentsService(
    prisma,
    new FilesService(prisma, storage),
  );
  const linkedPdfCandidates = await documents.listLinkedObjectPdfs(version.id);
  assert.equal(linkedPdfCandidates.items.length, 1);
  assert.equal(linkedPdfCandidates.items[0]?.eligible, true);
  assert.equal(linkedPdfCandidates.items[0]?.recommendedByDefault, true);
  const attached = await documents.attachLinkedObjectPdfs(
    version.id,
    { objectFileIds: [objectFile.id] },
    admin,
    { headers: {} },
  );
  assert.equal(attached.createdCount, 1);
  const sourceDocument = await waitForLinkedDocumentExtraction(
    attached.items[0].document.id,
  );
  assert.equal(
    sourceDocument.originKind,
    TrainingSourceOriginKind.LINKED_OBJECT_PDF,
  );
  assert.match(
    sourceDocument.extractedText ?? '',
    /Linked object PDF training fact/u,
  );

  await prisma.trainingProjectVersion.update({
    where: { id: version.id },
    data: {
      status: TrainingVersionStatus.PUBLISHED,
      publishedAt: new Date(),
      publishedById: admin.id,
    },
  });
  const assignment = await prisma.trainingProjectAssignment.create({
    data: {
      projectId: project.id,
      userId: employee.id,
      assignedById: admin.id,
    },
  });
  await prisma.trainingProject.update({
    where: { id: project.id },
    data: {
      status: TrainingProjectStatus.OPEN,
      activeVersionId: version.id,
    },
  });
  return {
    admin,
    employee: {
      ...employee,
      password: employeePassword,
    },
    unassignedEmployee,
    project,
    version,
    assignment,
    sourceDocument,
  };
}

async function waitForLinkedDocumentExtraction(documentId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const document = await prisma.trainingSourceDocument.findUniqueOrThrow({
      where: { id: documentId },
    });
    if (
      document.extractionStatus === TrainingSourceExtractionStatus.READY
    ) {
      return document;
    }
    if (
      document.extractionStatus === TrainingSourceExtractionStatus.FAILED ||
      document.extractionStatus ===
        TrainingSourceExtractionStatus.NEEDS_MANUAL_TEXT
    ) {
      throw new Error(
        `Linked PDF extraction stopped with ${document.extractionStatus}: ${document.errorMessage ?? 'no error'}`,
      );
    }
    await wait(100);
  }
  throw new Error('Linked PDF extraction did not finish in time');
}

function createPdf(text) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({
      autoFirstPage: false,
      compress: false,
    });
    const chunks = [];
    document.on('data', (chunk) => chunks.push(chunk));
    document.on('error', reject);
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.addPage();
    document.fontSize(18).text(text);
    document.end();
  });
}

async function assertConnectedDatabaseState({
  attemptId,
  fixture,
  storage,
  startCorrelationId,
  answerCorrelations,
}) {
  const attempt = await prisma.trainingAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    include: {
      user: true,
      project: true,
      projectVersion: true,
      attemptQuestions: {
        orderBy: { sequence: 'asc' },
        include: {
          answer: {
            include: {
              voiceSegments: { include: { originalFile: true } },
              mergedAudioFile: true,
              providerRuns: true,
              activeEvaluation: {
                include: { scoreComponents: true },
              },
            },
          },
        },
      },
      reviews: true,
    },
  });
  assert.equal(attempt.user.id, fixture.employee.id);
  assert.equal(attempt.project.id, fixture.project.id);
  assert.equal(attempt.projectVersion.id, fixture.version.id);
  assert.equal(attempt.attemptQuestions.length, 4);
  assert.equal(attempt.reviews.length, 1);

  const audioBucket = storage.getTrainingAudioBucket();
  for (const [index, question] of attempt.attemptQuestions.entries()) {
    assert.ok(question.answer);
    assert.equal(question.answer.voiceSegments.length, 1);
    assert.equal(
      question.answer.voiceSegments[0].originalFile.bucket,
      audioBucket,
    );
    assert.equal(question.answer.mergedAudioFile.bucket, audioBucket);
    assert.equal(
      (
        await storage.headObject(
          question.answer.mergedAudioFile.key,
          question.answer.mergedAudioFile.bucket,
        )
      ).exists,
      true,
    );
    assert.equal(question.answer.providerRuns.length, 2);
    for (const providerRun of question.answer.providerRuns) {
      assert.equal(
        providerRun.inputMetadataJson.correlationId,
        answerCorrelations[index],
      );
    }
  }

  const linkedAccount =
    await prisma.trainingTelegramAccount.findUniqueOrThrow({
      where: { userId: fixture.employee.id },
    });
  assert.equal(linkedAccount.revokedAt, null);
  const acceptance = await prisma.trainingPolicyAcceptance.findFirstOrThrow({
    where: { userId: fixture.employee.id, revokedAt: null },
  });
  assert.ok(acceptance.policyVersionId);

  const jobPayloads = await prisma.trainingJob.findMany({
    where: {
      payloadJson: {
        path: ['attemptId'],
        equals: attemptId,
      },
      kind: {
        in: [
          TrainingJobKind.TELEGRAM_DOWNLOAD_SEGMENT,
          TrainingJobKind.ASSEMBLE_ANSWER_AUDIO,
          TrainingJobKind.TRANSCRIBE_ANSWER,
          TrainingJobKind.EVALUATE_ANSWER,
          TrainingJobKind.FINALIZE_ATTEMPT,
        ],
      },
    },
    select: {
      kind: true,
      payloadJson: true,
    },
  });
  assert.ok(jobPayloads.length >= 17);
  assert.equal(
    jobPayloads.some(
      (job) =>
        job.kind === TrainingJobKind.FINALIZE_ATTEMPT &&
        answerCorrelations.includes(job.payloadJson.correlationId),
    ),
    true,
  );
  assert.equal(
    jobPayloads.every(
      (job) =>
        job.payloadJson.correlationId === startCorrelationId ||
        answerCorrelations.includes(job.payloadJson.correlationId),
    ),
    true,
  );
}

async function waitForTrainingWorkers() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const heartbeats = await prisma.trainingWorkerHeartbeat.findMany({
      where: { workerKind: { in: ['audio', 'attempt', 'document'] } },
      select: { workerKind: true },
    });
    const kinds = new Set(
      heartbeats.map((heartbeat) => heartbeat.workerKind),
    );
    if (
      kinds.has('audio') &&
      kinds.has('attempt') &&
      kinds.has('document')
    ) {
      return;
    }
    await wait(100);
  }
  throw new Error('Training audio/attempt/document worker did not become ready');
}

async function waitForAnswerProcessing({
  attemptId,
  completedQuestionSequence,
}) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const attempt = await prisma.trainingAttempt.findUniqueOrThrow({
      where: { id: attemptId },
      include: {
        attemptQuestions: {
          orderBy: { sequence: 'asc' },
          include: { answer: true },
        },
      },
    });
    const completed =
      attempt.attemptQuestions[completedQuestionSequence - 1];
    const next =
      attempt.attemptQuestions[completedQuestionSequence];
    const completedScored =
      completed?.status === TrainingAttemptQuestionStatus.SCORED &&
      completed.answer?.status === 'SCORED';
    const nextReady =
      completedQuestionSequence < 4
        ? next?.status === TrainingAttemptQuestionStatus.PRESENTED
        : [
            TrainingAttemptStatus.COMPLETED,
            TrainingAttemptStatus.REQUIRES_REVIEW,
          ].includes(attempt.status);
    if (completedScored && nextReady) return;
    const deadJob = await prisma.trainingJob.findFirst({
      where: {
        status: 'DEAD',
        payloadJson: {
          path: ['attemptId'],
          equals: attemptId,
        },
      },
      select: {
        kind: true,
        lastErrorCode: true,
        lastErrorMessage: true,
      },
    });
    if (deadJob) {
      throw new Error(
        `Training full-chain worker job became DEAD: ${deadJob.kind} ${deadJob.lastErrorCode ?? ''} ${deadJob.lastErrorMessage ?? ''}`.trim(),
      );
    }
    await wait(100);
  }
  throw new Error(
    `Training answer ${completedQuestionSequence} did not finish`,
  );
}

async function assertResultRankingAndCsv({ attemptId, fixture }) {
  const results = new TrainingResultsService(prisma);
  const employee = await results.getEmployeeAttempt(
    fixture.employee.id,
    attemptId,
  );
  assert.equal(employee.attempt.id, attemptId);
  assert.equal(employee.attempt.project.id, fixture.project.id);
  assert.equal(Number(employee.attempt.finalScore), 95);

  const admin = await results.getAdminAttempt(
    attemptId,
    {
      ...fixture.admin,
      permissions: ['training:results:read'],
    },
    {
      ip: '127.0.0.1',
      headers: { 'user-agent': 'training-full-chain-e2e' },
    },
  );
  assert.equal(admin.attempt.id, attemptId);
  assert.equal(admin.attempt.user.id, fixture.employee.id);
  assert.equal(admin.attempt.project.id, fixture.project.id);

  const rankingService = new TrainingRankingService(prisma);
  const ranking = await rankingService.list({
    page: 1,
    pageSize: 25,
    user: fixture.employee.email,
    projectId: fixture.project.id,
  });
  assert.equal(ranking.items.length, 1);
  assert.equal(ranking.items[0].user.id, fixture.employee.id);
  assert.equal(ranking.items[0].projects[0].attemptId, attemptId);
  assert.equal(Number(ranking.items[0].projects[0].finalScore), 95);

  const exported = await rankingService.listForExport({
    user: fixture.employee.email,
    projectId: fixture.project.id,
  });
  const csv = buildTrainingRankingCsv(exported);
  assert.equal(csv.startsWith('\uFEFF'), true);
  assert.match(csv, new RegExp(escapeRegExp(fixture.employee.email), 'u'));
  assert.match(csv, new RegExp(escapeRegExp(fixture.project.title), 'u'));
  const unfilteredCsv = buildTrainingRankingCsv(
    await rankingService.listForExport({}),
  );
  return { csv, unfilteredCsv };
}

async function assertEmployeeUi({ browser, fixture }) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await login(
      page,
      fixture.employee.email,
      fixture.employee.password,
    );
    await page.goto(`${webOrigin}/training`);
    await page.getByText(fixture.project.title, { exact: false }).first()
      .waitFor();
    await page
      .getByRole('button', { name: 'Открыть попытку 1' })
      .click();
    const detail = page.locator('.training-attempt-detail');
    await detail.getByText('95', { exact: true }).first().waitFor();
    await detail.getByText('Пройдено', { exact: true }).waitFor();
    assert.match(await detail.textContent(), /Подтверждено/u);
  } finally {
    await context.close();
  }
}

async function assertAdminUiAndCsv({
  browser,
  attemptId,
  fixture,
  csv,
}) {
  const context = await browser.newContext({ acceptDownloads: true });
  try {
    const page = await context.newPage();
    await login(
      page,
      process.env.TRAINING_E2E_ADMIN_EMAIL,
      process.env.TRAINING_E2E_ADMIN_PASSWORD,
    );
    await page.goto(
      `${webOrigin}/admin/training/results/${attemptId}`,
    );
    await page.getByText(fixture.project.title, { exact: false }).first()
      .waitFor();
    await page
      .getByText('E2E: утверждение отмечено как ошибка сотрудника', {
        exact: true,
      })
      .waitFor();
    assert.match(await page.locator('body').textContent(), /95/u);

    await page.goto(`${webOrigin}/admin/training/ranking`);
    await page.getByText('Рейтинг сотрудников', { exact: true }).waitFor();
    await page.getByText(fixture.employee.email, { exact: true }).waitFor();
    await page
      .getByRole('row')
      .filter({ hasText: fixture.employee.email })
      .getByRole('button', { name: 'Разбор' })
      .click();
    await page
      .locator('.training-ranking-projects')
      .getByText(fixture.project.title, { exact: true })
      .waitFor();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'CSV' }).click();
    const download = await downloadPromise;
    const downloadedPath = await download.path();
    assert.ok(downloadedPath);
    const downloadedCsv = await readFile(downloadedPath, 'utf8');
    assert.equal(downloadedCsv, csv);
  } finally {
    await context.close();
  }
}

async function login(page, email, password) {
  await page.goto(`${webOrigin}/login`);
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForURL((url) => url.pathname !== '/login');
}

function spawnManaged(command, args) {
  const child = spawn(command, args, {
    cwd: rootDir,
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  processes.add(child);
  child.once('exit', () => processes.delete(child));
  return child;
}

async function waitForHttp(url, child) {
  const deadline = Date.now() + 120_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Process for ${url} exited before becoming ready`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(250);
  }
  throw lastError ?? new Error(`${url} did not become ready`);
}

async function stopManagedProcesses() {
  const active = [...processes];
  for (const child of active) {
    child.kill('SIGTERM');
  }
  await Promise.all(
    active.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          const timeout = setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
          }, 5_000);
          child.once('exit', () => {
            clearTimeout(timeout);
            resolve();
          });
        }),
    ),
  );
}

function readPort(name) {
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a valid port`);
  }
  return value;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class FirstQuestionsSelector {
  select(candidates, count) {
    return candidates.slice(0, count).map((candidate, randomIndex) => ({
      candidate,
      randomIndex,
    }));
  }
}
