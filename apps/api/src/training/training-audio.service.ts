import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  FileStorage,
  TrainingAnswerProcessingStatus,
  TrainingAnswerSource,
} from '@prisma/client';

import { S3StorageService } from '../files/s3-storage.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  getTrainingAudioLimits,
  OPENAI_TRANSCRIPTION_HARD_MAX_BYTES,
  TrainingAudioLimitsError,
  type TrainingAudioLimits,
} from './training-audio-limits';
import { recordTrainingProjectDeleteCleanupObject } from './training-project-cleanup';
import {
  TRAINING_TELEGRAM_CLIENT,
  TrainingTelegramClientError,
  type TrainingTelegramClient,
} from './training-telegram-client';

export const TRAINING_FFMPEG_RUNNER = Symbol('TRAINING_FFMPEG_RUNNER');

export interface TrainingFfmpegRunner {
  run(args: string[], timeoutMs: number): Promise<void>;
}

export type TrainingAudioMimeType = 'audio/webm' | 'audio/wav';

export type TrainingProviderAudioUpload = {
  sequence: number;
  filePath: string;
  fileName: string;
  mimeType: TrainingAudioMimeType;
  sizeBytes: number;
  checksum: string;
  startSeconds: number;
  endSeconds: number;
};

export type PreparedTrainingAudio = {
  answerId: string;
  fileId: string;
  mimeType: TrainingAudioMimeType;
  sizeBytes: number;
  checksum: string;
  filePath: string;
  fileName: string;
  providerUploads: TrainingProviderAudioUpload[];
  durationSeconds: number;
  inputBytes: number;
  ffmpegLatencyMs: number | null;
  vocabularyPrompt: string;
  cleanup: () => Promise<void>;
};

export class TrainingAudioError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(`Training audio processing failed: ${code}`);
    this.name = 'TrainingAudioError';
  }
}

@Injectable()
export class SpawnTrainingFfmpegRunner implements TrainingFfmpegRunner {
  run(args: string[], timeoutMs: number) {
    return new Promise<void>((resolve, reject) => {
      const child = spawn('ffmpeg', args, {
        shell: false,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderrBytes = 0;
      let timedOut = false;
      let settled = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;

        if (stderrBytes > 64 * 1024) {
          child.stderr?.removeAllListeners('data');
        }
      });
      child.once('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new TrainingAudioError('FFMPEG_START_FAILED', true));
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);

        if (timedOut) {
          reject(new TrainingAudioError('FFMPEG_TIMEOUT', true));
        } else if (code !== 0) {
          reject(new TrainingAudioError('FFMPEG_FAILED', false));
        } else {
          resolve();
        }
      });
    });
  }
}

export class TrainingFfmpegConcurrencyGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  async run<T>(concurrency: number, operation: () => Promise<T>) {
    await this.acquire(concurrency);
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(concurrency: number) {
    if (this.active < concurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release() {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}

@Injectable()
export class TrainingAudioService {
  private readonly logger = new Logger(TrainingAudioService.name);
  private readonly ffmpegGate = new TrainingFfmpegConcurrencyGate();

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: S3StorageService,
    @Inject(TRAINING_TELEGRAM_CLIENT) private readonly telegram: TrainingTelegramClient,
    @Inject(TRAINING_FFMPEG_RUNNER) private readonly ffmpeg: TrainingFfmpegRunner,
  ) {}

  async prepareAnswerAudio(answerId: string): Promise<PreparedTrainingAudio> {
    const limits = readAudioLimits();
    const bucket = this.getPrivateBucket();
    const answer = await this.prisma.trainingAnswer.findUnique({
      where: { id: answerId },
      include: {
        attemptQuestion: {
          select: { attempt: { select: { projectId: true } } },
        },
        mergedAudioFile: true,
        segments: {
          include: { storedFile: true },
          orderBy: { position: 'asc' },
        },
      },
    });

    if (
      !answer ||
      answer.source !== TrainingAnswerSource.TELEGRAM ||
      answer.processingStatus !== TrainingAnswerProcessingStatus.PROCESSING ||
      answer.segments.length === 0
    ) {
      throw new TrainingAudioError('ANSWER_NOT_PROCESSABLE', false);
    }

    const durationSeconds = answer.segments.reduce(
      (total, segment) => total + segment.durationSeconds,
      0,
    );
    if (durationSeconds > limits.maxDurationSeconds) {
      throw new TrainingAudioError('VOICE_DURATION_LIMIT', false);
    }

    const directory = await mkdtemp(join(tmpdir(), 'platforma-training-voice-'));
    const cleanup = createDirectoryCleanup(directory);

    try {
      if (answer.mergedAudioFile) {
        return await this.prepareStoredMergedAudio({
          answerId,
          file: answer.mergedAudioFile,
          bucket,
          directory,
          cleanup,
          durationSeconds,
          inputBytes: sumKnownSegmentBytes(answer.segments),
          limits,
        });
      }

      const inputPaths: string[] = [];
      let inputBytes = 0;

      for (const segment of answer.segments) {
        const inputPath = join(
          directory,
          `segment-${String(segment.position).padStart(3, '0')}-${segment.id}.ogg`,
        );
        const segmentBytes = await this.materializeSegment({
          answerId,
          projectId: answer.attemptQuestion.attempt.projectId,
          segment,
          bucket,
          inputPath,
          limits,
        });
        inputBytes += segmentBytes;
        if (inputBytes > limits.maxTotalInputBytes) {
          throw new TrainingAudioError('VOICE_TOTAL_SIZE_LIMIT', false);
        }
        inputPaths.push(inputPath);
      }

      const outputPath = join(directory, 'merged.webm');
      const ffmpegStartedAt = Date.now();
      await this.runFfmpeg(
        buildTrainingFfmpegArgs(inputPaths, outputPath, limits.opusBitrateBps),
        limits,
      );
      const ffmpegLatencyMs = Math.max(0, Date.now() - ffmpegStartedAt);
      const output = await inspectAudioFile(
        outputPath,
        'audio/webm',
        OPENAI_TRANSCRIPTION_HARD_MAX_BYTES,
      );
      const checksum = await hashFile(outputPath);
      const key = `training-v2/answers/${answerId}/merged.webm`;

      await this.storage.putObjectFromFile({
        bucket,
        key,
        filePath: outputPath,
        contentType: 'audio/webm',
        checksum,
        contentLength: output.sizeBytes,
      });
      const file = await this.persistMergedFile({
        answerId,
        bucket,
        key,
        sizeBytes: output.sizeBytes,
        checksum,
        durationSeconds,
        inputBytes,
        ffmpegLatencyMs,
      }).catch(async (error: unknown) => {
        try {
          await this.storage.deleteObject(key, bucket);
        } catch (cleanupError) {
          await recordTrainingProjectDeleteCleanupObject(
            this.prisma,
            answer.attemptQuestion.attempt.projectId,
            { key, bucket },
          );
          throw new AggregateError(
            [error, cleanupError],
            'Training merged audio persistence and cleanup failed',
          );
        }
        throw error;
      });
      const providerUploads = await this.prepareProviderUploads(
        outputPath,
        directory,
        durationSeconds,
        output.sizeBytes,
        checksum,
        limits,
      );

      this.logger.log({
        event: 'training_audio_prepared',
        answerId,
        durationSeconds,
        inputBytes,
        outputBytes: output.sizeBytes,
        ffmpegLatencyMs,
        providerParts: providerUploads.length,
      });

      return {
        answerId,
        fileId: file.id,
        mimeType: 'audio/webm',
        sizeBytes: output.sizeBytes,
        checksum,
        filePath: outputPath,
        fileName: 'answer.webm',
        providerUploads,
        durationSeconds,
        inputBytes,
        ffmpegLatencyMs,
        vocabularyPrompt: '',
        cleanup,
      };
    } catch (error) {
      await cleanup().catch(() => undefined);
      throw error;
    }
  }

  private async prepareStoredMergedAudio(input: {
    answerId: string;
    file: {
      id: string;
      bucket: string | null;
      key: string;
      url: string | null;
      mimeType: string | null;
      sizeBytes: bigint | null;
      checksum: string | null;
    };
    bucket: string;
    directory: string;
    cleanup: () => Promise<void>;
    durationSeconds: number;
    inputBytes: number;
    limits: TrainingAudioLimits;
  }): Promise<PreparedTrainingAudio> {
    const format = resolveStoredMergedAudioFormat(input.file, input.answerId, input.bucket);
    const filePath = join(input.directory, format.fileName);
    const downloaded = await this.storage.getObjectToFile({
      key: input.file.key,
      bucket: input.bucket,
      filePath,
    });
    const expectedSize = Number(input.file.sizeBytes ?? -1n);

    if (
      expectedSize !== downloaded.size ||
      !input.file.checksum ||
      input.file.checksum !== downloaded.checksum
    ) {
      throw new TrainingAudioError('MERGED_AUDIO_INTEGRITY_FAILED', false);
    }
    await inspectAudioFile(
      filePath,
      format.mimeType,
      format.mimeType === 'audio/wav'
        ? 64 * 1024 * 1024
        : OPENAI_TRANSCRIPTION_HARD_MAX_BYTES,
    );

    const ownership = await this.prisma.trainingAnswer.count({
      where: { id: input.answerId, mergedAudioFileId: input.file.id },
    });
    if (ownership !== 1) {
      throw new TrainingAudioError('MERGED_AUDIO_OWNERSHIP_FAILED', false);
    }

    await this.prisma.trainingAnswer.updateMany({
      where: { id: input.answerId, mergedAudioFileId: input.file.id },
      data: {
        audioDurationSeconds: input.durationSeconds,
        audioInputBytes: BigInt(input.inputBytes),
        audioOutputBytes: BigInt(downloaded.size),
      },
    });
    const providerUploads = await this.prepareProviderUploads(
      filePath,
      input.directory,
      input.durationSeconds,
      downloaded.size,
      downloaded.checksum,
      input.limits,
      format.mimeType,
    );

    return {
      answerId: input.answerId,
      fileId: input.file.id,
      mimeType: format.mimeType,
      sizeBytes: downloaded.size,
      checksum: downloaded.checksum,
      filePath,
      fileName: format.fileName,
      providerUploads,
      durationSeconds: input.durationSeconds,
      inputBytes: input.inputBytes,
      ffmpegLatencyMs: null,
      vocabularyPrompt: '',
      cleanup: input.cleanup,
    };
  }

  private async materializeSegment(input: {
    answerId: string;
    projectId: string;
    segment: {
      id: string;
      position: number;
      telegramFileId: string;
      sizeBytes: bigint | null;
      storedFile: {
        id: string;
        bucket: string | null;
        key: string;
        url: string | null;
        mimeType: string | null;
        sizeBytes: bigint | null;
        checksum: string | null;
      } | null;
    };
    bucket: string;
    inputPath: string;
    limits: TrainingAudioLimits;
  }) {
    const { segment } = input;
    if (segment.storedFile) {
      this.assertPrivateFile(segment.storedFile, input.bucket, 'audio/ogg');
      const downloaded = await this.storage.getObjectToFile({
        key: segment.storedFile.key,
        bucket: input.bucket,
        filePath: input.inputPath,
      });
      const expectedSize = Number(segment.storedFile.sizeBytes ?? -1n);
      if (
        expectedSize !== downloaded.size ||
        downloaded.size > input.limits.maxSegmentBytes ||
        !segment.storedFile.checksum ||
        segment.storedFile.checksum !== downloaded.checksum
      ) {
        throw new TrainingAudioError('STORED_VOICE_INTEGRITY_FAILED', false);
      }
      await validateOggVoiceFile(input.inputPath, downloaded.size, input.limits.maxSegmentBytes);
      return downloaded.size;
    }

    const file = await this.telegram.getFile(segment.telegramFileId);
    if (file.sizeBytes !== null && file.sizeBytes > input.limits.maxSegmentBytes) {
      throw new TrainingAudioError('VOICE_SEGMENT_SIZE_LIMIT', false);
    }

    const downloaded = await this.telegram.downloadFile(
      file.filePath,
      input.limits.maxSegmentBytes,
    );
    validateOggVoice(downloaded.body, downloaded.mimeType, input.limits);
    if (downloaded.body.length > input.limits.maxBufferedBytes) {
      throw new TrainingAudioError('VOICE_MEMORY_LIMIT', false);
    }
    if (
      (file.sizeBytes !== null && file.sizeBytes !== downloaded.sizeBytes) ||
      (segment.sizeBytes !== null && Number(segment.sizeBytes) !== downloaded.sizeBytes)
    ) {
      throw new TrainingAudioError('VOICE_SIZE_MISMATCH', false);
    }

    await writeFile(input.inputPath, downloaded.body, { flag: 'wx' });
    const checksum = createHash('sha256').update(downloaded.body).digest('hex');
    const key = `training-v2/answers/${input.answerId}/segments/${segment.id}.ogg`;
    await this.storage.putObjectFromFile({
      bucket: input.bucket,
      key,
      filePath: input.inputPath,
      contentType: 'audio/ogg',
      checksum,
      contentLength: downloaded.sizeBytes,
    });
    try {
      await this.persistSegmentFile(
        segment.id,
        segment.position,
        input.bucket,
        key,
        downloaded.sizeBytes,
        checksum,
      );
    } catch (error) {
      try {
        await this.storage.deleteObject(key, input.bucket);
      } catch (cleanupError) {
        await recordTrainingProjectDeleteCleanupObject(
          this.prisma,
          input.projectId,
          { key, bucket: input.bucket },
        );
        throw new AggregateError(
          [error, cleanupError],
          'Training voice segment persistence and cleanup failed',
        );
      }
      throw error;
    }

    return downloaded.sizeBytes;
  }

  private async prepareProviderUploads(
    mergedPath: string,
    directory: string,
    durationSeconds: number,
    sizeBytes: number,
    checksum: string,
    limits: TrainingAudioLimits,
    mimeType: TrainingAudioMimeType = 'audio/webm',
  ): Promise<TrainingProviderAudioUpload[]> {
    if (sizeBytes <= limits.providerUploadMaxBytes) {
      return [{
        sequence: 0,
        filePath: mergedPath,
        fileName: mimeType === 'audio/webm' ? 'answer.webm' : 'answer.wav',
        mimeType,
        sizeBytes,
        checksum,
        startSeconds: 0,
        endSeconds: durationSeconds,
      }];
    }

    const chunkDurationSeconds = calculateTrainingAudioChunkDuration(limits);
    const uploads: TrainingProviderAudioUpload[] = [];
    let startSeconds = 0;

    while (startSeconds < Math.max(durationSeconds, 1)) {
      const endSeconds = Math.min(
        Math.max(durationSeconds, 1),
        startSeconds + chunkDurationSeconds,
      );
      const sequence = uploads.length;
      const fileName = `answer-part-${String(sequence + 1).padStart(3, '0')}.webm`;
      const filePath = join(directory, fileName);
      await this.runFfmpeg(
        buildTrainingAudioChunkFfmpegArgs(
          mergedPath,
          filePath,
          startSeconds,
          endSeconds - startSeconds,
          limits.opusBitrateBps,
        ),
        limits,
      );
      const chunk = await inspectAudioFile(
        filePath,
        'audio/webm',
        limits.providerUploadMaxBytes,
      ).catch((error: unknown) => {
        if (error instanceof TrainingAudioError && error.code === 'MERGED_AUDIO_SIZE_LIMIT') {
          throw new TrainingAudioError('PROVIDER_AUDIO_CHUNK_TOO_LARGE', false);
        }
        throw error;
      });
      uploads.push({
        sequence,
        filePath,
        fileName,
        mimeType: 'audio/webm',
        sizeBytes: chunk.sizeBytes,
        checksum: await hashFile(filePath),
        startSeconds,
        endSeconds,
      });

      if (endSeconds >= Math.max(durationSeconds, 1)) break;
      startSeconds = endSeconds - limits.chunkOverlapSeconds;
    }

    return uploads;
  }

  private async runFfmpeg(args: string[], limits: TrainingAudioLimits) {
    await this.ffmpegGate.run(
      limits.ffmpegConcurrency,
      () => this.ffmpeg.run(args, limits.ffmpegTimeoutMs),
    );
  }

  private async persistSegmentFile(
    segmentId: string,
    position: number,
    bucket: string,
    key: string,
    sizeBytes: number,
    checksum: string,
  ) {
    return this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.file.findFirst({
        where: { storage: FileStorage.MINIO, bucket, key },
      });
      const file = existing
        ? await transaction.file.update({
            where: { id: existing.id },
            data: {
              url: null,
              originalName: `segment-${position}.ogg`,
              mimeType: 'audio/ogg',
              sizeBytes: BigInt(sizeBytes),
              checksum,
            },
          })
        : await transaction.file.create({
            data: {
              storage: FileStorage.MINIO,
              bucket,
              key,
              url: null,
              originalName: `segment-${position}.ogg`,
              mimeType: 'audio/ogg',
              sizeBytes: BigInt(sizeBytes),
              checksum,
            },
          });

      await transaction.trainingAnswerSegment.update({
        where: { id: segmentId },
        data: { storedFileId: file.id },
      });

      return file;
    });
  }

