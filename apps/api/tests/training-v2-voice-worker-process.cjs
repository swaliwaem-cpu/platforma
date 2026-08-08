require('reflect-metadata');

const { Prisma, PrismaClient } = require('@prisma/client');

const { TrainingAttemptStateService } = require('../dist/training/training-attempt-state.service.js');
const { DeterministicFakeTrainingEvaluator } = require('../dist/training/training-evaluator.js');
const { TrainingProjectAccessService } = require('../dist/training/training-project-access.service.js');
const { TrainingVoiceWorkerService } = require('../dist/training/training-voice-worker.service.js');

const databaseUrl = process.env.TRAINING_TEST_DATABASE_URL;

if (!databaseUrl) throw new Error('TRAINING_TEST_DATABASE_URL_REQUIRED');

process.env.TRAINING_MODULE_ENABLED = 'true';
process.env.TRAINING_VOICE_WORKER_ENABLED = 'true';

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const evaluator = new DeterministicFakeTrainingEvaluator();
const attemptState = new TrainingAttemptStateService(
  prisma,
  evaluator,
  { select: (candidates) => candidates.slice(0, 3) },
  new TrainingProjectAccessService(prisma),
);
const worker = new TrainingVoiceWorkerService(
  prisma,
  new ProcessAudio(),
  new ProcessTranscriber(),
  evaluator,
  attemptState,
  { notifyAnswerProcessed: async () => undefined, notifyAnswerFailed: async () => undefined },
);
let shuttingDown = false;

async function start() {
  await prisma.$connect();
  await worker.onModuleInit();
  process.send?.({ event: 'ready' });
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await worker.shutdown();
  await prisma.$disconnect();
}

process.once('SIGTERM', () => {
  void shutdown().then(() => process.exit(0));
});
process.once('SIGINT', () => {
  void shutdown().then(() => process.exit(0));
});

function makeWav() {
  const wav = Buffer.alloc(64);
  wav.write('RIFF', 0, 'ascii');
  wav.write('WAVE', 8, 'ascii');
  return wav;
}

function resultFor(input) {
  return {
    text: `process-transcript:${input.answerId}`,
    model: 'process-fake-transcriber',
    requestId: `process:${input.answerId}`,
    latencyMs: 75,
    attempts: 1,
    responseId: null,
    usage: null,
  };
}

function statsUpdate(direction) {
  if (direction === 'start') {
    return prisma.$executeRaw(Prisma.sql`
      UPDATE "training_voice_worker_test_stats"
      SET
        "active" = "active" + 1,
        "peak" = GREATEST("peak", "active" + 1),
        "total" = "total" + 1
      WHERE "id" = 1
    `);
  }

  return prisma.$executeRaw(Prisma.sql`
    UPDATE "training_voice_worker_test_stats"
    SET "active" = GREATEST("active" - 1, 0)
    WHERE "id" = 1
  `);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function ProcessAudio() {}

ProcessAudio.prototype.prepareAnswerAudio = async function prepareAnswerAudio(answerId) {
  const wav = makeWav();
  const answer = await prisma.trainingAnswer.findUniqueOrThrow({ where: { id: answerId } });
  let fileId = answer.mergedAudioFileId;

  if (!fileId) {
    const file = await prisma.file.create({
      data: {
        storage: 'MINIO',
        bucket: 'training-worker-process-test',
        key: `training-worker-process-test/${answerId}.wav`,
        url: null,
        originalName: 'answer.wav',
        mimeType: 'audio/wav',
        sizeBytes: BigInt(wav.length),
        checksum: `process-checksum-${answerId}`,
      },
    });
    fileId = file.id;
    await prisma.trainingAnswer.update({
      where: { id: answerId },
      data: { mergedAudioFileId: fileId },
    });
  }

  return {
    answerId,
    fileId,
    mimeType: 'audio/wav',
    sizeBytes: wav.length,
    checksum: `process-checksum-${answerId}`,
    wav,
  };
};

function ProcessTranscriber() {}

ProcessTranscriber.prototype.transcribe = async function transcribe(input) {
  await statsUpdate('start');
  try {
    await delay(Number(process.env.TRAINING_TEST_PROVIDER_DELAY_MS ?? 75));
    return resultFor(input);
  } finally {
    await statsUpdate('finish');
  }
};

void start().catch(async (error) => {
  process.send?.({ event: 'error', code: error instanceof Error ? error.name : 'UNKNOWN_ERROR' });
  await shutdown().catch(() => undefined);
  process.exit(1);
});
