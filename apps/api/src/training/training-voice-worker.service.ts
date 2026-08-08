import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  Prisma,
  TrainingAiStepStatus,
  TrainingAnswerProcessingStatus,
  TrainingFakeOutcome,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  getTrainingAudioErrorCode,
  isRetryableTrainingAudioError,
  TrainingAudioService,
} from './training-audio.service';
import { TrainingAttemptStateService } from './training-attempt-state.service';
import {
  calculateTrainingObjectiveMetrics,
  scoreTrainingEvaluation,
  TRAINING_EVALUATOR,
  type TrainingEvaluationInput,
  type TrainingEvaluator,
} from './training-evaluator';
import { TrainingOpenAIError } from './training-openai-client';
import {
  isTrainingProjectSnapshotWithFacts,
  parseTrainingProjectSnapshot,
  type TrainingProjectSnapshotV2,
  type TrainingProjectSnapshotV3,
} from './training-snapshot';
import { TrainingTelegramClientError } from './training-telegram-client';
import { TrainingTelegramOutboxWorkerService } from './training-telegram-outbox-worker.service';
import {
  isTrainingHarmlessExtraRoutingEnabled,
  isTrainingModuleEnabled,
} from './training-runtime-config';
import {
  buildTrainingVocabularyPrompt,
  TRAINING_TRANSCRIBER,
  type TrainingTranscriber,
} from './training-transcriber';
import { TrainingVoiceWorkerWakeupService } from './training-voice-worker-wakeup.service';

const MAX_PROCESSING_ATTEMPTS = 3;
const MAX_OPENAI_EVALUATION_WORKER_ATTEMPTS = 2;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_RECOVERY_SWEEP_INTERVAL_MS = 15_000;
const IDLE_POLL_BACKOFF_MULTIPLIERS = [1, 2.5, 5, 7.5] as const;
const DEFAULT_STALE_LOCK_MS = 2 * 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_SHUTDOWN_DRAIN_MS = 10_000;
const EXHAUSTED_RECOVERY_BATCH_SIZE = 50;

type ClaimedAnswer = {
  id: string;
  processing_attempts: number;
  lock_owner: string;
};

type ActiveClaim = {
  answerId: string;
  externalStarted: boolean;
  ownershipLost: boolean;
};

