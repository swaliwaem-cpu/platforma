import { randomUUID } from 'node:crypto';

import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
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
import { TrainingTelegramService } from './training-telegram.service';
import {
  buildTrainingVocabularyPrompt,
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
    @Inject(TRAINING_EVALUATOR) private readonly evaluator: TrainingEvaluator,
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
        SELECT answer."id"
        FROM "training_answers" AS answer
        JOIN "training_attempt_questions" AS question ON question."id" = answer."attempt_question_id"
        JOIN "training_attempts" AS attempt ON attempt."id" = question."attempt_id"
        WHERE answer."processing_status" = 'processing'
          AND attempt."status" = 'in_progress'
          AND answer."processing_attempts" < ${MAX_PROCESSING_ATTEMPTS}
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
    if (!(await this.isStillClaimed(answer.id))) return;

    const heartbeat = setInterval(
      () => void this.refreshHeartbeat(answer.id).catch(() => undefined),
      getHeartbeatIntervalMs(),
    );
    let failedStep: 'transcription' | 'evaluation' | 'processing' = 'processing';

    try {
      const snapshot = parseTrainingProjectSnapshot(
        context.attemptQuestion.attempt.projectSnapshotJson,
      );

      if (!isTrainingProjectSnapshotWithFacts(snapshot)) {
        await this.audio.prepareAnswerAudio(answer.id);
        const result = await this.attemptState.completeTelegramVoiceAnswer(
          answer.id,
          this.workerId,
          '[fake:pass]',
        );
        if (result.status === 'COMPLETED' || result.status === 'TIMED_OUT') {
          await this.notifyProcessed(answer.id);
        }
        return;
      }

      const question = resolveSnapshotQuestion(snapshot, context.attemptQuestion.sourceQuestionId);
      let current = context;

      if (current.transcriptionStatus !== TrainingAiStepStatus.COMPLETED) {
        failedStep = 'transcription';
        const audio = await this.audio.prepareAnswerAudio(answer.id);
        const transcription = await this.transcriber.transcribe({
          ...audio,
          vocabularyPrompt: buildTrainingVocabularyPrompt({
            projectTitle: snapshot.projectTitle,
            relatedObjectTitle: snapshot.relatedObjectTitle,
            facts: question.facts,
          }),
        });
        const saved = await this.prisma.trainingAnswer.updateMany({
          where: {
            id: answer.id,
            processingStatus: TrainingAnswerProcessingStatus.PROCESSING,
            processingLockedBy: this.workerId,
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
        const result = await this.evaluator.evaluate(evaluationInput);
        const scoring = scoreTrainingEvaluation(result.evaluation, evaluationInput);
        const saved = await this.prisma.trainingAnswer.updateMany({
          where: {
            id: answer.id,
            processingStatus: TrainingAnswerProcessingStatus.PROCESSING,
            processingLockedBy: this.workerId,
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
        this.workerId,
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
            attempt: { select: { id: true, projectSnapshotJson: true } },
          },
        },
      },
    });
  }

  private async isStillClaimed(answerId: string) {
    return Boolean(await this.prisma.trainingAnswer.findFirst({
      where: {
        id: answerId,
        processingStatus: TrainingAnswerProcessingStatus.PROCESSING,
        processingLockedBy: this.workerId,
      },
      select: { id: true },
    }));
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

  private async handleProcessingFailure(
    answer: ClaimedAnswer,
    error: unknown,
    failedStep: 'transcription' | 'evaluation' | 'processing',
  ) {
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

    const failed = await this.attemptState.failTelegramVoiceAttempt(
      answer.id,
      getWorkerErrorCode(error),
      failedStep,
      this.workerId,
      error instanceof TrainingOpenAIError ? error.attempts : 0,
    );
    if (failed) await this.notifyFailed(answer.id);
  }

  private async notifyProcessed(answerId: string) {
    try {
      await this.telegram.notifyAnswerProcessed(answerId);
    } catch {
      // Domain state is committed; /start restores it if delivery fails.
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

type WorkerContext = {
  text: string | null;
  segments: Array<{ durationSeconds: number }>;
  attemptQuestion: { maxScore: number };
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
  if (error instanceof TrainingOpenAIError || error instanceof VoiceWorkerError) return error.code;
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