  private async persistMergedFile(input: {
    answerId: string;
    bucket: string;
    key: string;
    sizeBytes: number;
    checksum: string;
    durationSeconds: number;
    inputBytes: number;
    ffmpegLatencyMs: number;
  }) {
    return this.prisma.$transaction(async (transaction) => {
      const answer = await transaction.trainingAnswer.findUnique({
        where: { id: input.answerId },
        select: { processingStatus: true, mergedAudioFile: true },
      });

      if (!answer || answer.processingStatus !== TrainingAnswerProcessingStatus.PROCESSING) {
        throw new TrainingAudioError('ANSWER_NOT_PROCESSABLE', false);
      }

      if (answer.mergedAudioFile) return answer.mergedAudioFile;

      const existing = await transaction.file.findFirst({
        where: { storage: FileStorage.MINIO, bucket: input.bucket, key: input.key },
      });
      const file = existing
        ? await transaction.file.update({
            where: { id: existing.id },
            data: {
              url: null,
              originalName: 'merged.webm',
              mimeType: 'audio/webm',
              sizeBytes: BigInt(input.sizeBytes),
              checksum: input.checksum,
            },
          })
        : await transaction.file.create({
            data: {
              storage: FileStorage.MINIO,
              bucket: input.bucket,
              key: input.key,
              url: null,
              originalName: 'merged.webm',
              mimeType: 'audio/webm',
              sizeBytes: BigInt(input.sizeBytes),
              checksum: input.checksum,
            },
          });

      await transaction.trainingAnswer.update({
        where: { id: input.answerId },
        data: {
          mergedAudioFileId: file.id,
          audioDurationSeconds: input.durationSeconds,
          audioInputBytes: BigInt(input.inputBytes),
          audioOutputBytes: BigInt(input.sizeBytes),
          audioFfmpegLatencyMs: input.ffmpegLatencyMs,
        },
      });

      return file;
    });
  }

