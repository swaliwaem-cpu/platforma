require('reflect-metadata');

const { PrismaClient } = require('@prisma/client');

const {
  FilesService,
} = require('../../dist/files/files.service.js');
const {
  S3StorageService,
} = require('../../dist/files/s3-storage.service.js');
const {
  TrainingAudioConfig,
} = require('../../dist/training/audio/training-audio.config.js');
const {
  TrainingAudioWorkerService,
} = require('../../dist/training/audio/training-audio-worker.service.js');

const prisma = new PrismaClient();

void main();

async function main() {
  await prisma.$connect();
  const storage = new S3StorageService();
  await storage.onModuleInit();
  const files = new FilesService(prisma, storage);
  const provider = {
    async downloadVoice() {
      return {
        body: Buffer.from(
          process.env.TRAINING_AUDIO_CRASH_BODY ?? '',
          'base64',
        ),
        mimeType: 'audio/ogg',
      };
    },
  };
  const ffmpeg = {
    async withPreparedAudio() {
      throw new Error('ffmpeg must not run in crash upload fixture');
    },
  };
  const faultInjection = {
    async afterObjectUpload() {
      process.kill(process.pid, 'SIGKILL');
      await new Promise(() => {});
    },
  };
  const worker = new TrainingAudioWorkerService(
    prisma,
    new TrainingAudioConfig(),
    files,
    ffmpeg,
    provider,
    faultInjection,
  );
  await worker.drainNow();
  process.exitCode = 91;
}

