import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Inject, Injectable } from '@nestjs/common';
import {
  FileStorage,
  TrainingAnswerProcessingStatus,
  TrainingAnswerSource,
} from '@prisma/client';

import { S3StorageService } from '../files/s3-storage.service';
import { PrismaService } from '../prisma/prisma.service';
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

@Injectable()
export class TrainingAudioService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: S3StorageService,
    @Inject(TRAINING_TELEGRAM_CLIENT) private readonly telegram: TrainingTelegramClient,
    @Inject(TRAINING_FFMPEG_RUNNER) private readonly ffmpeg: TrainingFfmpegRunner,
  ) {}

  async prepareAnswerAudio(answerId: string) {
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

    if (answer.mergedAudioFile) {
      this.assertPrivateFile(answer.mergedAudioFile, bucket, 'audio/wav');
      return this.loadVerifiedMergedAudio(answerId, answer.mergedAudioFile, bucket);
    }

    const totalDuration = answer.segments.reduce(
      (total, segment) => total + segment.durationSeconds,
      0,
    );

    if (totalDuration > 30 * 60) {
      throw new TrainingAudioError('VOICE_DURATION_LIMIT', false);
    }

    const directory = await mkdtemp(join(tmpdir(), 'platforma-training-voice-'));

    try {
      const inputPaths: string[] = [];
      let totalBytes = 0;

      for (const segment of answer.segments) {
        const body = await this.loadSegmentBody(
          answerId,
          answer.attemptQuestion.attempt.projectId,
          segment,
          bucket,
        );
        totalBytes += body.length;

        if (totalBytes > 60 * 1024 * 1024) {
          throw new TrainingAudioError('VOICE_TOTAL_SIZE_LIMIT', false);
        }

        const inputPath = join(
          directory,
          `segment-${String(segment.position).padStart(3, '0')}-${segment.id}.ogg`,
        );
        await writeFile(inputPath, body, { flag: 'wx' });
        inputPaths.push(inputPath);
      }

      const outputPath = join(directory, 'merged.wav');
      await this.ffmpeg.run(
        buildTrainingFfmpegArgs(inputPaths, outputPath),
        getFfmpegTimeoutMs(),
      );
      const outputStats = await stat(outputPath);

      if (outputStats.size <= 44 || outputStats.size > 64 * 1024 * 1024) {
        throw new TrainingAudioError('INVALID_WAV_SIZE', false);
      }

      const header = await readFile(outputPath).then((body) => body.subarray(0, 12));

      if (
        header.toString('ascii', 0, 4) !== 'RIFF' ||
        header.toString('ascii', 8, 12) !== 'WAVE'
      ) {
        throw new TrainingAudioError('INVALID_WAV_BYTES', false);
      }

      const checksum = await hashFile(outputPath);
      const key = `training-v2/answers/${answerId}/merged.wav`;
      await this.storage.putObjectFromFile({
        bucket,
        key,
        filePath: outputPath,
        contentType: 'audio/wav',
        checksum,
        contentLength: outputStats.size,
      });
      const file = await this.persistMergedFile(
        answerId,
        bucket,
        key,
        outputStats.size,
        checksum,
      )
        .catch(async (error: unknown) => {
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

      return this.loadVerifiedMergedAudio(answerId, file, bucket);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async loadSegmentBody(
    answerId: string,
    projectId: string,
    segment: {
      id: string;
      position: number;
      telegramFileId: string;
      durationSeconds: number;
      sizeBytes: bigint | null;
      storedFileId: string | null;
      storedFile: {
        id: string;
        bucket: string | null;
        key: string;
        url: string | null;
        mimeType: string | null;
        sizeBytes: bigint | null;
      } | null;
    },
    bucket: string,
  ) {
    if (segment.storedFile) {
      this.assertPrivateFile(segment.storedFile, bucket, 'audio/ogg');
      const body = await this.storage.getObject(segment.storedFile.key, bucket);
      validateOggVoice(body, segment.storedFile.mimeType);
      return body;
    }

    const file = await this.telegram.getFile(segment.telegramFileId);

    if (file.sizeBytes !== null && file.sizeBytes > 20 * 1024 * 1024) {
      throw new TrainingAudioError('VOICE_SEGMENT_SIZE_LIMIT', false);
    }

    const downloaded = await this.telegram.downloadFile(file.filePath, 20 * 1024 * 1024);
    validateOggVoice(downloaded.body, downloaded.mimeType);

    if (
      (file.sizeBytes !== null && file.sizeBytes !== downloaded.sizeBytes) ||
      (segment.sizeBytes !== null && Number(segment.sizeBytes) !== downloaded.sizeBytes)
    ) {
      throw new TrainingAudioError('VOICE_SIZE_MISMATCH', false);
    }

    const checksum = createHash('sha256').update(downloaded.body).digest('hex');
    const key = `training-v2/answers/${answerId}/segments/${segment.id}.ogg`;
    await this.storage.putObject({
      bucket,
      key,
      body: downloaded.body,
      contentType: 'audio/ogg',
    });
    try {
      await this.persistSegmentFile(
        segment.id,
        segment.position,
        bucket,
        key,
        downloaded.sizeBytes,
        checksum,
      );
    } catch (error) {
      try {
        await this.storage.deleteObject(key, bucket);
      } catch (cleanupError) {
        await recordTrainingProjectDeleteCleanupObject(
          this.prisma,
          projectId,
          { key, bucket },
        );
        throw new AggregateError(
          [error, cleanupError],
          'Training voice segment persistence and cleanup failed',
        );
      }
      throw error;
    }

    return downloaded.body;
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

  private async persistMergedFile(
    answerId: string,
    bucket: string,
    key: string,
    sizeBytes: number,
    checksum: string,
  ) {
    return this.prisma.$transaction(async (transaction) => {
      const answer = await transaction.trainingAnswer.findUnique({
        where: { id: answerId },
        select: { processingStatus: true, mergedAudioFile: true },
      });

      if (!answer || answer.processingStatus !== TrainingAnswerProcessingStatus.PROCESSING) {
        throw new TrainingAudioError('ANSWER_NOT_PROCESSABLE', false);
      }

      if (answer.mergedAudioFile) return answer.mergedAudioFile;

      const existing = await transaction.file.findFirst({
        where: { storage: FileStorage.MINIO, bucket, key },
      });
      const file = existing
        ? await transaction.file.update({
            where: { id: existing.id },
            data: {
              url: null,
              originalName: 'merged.wav',
              mimeType: 'audio/wav',
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
              originalName: 'merged.wav',
              mimeType: 'audio/wav',
              sizeBytes: BigInt(sizeBytes),
              checksum,
            },
          });

      await transaction.trainingAnswer.update({
        where: { id: answerId },
        data: { mergedAudioFileId: file.id },
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

  private async loadVerifiedMergedAudio(
    answerId: string,
    file: {
      id: string;
      bucket: string | null;
      key: string;
      url: string | null;
      mimeType: string | null;
      sizeBytes: bigint | null;
      checksum: string | null;
    },
    bucket: string,
  ) {
    this.assertPrivateFile(file, bucket, 'audio/wav');
    const body = await this.storage.getObject(file.key, bucket);
    const sizeBytes = Number(file.sizeBytes ?? -1n);
    const checksum = createHash('sha256').update(body).digest('hex');

    if (
      sizeBytes !== body.length ||
      body.length <= 44 ||
      body.length > 64 * 1024 * 1024 ||
      !file.checksum ||
      checksum !== file.checksum ||
      body.toString('ascii', 0, 4) !== 'RIFF' ||
      body.toString('ascii', 8, 12) !== 'WAVE'
    ) {
      throw new TrainingAudioError('MERGED_WAV_INTEGRITY_FAILED', false);
    }

    const ownership = await this.prisma.trainingAnswer.count({
      where: { id: answerId, mergedAudioFileId: file.id },
    });

    if (ownership !== 1) throw new TrainingAudioError('MERGED_WAV_OWNERSHIP_FAILED', false);

    return {
      answerId,
      fileId: file.id,
      mimeType: 'audio/wav' as const,
      sizeBytes,
      checksum,
      wav: body,
      vocabularyPrompt: '',
    };
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

export function buildTrainingFfmpegArgs(inputPaths: string[], outputPath: string) {
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

  args.push('-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', outputPath);
  return args;
}

function validateOggVoice(body: Buffer, mimeType: string | null) {
  const allowedMimeTypes = new Set([
    'audio/ogg',
    'application/ogg',
    'audio/opus',
    'application/octet-stream',
  ]);

  if (
    body.length === 0 ||
    body.length > 20 * 1024 * 1024 ||
    !mimeType ||
    !allowedMimeTypes.has(mimeType) ||
    body.toString('ascii', 0, 4) !== 'OggS'
  ) {
    throw new TrainingAudioError('INVALID_OGG_VOICE', false);
  }
}

function getFfmpegTimeoutMs() {
  const parsed = Number(process.env.TRAINING_FFMPEG_TIMEOUT_MS ?? 30_000);

  return Number.isInteger(parsed) && parsed >= 1_000 && parsed <= 120_000
    ? parsed
    : 30_000;
}

async function hashFile(path: string) {
  const body = await readFile(path);
  return createHash('sha256').update(body).digest('hex');
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