@Injectable()
export class TrainingVoiceWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TrainingVoiceWorkerService.name);
  private readonly workerId = `training-voice-${process.pid}-${randomUUID()}`;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeWakeup: (() => void) | null = null;
  private idlePollIndex = 0;
  private wakeRequested = false;
  private stopping = false;
  private pumping = false;
  private pumpTask: Promise<boolean> | null = null;
  private readonly activeTasks = new Set<Promise<void>>();
  private readonly activeClaims = new Map<string, ActiveClaim>();
  private readonly externalAbortController = new AbortController();
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audio: TrainingAudioService,
    @Inject(TRAINING_TRANSCRIBER) private readonly transcriber: TrainingTranscriber,
    @Inject(TRAINING_EVALUATOR) private readonly evaluator: TrainingEvaluator,
    private readonly attemptState: TrainingAttemptStateService,
    private readonly telegramOutbox: TrainingTelegramOutboxWorkerService,
    private readonly wakeup = new TrainingVoiceWorkerWakeupService(),
  ) {}

  async onModuleInit() {
    if (!isWorkerEnabled() || !isTrainingModuleEnabled()) return;

    await this.recoverExhaustedAnswers();
    this.unsubscribeWakeup = this.wakeup.subscribe(() => this.kick());
    this.recoveryTimer = setInterval(
      () => void this.runRecoverySweep(),
      getRecoverySweepIntervalMs(),
    );
    this.kick();
  }

  async onModuleDestroy() {
    await this.shutdown();
  }

  async shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;

    this.shutdownPromise = this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown() {
    this.stopping = true;
    this.externalAbortController.abort();
    this.clearPollTimer();
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = null;
    this.unsubscribeWakeup?.();
    this.unsubscribeWakeup = null;
    const drainMs = getShutdownDrainMs();
    const deadline = Date.now() + drainMs;
    const releaseReserveMs = Math.min(1_000, Math.max(50, Math.floor(drainMs / 5)));
    const workDeadline = deadline - releaseReserveMs;

    if (this.pumpTask && !(await settlesBefore(this.pumpTask, workDeadline))) {
      await settlesBefore(this.releaseActiveClaimsForRestart(), deadline);
      return;
    }

    if (!this.activeTasks.size) return;

    const drain = Promise.allSettled([...this.activeTasks]);
    if (await settlesBefore(drain, workDeadline)) return;

    const release = this.releaseActiveClaimsForRestart();
    await settlesBefore(release, deadline);
  }

  kick() {
    if (this.stopping || !isTrainingModuleEnabled()) return;

    this.idlePollIndex = 0;
    this.wakeRequested = true;
    this.clearPollTimer();
    this.startPump();
  }

  private startPump() {
    if (this.pumpTask || this.stopping || !isTrainingModuleEnabled()) return;

    this.wakeRequested = false;
    const task = this.pump();
    this.pumpTask = task;
    void task.then(
      (foundWork) => this.completePump(task, foundWork),
      () => {
        this.logWorkerFailure('pump');
        this.completePump(task, false);
      },
    );
  }

  private completePump(task: Promise<boolean>, foundWork: boolean) {
    if (this.pumpTask !== task) return;
    this.pumpTask = null;

    if (this.stopping || !isTrainingModuleEnabled()) return;
    if (this.wakeRequested) {
      this.startPump();
      return;
    }
    if (foundWork) this.idlePollIndex = 0;
    this.schedulePoll();
  }

  private schedulePoll() {
    if (this.pollTimer || this.stopping || !isTrainingModuleEnabled()) return;
    const delays = getIdlePollDelaysMs();
    const delay = delays[Math.min(this.idlePollIndex, delays.length - 1)] ??
      DEFAULT_POLL_INTERVAL_MS;
    this.idlePollIndex = Math.min(this.idlePollIndex + 1, delays.length - 1);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.startPump();
    }, delay);
  }

  private clearPollTimer() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private async runRecoverySweep() {
    try {
      await this.recoverExhaustedAnswers();
    } catch {
      this.logWorkerFailure('recovery');
    }
  }

  private logWorkerFailure(operation: 'pump' | 'recovery') {
    this.logger.warn({
      event: 'training_voice_worker_failed',
      operation,
      code: 'UNEXPECTED_ERROR',
    });
  }

  async runOnce() {
    if (this.stopping || !isTrainingModuleEnabled()) return false;
    await this.recoverExhaustedAnswers();
    const answer = await this.claimNextAnswer();

    if (!answer) return false;

    this.trackClaim(answer);
    if (this.stopping || !isTrainingModuleEnabled()) {
      await this.releaseClaim(answer, true);
      this.activeClaims.delete(answer.lock_owner);
      return false;
    }

    try {
      await this.processClaimedAnswer(answer);
    } finally {
      this.activeClaims.delete(answer.lock_owner);
    }
    return true;
  }

  private async pump() {
    if (this.pumping || this.stopping || !isTrainingModuleEnabled()) return false;
    this.pumping = true;
    let foundWork = false;
    try {
      while (
        !this.stopping &&
        isTrainingModuleEnabled() &&
        this.activeTasks.size < getWorkerConcurrency()
      ) {
        const answer = await this.claimNextAnswer();

        if (!answer) break;
        foundWork = true;
        this.trackClaim(answer);
        if (this.stopping || !isTrainingModuleEnabled()) {
          await this.releaseClaim(answer, true);
          this.activeClaims.delete(answer.lock_owner);
          break;
        }
        this.startClaimedTask(answer);
      }
    } finally {
      this.pumping = false;
    }
    return foundWork;
  }

  private startClaimedTask(answer: ClaimedAnswer) {
    const task = this.processClaimedAnswer(answer)
      .catch((error: unknown) => this.handleProcessingFailure(answer, error, 'processing'))
      .then(() => undefined)
      .finally(() => {
        this.activeClaims.delete(answer.lock_owner);
        this.activeTasks.delete(task);
        if (!this.stopping && isTrainingModuleEnabled()) queueMicrotask(() => this.kick());
      });

    this.activeTasks.add(task);
  }

  private trackClaim(answer: ClaimedAnswer) {
    this.activeClaims.set(answer.lock_owner, {
      answerId: answer.id,
      externalStarted: false,
      ownershipLost: false,
    });
  }

  private async claimNextAnswer() {
    if (this.stopping || !isTrainingModuleEnabled()) return null;
    const staleLockMs = getStaleLockMs();
    const concurrency = getWorkerConcurrency();
    const lockOwner = `${this.workerId}-${randomUUID()}`;
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(
          hashtext('platforma'),
          hashtext('training_voice_worker_concurrency')
        ) IS NULL AS "lockAcquired"
      `);

      if (this.stopping || !isTrainingModuleEnabled()) return null;

      const rows = await transaction.$queryRaw<ClaimedAnswer[]>(Prisma.sql`
        WITH capacity AS MATERIALIZED (
          SELECT COUNT(*)::integer AS "activeClaims"
          FROM "training_answers" AS active_answer
          WHERE active_answer."processing_status" = 'processing'
            AND active_answer."processing_locked_by" IS NOT NULL
            AND active_answer."processing_locked_at" >= CURRENT_TIMESTAMP - (${staleLockMs} * INTERVAL '1 millisecond')
        ),
        candidate AS (
          SELECT answer."id"
          FROM "training_answers" AS answer
          JOIN "training_attempt_questions" AS question ON question."id" = answer."attempt_question_id"
          JOIN "training_attempts" AS attempt ON attempt."id" = question."attempt_id"
          CROSS JOIN capacity
          WHERE answer."processing_status" = 'processing'
            AND attempt."status" = 'in_progress'
            AND answer."processing_attempts" < ${MAX_PROCESSING_ATTEMPTS}
            AND capacity."activeClaims" < ${concurrency}
            AND (
              answer."processing_locked_at" IS NULL
              OR answer."processing_locked_at" < CURRENT_TIMESTAMP - (${staleLockMs} * INTERVAL '1 millisecond')
            )
          ORDER BY answer."created_at" ASC, answer."id" ASC
          FOR UPDATE OF answer SKIP LOCKED
          LIMIT 1
        )
        UPDATE "training_answers" AS answer
        SET
          "processing_locked_at" = CURRENT_TIMESTAMP,
          "processing_locked_by" = ${lockOwner},
          "processing_attempts" = "processing_attempts" + 1,
          "processing_error_code" = NULL,
          "updated_at" = CURRENT_TIMESTAMP
        FROM candidate
        WHERE answer."id" = candidate."id"
        RETURNING
          answer."id",
          answer."processing_attempts",
          answer."processing_locked_by" AS "lock_owner"
      `);

      return rows[0] ?? null;
    });
  }

  private async recoverExhaustedAnswers() {
    if (this.stopping || !isTrainingModuleEnabled()) return;
    const staleLockMs = getStaleLockMs();
    const exhausted = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT answer."id"
      FROM "training_answers" AS answer
      JOIN "training_attempt_questions" AS question ON question."id" = answer."attempt_question_id"
      JOIN "training_attempts" AS attempt ON attempt."id" = question."attempt_id"
      WHERE answer."processing_status" = 'processing'
        AND attempt."status" = 'in_progress'
        AND answer."processing_attempts" >= ${MAX_PROCESSING_ATTEMPTS}
        AND (
          answer."processing_locked_at" IS NULL
          OR answer."processing_locked_at" < CURRENT_TIMESTAMP - (${staleLockMs} * INTERVAL '1 millisecond')
        )
      ORDER BY answer."created_at" ASC, answer."id" ASC
      LIMIT ${EXHAUSTED_RECOVERY_BATCH_SIZE}
    `);

    for (const answer of exhausted) {
      const failed = await this.attemptState.failTelegramVoiceAttempt(
        answer.id,
        'PROCESSING_ATTEMPTS_EXHAUSTED',
        'processing',
      );
      if (failed) await this.notifyFailed(answer.id);
    }
  }

  private async processClaimedAnswer(answer: ClaimedAnswer) {
    const context = await this.loadContext(answer.id);

    if (!context) return;
    const timedOut = await this.attemptState.finalizeAttemptIfExpired(
      context.attemptQuestion.attempt.id,
    );

    if (timedOut) {
      await this.notifyProcessed(answer.id);
      return;
    }
    if (!(await this.canContinueClaim(answer))) return;

    const heartbeat = setInterval(
      () => void this.refreshHeartbeat(answer).catch(() => undefined),
      getHeartbeatIntervalMs(),
    );
    let failedStep: 'transcription' | 'evaluation' | 'processing' = 'processing';

    try {
      const snapshot = parseTrainingProjectSnapshot(
        context.attemptQuestion.attempt.projectSnapshotJson,
      );

      if (!isTrainingProjectSnapshotWithFacts(snapshot)) {
        if (!(await this.canContinueClaim(answer))) return;
        const audio = await this.audio.prepareAnswerAudio(answer.id);
        try {
          const result = await this.attemptState.completeTelegramVoiceAnswer(
            answer.id,
            answer.lock_owner,
            '[fake:pass]',
          );
          if (result.status === 'COMPLETED' || result.status === 'TIMED_OUT') {
            await this.notifyProcessed(answer.id);
          }
        } finally {
          await this.cleanupPreparedAudio(audio);
        }
        return;
      }

      const question = resolveSnapshotQuestion(snapshot, context.attemptQuestion.sourceQuestionId);
      let current = context;

      if (current.transcriptionStatus !== TrainingAiStepStatus.COMPLETED) {
        failedStep = 'transcription';
        if (!(await this.canContinueClaim(answer))) return;
        const audio = await this.audio.prepareAnswerAudio(answer.id);
        const transcriptionSignal = await this.beginExternalCall(answer);
        if (!transcriptionSignal) {
          await this.cleanupPreparedAudio(audio);
          return;
        }
        let transcription;
        try {
          transcription = await this.transcriber.transcribe(
            {
              ...audio,
              projectId: current.attemptQuestion.attempt.projectId,
              attemptId: current.attemptQuestion.attempt.id,
              vocabularyPrompt: buildTrainingVocabularyPrompt({
                projectTitle: snapshot.projectTitle,
                relatedObjectTitle: snapshot.relatedObjectTitle,
                facts: question.facts,
              }),
            },
            { signal: transcriptionSignal },
          );
        } finally {
          await this.cleanupPreparedAudio(audio);
        }
        const saved = await this.prisma.trainingAnswer.updateMany({
          where: {
            id: answer.id,
            processingStatus: TrainingAnswerProcessingStatus.PROCESSING,
            processingLockedBy: answer.lock_owner,
            transcriptionStatus: TrainingAiStepStatus.PENDING,
          },
          data: {
            text: transcription.text,
            transcriptionStatus: TrainingAiStepStatus.COMPLETED,
            transcriptionAttempts: { increment: transcription.attempts },
            transcriptionModel: transcription.model,
            transcriptionRequestId: transcription.requestId,
            transcriptionLatencyMs: transcription.latencyMs,
          },
        });

        if (saved.count !== 1) return;
        const reloaded = await this.loadContext(answer.id);
        if (!reloaded) return;
        current = reloaded;
      }

      if (current.evaluationStatus !== TrainingAiStepStatus.COMPLETED) {
        failedStep = 'evaluation';
        if (!current.text) throw new VoiceWorkerError('TRANSCRIPT_CHECKPOINT_MISSING', false);
        const evaluationInput = createEvaluationInput(snapshot, question, current);
        const evaluationSignal = await this.beginExternalCall(answer);
        if (!evaluationSignal) return;
        const result = await this.evaluator.evaluate(
          evaluationInput,
          { signal: evaluationSignal },
        );
        const scoring = scoreTrainingEvaluation(result.evaluation, evaluationInput);
        const saved = await this.prisma.trainingAnswer.updateMany({
          where: {
            id: answer.id,
            processingStatus: TrainingAnswerProcessingStatus.PROCESSING,
            processingLockedBy: answer.lock_owner,
            transcriptionStatus: TrainingAiStepStatus.COMPLETED,
            evaluationStatus: TrainingAiStepStatus.PENDING,
          },
          data: {
            score: scoring.score,
            fakeOutcome: scoring.requiresReview
              ? TrainingFakeOutcome.REQUIRES_REVIEW
              : TrainingFakeOutcome.SCORED,
            safeBreakdownJson: scoring.safeBreakdown,
            evaluationStatus: TrainingAiStepStatus.COMPLETED,
            evaluationAttempts: { increment: result.attempts },
            evaluationModel: result.model,
            evaluationRequestId: result.requestId,
            evaluationLatencyMs: result.latencyMs,
            evaluationSchemaVersion: result.evaluation.schema_version,
            evaluationJson: result.evaluation as unknown as Prisma.InputJsonValue,
            objectiveMetricsJson: evaluationInput.objectiveMetrics as unknown as Prisma.InputJsonValue,
          },
        });

        if (saved.count !== 1) return;
      }

      failedStep = 'processing';
      const progression = await this.attemptState.completeEvaluatedTelegramVoiceAnswer(
        answer.id,
        answer.lock_owner,
      );

      if (progression.status === 'COMPLETED' || progression.status === 'TIMED_OUT') {
        await this.notifyProcessed(answer.id);
      }
    } catch (error) {
      await this.handleProcessingFailure(answer, error, failedStep);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async loadContext(answerId: string) {
    return this.prisma.trainingAnswer.findUnique({
      where: { id: answerId },
      include: {
        segments: { orderBy: { position: 'asc' } },
        attemptQuestion: {
          include: {
            attempt: { select: { id: true, projectId: true, projectSnapshotJson: true } },
          },
        },
      },
    });
  }

  private async isStillClaimed(answerId: string, lockOwner: string) {
    if (this.activeClaims.get(lockOwner)?.ownershipLost) return false;

    return Boolean(await this.prisma.trainingAnswer.findFirst({
      where: {
        id: answerId,
        processingStatus: TrainingAnswerProcessingStatus.PROCESSING,
        processingLockedBy: lockOwner,
      },
      select: { id: true },
    }));
  }

  private async refreshHeartbeat(answer: ClaimedAnswer) {
    const updated = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "training_answers"
      SET "processing_locked_at" = CURRENT_TIMESTAMP, "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = CAST(${answer.id} AS uuid)
        AND "processing_status" = 'processing'
        AND "processing_locked_by" = ${answer.lock_owner}
    `);

    if (updated !== 1) {
      const active = this.activeClaims.get(answer.lock_owner);
      if (active) active.ownershipLost = true;
    }
  }

  private async handleProcessingFailure(
    answer: ClaimedAnswer,
    error: unknown,
    failedStep: 'transcription' | 'evaluation' | 'processing',
  ) {
    if (
      this.stopping &&
      error instanceof TrainingOpenAIError &&
      error.code === 'OPENAI_ABORTED'
    ) {
      await this.releaseClaim(answer, false);
      return;
    }

    const openAiEvaluationError =
      failedStep === 'evaluation' && error instanceof TrainingOpenAIError
        ? error
        : null;
    const retryable = openAiEvaluationError
      ? openAiEvaluationError.retryable
      : isRetryableWorkerError(error);
    const maximumAttempts = openAiEvaluationError
      ? MAX_OPENAI_EVALUATION_WORKER_ATTEMPTS
      : MAX_PROCESSING_ATTEMPTS;
    const exhausted = answer.processing_attempts >= maximumAttempts;

    if (retryable && !exhausted) {
      this.logger.warn({
        event: 'training_voice_processing_retry',
        step: failedStep,
        code: getWorkerErrorCode(error),
        processingAttempt: answer.processing_attempts,
      });
      await this.prisma.trainingAnswer.updateMany({
        where: {
          id: answer.id,
          processingStatus: TrainingAnswerProcessingStatus.PROCESSING,
          processingLockedBy: answer.lock_owner,
        },
        data: {
          processingLockedAt: null,
          processingLockedBy: null,
          processingErrorCode: null,
          ...(openAiEvaluationError && openAiEvaluationError.attempts > 0
            ? { evaluationAttempts: { increment: openAiEvaluationError.attempts } }
            : {}),
        },
      });
      return;
    }

    const failed = await this.attemptState.failTelegramVoiceAttempt(
      answer.id,
      getWorkerErrorCode(error),
      failedStep,
      answer.lock_owner,
      error instanceof TrainingOpenAIError ? error.attempts : 0,
    );
    if (failed) await this.notifyFailed(answer.id);
  }

  private async notifyProcessed(answerId: string) {
    if (this.stopping || !isTrainingModuleEnabled()) return;
    try {
      await this.telegramOutbox.notifyAnswerProcessed(answerId);
    } catch (error) {
      this.logTelegramDeliveryFailure('answerProcessed', error);
    }
  }

  private async notifyFailed(answerId: string) {
    if (this.stopping || !isTrainingModuleEnabled()) return;
    try {
      await this.telegramOutbox.notifyAnswerFailed(answerId);
    } catch (error) {
      this.logTelegramDeliveryFailure('answerFailed', error);
    }
  }

  private async cleanupPreparedAudio(audio: { cleanup?: () => Promise<void> }) {
    if (!audio.cleanup) return;
    try {
      await audio.cleanup();
    } catch {
      this.logger.warn({ event: 'training_audio_temp_cleanup_failed' });
    }
  }

  private logTelegramDeliveryFailure(operation: string, error: unknown) {
    this.logger.warn({
      event: 'training_telegram_delivery_failed',
      operation,
      code: error instanceof TrainingTelegramClientError ? error.code : 'UNEXPECTED_ERROR',
      retryable: error instanceof TrainingTelegramClientError && error.retryable,
    });
  }

  private async canContinueClaim(answer: ClaimedAnswer) {
    if (!isTrainingModuleEnabled()) {
      await this.releaseClaim(answer, !this.hasStartedExternal(answer));
      return false;
    }
    if (this.stopping) {
      await this.releaseClaim(answer, !this.hasStartedExternal(answer));
      return false;
    }
    if (!(await this.isStillClaimed(answer.id, answer.lock_owner))) return false;
    return true;
  }

  private async beginExternalCall(answer: ClaimedAnswer) {
    if (!(await this.canContinueClaim(answer))) return null;
    if (this.externalAbortController.signal.aborted) {
      await this.releaseClaim(answer, !this.hasStartedExternal(answer));
      return null;
    }

    const active = this.activeClaims.get(answer.lock_owner);
    if (active) active.externalStarted = true;
    return this.externalAbortController.signal;
  }

  private hasStartedExternal(answer: ClaimedAnswer) {
    return this.activeClaims.get(answer.lock_owner)?.externalStarted ?? true;
  }

  private async releaseClaim(answer: ClaimedAnswer, rollbackAttempt: boolean) {
    if (rollbackAttempt) {
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "training_answers"
        SET
          "processing_locked_at" = NULL,
          "processing_locked_by" = NULL,
          "processing_attempts" = GREATEST("processing_attempts" - 1, 0),
          "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = CAST(${answer.id} AS uuid)
          AND "processing_status" = 'processing'
          AND "processing_locked_by" = ${answer.lock_owner}
      `);
      return;
    }

    await this.prisma.trainingAnswer.updateMany({
      where: {
        id: answer.id,
        processingStatus: TrainingAnswerProcessingStatus.PROCESSING,
        processingLockedBy: answer.lock_owner,
      },
      data: { processingLockedAt: null, processingLockedBy: null },
    });
  }

  private async releaseActiveClaimsForRestart() {
    await Promise.all(
      [...this.activeClaims.entries()].map(([lockOwner, active]) =>
        this.releaseClaim(
          { id: active.answerId, processing_attempts: 0, lock_owner: lockOwner },
          !active.externalStarted,
        ),
      ),
    );
  }
}

