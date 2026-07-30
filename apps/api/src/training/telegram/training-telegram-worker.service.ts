import { randomUUID } from 'node:crypto';

import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  Prisma,
  TrainingJobKind,
  TrainingJobStatus,
  TrainingProcessedUpdateStatus,
  UserStatus,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { TrainingAttemptEngineService } from '../training-attempt-engine.service';
import { TRAINING_ACTIVE_ATTEMPT_STATUSES } from '../training.domain';
import {
  TrainingConfigService,
  TrainingFeatureDisabledAfterClaimError,
} from '../training.config';
import { TrainingWorkerHeartbeatService } from '../training-worker-heartbeat.service';
import {
  formatTrainingErrorForLog,
  readTrainingCorrelationId,
  resolveTrainingCorrelationId,
  safeTrainingFailureMessage,
  writeSafeTrainingLog,
} from '../training-safe-log';
import { TrainingTelegramConfig } from './training-telegram.config';
import { TrainingTelegramDialogService } from './training-telegram-dialog.service';
import {
  readTrainingTelegramOutboxEvent,
  TRAINING_TELEGRAM_OUTBOX_OPERATION,
  type TrainingTelegramOutboxEvent,
} from './training-telegram-outbox';
import type { SanitizedTelegramUpdate } from './training-telegram.update';
import {
  TRAINING_TELEGRAM_TRANSPORT,
  TrainingTelegramTransportError,
  type TrainingTelegramTransport,
} from './training-telegram.transport';

