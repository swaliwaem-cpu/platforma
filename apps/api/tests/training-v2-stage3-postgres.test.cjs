require('reflect-metadata');

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, beforeEach, test } = require('node:test');
const {
  Prisma,
  PrismaClient,
  TrainingAnswerProcessingStatus,
  TrainingAnswerSource,
  TrainingAttemptStatus,
  TrainingProjectAccessMode,
  UserStatus,
} = require('@prisma/client');
const { ConflictException } = require('@nestjs/common');

const { TrainingAttemptStateService } = require('../dist/training/training-attempt-state.service.js');
const { TrainingAttemptService } = require('../dist/training/training-attempt.service.js');
const { DeterministicFakeTrainingEvaluator } = require('../dist/training/training-evaluator.js');
const { TrainingOpenAIError } = require('../dist/training/training-openai-client.js');
const { TrainingProjectService } = require('../dist/training/training-project.service.js');
const { TrainingProjectAccessService } = require('../dist/training/training-project-access.service.js');
const { TrainingReviewService } = require('../dist/training/training-review.service.js');
const { TrainingVoiceWorkerService } = require('../dist/training/training-voice-worker.service.js');

const databaseUrl = process.env.TRAINING_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('Training Stage 3 PostgreSQL scenarios require the targeted runner', () => {
    assert.equal(process.env.TRAINING_TEST_DATABASE_URL, undefined);
  });
} else {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const projectAccess = new TrainingProjectAccessService(prisma);
  const fakeEvaluator = new DeterministicFakeTrainingEvaluator();
  const state = new TrainingAttemptStateService(
    prisma,
    fakeEvaluator,
    { select: (candidates) => candidates.slice(0, 3) },
    projectAccess,
  );
  const attempts = new TrainingAttemptService(prisma, state, projectAccess);
  const projects = new TrainingProjectService(prisma);
  const reviewNotifications = [];
  const reviews = new TrainingReviewService(prisma, {
    dispatchAttemptStateNotification: (attemptId) => reviewNotifications.push(attemptId),
  });

  before(async () => prisma.$connect());
  beforeEach(clearTrainingData);
  after(async () => {
    await clearTrainingData();
    await prisma.$disconnect();
  });

  test('snapshot freezes facts/criteria and live edits do not change an existing attempt', async () => {
    const user = await createUser('snapshot');
    const project = await createOpenProject('Stage 3 snapshot');
    const started = await attempts.startAttempt(project.id, user.id, startInput());
    const stored = await prisma.trainingAttempt.findUniqueOrThrow({ where: { id: started.id } });
    const snapshot = stored.projectSnapshotJson;

    assert.equal(snapshot.schemaVersion, 3);
    assert.equal(snapshot.evaluationSchemaVersion, 'training-v2-evaluation-v2');
    assert.equal(snapshot.questions.every((question) => question.facts.length === 1), true);
    assert.equal(snapshot.criteria.main.reduce((sum, item) => sum + item.maxPoints, 0), 55);
    assert.equal(snapshot.criteria.followUp.reduce((sum, item) => sum + item.maxPoints, 0), 15);

    await projects.setAvailability(project.id, false);
    await projects.updateDraft(project.id, projectDraft('Stage 3 changed', 'Изменённый факт'));
    const unchanged = await prisma.trainingAttempt.findUniqueOrThrow({ where: { id: started.id } });
    assert.deepEqual(unchanged.projectSnapshotJson, snapshot);
  });

  test('legacy schema v1 project still publishes, opens and starts with a v1 snapshot', async () => {
    const user = await createUser('legacy-v1');
    const legacy = await prisma.trainingProject.create({
      data: {
        title: 'Legacy Stage 2 project',
        description: null,
        realEstateObjectId: null,
        sortOrder: 0,
        attemptLimit: 3,
        timeLimitSeconds: 420,
        passScore: 75,
        allowRetakeAfterPass: true,
        contentSchemaVersion: 1,
        accessMode: TrainingProjectAccessMode.ALL_PARTICIPANTS,
        questions: {
          create: [
            {
              type: 'MAIN',
              text: 'Legacy main',
              position: 1,
            },
            ...Array.from({ length: 10 }, (_, index) => ({
              type: 'FOLLOW_UP',
              text: `Legacy follow-up ${index + 1}`,
              position: index + 1,
            })),
          ],
        },
      },
    });

    const published = await projects.publishProject(legacy.id);
    assert.equal(published.status, 'PUBLISHED');
    assert.deepEqual(published.publicationErrors, []);
    const opened = await projects.setAvailability(legacy.id, true);
    assert.equal(opened.isOpen, true);

    const started = await attempts.startAttempt(legacy.id, user.id, startInput());
    const stored = await prisma.trainingAttempt.findUniqueOrThrow({
      where: { id: started.id },
    });
    assert.equal(stored.projectSnapshotJson.schemaVersion, 1);
  });

  test('transcription checkpoint survives evaluation retry and skips a second transcription', async () => {
    const item = await createProcessingAnswer('resume-transcription');
    const transcriber = new RecordingTranscriber();
    const evaluator = new FailOnceEvaluator(fakeEvaluator);
    const worker = createWorker(new FakeAudio(prisma), transcriber, evaluator, state);

    assert.equal(await worker.runOnce(), true);
    const checkpoint = await prisma.trainingAnswer.findUniqueOrThrow({ where: { id: item.answerId } });
    assert.equal(checkpoint.transcriptionStatus, 'COMPLETED');
    assert.equal(checkpoint.evaluationStatus, 'PENDING');
    assert.equal(checkpoint.text, '[fake:pass]');
    assert.equal(checkpoint.processingStatus, 'PROCESSING');

    assert.equal(await worker.runOnce(), true);
    const completed = await prisma.trainingAnswer.findUniqueOrThrow({ where: { id: item.answerId } });
    assert.equal(transcriber.calls, 1);
    assert.equal(evaluator.calls, 2);
    assert.equal(completed.processingStatus, 'COMPLETED');
    assert.equal(completed.evaluationStatus, 'COMPLETED');
    assert.equal(completed.processingAttempts, 2);
    assert.equal(completed.evaluationAttempts, 2);
    assert.equal(await prisma.trainingAttemptQuestion.count({ where: { attemptId: item.attempt.id } }), 4);
  });

  test('classified harmless voice answer persists its route and does not block final completion', async () => {
    const item = await createProcessingAnswer('harmless-routing');
    const transcriber = {
      transcribe: async () => ({
        text: '[fake:harmless]',
        model: 'stub-transcriber',
        requestId: 'harmless-transcription',
        latencyMs: 1,
        attempts: 1,
        usage: null,
      }),
    };
    const worker = createWorker(new FakeAudio(prisma), transcriber, fakeEvaluator, state);
    const previous = process.env.TRAINING_HARMLESS_EXTRA_ROUTING_ENABLED;
    process.env.TRAINING_HARMLESS_EXTRA_ROUTING_ENABLED = 'true';

    try {
      assert.equal(await worker.runOnce(), true);
    } finally {
      if (previous === undefined) delete process.env.TRAINING_HARMLESS_EXTRA_ROUTING_ENABLED;
      else process.env.TRAINING_HARMLESS_EXTRA_ROUTING_ENABLED = previous;
    }

    const storedAnswer = await prisma.trainingAnswer.findUniqueOrThrow({
      where: { id: item.answerId },
    });
    assert.equal(storedAnswer.fakeOutcome, 'SCORED');
    assert.equal(storedAnswer.evaluationSchemaVersion, 'training-v2-evaluation-v2');
    assert.deepEqual(storedAnswer.evaluationJson.unsupported_claims, [{
      claim: 'fake harmless extra',
      evidence: '[fake:harmless]',
      category: 'HARMLESS_EXTRA',
    }]);
    assert.equal(storedAnswer.evaluationJson.requires_review, false);

    const completed = await answerAll(
      await attempts.getEmployeeAttempt(item.attempt.id, item.user.id),
      item.user.id,
      '[fake:pass]',
    );
    assert.equal(completed.status, 'COMPLETED');
    assert.notEqual(completed.result.finalScore, null);
  });

  test('retryable evaluation exhausts after two worker cycles with safe detail and refunded attempt', async () => {
    const item = await createProcessingAnswer('evaluation-exhausted');
    const transcriber = new RecordingTranscriber();
    const evaluator = new AlwaysRetryableEvaluator(fakeEvaluator);
    const worker = createWorker(new FakeAudio(prisma), transcriber, evaluator, state);

    assert.equal(await worker.runOnce(), true);
    const retrying = await prisma.trainingAnswer.findUniqueOrThrow({ where: { id: item.answerId } });
    assert.equal(retrying.processingStatus, 'PROCESSING');
    assert.equal(retrying.processingErrorCode, null);
    assert.equal(retrying.processingAttempts, 1);
    assert.equal(retrying.evaluationAttempts, 2);

    assert.equal(await worker.runOnce(), true);
    const failedAnswer = await prisma.trainingAnswer.findUniqueOrThrow({ where: { id: item.answerId } });
    const failedAttempt = await prisma.trainingAttempt.findUniqueOrThrow({ where: { id: item.attempt.id } });
    assert.equal(transcriber.calls, 1);
    assert.equal(evaluator.calls, 2);
    assert.equal(failedAnswer.processingStatus, 'FAILED');
    assert.equal(failedAnswer.processingAttempts, 2);
    assert.equal(failedAnswer.evaluationAttempts, 4);
    assert.equal(
      failedAnswer.processingErrorCode,
      'OPENAI_EVALUATION_INVALID_CRITERION_POINTS_OUT_OF_RANGE',
    );
    assert.equal(failedAttempt.status, 'TECHNICAL_FAILED');
    assert.equal(failedAttempt.countsTowardAttemptLimit, false);
    assert.equal(failedAttempt.finalScore, null);
    assert.equal(await worker.runOnce(), false);
  });

  test('deterministic evaluation failure is not repeated by the voice worker', async () => {
    const item = await createProcessingAnswer('evaluation-deterministic');
    const transcriber = new RecordingTranscriber();
    const evaluator = new AlwaysDeterministicInvalidEvaluator(fakeEvaluator);
    const worker = createWorker(new FakeAudio(prisma), transcriber, evaluator, state);

    assert.equal(await worker.runOnce(), true);
    const failedAnswer = await prisma.trainingAnswer.findUniqueOrThrow({
      where: { id: item.answerId },
    });
    const failedAttempt = await prisma.trainingAttempt.findUniqueOrThrow({
      where: { id: item.attempt.id },
    });
    assert.equal(transcriber.calls, 1);
    assert.equal(evaluator.calls, 1);
    assert.equal(failedAnswer.processingStatus, 'FAILED');
    assert.equal(failedAnswer.processingAttempts, 1);
    assert.equal(failedAnswer.evaluationAttempts, 2);
    assert.equal(
      failedAnswer.processingErrorCode,
      'OPENAI_EVALUATION_INVALID_EVIDENCE_NOT_IN_TRANSCRIPT',
    );
    assert.equal(failedAttempt.status, 'TECHNICAL_FAILED');
    assert.equal(failedAttempt.finalScore, null);
    assert.equal(await worker.runOnce(), false);
  });

  test('evaluation checkpoint survives progression restart and creates follow-ups exactly once', async () => {
    const item = await createProcessingAnswer('resume-evaluation');
    const transcriber = new RecordingTranscriber();
    const evaluator = new RecordingEvaluator(fakeEvaluator);
    let progressionCalls = 0;
    const stateWithCrash = {
      finalizeAttemptIfExpired: (...args) => state.finalizeAttemptIfExpired(...args),
      failTelegramVoiceAttempt: (...args) => state.failTelegramVoiceAttempt(...args),
      completeEvaluatedTelegramVoiceAnswer: async () => {
        progressionCalls += 1;
        throw new Error('simulated restart after evaluation checkpoint');
      },
    };
    const firstWorker = createWorker(new FakeAudio(prisma), transcriber, evaluator, stateWithCrash);

    assert.equal(await firstWorker.runOnce(), true);
    const checkpoint = await prisma.trainingAnswer.findUniqueOrThrow({ where: { id: item.answerId } });
    assert.equal(checkpoint.evaluationStatus, 'COMPLETED');
    assert.equal(checkpoint.processingStatus, 'PROCESSING');

    const resumedWorker = createWorker(new FakeAudio(prisma), transcriber, evaluator, state);
    assert.equal(await resumedWorker.runOnce(), true);
    assert.equal(transcriber.calls, 1);
    assert.equal(evaluator.calls, 1);
    assert.equal(progressionCalls, 1);
    const questions = await prisma.trainingAttemptQuestion.findMany({
      where: { attemptId: item.attempt.id },
      orderBy: { sequence: 'asc' },
    });
    assert.deepEqual(questions.map((question) => question.sequence), [1, 2, 3, 4]);
    assert.equal(await resumedWorker.runOnce(), false);
  });

  test('permanent provider failure refunds attempt and allows a replacement at limit one', async () => {
    const item = await createProcessingAnswer('technical', { attemptLimit: 1 });
    const transcriber = {
      transcribe: async () => {
        throw new TrainingOpenAIError('OPENAI_UNAUTHORIZED', false, 1);
      },
    };
    const worker = createWorker(new FakeAudio(prisma), transcriber, fakeEvaluator, state);

    assert.equal(await worker.runOnce(), true);
    const failedAttempt = await prisma.trainingAttempt.findUniqueOrThrow({ where: { id: item.attempt.id } });
    const failedAnswer = await prisma.trainingAnswer.findUniqueOrThrow({ where: { id: item.answerId } });
    assert.equal(failedAttempt.status, 'TECHNICAL_FAILED');
    assert.equal(failedAttempt.countsTowardAttemptLimit, false);
    assert.equal(failedAttempt.finalScore, null);
    assert.equal(failedAttempt.isPassed, false);
    assert.equal(failedAnswer.processingStatus, 'FAILED');
    assert.equal(failedAnswer.processingErrorCode, 'OPENAI_UNAUTHORIZED');
    assert.equal(failedAnswer.transcriptionStatus, 'FAILED');

    const employee = await attempts.getEmployeeAttempt(item.attempt.id, item.user.id);
    assert.equal(employee.result.attemptRefunded, true);
    assert.equal(employee.result.message, 'Произошла техническая ошибка. Попытка возвращена.');
    assert.doesNotMatch(JSON.stringify(employee), /OPENAI_UNAUTHORIZED|transcript|evaluation/iu);
    const replacement = await attempts.startAttempt(item.project.id, item.user.id, startInput());
    assert.equal(replacement.attemptNumber, 2);
    const projectList = await attempts.listEmployeeProjects(item.user.id);
    assert.equal(projectList.items[0].attemptsUsed, 1);
  });

  test('pending review hides provisional result; approve and override are idempotent', async () => {
    reviewNotifications.length = 0;
    const reviewer = await createUser('reviewer');
    const employee = await createUser('reviewed');
    const project = await createOpenProject('Stage 3 review', { attemptLimit: 3 });
    const pending = await answerAll(
      await attempts.startAttempt(project.id, employee.id, startInput()),
      employee.id,
      '[fake:review]',
    );

    assert.equal(pending.status, 'REQUIRES_REVIEW');
    assert.equal(pending.result.finalScore, null);
    assert.deepEqual(pending.result.safeBreakdown, []);
    assert.doesNotMatch(JSON.stringify(pending), /calculatedScore|\[fake:review\]|evaluation/iu);
    const approved = await reviews.reviewAttempt(pending.id, reviewer.id, {
      decision: 'APPROVE', finalScore: null, comment: null,
    });
    const repeated = await reviews.reviewAttempt(pending.id, reviewer.id, {
      decision: 'APPROVE', finalScore: null, comment: null,
    });
    assert.deepEqual(repeated, approved);
    assert.equal(approved.reviewDecision, 'APPROVED');
    assert.equal(approved.isPassed, false);
    assert.deepEqual(reviewNotifications, [pending.id]);
    await assert.rejects(
      () => reviews.reviewAttempt(pending.id, reviewer.id, {
        decision: 'OVERRIDE', finalScore: 50, comment: 'Другая оценка',
      }),
      ConflictException,
    );
    await assert.rejects(
      () => attempts.startAttempt(project.id, employee.id, startInput()),
      ConflictException,
    );
    await prisma.$executeRaw(Prisma.sql`
      UPDATE training_attempts
       SET reviewed_at = CURRENT_TIMESTAMP - INTERVAL '59 minutes 59 seconds'
       WHERE id = CAST(${pending.id} AS uuid)
    `);
    await assert.rejects(
      () => attempts.startAttempt(project.id, employee.id, startInput()),
      ConflictException,
    );
    await prisma.$executeRaw(Prisma.sql`
      UPDATE training_attempts
       SET reviewed_at = CURRENT_TIMESTAMP - INTERVAL '60 minutes'
       WHERE id = CAST(${pending.id} AS uuid)
    `);

    const secondPending = await answerAll(
      await attempts.startAttempt(project.id, employee.id, startInput()),
      employee.id,
      '[fake:review]',
    );
    const overridden = await reviews.reviewAttempt(secondPending.id, reviewer.id, {
      decision: 'OVERRIDE', finalScore: 42, comment: 'Проверено вручную',
    });
    assert.equal(overridden.finalScore, 42);
    assert.equal(overridden.reviewDecision, 'OVERRIDDEN');
    assert.deepEqual(reviewNotifications, [pending.id, secondPending.id]);
    const visible = await attempts.getEmployeeAttempt(secondPending.id, employee.id);
    assert.equal(visible.result.finalScore, 42);
    assert.deepEqual(visible.result.safeBreakdown, []);
    assert.equal(visible.result.message, 'Итог скорректирован после проверки.');
  });

  async function createProcessingAnswer(label, overrides = {}) {
    const user = await createUser(label);
    const project = await createOpenProject(`Project ${label}`, overrides);
    const attempt = await attempts.startAttempt(project.id, user.id, startInput());
    const answer = await prisma.trainingAnswer.create({
      data: {
        attemptQuestionId: attempt.currentQuestion.id,
        source: TrainingAnswerSource.TELEGRAM,
        processingStatus: TrainingAnswerProcessingStatus.PROCESSING,
        submittedAt: new Date(),
        segments: {
          create: {
            position: 1,
            telegramMessageId: BigInt(Math.floor(Math.random() * 1_000_000) + 1),
            telegramFileId: `file-${randomUUID()}`,
            telegramFileUniqueId: `unique-${randomUUID()}`,
            durationSeconds: 30,
            sizeBytes: 64n,
          },
        },
      },
    });
    return { answerId: answer.id, attempt, project, user };
  }

  async function createOpenProject(title, overrides = {}) {
    const project = await projects.createProject({
      title,
      description: null,
      realEstateObjectId: null,
      sortOrder: 0,
      attemptLimit: overrides.attemptLimit ?? 3,
      timeLimitSeconds: 420,
      passScore: 75,
      allowRetakeAfterPass: true,
      accessMode: TrainingProjectAccessMode.ALL_PARTICIPANTS,
    });
    await projects.updateDraft(project.id, projectDraft(title, `${title} approved fact`, overrides));
    await projects.publishProject(project.id);
    return projects.setAvailability(project.id, true);
  }

  function projectDraft(title, factPrefix, overrides = {}) {
    return {
      title,
      description: null,
      realEstateObjectId: null,
      sortOrder: 0,
      attemptLimit: overrides.attemptLimit ?? 3,
      timeLimitSeconds: 420,
      passScore: 75,
      allowRetakeAfterPass: true,
      accessMode: TrainingProjectAccessMode.ALL_PARTICIPANTS,
      mainQuestion: `${title} main`,
      followUpQuestions: Array.from({ length: 10 }, (_, index) => `${title} follow-up ${index + 1}`),
      facts: Array.from({ length: 11 }, (_, index) => ({
        id: null,
        questionType: index === 0 ? 'MAIN' : 'FOLLOW_UP',
        questionPosition: index === 0 ? 1 : index,
        statement: `${factPrefix} ${index + 1}`,
        aliases: [`term ${index + 1}`],
        isRequired: true,
        position: 1,
      })),
      criteria: [
        { id: null, questionType: 'MAIN', code: 'main', title: 'Main', guidance: '', maxPoints: 55, position: 1 },
        { id: null, questionType: 'FOLLOW_UP', code: 'follow_up', title: 'Follow-up', guidance: '', maxPoints: 15, position: 1 },
      ],
    };
  }

  async function createUser(label) {
    const permission = await prisma.permission.upsert({
      where: { key: 'training:participate' },
      update: {},
      create: { key: 'training:participate', description: 'Participate' },
    });
    const role = await prisma.role.create({
      data: {
        name: `training-stage3-${label.slice(0, 12)}-${randomUUID().slice(0, 8)}`,
        description: 'Stage 3 test',
        permissions: { create: { permissionId: permission.id } },
      },
    });
    return prisma.user.create({
      data: { email: `${label}-${randomUUID()}@training.test`, passwordHash: 'hash', name: label, status: UserStatus.ACTIVE, roleId: role.id },
    });
  }

  async function answerAll(initial, userId, text) {
    let attempt = initial;
    while (attempt.currentQuestion) {
      attempt = await attempts.submitAnswer(attempt.id, userId, {
        attemptQuestionId: attempt.currentQuestion.id,
        text,
      });
    }
    return attempt;
  }

  function createWorker(audio, transcriber, evaluator, attemptState) {
    return new TrainingVoiceWorkerService(
      prisma,
      audio,
      transcriber,
      evaluator,
      attemptState,
      { notifyAnswerProcessed: async () => undefined, notifyAnswerFailed: async () => undefined },
    );
  }

  function startInput() {
    return { confirmed: true, idempotencyKey: randomUUID() };
  }

  async function clearTrainingData() {
    await prisma.trainingAnswerSegment.deleteMany();
    await prisma.trainingAnswer.deleteMany();
    await prisma.trainingAttemptQuestion.deleteMany();
    await prisma.trainingAttempt.deleteMany();
    await prisma.trainingTelegramLinkToken.deleteMany();
    await prisma.trainingTelegramAccount.deleteMany();
    await prisma.trainingProjectAssignment.deleteMany();
    await prisma.trainingFact.deleteMany();
    await prisma.trainingCriterion.deleteMany();
    await prisma.trainingQuestion.deleteMany();
    await prisma.trainingProject.deleteMany();
    await prisma.file.deleteMany({ where: { key: { startsWith: 'training-stage3-test/' } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: '@training.test' } } });
    await prisma.role.deleteMany({ where: { name: { startsWith: 'training-stage3-' } } });
  }

  class FakeAudio {
    constructor(database) {
      this.database = database;
    }

    async prepareAnswerAudio(answerId) {
      const existing = await this.database.trainingAnswer.findUniqueOrThrow({ where: { id: answerId } });
      let fileId = existing.mergedAudioFileId;

      if (!fileId) {
        const file = await this.database.file.create({
          data: {
            storage: 'MINIO',
            bucket: 'training-stage3-private',
            key: `training-stage3-test/${answerId}.wav`,
            originalName: 'answer.wav',
            mimeType: 'audio/wav',
            sizeBytes: 64n,
            checksum: 'test-checksum',
          },
        });
        fileId = file.id;
        await this.database.trainingAnswer.update({ where: { id: answerId }, data: { mergedAudioFileId: fileId } });
      }

      const wav = Buffer.alloc(64);
      wav.write('RIFF', 0, 'ascii');
      wav.write('WAVE', 8, 'ascii');
      return { answerId, fileId, mimeType: 'audio/wav', sizeBytes: wav.length, checksum: 'test-checksum', wav, vocabularyPrompt: '' };
    }
  }

  class RecordingTranscriber {
    constructor() { this.calls = 0; }
    async transcribe() {
      this.calls += 1;
      return { text: '[fake:pass]', model: 'stub-transcriber', requestId: `transcription-${this.calls}`, latencyMs: 1, attempts: 1, usage: null };
    }
  }

  class RecordingEvaluator {
    constructor(delegate) { this.delegate = delegate; this.calls = 0; this.version = delegate.version; }
    async evaluate(input) { this.calls += 1; return this.delegate.evaluate(input); }
  }

  class FailOnceEvaluator extends RecordingEvaluator {
    async evaluate(input) {
      this.calls += 1;
      if (this.calls === 1) {
        throw new TrainingOpenAIError(
          'OPENAI_EVALUATION_INVALID',
          true,
          1,
          'CRITERION_POINTS_OUT_OF_RANGE',
        );
      }
      return this.delegate.evaluate(input);
    }
  }

  class AlwaysRetryableEvaluator extends RecordingEvaluator {
    async evaluate() {
      this.calls += 1;
      throw new TrainingOpenAIError(
        'OPENAI_EVALUATION_INVALID',
        true,
        2,
        'CRITERION_POINTS_OUT_OF_RANGE',
      );
    }
  }

  class AlwaysDeterministicInvalidEvaluator extends RecordingEvaluator {
    async evaluate() {
      this.calls += 1;
      throw new TrainingOpenAIError(
        'OPENAI_EVALUATION_INVALID',
        false,
        2,
        'EVIDENCE_NOT_IN_TRANSCRIPT',
      );
    }
  }
}