type WorkerContext = {
  text: string | null;
  segments: Array<{ durationSeconds: number }>;
  attemptQuestion: {
    maxScore: number;
    attempt: { id: string; projectId: string };
  };
};

type TrainingSnapshotWithFacts = TrainingProjectSnapshotV2 | TrainingProjectSnapshotV3;

function resolveSnapshotQuestion(snapshot: TrainingSnapshotWithFacts, sourceQuestionId: string | null) {
  const question = snapshot.questions.find((item) => item.sourceQuestionId === sourceQuestionId);

  if (!question) throw new VoiceWorkerError('SNAPSHOT_QUESTION_MISSING', false);
  return question;
}

function createEvaluationInput(
  snapshot: TrainingSnapshotWithFacts,
  question: TrainingProjectSnapshotV2['questions'][number],
  answer: WorkerContext,
): TrainingEvaluationInput {
  if (!answer.text) throw new VoiceWorkerError('TRANSCRIPT_CHECKPOINT_MISSING', false);
  const criteria = question.type === 'MAIN' ? snapshot.criteria.main : snapshot.criteria.followUp;

  return {
    projectId: answer.attemptQuestion.attempt.projectId,
    attemptId: answer.attemptQuestion.attempt.id,
    questionId: question.sourceQuestionId,
    projectKnowledgeVersion: snapshot.projectKnowledgeVersion,
    questionText: question.text,
    questionType: question.type,
    transcript: answer.text,
    facts: question.facts,
    criteria,
    objectiveMetrics: calculateTrainingObjectiveMetrics({
      transcript: answer.text,
      audioDurationSeconds: answer.segments.reduce(
        (total, segment) => total + segment.durationSeconds,
        0,
      ),
      segmentCount: answer.segments.length,
    }),
    maxScore: answer.attemptQuestion.maxScore,
    evaluationSchemaVersion: snapshot.evaluationSchemaVersion,
    harmlessExtraRoutingEnabled: isTrainingHarmlessExtraRoutingEnabled(),
  };
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
  if (error instanceof TrainingOpenAIError) return false;
  if (error instanceof VoiceWorkerError) return error.retryable;
  return isRetryableTrainingAudioError(error);
}