  private getPrivateBucket() {
    const bucket = (process.env.TRAINING_AUDIO_BUCKET ?? 'platforma-training-audio').trim();

    if (
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket) ||
      bucket === this.storage.getBucket()
    ) {
      throw new TrainingAudioError('PRIVATE_BUCKET_INVALID', false);
    }

    return bucket;
  }

  private assertPrivateFile(
    file: { bucket: string | null; url: string | null; mimeType: string | null },
    bucket: string,
    mimeType: string,
  ) {
    if (file.bucket !== bucket || file.url !== null || file.mimeType !== mimeType) {
      throw new TrainingAudioError('PRIVATE_FILE_INVALID', false);
    }
  }
}

export function buildTrainingFfmpegArgs(
  inputPaths: string[],
  outputPath: string,
  opusBitrateBps = 32_000,
) {
  if (inputPaths.length === 0) {
    throw new TrainingAudioError('VOICE_SEGMENTS_MISSING', false);
  }

  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];

  for (const inputPath of inputPaths) {
    args.push('-i', inputPath);
  }

  if (inputPaths.length > 1) {
    const streams = inputPaths.map((_, index) => `[${index}:a]`).join('');
    args.push(
      '-filter_complex',
      `${streams}concat=n=${inputPaths.length}:v=0:a=1[out]`,
      '-map',
      '[out]',
    );
  } else {
    args.push('-vn');
  }

  args.push(...trainingOpusOutputArgs(opusBitrateBps), outputPath);
  return args;
}

