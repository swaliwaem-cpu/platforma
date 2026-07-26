import { timingSafeEqual } from 'node:crypto';

import {
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  Prisma,
  TrainingJobKind,
  TrainingJobStatus,
  TrainingProcessedUpdateStatus,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { TrainingTelegramConfig } from './training-telegram.config';
import { sanitizeTelegramUpdate } from './training-telegram.update';

@Injectable()
export class TrainingTelegramWebhookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: TrainingTelegramConfig,
  ) {}

  verifySecret(providedSecret: string | undefined) {
    if (!this.config.webhookSecret) {
      throw new ServiceUnavailableException(
        'Telegram webhook secret is not configured',
      );
    }
    const expected = Buffer.from(this.config.webhookSecret, 'utf8');
    const provided = Buffer.from(providedSecret ?? '', 'utf8');
    if (
      expected.length !== provided.length ||
      !timingSafeEqual(expected, provided)
    ) {
      throw new ForbiddenException('Telegram webhook secret is invalid');
    }
  }

  async acceptUpdate(rawUpdate: unknown) {
    const receivedAt = new Date();
    const ingress = sanitizeTelegramUpdate(rawUpdate, receivedAt);

    return this.prisma.$transaction(async (tx) => {
      const inserted = await tx.trainingProcessedUpdate.createMany({
        data: [
          {
            updateId: ingress.updateId,
            status: TrainingProcessedUpdateStatus.RECEIVED,
            updateType: ingress.updateType,
            payloadHash: ingress.payloadHash,
            receivedAt,
          },
        ],
        skipDuplicates: true,
      });
      if (inserted.count === 0) {
        return { ok: true as const, duplicate: true, queued: false };
      }

      if (
        !ingress.payload ||
        !ingress.jobIdempotencyKey ||
        ingress.rejectionCode
      ) {
        await tx.trainingProcessedUpdate.update({
          where: { updateId: ingress.updateId },
          data: {
            status: TrainingProcessedUpdateStatus.PROCESSED,
            processedAt: receivedAt,
            errorCode: ingress.rejectionCode ?? 'UNSUPPORTED_UPDATE',
          },
        });
        return { ok: true as const, duplicate: false, queued: false };
      }

      const queued = await tx.trainingJob.createMany({
        data: [
          {
            kind: TrainingJobKind.PROCESS_TELEGRAM_UPDATE,
            status: TrainingJobStatus.PENDING,
            payloadJson: ingress.payload as unknown as Prisma.InputJsonObject,
            idempotencyKey: ingress.jobIdempotencyKey,
            runAt: receivedAt,
            maxAttempts: 5,
          },
        ],
        skipDuplicates: true,
      });
      if (queued.count === 0) {
        await tx.trainingProcessedUpdate.update({
          where: { updateId: ingress.updateId },
          data: {
            status: TrainingProcessedUpdateStatus.PROCESSED,
            processedAt: receivedAt,
            errorCode: 'DUPLICATE_TELEGRAM_SOURCE',
          },
        });
      }
      return {
        ok: true as const,
        duplicate: queued.count === 0,
        queued: queued.count === 1,
      };
    });
  }
}
