import { randomUUID } from 'node:crypto';

import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, TrainingAnswerProcessingStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  getTrainingAudioErrorCode,
  isRetryableTrainingAudioError,
  TrainingAudioService,
} from './training-audio.service';
import { TrainingAttemptStateService } from './training-attempt-state.service';
import { TrainingTelegramService } from './training-telegram.service';
import {
  TRAINING_TRANSCRIBER,
  type TrainingTranscriber,
} from './training-transcriber';

const MAX_PROCESSING_ATTEMPTS = 3;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_STALE_LOCK_MS = 2 * 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

type ClaimedAnswer = {
  id: string;
  processing_attempts: number;
};

@Injectable()
export class TrainingVoiceWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly workerId = `training-voice-${process.pid}-${randomUUID()}`;
  private timer: ReturnType<typeof setInterval> | null = null;
  private active = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audio: TrainingAudioService,
    @Inject(TRAINING_TRANSCRIBER) private readonly transcriber: TrainingTranscriber,
    private readonly attemptState: TrainingAttemptStateService,
    private readonly telegram: TrainingTelegramService,
  ) {}

  async onModuleInit() {
    if (!isWorkerEnabled()) return;

    await this.recoverExhaustedAnswers();
    this.timer = setInterval(() => void this.drain(), getPollIntervalMs());
    this.kick();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  kick() {
    void this.drain();
  }

  async runOnce() {
    await this.recoverExhaustedAnswers();
    const answer = await this.claimNextAnswer();

    if (!answer) return false;

    await this.processClaimedAnswer(answer);
    return true;
  }

  private async drain() {
    if (this.active) return;
    this.active = true;
    let processed = false;

    try {
      processed = await this.runOnce();
    } finally {
      this.active = false;

      if (processed) queueMicrotask(() => void this.drain());
    }
  }

  private async claimNextAnswer() {
    const staleLockMs = getStaleLockMs();
    const rows = await this.prisma.$queryRaw<ClaimedAnswer[]>(Prisma.sql`
      WITH candidate AS (
        SELECT "id"
        FROM "training_answers"
        WHERE "processing_status" = 'processing'
          AND "processing_attempts" < ${MAX_PROCESSING_ATTEMPTS}
          AND (
            "processing_locked_at" IS NULL
            OR "processing_locked_at" < CURRENT_TIMESTAMP - (${staleLockMs} * INTERVAL '1 millisecond')
          )
        ORDER BY "created_at" ASC, "id" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE "training_answers" AS answer
      SET
        "processing_locked_at" = CURRENT_TIMESTAMP,
        "processing_locked_by" = ${this.workerId},
        "processing_attempts" = "processing_attempts" + 1,
        "processing_error_code" = NULL,
        "updated_at" = CURRENT_TIMESTAMP
      FROM candidate
      WHERE answer."id" = candidate."id"
      RETURNING answer."id", answer."processing_attempts"
    `);

    return rows[0] ?? null;
  }

  private async recoverExhaustedAnswers() {
    const staleLockMs = getStaleLockMs();
    const failed = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      UPDATE "training_answers"
      SET
        "processing_status" = 'failed',
        "processing_locked_at" = NULL,
        "processing_locked_by" = NULL,
        "processing_error_code" = 'PROCESSING_ATTEMPTS_EXHAUSTED',
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "processing_status" = 'processing'
        AND "processing_attempts" >= ${MAX_PROCESSING_ATTEMPTS}
        AND (
          "processing_locked_at" IS NULL
          OR "processing_locked_at" < CURRENT_TIMESTAMP - (${staleLockMs} * INTERVAL '1 millisecond')
        )
      RETURNING "id"
    `);

    for (const answer of failed) {
      await this.notifyFailed(answer.id);
    }
  }

  private async processClaimedAnswer(answer: ClaimedAnswer) {
    const answerRef = await this.prisma.trainingAnswer.findUnique({
      where: { id: answer.id },
      select: { attemptQuestion: { select: { attemptId: true } } },
    });

    if (!answerRef) return;

    const timedOut = await this.attemptState.finalizeAttemptIfExpired(
      answerRef.attemptQuestion.attemptId,
    );

    if (timedOut) {
      await this.notifyProcessed(answer.id);
      return;
    }
    const stillClaimed = await this.prisma.trainingAnswer.findFirst({
      where: {
        id: answer.id,
        processingStatus: TrainingAnswerProcessingStatus.PROCESSING,
        processingLockedBy: this.workerId,
      },
      select: { id: true },
    });

    if (!stillClaimed) return;

    const heartbeat = setInterval(
      () => void this.refreshHeartbeat(answer.id).catch(() => undefined),
      getHeartbeatIntervalMs(),
    );

    try {
      const audio = await this.audio.prepareAnswerAudio(answer.id);
      const transcript = await this.transcriber.transcribe(audio);

      if (!transcript.trim()) {
        throw new VoiceWorkerError('EMPTY_TRANSCRIPT', false);
      }

      const result = await this.attemptState.completeTelegramVoiceAnswer(
        answer.id,
        this.workerId,
        transcript,
      );

      if (result.status === 'COMPLETED') {
        await this.notifyProcessed(answer.id);
      } else if (result.status === 'TIMED_OUT') {
        await this.notifyProcessed(answer.id);
      }
    } catch (error) {
      await this.handleProcessingFailure(answer, error);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async refreshHeartbeat(answerId: string) {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "training_answers"
      SET "processing_locked_at" = CURRENT_TIMESTAMP, "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = CAST(${answerId} AS uuid)
        AND "processing_status" = 'processing'
        AND "processing_locked_by" = ${this.workerId}
    `);
  }

  private async handleProcessingFailure(answer: ClaimedAnswer, error: unknown) {
    const retryable = isRetryableWorkerError(error);
    const exhausted = answer.processing_attempts >= MAX_PROCESSING_ATTEMPTS;

    if (retryable && !exhausted) {
      await this.prisma.trainingAnswer.updateMany({
        where: {
          id: answer.id,
          processingStatus: TrainingAnswerProcessingStatus.PROCESSING,
          processingLockedBy: this.workerId,
        },
        data: {
          processingLockedAt: null,
          processingLockedBy: null,
          processingErrorCode: null,
        },
      });
      return;
    }

    const failed = await this.prisma.trainingAnswer.updateMany({
      where: {
        id: answer.id,
        processingStatus: TrainingAnswerProcessingStatus.PROCESSING,
        processingLockedBy: this.workerId,
      },
      data: {
        processingStatus: TrainingAnswerProcessingStatus.FAILED,
        processingLockedAt: null,
        processingLockedBy: null,
        processingErrorCode: getWorkerErrorCode(error),
      },
    });

    if (failed.count === 1) await this.notifyFailed(answer.id);
  }

  private async notifyProcessed(answerId: string) {
    try {
      await this.telegram.notifyAnswerProcessed(answerId);
    } catch {
      // Domain state is already committed; /start restores it if delivery fails.
    }
  }

  private async notifyFailed(answerId: string) {
    try {
      await this.telegram.notifyAnswerFailed(answerId);
    } catch {
      // A failed informational delivery must not reopen answer processing.
    }
  }
}

