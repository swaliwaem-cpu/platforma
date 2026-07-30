import { createHash } from 'node:crypto';

import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';

import type { AuthenticatedUser } from '../../auth/auth.types';
import { FilesService } from '../../files/files.service';
import { PrismaService } from '../../prisma/prisma.service';

export type TrainingAudioAuditRequest = {
  ip?: string;
  headers?: {
    'user-agent'?: string | string[];
  };
};

@Injectable()
export class TrainingAudioAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
  ) {}

  async getAnswerAudio(
    answerId: string,
    actor: AuthenticatedUser,
    request: TrainingAudioAuditRequest,
  ) {
    const answer = await this.prisma.trainingAnswer.findUnique({
      where: { id: answerId },
      include: {
        mergedAudioFile: true,
        attemptQuestion: {
          include: {
            attempt: {
              select: {
                id: true,
                userId: true,
              },
            },
          },
        },
      },
    });
    const canReadAdministrativeResults = actor.permissions.includes(
      'training:results:read',
    );
    if (
      !answer ||
      !answer.mergedAudioFile ||
      (answer.attemptQuestion.attempt.userId !== actor.id &&
        !canReadAdministrativeResults)
    ) {
      throw new NotFoundException('Training answer audio not found');
    }
    const file = answer.mergedAudioFile;
    if (
      !file.mimeType ||
      file.sizeBytes === null ||
      !file.checksum ||
      file.url !== null
    ) {
      throw new InternalServerErrorException(
        'Training answer audio metadata is invalid',
      );
    }

    const buffer = await this.files.readStoredFile(file, {
      privateTrainingAudio: true,
    });
    const checksum = createHash('sha256').update(buffer).digest('hex');
    if (
      BigInt(buffer.length) !== file.sizeBytes ||
      checksum !== file.checksum
    ) {
      throw new InternalServerErrorException(
        'Training answer audio integrity check failed',
      );
    }
    await this.prisma.auditLog.create({
      data: {
        actorUserId: actor.id,
        action: 'training.audio.read',
        entityType: 'training_answer',
        entityId: answer.id,
        metadata: {
          answerId: answer.id,
          attemptId: answer.attemptQuestion.attempt.id,
          ownerUserId: answer.attemptQuestion.attempt.userId,
          scope:
            answer.attemptQuestion.attempt.userId === actor.id
              ? 'ownership'
              : 'administrative',
        },
        ipAddress: request.ip?.slice(0, 64) ?? null,
        userAgent: readUserAgent(request.headers?.['user-agent']),
      },
    });
    return {
      buffer,
      mimeType: file.mimeType,
      sizeBytes: buffer.length,
    };
  }
}

function readUserAgent(value: string | string[] | undefined) {
  const normalized = Array.isArray(value) ? value[0] : value;
  return normalized?.slice(0, 1_000) ?? null;
}
