import { randomUUID } from 'node:crypto';

import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  Prisma,
  TrainingJobKind,
  TrainingJobStatus,
  TrainingProcessedUpdateStatus,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { TRAINING_ACTIVE_ATTEMPT_STATUSES } from '../training.domain';
import { TrainingTelegramConfig } from './training-telegram.config';
import { TrainingTelegramDialogService } from './training-telegram-dialog.service';
import type { SanitizedTelegramUpdate } from './training-telegram.update';
import {
  TRAINING_TELEGRAM_TRANSPORT,
  type TrainingTelegramTransport,
} from './training-telegram.transport';

const TELEGRAM_JOB_LEASE_MS = 30_000;
const TELEGRAM_JOB_LIMIT_PER_DRAIN = 100;
const TELEGRAM_JOB_KINDS = [
  TrainingJobKind.PROCESS_TELEGRAM_UPDATE,
  TrainingJobKind.SEND_TELEGRAM_MESSAGE,
  TrainingJobKind.SEND_TIMER_WARNING,
] as const;

type ClaimedTelegramJob = {
  id: string;
  kind: TrainingJobKind;
  payloadJson: Prisma.JsonValue;
  idempotencyKey: string;
  attempts: number;
  maxAttempts: number;
};

@Injectable()
export class TrainingTelegramWorkerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(TrainingTelegramWorkerService.name);
  private readonly workerId = `training-telegram:${process.pid}:${randomUUID()}`;
  private pollInterval: NodeJS.Timeout | null = null;
  private drainPromise: Promise<void> | null = null;
  private kickQueued = false;
  private destroyed = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: TrainingTelegramConfig,
    private readonly dialog: TrainingTelegramDialogService,
    @Inject(TRAINING_TELEGRAM_TRANSPORT)
    private readonly transport: TrainingTelegramTransport,
  ) {}

  onModuleInit() {
    this.destroyed = false;
    this.pollInterval = setInterval(
      () => this.kick(),
      this.config.workerPollMs,
    );
    this.pollInterval.unref();
    this.kick();
  }

  onModuleDestroy() {
    this.destroyed = true;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  kick() {
    if (this.destroyed || this.kickQueued) return;
    this.kickQueued = true;
    setImmediate(() => {
      this.kickQueued = false;
      void this.drainNow().catch((error) => {
        this.logger.error(`Telegram worker drain failed: ${safeError(error)}`);
      });
    });
  }

  async drainNow() {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.drainLoop().finally(() => {
      this.drainPromise = null;
    });
    return this.drainPromise;
  }

  private async drainLoop() {
    await this.recoverStaleJobs();
    for (let index = 0; index < TELEGRAM_JOB_LIMIT_PER_DRAIN; index += 1) {
      const job = await this.claimNextJob();
      if (!job) return;
      try {
        await this.processJob(job);
        await this.completeJob(job.id);
      } catch (error) {
        await this.failJob(job, error);
      }
    }
  }

  private async claimNextJob(): Promise<ClaimedTelegramJob | null> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const candidate = await tx.trainingJob.findFirst({
        where: {
          kind: { in: [...TELEGRAM_JOB_KINDS] },
          status: TrainingJobStatus.PENDING,
          runAt: { lte: now },
        },
        orderBy: [{ runAt: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          kind: true,
          payloadJson: true,
          idempotencyKey: true,
          attempts: true,
          maxAttempts: true,
        },
      });
      if (!candidate) return null;
      const claimed = await tx.trainingJob.updateMany({
        where: {
          id: candidate.id,
          status: TrainingJobStatus.PENDING,
          runAt: { lte: now },
        },
        data: {
          status: TrainingJobStatus.RUNNING,
          attempts: { increment: 1 },
          lockOwner: this.workerId,
          lockedAt: now,
          heartbeatAt: now,
        },
      });
      if (claimed.count !== 1) return null;
      return { ...candidate, attempts: candidate.attempts + 1 };
    });
  }

  private async processJob(job: ClaimedTelegramJob) {
    if (job.kind === TrainingJobKind.PROCESS_TELEGRAM_UPDATE) {
      const update = readUpdatePayload(job.payloadJson);
      await this.prisma.trainingProcessedUpdate.updateMany({
        where: {
          updateId: BigInt(update.updateId),
          status: TrainingProcessedUpdateStatus.RECEIVED,
        },
        data: { status: TrainingProcessedUpdateStatus.PROCESSING },
      });
      await this.dialog.processUpdate(update, job.idempotencyKey);
      return;
    }

    if (job.kind === TrainingJobKind.SEND_TIMER_WARNING) {
      const payload = readTimerPayload(job.payloadJson);
      const plan = await this.dialog.buildTimerWarning(
        payload.attemptId,
        payload.warningSeconds,
      );
      if (plan?.operation === 'SEND_MESSAGE') {
        await this.transport.sendMessage({
          idempotencyKey: job.idempotencyKey,
          chatId: plan.chatId,
          text: plan.text,
          replyMarkup: plan.replyMarkup,
        });
      }
      return;
    }

    const payload = readDeliveryPayload(job.payloadJson);
    if (payload.operation === 'ATTEMPT_RESULT') {
      const plan = await this.dialog.deliverAttemptResult(payload.attemptId);
      if (plan?.operation === 'SEND_MESSAGE') {
        await this.transport.sendMessage({
          idempotencyKey: job.idempotencyKey,
          chatId: plan.chatId,
          text: plan.text,
          replyMarkup: plan.replyMarkup,
        });
      }
      return;
    }
    if (payload.operation === 'ANSWER_CALLBACK') {
      await this.transport.answerCallbackQuery({
        idempotencyKey: job.idempotencyKey,
        callbackQueryId: payload.callbackQueryId,
        text: payload.text,
      });
      return;
    }
    if (
      payload.activeAttemptId &&
      !(await this.isAttemptActive(payload.activeAttemptId))
    ) {
      return;
    }
    await this.transport.sendMessage({
      idempotencyKey: job.idempotencyKey,
      chatId: payload.chatId,
      text: payload.text,
      replyMarkup: payload.replyMarkup,
    });
  }

  private async completeJob(jobId: string) {
    const completedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      const job = await tx.trainingJob.findUnique({
        where: { id: jobId },
        select: { kind: true, payloadJson: true },
      });
      const completed = await tx.trainingJob.updateMany({
        where: {
          id: jobId,
          status: TrainingJobStatus.RUNNING,
          lockOwner: this.workerId,
        },
        data: {
          status: TrainingJobStatus.SUCCEEDED,
          finishedAt: completedAt,
          lockOwner: null,
          lockedAt: null,
          heartbeatAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          errorDetailsJson: Prisma.JsonNull,
        },
      });
      if (
        completed.count === 1 &&
        job?.kind === TrainingJobKind.PROCESS_TELEGRAM_UPDATE
      ) {
        const update = readUpdatePayload(job.payloadJson);
        await tx.trainingProcessedUpdate.updateMany({
          where: { updateId: BigInt(update.updateId) },
          data: {
            status: TrainingProcessedUpdateStatus.PROCESSED,
            processedAt: completedAt,
            errorCode: null,
          },
        });
      }
    });
  }

  private async failJob(job: ClaimedTelegramJob, error: unknown) {
    const failedAt = new Date();
    const retry = job.attempts < job.maxAttempts;
    const message = safeError(error);
    const runAt = new Date(
      failedAt.getTime() + Math.min(30_000, 250 * 2 ** job.attempts),
    );
    await this.prisma.$transaction(async (tx) => {
      await tx.trainingJob.updateMany({
        where: {
          id: job.id,
          status: TrainingJobStatus.RUNNING,
          lockOwner: this.workerId,
        },
        data: {
          status: retry ? TrainingJobStatus.PENDING : TrainingJobStatus.DEAD,
          runAt,
          lockOwner: null,
          lockedAt: null,
          heartbeatAt: null,
          lastErrorCode: retry ? 'TELEGRAM_RETRY' : 'TELEGRAM_DEAD',
          lastErrorMessage: message,
          errorDetailsJson: { retryable: retry },
          finishedAt: retry ? null : failedAt,
        },
      });
      if (job.kind === TrainingJobKind.PROCESS_TELEGRAM_UPDATE) {
        const update = readUpdatePayload(job.payloadJson);
        await tx.trainingProcessedUpdate.updateMany({
          where: { updateId: BigInt(update.updateId) },
          data: {
            status: retry
              ? TrainingProcessedUpdateStatus.RECEIVED
              : TrainingProcessedUpdateStatus.FAILED,
            processedAt: retry ? null : failedAt,
            errorCode: retry ? 'TELEGRAM_RETRY' : 'TELEGRAM_DEAD',
          },
        });
      }
    });
  }

  private async recoverStaleJobs() {
    const staleAt = new Date(Date.now() - TELEGRAM_JOB_LEASE_MS);
    await this.prisma.trainingJob.updateMany({
      where: {
        kind: { in: [...TELEGRAM_JOB_KINDS] },
        status: TrainingJobStatus.RUNNING,
        OR: [
          { heartbeatAt: { lt: staleAt } },
          { heartbeatAt: null, lockedAt: { lt: staleAt } },
        ],
      },
      data: {
        status: TrainingJobStatus.PENDING,
        lockOwner: null,
        lockedAt: null,
        heartbeatAt: null,
        runAt: new Date(),
        lastErrorCode: 'STALE_TELEGRAM_JOB',
        lastErrorMessage: 'Recovered stale Telegram job lease',
      },
    });
  }

  private async isAttemptActive(attemptId: string) {
    const attempt = await this.prisma.trainingAttempt.findUnique({
      where: { id: attemptId },
      select: { status: true },
    });
    return Boolean(
      attempt &&
        TRAINING_ACTIVE_ATTEMPT_STATUSES.includes(
          attempt.status as (typeof TRAINING_ACTIVE_ATTEMPT_STATUSES)[number],
        ),
    );
  }
}