export function buildTrainingAudioChunkFfmpegArgs(
  inputPath: string,
  outputPath: string,
  startSeconds: number,
  durationSeconds: number,
  opusBitrateBps = 32_000,
) {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-ss',
    formatFfmpegSeconds(startSeconds),
    '-i',
    inputPath,
    '-t',
    formatFfmpegSeconds(durationSeconds),
    '-vn',
    ...trainingOpusOutputArgs(opusBitrateBps),
    outputPath,
  ];
}

export function calculateTrainingAudioChunkDuration(limits: TrainingAudioLimits) {
  const containerReserveBytes = 64 * 1024;
  const usableBytes = limits.providerUploadMaxBytes - containerReserveBytes;
  const seconds = Math.floor((usableBytes * 8) / limits.opusBitrateBps);
  return Math.max(15, seconds);
}

function trainingOpusOutputArgs(opusBitrateBps: number) {
  return [
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'libopus',
    '-application',
    'voip',
    '-b:a',
    String(opusBitrateBps),
    '-vbr',
    'constrained',
    '-compression_level',
    '10',
    '-f',
    'webm',
  ];
}

function validateOggVoice(body: Buffer, mimeType: string | null, limits: TrainingAudioLimits) {
  const allowedMimeTypes = new Set([
    'audio/ogg',
    'application/ogg',
    'audio/opus',
    'application/octet-stream',
  ]);

  if (
    body.length === 0 ||
    body.length > limits.maxSegmentBytes ||
    !mimeType ||
    !allowedMimeTypes.has(mimeType) ||
    body.toString('ascii', 0, 4) !== 'OggS'
  ) {
    throw new TrainingAudioError('INVALID_OGG_VOICE', false);
  }
}