function getWorkerErrorCode(error: unknown) {
  if (error instanceof TrainingOpenAIError) {
    return [error.code, error.detailCode].filter(Boolean).join('_').slice(0, 64);
  }
  if (error instanceof VoiceWorkerError) return error.code;
  return getTrainingAudioErrorCode(error).slice(0, 64);
}

function isWorkerEnabled() {
  const explicit = process.env.TRAINING_VOICE_WORKER_ENABLED;

  if (explicit !== undefined) return explicit === 'true';
  return process.env.NODE_ENV !== 'test';
}

function getWorkerConcurrency() {
  return readBoundedInteger(
    process.env.TRAINING_VOICE_WORKER_CONCURRENCY,
    DEFAULT_CONCURRENCY,
    1,
    10,
  );
}

function getShutdownDrainMs() {
  return readBoundedInteger(
    process.env.TRAINING_VOICE_WORKER_SHUTDOWN_DRAIN_MS,
    DEFAULT_SHUTDOWN_DRAIN_MS,
    250,
    60_000,
  );
}

function getPollIntervalMs() {
  return readBoundedInteger(
    process.env.TRAINING_VOICE_WORKER_POLL_INTERVAL_MS,
    DEFAULT_POLL_INTERVAL_MS,
    250,
    60_000,
  );
}

export function createTrainingVoiceWorkerIdlePollDelays(minimumMs: number) {
  if (!Number.isInteger(minimumMs) || minimumMs < 1) {
    throw new RangeError('TRAINING_VOICE_WORKER_POLL_INTERVAL_INVALID');
  }

  return IDLE_POLL_BACKOFF_MULTIPLIERS.map((multiplier) =>
    Math.round(minimumMs * multiplier),
  );
}

function getIdlePollDelaysMs() {
  return createTrainingVoiceWorkerIdlePollDelays(getPollIntervalMs());
}

function getRecoverySweepIntervalMs() {
  return Math.max(DEFAULT_RECOVERY_SWEEP_INTERVAL_MS, getPollIntervalMs());
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

async function settlesBefore(promise: Promise<unknown>, deadline: number) {
  const observed = promise.then(
    () => true,
    () => true,
  );
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return false;

  let timeout: ReturnType<typeof setTimeout> | null = null;
  const settled = await Promise.race([
    observed,
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), remainingMs);
    }),
  ]);

  if (timeout) clearTimeout(timeout);
  return settled;
}