function readUpdatePayload(value: Prisma.JsonValue) {
  const payload = readObject(value);
  if (
    (payload.type !== 'MESSAGE' && payload.type !== 'CALLBACK') ||
    typeof payload.updateId !== 'string'
  ) {
    throw new TypeError('Telegram update job payload is invalid');
  }
  return payload as unknown as SanitizedTelegramUpdate;
}

function readTimerPayload(value: Prisma.JsonValue) {
  const payload = readObject(value);
  if (
    typeof payload.attemptId !== 'string' ||
    typeof payload.warningSeconds !== 'number' ||
    !Number.isInteger(payload.warningSeconds) ||
    payload.warningSeconds <= 0
  ) {
    throw new TypeError('Telegram timer job payload is invalid');
  }
  return {
    attemptId: payload.attemptId,
    warningSeconds: payload.warningSeconds,
  };
}

type DeliveryPayload =
  | {
      operation: 'ATTEMPT_RESULT';
      attemptId: string;
    }
  | {
      operation: 'ANSWER_CALLBACK';
      callbackQueryId: string;
      text?: string;
    }
  | {
      operation: 'SEND_MESSAGE';
      chatId: string;
      text: string;
      replyMarkup?: {
        inline_keyboard: Array<
          Array<
            | { text: string; callback_data: string }
            | { text: string; url: string }
          >
        >;
      };
      activeAttemptId?: string;
    };

function readDeliveryPayload(value: Prisma.JsonValue): DeliveryPayload {
  const payload = readObject(value);
  if (
    payload.operation === 'ATTEMPT_RESULT' &&
    typeof payload.attemptId === 'string'
  ) {
    return { operation: 'ATTEMPT_RESULT', attemptId: payload.attemptId };
  }
  if (
    payload.operation === 'ANSWER_CALLBACK' &&
    typeof payload.callbackQueryId === 'string'
  ) {
    return {
      operation: 'ANSWER_CALLBACK',
      callbackQueryId: payload.callbackQueryId,
      ...(typeof payload.text === 'string' ? { text: payload.text } : {}),
    };
  }
  if (
    payload.operation === 'SEND_MESSAGE' &&
    typeof payload.chatId === 'string' &&
    typeof payload.text === 'string'
  ) {
    return payload as unknown as DeliveryPayload;
  }
  throw new TypeError('Telegram delivery job payload is invalid');
}

function readObject(value: Prisma.JsonValue) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Telegram job payload is invalid');
  }
  return value as Prisma.JsonObject;
}

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n]+/gu, ' ')
    .slice(0, 2_000);
}
