import { createHash } from 'node:crypto';

import { Injectable, NotFoundException } from '@nestjs/common';
import { FileStorage, TrainingAnswerSource } from '@prisma/client';

import { S3StorageService } from '../files/s3-storage.service';
import { PrismaService } from '../prisma/prisma.service';

const MAX_AUDIO_BYTES = 64 * 1024 * 1024;

@Injectable()
export class TrainingAudioAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: S3StorageService,
  ) {}

  async readAnswerAudio(answerId: string, actorUserId: string) {
    const answer = await this.prisma.trainingAnswer.findUnique({
      where: { id: answerId },
      select: {
        id: true,
        source: true,
        mergedAudioFile: {
          select: {
            id: true,
            storage: true,
            bucket: true,
            key: true,
            url: true,
            mimeType: true,
            sizeBytes: true,
            checksum: true,
          },
        },
        attemptQuestion: {
          select: {
            attempt: { select: { id: true, projectId: true } },
          },
        },
      },
    });
    const file = answer?.mergedAudioFile;
    const privateBucket = getPrivateAudioBucket(this.storage.getBucket());
    const format = answer && file
      ? resolveAudioFormat(answer.id, file.key, file.mimeType)
      : null;

    if (
      !answer ||
      answer.source !== TrainingAnswerSource.TELEGRAM ||
      !file ||
      !format ||
      file.storage !== FileStorage.MINIO ||
      file.bucket !== privateBucket ||
      file.url !== null ||
      file.sizeBytes === null ||
      !file.checksum
    ) {
      throw safeNotFound();
    }

    let buffer: Buffer;

    try {
      buffer = await this.storage.getObject(file.key, privateBucket);
    } catch {
      throw safeNotFound();
    }

    const checksum = createHash('sha256').update(buffer).digest('hex');

    if (
      buffer.length <= format.minimumBytes ||
      buffer.length > format.maximumBytes ||
      BigInt(buffer.length) !== file.sizeBytes ||
      checksum !== file.checksum ||
      !format.hasValidHeader(buffer)
    ) {
      throw safeNotFound();
    }

    await this.prisma.auditLog.create({
      data: {
        actorUserId,
        action: 'training.audio.read',
        entityType: 'training_answer',
        entityId: answer.id,
        metadata: {
          attemptId: answer.attemptQuestion.attempt.id,
          projectId: answer.attemptQuestion.attempt.projectId,
          fileId: file.id,
          sizeBytes: buffer.length,
        },
      },
    });

    return { buffer, mimeType: format.mimeType, fileName: format.fileName };
  }
}

function resolveAudioFormat(answerId: string, key: string, mimeType: string | null) {
  if (
    key === `training-v2/answers/${answerId}/merged.webm` &&
    mimeType === 'audio/webm'
  ) {
    return {
      mimeType: 'audio/webm' as const,
      fileName: 'training-answer-audio.webm',
      minimumBytes: 4,
      maximumBytes: 25 * 1024 * 1024,
      hasValidHeader: (buffer: Buffer) =>
        buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])),
    };
  }
  if (
    key === `training-v2/answers/${answerId}/merged.wav` &&
    mimeType === 'audio/wav'
  ) {
    return {
      mimeType: 'audio/wav' as const,
      fileName: 'training-answer-audio.wav',
      minimumBytes: 44,
      maximumBytes: MAX_AUDIO_BYTES,
      hasValidHeader: (buffer: Buffer) =>
        buffer.toString('ascii', 0, 4) === 'RIFF' &&
        buffer.toString('ascii', 8, 12) === 'WAVE',
    };
  }
  return null;
}

function getPrivateAudioBucket(publicBucket: string) {
  const bucket = (process.env.TRAINING_AUDIO_BUCKET ?? 'platforma-training-audio').trim();

  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket) ||
    bucket === publicBucket
  ) {
    throw safeNotFound();
  }

  return bucket;
}

function safeNotFound() {
  return new NotFoundException('Training answer audio not found');
}
