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

    if (
      !answer ||
      answer.source !== TrainingAnswerSource.TELEGRAM ||
      !file ||
      file.storage !== FileStorage.MINIO ||
      file.bucket !== privateBucket ||
      file.key !== `training-v2/answers/${answer.id}/merged.wav` ||
      file.url !== null ||
      file.mimeType !== 'audio/wav' ||
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
      buffer.length <= 44 ||
      buffer.length > MAX_AUDIO_BYTES ||
      BigInt(buffer.length) !== file.sizeBytes ||
      checksum !== file.checksum ||
      buffer.toString('ascii', 0, 4) !== 'RIFF' ||
      buffer.toString('ascii', 8, 12) !== 'WAVE'
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

    return { buffer, mimeType: 'audio/wav' as const };
  }
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
