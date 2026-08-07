import { randomInt, randomUUID } from 'node:crypto';

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  Prisma,
  TrainingTelegramOutboxEventType,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { isTrainingModuleEnabled } from './training-runtime-config';
import { TrainingTelegramClientError } from './training-telegram-client';
import { TrainingTelegramService } from './training-telegram.service';

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_STALE_LOCK_MS = 5 * 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_SHUTDOWN_DRAIN_MS = 10_000;
const DEFAULT_RETRY_BASE_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60 * 60_000;
const MAX_DELIVERY_ATTEMPTS = 8;

type DatabaseEventType = 'answer_processed' | 'answer_failed' | 'attempt_state';

type ClaimedNotification = {
  id: string;
  event_type: DatabaseEventType;
  attempt_id: string;
  answer_id: string | null;
  attempts: number;
  lock_owner: string;
};

type ClaimFilter = {
  eventType?: DatabaseEventType;
  attemptId?: string;
  answerId?: string;
};

@Injectable()
export class TrainingTelegramOutboxWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TrainingTelegramOutboxWorkerService.name);
  private readonly workerId = `training-telegram-outbox-${process.pid}-${randomUUID()}`;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pumpTask: Promise<void> | null = null;
  private stopping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TrainingTelegramService,
  ) {}

  async onModuleInit() {
    if (!isWorkerEnabled() || !isTrainingModuleEnabled()) return;

    await this.failExhaustedStaleClaims();
    this.timer = setInterval(
      () => void this.poll().catch(() => this.logWorkerFailure('poll')),
      getPollIntervalMs(),
    );
    this.kick();
  }

  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;

    if (this.pumpTask) {
      await settlesWithin(this.pumpTask, getShutdownDrainMs());
    }
  }

  kick() {
    if (this.stopping || !isTrainingModuleEnabled() || this.pumpTask) return;

    const task = this.pump();
    this.pumpTask = task;
    void task.then(
      () => this.clearPumpTask(task),
      () => {
        this.logWorkerFailure('pump');
        this.clearPumpTask(task);
      },
    );
  }

  async runOnce() {
    return this.runMatching();
  }

  async notifyAnswerProcessed(answerId: string) {
    await this.runCommitted({ eventType: 'answer_processed', answerId });
  }

  async notifyAnswerFailed(answerId: string) {
    await this.runCommitted({ eventType: 'answer_failed', answerId });
  }

  dispatchAttemptStateNotification(attemptId: string) {
    queueMicrotask(() => {
      void this.runCommitted({ eventType: 'attempt_state', attemptId })
        .catch(() => this.logWorkerFailure('attemptState'));
    });
  }

  async retryFailed(notificationId: string) {
    const retried = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "training_telegram_outbox"
      SET
        "status" = 'pending',
        "attempts" = 0,
        "available_at" = CURRENT_TIMESTAMP - INTERVAL '1 millisecond',
        "locked_at" = NULL,
        "locked_by" = NULL,
        "last_error_code" = NULL,
        "sent_at" = NULL,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = CAST(${notificationId} AS uuid)
        AND "status" = 'failed'
    `);

    if (retried === 1) this.kick();
    return retried === 1;
  }

  private async poll() {
    if (this.stopping || !isTrainingModuleEnabled()) return;
    await this.failExhaustedStaleClaims();
    this.kick();
  }

  private clearPumpTask(task: Promise<void>) {
    if (this.pumpTask === task) this.pumpTask = null;
  }

  private logWorkerFailure(operation: string) {
    this.logger.warn({
      event: 'training_telegram_outbox_worker_failed',
      operation,
      code: 'UNEXPECTED_ERROR',
    });
  }

  private async pump() {
    while (!this.stopping && isTrainingModuleEnabled() && (await this.runMatching())) {
      // Continue until the currently available batch is drained.
    }
  }

  private async runMatching(filter: ClaimFilter = {}) {
    if (this.stopping || !isTrainingModuleEnabled()) return false;
    const notification = await this.claimNext(filter);

    if (!notification) return false;

    await this.deliverClaim(notification);
    return true;
  }

  private async runCommitted(filter: ClaimFilter) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await this.runMatching(filter)) return true;
      if (attempt < 2) await delay(2);
    }
    return false;
  }

  private async claimNext(filter: ClaimFilter) {
    const staleLockMs = getStaleLockMs();
    const lockOwner = `${this.workerId}-${randomUUID()}`;
    const filterSql = Prisma.join([
      filter.eventType
        ? Prisma.sql`AND outbox."event_type" = CAST(${filter.eventType} AS "training_telegram_outbox_event_type")`
        : Prisma.empty,
      filter.attemptId
        ? Prisma.sql`AND outbox."attempt_id" = CAST(${filter.attemptId} AS uuid)`
        : Prisma.empty,
      filter.answerId
        ? Prisma.sql`AND outbox."answer_id" = CAST(${filter.answerId} AS uuid)`
        : Prisma.empty,
    ], ' ');
    const rows = await this.prisma.$queryRaw<ClaimedNotification[]>(Prisma.sql`
      WITH candidate AS (
        SELECT outbox."id"
        FROM "training_telegram_outbox" AS outbox
        WHERE outbox."attempts" < ${MAX_DELIVERY_ATTEMPTS}
          AND (
            (
              outbox."status" = 'pending'
              AND outbox."available_at" <= CURRENT_TIMESTAMP + INTERVAL '1 millisecond'
            ) OR (
              outbox."status" = 'processing'
              AND outbox."locked_at" < CURRENT_TIMESTAMP - (${staleLockMs} * INTERVAL '1 millisecond')
            )
          )
          ${filterSql}
        ORDER BY outbox."available_at" ASC, outbox."created_at" ASC, outbox."id" ASC
        FOR UPDATE OF outbox SKIP LOCKED
        LIMIT 1
      )
      UPDATE "training_telegram_outbox" AS outbox
      SET
        "status" = 'processing',
        "attempts" = "attempts" + 1,
        "locked_at" = CURRENT_TIMESTAMP,
        "locked_by" = ${lockOwner},
        "updated_at" = CURRENT_TIMESTAMP
      FROM candidate
      WHERE outbox."id" = candidate."id"
      RETURNING
        outbox."id",
        outbox."event_type",
        outbox."attempt_id",
        outbox."answer_id",
        outbox."attempts",
        outbox."locked_by" AS "lock_owner"
    `);

    return rows[0] ?? null;
  }

  private async deliverClaim(notification: ClaimedNotification) {
    const heartbeat = setInterval(
      () => void this.refreshHeartbeat(notification),
      getHeartbeatIntervalMs(),
    );

    try {
      const outcome = await this.telegram.deliverOutboxNotification({
        eventType: toPrismaEventType(notification.event_type),
        attemptId: notification.attempt_id,
        answerId: notification.answer_id,
      });

      if (outcome === 'RECIPIENT_UNAVAILABLE') {
        await this.handleDeliveryFailure(
          notification,
          new TrainingTelegramOutboxDeliveryError('RECIPIENT_UNAVAILABLE', false),
        );
        return;
      }

      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "training_telegram_outbox"
        SET
          "status" = 'sent',
          "locked_at" = NULL,
          "locked_by" = NULL,
          "last_error_code" = NULL,
          "sent_at" = CURRENT_TIMESTAMP,
          "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = CAST(${notification.id} AS uuid)
          AND "status" = 'processing'
          AND "locked_by" = ${notification.lock_owner}
      `);
    } catch (error) {
      await this.handleDeliveryFailure(notification, error);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async refreshHeartbeat(notification: ClaimedNotification) {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "training_telegram_outbox"
      SET "locked_at" = CURRENT_TIMESTAMP, "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = CAST(${notification.id} AS uuid)
        AND "status" = 'processing'
        AND "locked_by" = ${notification.lock_owner}
    `).catch(() => undefined);
  }

  private async handleDeliveryFailure(notification: ClaimedNotification, error: unknown) {
    const failure = classifyDeliveryFailure(error);
    const canRetry = failure.retryable && notification.attempts < MAX_DELIVERY_ATTEMPTS;
    const retryDelayMs = canRetry ? getRetryDelayMs(notification.attempts) : null;
    const updated = retryDelayMs === null
      ? await this.prisma.$executeRaw(Prisma.sql`
          UPDATE "training_telegram_outbox"
          SET
            "status" = 'failed',
            "locked_at" = NULL,
            "locked_by" = NULL,
            "last_error_code" = ${failure.code},
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = CAST(${notification.id} AS uuid)
            AND "status" = 'processing'
            AND "locked_by" = ${notification.lock_owner}
        `)
      : await this.prisma.$executeRaw(Prisma.sql`
          UPDATE "training_telegram_outbox"
          SET
            "status" = 'pending',
            "available_at" = CURRENT_TIMESTAMP + (${retryDelayMs} * INTERVAL '1 millisecond'),
            "locked_at" = NULL,
            "locked_by" = NULL,
            "last_error_code" = ${failure.code},
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = CAST(${notification.id} AS uuid)
            AND "status" = 'processing'
            AND "locked_by" = ${notification.lock_owner}
        `);

    if (updated !== 1) return;

    this.logger.warn({
      event: retryDelayMs === null
        ? 'training_telegram_outbox_failed'
        : 'training_telegram_outbox_retry_scheduled',
      eventType: notification.event_type,
      code: failure.code,
      deliveryAttempt: notification.attempts,
      retryable: failure.retryable,
      ...(retryDelayMs === null ? {} : { retryDelayMs }),
    });
  }

  private async failExhaustedStaleClaims() {
    const staleLockMs = getStaleLockMs();
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "training_telegram_outbox"
      SET
        "status" = 'failed',
        "locked_at" = NULL,
        "locked_by" = NULL,
        "last_error_code" = COALESCE("last_error_code", 'DELIVERY_ATTEMPTS_EXHAUSTED'),
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "status" = 'processing'
        AND "attempts" >= ${MAX_DELIVERY_ATTEMPTS}
        AND "locked_at" < CURRENT_TIMESTAMP - (${staleLockMs} * INTERVAL '1 millisecond')
    `);
  }
}

class TrainingTelegramOutboxDeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(`Training Telegram outbox delivery failed: ${code}`);
  }
}

function classifyDeliveryFailure(error: unknown) {
  if (
    error instanceof TrainingTelegramClientError ||
    error instanceof TrainingTelegramOutboxDeliveryError
  ) {
    return {
      code: normalizeErrorCode(error.code),
      retryable: error.retryable,
    };
  }

  return { code: 'UNEXPECTED_ERROR', retryable: true };
}

function normalizeErrorCode(value: string) {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9_]/gu, '_').slice(0, 64);
  return normalized || 'UNEXPECTED_ERROR';
}

function toPrismaEventType(eventType: DatabaseEventType) {
  switch (eventType) {
    case 'answer_processed':
      return TrainingTelegramOutboxEventType.ANSWER_PROCESSED;
    case 'answer_failed':
      return TrainingTelegramOutboxEventType.ANSWER_FAILED;
    case 'attempt_state':
      return TrainingTelegramOutboxEventType.ATTEMPT_STATE;
  }
}

export function getTrainingTelegramOutboxRetryDelayMs(attempt: number, jitterMs = 0) {
  const exponent = Math.max(0, attempt - 1);
  const baseDelay = Math.min(
    MAX_RETRY_DELAY_MS,
    getRetryBaseMs() * 2 ** exponent,
  );
  const maximumJitter = Math.max(1, Math.floor(baseDelay / 4));
  const boundedJitter = Math.max(0, Math.min(jitterMs, maximumJitter - 1));

  return Math.min(MAX_RETRY_DELAY_MS, baseDelay + boundedJitter);
}