class VoiceWorkerError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(`Training voice worker failed: ${code}`);
  }
}

function isRetryableWorkerError(error: unknown) {
  if (error instanceof VoiceWorkerError) return error.retryable;
  return isRetryableTrainingAudioError(error);
}

function getWorkerErrorCode(error: unknown) {
  if (error instanceof VoiceWorkerError) return error.code;
  return getTrainingAudioErrorCode(error).slice(0, 64);
}

function isWorkerEnabled() {
  const explicit = process.env.TRAINING_VOICE_WORKER_ENABLED;

  if (explicit !== undefined) return explicit === 'true';
  return process.env.NODE_ENV !== 'test';
}

function getPollIntervalMs() {
  return readBoundedInteger(
    process.env.TRAINING_VOICE_WORKER_POLL_INTERVAL_MS,
    DEFAULT_POLL_INTERVAL_MS,
    250,
    60_000,
  );
}

function getStaleLockMs() {
  return readBoundedInteger(
    process.env.TRAINING_VOICE_STALE_LOCK_MS,
    DEFAULT_STALE_LOCK_MS,
    1_000,
    30 * 60_000,
  );
}

function getHeartbeatIntervalMs() {
  const configured = readBoundedInteger(
    process.env.TRAINING_VOICE_HEARTBEAT_INTERVAL_MS,
    DEFAULT_HEARTBEAT_INTERVAL_MS,
    250,
    60_000,
  );
  const maximumSafeInterval = Math.max(250, Math.floor(getStaleLockMs() / 3));

  return Math.min(configured, maximumSafeInterval);
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