async function validateOggVoiceFile(path: string, sizeBytes: number, maxBytes: number) {
  const header = await readFileHeader(path, 4);
  if (
    sizeBytes === 0 ||
    sizeBytes > maxBytes ||
    header.toString('ascii', 0, 4) !== 'OggS'
  ) {
    throw new TrainingAudioError('INVALID_OGG_VOICE', false);
  }
}

async function inspectAudioFile(
  path: string,
  mimeType: TrainingAudioMimeType,
  maxBytes: number,
) {
  const outputStats = await stat(path);
  if (outputStats.size <= 4 || outputStats.size > maxBytes) {
    throw new TrainingAudioError('MERGED_AUDIO_SIZE_LIMIT', false);
  }
  const header = await readFileHeader(path, 12);
  const valid = mimeType === 'audio/webm'
    ? header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    : header.toString('ascii', 0, 4) === 'RIFF' &&
      header.toString('ascii', 8, 12) === 'WAVE';
  if (!valid) throw new TrainingAudioError('MERGED_AUDIO_INVALID_BYTES', false);
  return { sizeBytes: outputStats.size };
}

function resolveStoredMergedAudioFormat(
  file: { bucket: string | null; key: string; url: string | null; mimeType: string | null },
  answerId: string,
  bucket: string,
) {
  const webmKey = `training-v2/answers/${answerId}/merged.webm`;
  const wavKey = `training-v2/answers/${answerId}/merged.wav`;
  if (
    file.bucket === bucket &&
    file.url === null &&
    file.mimeType === 'audio/webm' &&
    file.key === webmKey
  ) {
    return { mimeType: 'audio/webm' as const, fileName: 'merged.webm' };
  }
  if (
    file.bucket === bucket &&
    file.url === null &&
    file.mimeType === 'audio/wav' &&
    file.key === wavKey
  ) {
    return { mimeType: 'audio/wav' as const, fileName: 'merged.wav' };
  }
  throw new TrainingAudioError('PRIVATE_FILE_INVALID', false);
}

async function hashFile(path: string) {
  const checksum = createHash('sha256');
  for await (const chunk of createReadStream(path)) checksum.update(chunk);
  return checksum.digest('hex');
}

async function readFileHeader(path: string, length: number) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function createDirectoryCleanup(directory: string) {
  let cleanup: Promise<void> | null = null;
  return () => {
    cleanup ??= rm(directory, { recursive: true, force: true });
    return cleanup;
  };
}

function sumKnownSegmentBytes(
  segments: Array<{ sizeBytes: bigint | null; storedFile: { sizeBytes: bigint | null } | null }>,
) {
  return segments.reduce((total, segment) => {
    const value = segment.storedFile?.sizeBytes ?? segment.sizeBytes ?? 0n;
    const size = Number(value);
    return total + (Number.isSafeInteger(size) && size >= 0 ? size : 0);
  }, 0);
}

function formatFfmpegSeconds(value: number) {
  return Math.max(0, value).toFixed(3);
}

function readAudioLimits() {
  try {
    return getTrainingAudioLimits();
  } catch (error) {
    if (error instanceof TrainingAudioLimitsError) {
      throw new TrainingAudioError(error.code, false);
    }
    throw error;
  }
}

export function isRetryableTrainingAudioError(error: unknown) {
  if (error instanceof TrainingAudioError || error instanceof TrainingTelegramClientError) {
    return error.retryable;
  }

  return true;
}

export function getTrainingAudioErrorCode(error: unknown) {
  if (error instanceof TrainingAudioError || error instanceof TrainingTelegramClientError) {
    return error.code;
  }

  return 'VOICE_PROCESSING_FAILED';
}