function getRetryDelayMs(attempt: number) {
  const baseDelay = getTrainingTelegramOutboxRetryDelayMs(attempt);
  const maximumJitter = Math.max(1, Math.floor(baseDelay / 4));
  return getTrainingTelegramOutboxRetryDelayMs(attempt, randomInt(maximumJitter));
}

function isWorkerEnabled() {
  const explicit = process.env.TRAINING_TELEGRAM_OUTBOX_WORKER_ENABLED;
  if (explicit !== undefined) return explicit === 'true';
  return process.env.NODE_ENV !== 'test';
}

function getPollIntervalMs() {
  return readBoundedInteger(
    process.env.TRAINING_TELEGRAM_OUTBOX_POLL_INTERVAL_MS,
    DEFAULT_POLL_INTERVAL_MS,
    250,
    60_000,
  );
}

function getStaleLockMs() {
  return readBoundedInteger(
    process.env.TRAINING_TELEGRAM_OUTBOX_STALE_LOCK_MS,
    DEFAULT_STALE_LOCK_MS,
    5_000,
    30 * 60_000,
  );
}

function getHeartbeatIntervalMs() {
  const configured = readBoundedInteger(
    process.env.TRAINING_TELEGRAM_OUTBOX_HEARTBEAT_INTERVAL_MS,
    DEFAULT_HEARTBEAT_INTERVAL_MS,
    250,
    60_000,
  );
  return Math.min(configured, Math.max(250, Math.floor(getStaleLockMs() / 3)));
}

function getShutdownDrainMs() {
  return readBoundedInteger(
    process.env.TRAINING_TELEGRAM_OUTBOX_SHUTDOWN_DRAIN_MS,
    DEFAULT_SHUTDOWN_DRAIN_MS,
    250,
    60_000,
  );
}

function getRetryBaseMs() {
  return readBoundedInteger(
    process.env.TRAINING_TELEGRAM_OUTBOX_RETRY_BASE_MS,
    DEFAULT_RETRY_BASE_MS,
    100,
    60_000,
  );
}

function readBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    promise.catch(() => undefined),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