const TELEGRAM_JOB_LIMIT_PER_DRAIN = 100;
const TELEGRAM_TERMINALIZATION_ATTEMPTS = 3;
const TELEGRAM_TERMINALIZATION_RETRY_MS = 25;
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
  private recoveredDeadCriticalDeliveries = false;
  private readonly heartbeatIntervals = new Map<string, NodeJS.Timeout>();
  private readonly lostOwnership = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: TrainingTelegramConfig,
    private readonly dialog: TrainingTelegramDialogService,
    @Inject(TRAINING_TELEGRAM_TRANSPORT)
    private readonly transport: TrainingTelegramTransport,
    @Optional()
    private readonly trainingConfig?: TrainingConfigService,
    @Optional()
    private readonly workerHeartbeat?: TrainingWorkerHeartbeatService,
    @Optional()
    private readonly attempts?: TrainingAttemptEngineService,
  ) {}

  onModuleInit() {
    this.destroyed = false;
    this.recoveredDeadCriticalDeliveries = false;
    if (this.trainingConfig?.isEnabled() === false) return;
    void this.workerHeartbeat
      ?.register('telegram', this.workerId)
      .catch(() => undefined);
    this.pollInterval = setInterval(
      () => this.kick(),
      this.config.workerPollMs,
    );
    this.pollInterval.unref();
    this.kick();
  }

  async onModuleDestroy() {
    this.destroyed = true;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    const drained = this.drainPromise
      ? await waitForPromise(
          this.drainPromise,
          this.config.workerDrainTimeoutMs,
        )
      : true;
    if (!drained) {
      await this.releaseOwnedJobsAfterShutdown();
    }
    for (const interval of this.heartbeatIntervals.values()) {
      clearInterval(interval);
    }
    this.heartbeatIntervals.clear();
  }

  kick() {
    if (
      this.destroyed ||
      this.kickQueued ||
      this.trainingConfig?.isEnabled() === false
    ) {
      return;
    }
    void this.workerHeartbeat?.touch(this.workerId).catch(() => undefined);
    this.kickQueued = true;
    setImmediate(() => {
      this.kickQueued = false;
      void this.drainNow().catch((error) => {
        writeSafeTrainingLog(
          this.logger,
          'error',
          'training.telegram.worker.failed',
          {
            workerKind: 'telegram',
            errorCode: formatTrainingErrorForLog(error),
          },
        );
      });
    });
  }

  async drainNow() {
    if (this.drainPromise) return this.drainPromise;
    if (this.destroyed || this.trainingConfig?.isEnabled() === false) return;
    const drain = this.drainLoop().finally(() => {
      if (this.drainPromise === drain) {
        this.drainPromise = null;
      }
    });
    this.drainPromise = drain;
    return drain;
  }

  private async drainLoop() {
    if (this.destroyed || this.trainingConfig?.isEnabled() === false) return;
    if (!this.recoveredDeadCriticalDeliveries) {
      await this.recoverDeadCriticalQuestionDeliveries();
      this.recoveredDeadCriticalDeliveries = true;
    }
    await this.recoverStaleJobs();
    for (
      let index = 0;
      index < TELEGRAM_JOB_LIMIT_PER_DRAIN &&
      !this.destroyed &&
      this.trainingConfig?.isEnabled() !== false;
      index += 1
    ) {
      const job = await this.claimNextJob();
      if (!job) return;
      try {
        await this.withHeartbeat(job.id, () => this.processJob(job));
        if (!(await this.refreshOwnership(job.id))) {
          throw new LostTelegramJobOwnershipError();
        }
        await this.completeJob(job);
      } catch (error) {
        if (error instanceof LostTelegramJobOwnershipError) continue;
        if (error instanceof TrainingFeatureDisabledAfterClaimError) {
          await this.releaseJobAfterFeatureDisable(job);
          continue;
        }
        await this.failJob(job, error);
      }
    }
  }

  private async claimNextJob(): Promise<ClaimedTelegramJob | null> {
    if (this.destroyed) return null;
    while (!this.destroyed) {
      const now = new Date();
      const candidate = await this.prisma.trainingJob.findFirst({
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
      if (this.destroyed) return null;
      if (!candidate) return null;
      if (candidate.attempts >= candidate.maxAttempts) {
        const exhausted = await this.prisma.trainingJob.updateMany({
          where: {
            id: candidate.id,
            status: TrainingJobStatus.PENDING,
            attempts: candidate.attempts,
          },
          data: {
            status: TrainingJobStatus.DEAD,
            finishedAt: now,
            lastErrorCode: 'TELEGRAM_ATTEMPTS_EXHAUSTED',
            lastErrorMessage: 'Telegram job attempts are exhausted',
            errorDetailsJson: { retryable: false },
          },
        });
        if (exhausted.count === 1) {
          await this.terminalizeDeadCriticalQuestionDelivery(
            { ...candidate, attempts: candidate.attempts },
            'TELEGRAM_ATTEMPTS_EXHAUSTED',
          );
        }
        if (this.destroyed) return null;
        continue;
      }

      if (this.destroyed) return null;
      const claimed = await this.prisma.trainingJob.updateMany({
        where: {
          id: candidate.id,
          status: TrainingJobStatus.PENDING,
          runAt: { lte: now },
          attempts: candidate.attempts,
          maxAttempts: candidate.maxAttempts,
        },
        data: {
          status: TrainingJobStatus.RUNNING,
          attempts: { increment: 1 },
          lockOwner: this.workerId,
          lockedAt: now,
          heartbeatAt: now,
          finishedAt: null,
        },
      });
      if (claimed.count !== 1) continue;
      this.lostOwnership.delete(candidate.id);
      return { ...candidate, attempts: candidate.attempts + 1 };
    }
    return null;
  }

  private async processJob(job: ClaimedTelegramJob) {
    this.assertRuntimeEnabled();
    const correlationId = readJobCorrelationId(job.payloadJson);
    writeSafeTrainingLog(
      this.logger,
      'log',
      'training.telegram.job.started',
      {
        correlationId,
        jobId: job.id,
        updateId:
          job.kind === TrainingJobKind.PROCESS_TELEGRAM_UPDATE
            ? readUpdatePayload(job.payloadJson).updateId
            : undefined,
        status: job.kind,
        workerKind: 'telegram',
      },
    );
    if (job.kind === TrainingJobKind.PROCESS_TELEGRAM_UPDATE) {
      const update = readUpdatePayload(job.payloadJson);
      await this.refreshOwnershipOrThrow(job.id);
      this.assertRuntimeEnabled();
      await this.prisma.trainingProcessedUpdate.updateMany({
        where: {
          updateId: BigInt(update.updateId),
          status: {
            in: [
              TrainingProcessedUpdateStatus.RECEIVED,
              TrainingProcessedUpdateStatus.PROCESSING,
            ],
          },
        },
        data: { status: TrainingProcessedUpdateStatus.PROCESSING },
      });
      this.assertRuntimeEnabled();
      await this.dialog.processUpdate(update, job.idempotencyKey);
      return;
    }

    if (job.kind === TrainingJobKind.SEND_TIMER_WARNING) {
      const payload = readTimerPayload(job.payloadJson);
      if (!(await this.preflightTimerWarning(job.id, payload.attemptId))) {
        return;
      }
      const plan = await this.dialog.buildTimerWarning(
        payload.attemptId,
        payload.warningSeconds,
      );
      if (plan?.operation === 'SEND_MESSAGE') {
        await this.refreshOwnershipOrThrow(job.id);
        this.assertRuntimeEnabled();
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
    if (payload.operation === TRAINING_TELEGRAM_OUTBOX_OPERATION) {
      const plan = await this.dialog.buildOutboxEvent(payload);
      if (plan?.operation === 'SEND_MESSAGE') {
        await this.refreshOwnershipOrThrow(job.id);
        this.assertRuntimeEnabled();
        await this.transport.sendMessage({
          idempotencyKey: job.idempotencyKey,
          chatId: plan.chatId,
          text: plan.text,
          replyMarkup: plan.replyMarkup,
        });
      }
      return;
    }
    if (payload.operation === 'ATTEMPT_RESULT') {
      const plan = await this.dialog.deliverAttemptResult(payload.attemptId);
      if (plan?.operation === 'SEND_MESSAGE') {
        await this.refreshOwnershipOrThrow(job.id);
        this.assertRuntimeEnabled();
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
      await this.refreshOwnershipOrThrow(job.id);
      this.assertRuntimeEnabled();
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
    await this.refreshOwnershipOrThrow(job.id);
    this.assertRuntimeEnabled();
    await this.transport.sendMessage({
      idempotencyKey: job.idempotencyKey,
      chatId: payload.chatId,
      text: payload.text,
      replyMarkup: payload.replyMarkup,
    });
  }

  private assertRuntimeEnabled() {
    if (this.trainingConfig?.isEnabled() === false) {
      throw new TrainingFeatureDisabledAfterClaimError();
    }
  }

  private async releaseJobAfterFeatureDisable(job: ClaimedTelegramJob) {
    this.lostOwnership.add(job.id);
    await this.prisma.trainingJob.updateMany({
      where: {
        id: job.id,
        status: TrainingJobStatus.RUNNING,
        lockOwner: this.workerId,
        attempts: job.attempts,
      },
      data: {
        status: TrainingJobStatus.PENDING,
        attempts: { decrement: 1 },
        runAt: new Date(),
        finishedAt: null,
        lockOwner: null,
        lockedAt: null,
        heartbeatAt: null,
        lastErrorCode: 'TRAINING_DISABLED_AFTER_CLAIM',
        lastErrorMessage: 'Training job released after runtime disable',
        errorDetailsJson: { retryable: true },
      },
    });
    writeSafeTrainingLog(
      this.logger,
      'log',
      'training.telegram.job.released',
      {
        correlationId: readJobCorrelationId(job.payloadJson),
        jobId: job.id,
        status: 'disabled',
        workerKind: 'telegram',
      },
    );
  }

  private async completeJob(job: ClaimedTelegramJob) {
    const completedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      const completed = await tx.trainingJob.updateMany({
        where: {
          id: job.id,
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
        job.kind === TrainingJobKind.PROCESS_TELEGRAM_UPDATE
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
    const transportError =
      error instanceof TrainingTelegramTransportError ? error : null;
    const retryable = transportError ? transportError.retryable : true;
    const retry = retryable && job.attempts < job.maxAttempts;
    const backoffMs = Math.min(
      30_000,
      250 * 2 ** Math.max(0, job.attempts - 1) +
        Math.floor(Math.random() * 250),
    );
    const retryDelayMs = Math.max(
      backoffMs,
      transportError?.retryAfterMs ?? 0,
    );
    const runAt = new Date(failedAt.getTime() + retryDelayMs);
    const errorCode =
      transportError?.code ??
      (retry ? 'TELEGRAM_JOB_RETRY' : 'TELEGRAM_JOB_DEAD');
    const message = safeTrainingFailureMessage(error, 'Telegram job failed');

    const failed = await this.prisma.$transaction(async (tx) => {
      const failed = await tx.trainingJob.updateMany({
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
          lastErrorCode: errorCode,
          lastErrorMessage: message,
          errorDetailsJson: {
            classification: errorCode,
            retryable,
            retryAfterMs: transportError?.retryAfterMs ?? null,
          },
          finishedAt: retry ? null : failedAt,
        },
      });
      if (
        failed.count === 1 &&
        job.kind === TrainingJobKind.PROCESS_TELEGRAM_UPDATE
      ) {
        const update = readUpdatePayload(job.payloadJson);
        await tx.trainingProcessedUpdate.updateMany({
          where: { updateId: BigInt(update.updateId) },
          data: {
            status: retry
              ? TrainingProcessedUpdateStatus.RECEIVED
              : TrainingProcessedUpdateStatus.FAILED,
            processedAt: retry ? null : failedAt,
            errorCode,
          },
        });
      }
      return failed.count === 1;
    });
    if (failed && !retry) {
      await this.terminalizeDeadCriticalQuestionDelivery(job, errorCode);
    }
  }

  private async recoverStaleJobs() {
    const staleAt = new Date(Date.now() - this.config.workerLeaseMs);
    const staleJobs = await this.prisma.trainingJob.findMany({
      where: {
        kind: { in: [...TELEGRAM_JOB_KINDS] },
        status: TrainingJobStatus.RUNNING,
        OR: [
          { heartbeatAt: { lt: staleAt } },
          { heartbeatAt: null, lockedAt: { lt: staleAt } },
        ],
      },
      select: {
        id: true,
        kind: true,
        payloadJson: true,
        idempotencyKey: true,
        attempts: true,
        maxAttempts: true,
        heartbeatAt: true,
        lockedAt: true,
      },
      take: TELEGRAM_JOB_LIMIT_PER_DRAIN,
    });
    for (const job of staleJobs) {
      const retry = job.attempts < job.maxAttempts;
      const recovered = await this.prisma.trainingJob.updateMany({
        where: {
          id: job.id,
          status: TrainingJobStatus.RUNNING,
          attempts: job.attempts,
          heartbeatAt: job.heartbeatAt,
          lockedAt: job.lockedAt,
        },
        data: {
          status: retry ? TrainingJobStatus.PENDING : TrainingJobStatus.DEAD,
          lockOwner: null,
          lockedAt: null,
          heartbeatAt: null,
          runAt: new Date(),
          finishedAt: retry ? null : new Date(),
          lastErrorCode: retry
            ? 'STALE_TELEGRAM_JOB'
            : 'STALE_TELEGRAM_JOB_DEAD',
          lastErrorMessage: retry
            ? 'Recovered stale Telegram job lease'
            : 'Stale Telegram job exhausted max attempts',
          errorDetailsJson: { retryable: retry },
        },
      });
      if (recovered.count === 1 && !retry) {
        await this.terminalizeDeadCriticalQuestionDelivery(
          {
            id: job.id,
            kind: job.kind,
            payloadJson: job.payloadJson,
            idempotencyKey: job.idempotencyKey,
            attempts: job.attempts,
            maxAttempts: job.maxAttempts,
          },
          'STALE_TELEGRAM_JOB_DEAD',
        );
      }
    }
  }

  private async withHeartbeat<T>(
    jobId: string,
    operation: () => Promise<T>,
  ) {
    const interval = setInterval(() => {
      void this.refreshOwnership(jobId).catch((error) => {
        writeSafeTrainingLog(
          this.logger,
          'warn',
          'training.telegram.heartbeat.failed',
          {
            jobId,
            workerKind: 'telegram',
            errorCode: formatTrainingErrorForLog(error),
          },
        );
      });
    }, this.config.workerHeartbeatMs);
    interval.unref();
    this.heartbeatIntervals.set(jobId, interval);
    try {
      return await operation();
    } finally {
      clearInterval(interval);
      this.heartbeatIntervals.delete(jobId);
    }
  }

  private async refreshOwnership(jobId: string) {
    if (this.lostOwnership.has(jobId)) return false;
    const owned = await this.prisma.trainingJob.updateMany({
      where: {
        id: jobId,
        status: TrainingJobStatus.RUNNING,
        lockOwner: this.workerId,
      },
      data: { heartbeatAt: new Date() },
    });
    if (owned.count !== 1) {
      this.lostOwnership.add(jobId);
      return false;
    }
    return true;
  }

  private async refreshOwnershipOrThrow(jobId: string) {
    if (!(await this.refreshOwnership(jobId))) {
      throw new LostTelegramJobOwnershipError();
    }
  }

  private async preflightTimerWarning(jobId: string, attemptId: string) {
    const preflightAt = new Date();
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT 1 AS "locked" FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`training-attempt-id:${attemptId}`}, 0))) AS "lock_state"`,
      );
      const job = await tx.trainingJob.findFirst({
        where: {
          id: jobId,
          status: TrainingJobStatus.RUNNING,
          lockOwner: this.workerId,
          kind: TrainingJobKind.SEND_TIMER_WARNING,
        },
        select: { id: true },
      });
      if (!job) return false;
      const attempt = await tx.trainingAttempt.findFirst({
        where: {
          id: attemptId,
          status: { in: [...TRAINING_ACTIVE_ATTEMPT_STATUSES] },
          expiresAt: { gt: preflightAt },
          user: {
            status: UserStatus.ACTIVE,
            deletedAt: null,
            trainingTelegramAccount: {
              is: { revokedAt: null },
            },
          },
        },
        select: { id: true },
      });
      if (!attempt) return false;
      const gated = await tx.trainingJob.updateMany({
        where: {
          id: jobId,
          status: TrainingJobStatus.RUNNING,
          lockOwner: this.workerId,
        },
        data: {
          heartbeatAt: new Date(),
          errorDetailsJson: {
            warningPreSendGate: true,
          },
        },
      });
      return gated.count === 1;
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

  private async releaseOwnedJobsAfterShutdown() {
    const jobs = await this.prisma.trainingJob.findMany({
      where: {
        kind: { in: [...TELEGRAM_JOB_KINDS] },
        status: TrainingJobStatus.RUNNING,
        lockOwner: this.workerId,
      },
      select: {
        id: true,
        kind: true,
        payloadJson: true,
        idempotencyKey: true,
        attempts: true,
        maxAttempts: true,
      },
    });
    for (const job of jobs) {
      this.lostOwnership.add(job.id);
      const retry = job.attempts < job.maxAttempts;
      const released = await this.prisma.trainingJob.updateMany({
        where: {
          id: job.id,
          status: TrainingJobStatus.RUNNING,
          lockOwner: this.workerId,
          attempts: job.attempts,
        },
        data: {
          status: retry ? TrainingJobStatus.PENDING : TrainingJobStatus.DEAD,
          runAt: new Date(),
          lockOwner: null,
          lockedAt: null,
          heartbeatAt: null,
          finishedAt: retry ? null : new Date(),
          lastErrorCode: retry
            ? 'TELEGRAM_SHUTDOWN_RELEASE'
            : 'TELEGRAM_SHUTDOWN_DEAD',
          lastErrorMessage: retry
            ? 'Telegram job released during worker shutdown'
            : 'Telegram job exhausted attempts during worker shutdown',
          errorDetailsJson: { retryable: retry },
        },
      });
      if (released.count === 1 && !retry) {
        await this.terminalizeDeadCriticalQuestionDelivery(
          job,
          'TELEGRAM_SHUTDOWN_DEAD',
        );
      }
    }
  }

  private async recoverDeadCriticalQuestionDeliveries() {
    const jobs = await this.prisma.trainingJob.findMany({
      where: {
        kind: TrainingJobKind.SEND_TELEGRAM_MESSAGE,
        status: TrainingJobStatus.DEAD,
        AND: [
          {
            payloadJson: {
              path: ['operation'],
              equals: TRAINING_TELEGRAM_OUTBOX_OPERATION,
            },
          },
          {
            payloadJson: {
              path: ['eventType'],
              equals: 'ATTEMPT_QUESTION',
            },
          },
        ],
      },
      orderBy: [{ finishedAt: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        kind: true,
        payloadJson: true,
        idempotencyKey: true,
        attempts: true,
        maxAttempts: true,
        lastErrorCode: true,
      },
      take: TELEGRAM_JOB_LIMIT_PER_DRAIN,
    });
    for (const job of jobs) {
      await this.terminalizeDeadCriticalQuestionDelivery(
        job,
        job.lastErrorCode ?? 'DEAD_TELEGRAM_QUESTION_DELIVERY',
      );
    }
  }

  private async terminalizeDeadCriticalQuestionDelivery(
    job: ClaimedTelegramJob,
    errorCode: string,
  ) {
    if (job.kind !== TrainingJobKind.SEND_TELEGRAM_MESSAGE) return;
    const payload = readDeliveryPayload(job.payloadJson);
    if (
      payload.operation !== TRAINING_TELEGRAM_OUTBOX_OPERATION ||
      payload.eventType !== 'ATTEMPT_QUESTION'
    ) {
      return;
    }
    if (!this.attempts) {
      throw new Error(
        'Training attempt engine is unavailable for critical Telegram delivery failure',
      );
    }
    const terminalErrorCode = /^[A-Z0-9_]{3,120}$/u.test(errorCode)
      ? errorCode
      : 'DEAD_TELEGRAM_QUESTION_DELIVERY';
    let lastError: unknown;
    for (
      let attempt = 1;
      attempt <= TELEGRAM_TERMINALIZATION_ATTEMPTS;
      attempt += 1
    ) {
      try {
        await this.attempts.terminalizeTelegramDeliveryFailure({
          attemptId: payload.attemptId,
          attemptQuestionId: payload.attemptQuestionId,
          failedJobId: job.id,
          errorCode: terminalErrorCode,
          correlationId: payload.correlationId,
        });
        return;
      } catch (error) {
        lastError = error;
        if (attempt < TELEGRAM_TERMINALIZATION_ATTEMPTS) {
          await waitForTimeout(
            TELEGRAM_TERMINALIZATION_RETRY_MS * attempt,
          );
        }
      }
    }
    this.recoveredDeadCriticalDeliveries = false;
    throw lastError;
  }
}

class LostTelegramJobOwnershipError extends Error {}

function readUpdatePayload(value: Prisma.JsonValue) {
  const payload = readObject(value);
  if (
    (payload.type !== 'MESSAGE' && payload.type !== 'CALLBACK') ||
    typeof payload.updateId !== 'string'
  ) {
    throw new TypeError('Telegram update job payload is invalid');
  }
  return {
    ...payload,
    correlationId: resolveTrainingCorrelationId(
      payload.correlationId,
      `telegram-update:${payload.updateId}`,
    ),
  } as unknown as SanitizedTelegramUpdate;
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
  | TrainingTelegramOutboxEvent
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
  const outboxEvent = readTrainingTelegramOutboxEvent(payload);
  if (outboxEvent) return outboxEvent;
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

function readJobCorrelationId(value: Prisma.JsonValue) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return typeof value.updateId === 'string'
    ? resolveTrainingCorrelationId(
        value.correlationId,
        `telegram-update:${value.updateId}`,
      )
    : readTrainingCorrelationId(value.correlationId);
}

async function waitForPromise(promise: Promise<void>, timeoutMs: number) {
  let timeout: NodeJS.Timeout | null = null;
  const timedOut = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
    timeout.unref();
  });
  const result = await Promise.race([
    promise.then(() => true as const),
    timedOut,
  ]);
  if (timeout) clearTimeout(timeout);
  return result;
}

function waitForTimeout(timeoutMs: number) {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    timeout.unref();
  });
}
