import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  TrainingAiStepStatus,
  TrainingAnswerProcessingStatus,
  TrainingAnswerSource,
  TrainingAttemptCompletionReason,
  TrainingAttemptQuestionStatus,
  TrainingAttemptStatus,
  TrainingFakeOutcome,
  TrainingQuestionType,
  TrainingReviewStatus,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  clampTrainingTotalScore,
  evaluateLegacyTrainingText,
  TRAINING_FOLLOW_UP_MAX_SCORE,
  TRAINING_EVALUATOR,
  TRAINING_MAIN_MAX_SCORE,
  TrainingEvaluator,
} from './training-evaluator';
import { TrainingFollowUpSelector } from './training-follow-up-selector';
import { TrainingProjectAccessService } from './training-project-access.service';
import {
  hasTrainingSnapshotQuestionStructure,
  parseTrainingProjectSnapshot,
  TRAINING_EVALUATION_SCHEMA_VERSION,
  TRAINING_LEGACY_SNAPSHOT_SCHEMA_VERSION,
  TRAINING_SCORING_VERSION,
  TRAINING_STAGE3_SNAPSHOT_SCHEMA_VERSION,
  TRAINING_SNAPSHOT_SCHEMA_VERSION,
  TrainingProjectSnapshot,
  TrainingProjectSnapshotV2,
  TrainingProjectSnapshotV3,
} from './training-snapshot';

export type StartTrainingAttemptInput = {
  confirmed: true;
  idempotencyKey: string;
};

export type SubmitTrainingAnswerInput = {
  attemptQuestionId: string;
  text: string;
};

export type AddTrainingVoiceSegmentInput = {
  telegramMessageId: bigint;
  telegramFileId: string;
  telegramFileUniqueId: string;
  durationSeconds: number;
  sizeBytes: bigint | null;
};

export type AddTrainingVoiceSegmentResult =
  | { status: 'ADDED' | 'DUPLICATE'; attemptQuestionId: string; position: number }
  | { status: 'PROCESSING' | 'FAILED' | 'NO_CURRENT_QUESTION' | 'TIMED_OUT' };

export type FinishTrainingVoiceAnswerResult =
  | { status: 'PROCESSING' | 'FAILED'; answerId: string }
  | { status: 'STALE' | 'NO_SEGMENTS' | 'TIMED_OUT' };

export const TRAINING_RETAKE_DELAY_MINUTES = 60;

const TRAINING_MAX_VOICE_SEGMENTS = 20;
const TRAINING_MAX_VOICE_SEGMENT_BYTES = 20 * 1024 * 1024;
const TRAINING_MAX_VOICE_TOTAL_BYTES = 60 * 1024 * 1024;
const TRAINING_RETAKE_DELAY_MS = TRAINING_RETAKE_DELAY_MINUTES * 60 * 1000;

@Injectable()
export class TrainingAttemptStateService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(TRAINING_EVALUATOR) private readonly evaluator: TrainingEvaluator,
    private readonly followUpSelector: TrainingFollowUpSelector,
    private readonly projectAccess: TrainingProjectAccessService,
  ) {}

  async startAttempt(projectId: string, userId: string, input: StartTrainingAttemptInput) {
    return this.prisma.$transaction((transaction) =>
      this.startAttemptInTransaction(transaction, projectId, userId, input),
    );
  }

  async startAttemptFromTelegramLinkToken(tokenId: string, userId: string) {
    return this.prisma.$transaction(async (transaction) => {
      const tokenSnapshot = await transaction.trainingTelegramLinkToken.findFirst({
        where: { id: tokenId, userId },
        select: { projectId: true },
      });

      if (!tokenSnapshot) {
        throw new NotFoundException('Training Telegram link not found');
      }

      await this.lockUser(transaction, userId);
      await this.lockProject(transaction, tokenSnapshot.projectId);
      await transaction.$queryRaw(
        Prisma.sql`SELECT "id" FROM "training_telegram_link_tokens" WHERE "id" = CAST(${tokenId} AS uuid) FOR UPDATE`,
      );
      const token = await transaction.trainingTelegramLinkToken.findFirst({
        where: { id: tokenId, userId },
      });

      if (
        !token ||
        token.projectId !== tokenSnapshot.projectId ||
        token.usedAt === null
      ) {
        throw new NotFoundException('Training Telegram link not found');
      }

      if (token.revokedAt !== null) {
        await this.projectAccess.assertParticipant(userId, transaction);
        const existingAttempt = await transaction.trainingAttempt.findFirst({
          where: {
            userId,
            projectId: token.projectId,
            OR: [
              { startIdempotencyKey: token.id },
              { status: TrainingAttemptStatus.IN_PROGRESS },
            ],
          },
          orderBy: { startedAt: 'desc' },
          select: { id: true },
        });

        return existingAttempt?.id ?? null;
      }

      const attemptId = await this.startAttemptAfterLocks(
        transaction,
        token.projectId,
        userId,
        { confirmed: true, idempotencyKey: token.id },
      );
      await transaction.trainingTelegramLinkToken.update({
        where: { id: token.id },
        data: {
          revokedAt: await this.getDatabaseNow(transaction),
        },
      });

      return attemptId;
    });
  }

  private async startAttemptInTransaction(
    transaction: Prisma.TransactionClient,
    projectId: string,
    userId: string,
    input: StartTrainingAttemptInput,
  ) {
      await this.lockUser(transaction, userId);
      await this.lockProject(transaction, projectId);
      return this.startAttemptAfterLocks(transaction, projectId, userId, input);
  }

  private async startAttemptAfterLocks(
    transaction: Prisma.TransactionClient,
    projectId: string,
    userId: string,
    input: StartTrainingAttemptInput,
  ) {
      const now = await this.getDatabaseNow(transaction);
      const project = await transaction.trainingProject.findUnique({
        where: { id: projectId },
        include: {
          realEstateObject: { select: { title: true } },
          questions: {
            where: { isActive: true },
            include: {
              facts: {
                where: { isActive: true },
                include: {
                  sourceRevision: { include: { material: true } },
                },
                orderBy: [{ position: 'asc' }, { id: 'asc' }],
              },
            },
            orderBy: [{ type: 'asc' }, { position: 'asc' }],
          },
          criteria: {
            where: { isActive: true },
            orderBy: [{ questionType: 'asc' }, { position: 'asc' }, { id: 'asc' }],
          },
        },
      });

      if (!project) {
        throw new NotFoundException('Training project not found');
      }

      await this.projectAccess.assertParticipant(userId, transaction);

      const idempotentAttempt = await transaction.trainingAttempt.findUnique({
        where: {
          userId_projectId_startIdempotencyKey: {
            userId,
            projectId,
            startIdempotencyKey: input.idempotencyKey,
          },
        },
      });

      if (idempotentAttempt) {
        await this.lockAttempt(transaction, idempotentAttempt.id, userId);
        await this.finalizeTimeoutIfNeeded(transaction, idempotentAttempt.id, now);
        return idempotentAttempt.id;
      }

      const activeAttempt = await transaction.trainingAttempt.findFirst({
        where: { userId, projectId, status: TrainingAttemptStatus.IN_PROGRESS },
        orderBy: { startedAt: 'desc' },
      });

      if (activeAttempt) {
        await this.lockAttempt(transaction, activeAttempt.id, userId);
        const currentAttempt = await transaction.trainingAttempt.findUnique({
          where: { id: activeAttempt.id },
          select: { status: true },
        });

        if (currentAttempt?.status === TrainingAttemptStatus.IN_PROGRESS) {
          const timedOut = await this.finalizeTimeoutIfNeeded(transaction, activeAttempt.id, now);

          if (!timedOut) return activeAttempt.id;
        }
      }

      await this.projectAccess.assertNewAttemptAccess(projectId, userId, transaction);

      const attemptsUsed = await transaction.trainingAttempt.count({
        where: { userId, projectId, countsTowardAttemptLimit: true },
      });

      if (attemptsUsed >= project.attemptLimit) {
        throw new ConflictException('Training attempt limit reached');
      }

      const resolvedAttempts = await transaction.trainingAttempt.findMany({
        where: {
          userId,
          projectId,
          status: TrainingAttemptStatus.COMPLETED,
          isPassed: { not: null },
        },
        select: {
          status: true,
          completedAt: true,
          reviewedAt: true,
          isPassed: true,
        },
      });

      if (isTrainingRetakeDelayActive(resolvedAttempts, now)) {
        throw new ConflictException('Training retake delay is active');
      }

      if (!project.allowRetakeAfterPass) {
        const passedAttempt = await transaction.trainingAttempt.findFirst({
          where: {
            userId,
            projectId,
            status: TrainingAttemptStatus.COMPLETED,
            isPassed: true,
          },
          select: { id: true },
        });

        if (passedAttempt) {
          throw new ConflictException('Training project has already been passed');
        }
      }

      const snapshot = this.createSnapshot(project);
      const mainQuestion = snapshot.questions.find(
        (question) => question.type === TrainingQuestionType.MAIN,
      );

      if (!mainQuestion) {
        throw new BadRequestException('Training project has no main question');
      }

      const lastAttempt = await transaction.trainingAttempt.findFirst({
        where: { userId, projectId },
        orderBy: { attemptNumber: 'desc' },
        select: { attemptNumber: true },
      });
      const expiresAt = new Date(now.getTime() + project.timeLimitSeconds * 1000);
      const attempt = await transaction.trainingAttempt.create({
        data: {
          userId,
          projectId,
          attemptNumber: (lastAttempt?.attemptNumber ?? 0) + 1,
          startIdempotencyKey: input.idempotencyKey,
          startedAt: now,
          expiresAt,
          projectSnapshotJson: snapshot as unknown as Prisma.InputJsonValue,
          fakeEvaluationVersion: this.evaluator.version,
        },
        select: { id: true },
      });

      await transaction.trainingAttemptQuestion.create({
        data: {
          attemptId: attempt.id,
          sourceQuestionId: mainQuestion.sourceQuestionId,
          sequence: 1,
          type: TrainingQuestionType.MAIN,
          questionTextSnapshot: mainQuestion.text,
          maxScore: TRAINING_MAIN_MAX_SCORE,
          presentedAt: now,
        },
      });

      return attempt.id;
  }

  async submitAnswer(attemptId: string, userId: string, input: SubmitTrainingAnswerInput) {
    const submittedAttemptId = await this.prisma.$transaction(async (transaction) => {
      const locked = await this.lockAttempt(transaction, attemptId, userId);

      if (!locked) {
        throw new NotFoundException('Training attempt not found');
      }

      const now = await this.getDatabaseNow(transaction);
      const attempt = await transaction.trainingAttempt.findUniqueOrThrow({
        where: { id: attemptId },
        include: {
          questions: {
            include: { answer: true },
            orderBy: { sequence: 'asc' },
          },
        },
      });

      if (attempt.status !== TrainingAttemptStatus.IN_PROGRESS) {
        throw new ConflictException('Training attempt is already finalized');
      }

      if (await this.finalizeTimeoutIfNeeded(transaction, attempt.id, now)) {
        return null;
      }

      const currentQuestion = attempt.questions.find(
        (question) =>
          question.status === TrainingAttemptQuestionStatus.PRESENTED && !question.answer,
      );

      if (!currentQuestion || currentQuestion.id !== input.attemptQuestionId) {
        throw new NotFoundException('Current training question not found');
      }

      if (currentQuestion.answer) {
        throw new ConflictException('Current training answer is already in progress');
      }

      await this.completeAnswerFromText(
        transaction,
        attempt,
        currentQuestion,
        input.text,
        now,
      );
      return attempt.id;
    });

    if (!submittedAttemptId) throw new ConflictException('Training attempt time has expired');

    return submittedAttemptId;
  }

  async addTelegramVoiceSegment(
    attemptId: string,
    userId: string,
    input: AddTrainingVoiceSegmentInput,
  ): Promise<AddTrainingVoiceSegmentResult> {
    return this.prisma.$transaction(async (transaction) => {
      const locked = await this.lockAttempt(transaction, attemptId, userId);

      if (!locked) {
        throw new NotFoundException('Training attempt not found');
      }

      const now = await this.getDatabaseNow(transaction);

      if (await this.finalizeTimeoutIfNeeded(transaction, attemptId, now)) {
        return { status: 'TIMED_OUT' };
      }

      const currentQuestion = await transaction.trainingAttemptQuestion.findFirst({
        where: {
          attemptId,
          status: TrainingAttemptQuestionStatus.PRESENTED,
        },
        include: {
          answer: {
            include: {
              segments: { orderBy: { position: 'asc' } },
            },
          },
        },
        orderBy: { sequence: 'asc' },
      });

      if (!currentQuestion) {
        return { status: 'NO_CURRENT_QUESTION' };
      }

      let answer = currentQuestion.answer;

      if (!answer) {
        answer = await transaction.trainingAnswer.create({
          data: {
            attemptQuestionId: currentQuestion.id,
            source: TrainingAnswerSource.TELEGRAM,
            processingStatus: TrainingAnswerProcessingStatus.COLLECTING,
          },
          include: { segments: true },
        });
      }

      if (
        answer.source !== TrainingAnswerSource.TELEGRAM ||
        answer.processingStatus === TrainingAnswerProcessingStatus.COMPLETED
      ) {
        return { status: 'NO_CURRENT_QUESTION' };
      }

      if (answer.processingStatus === TrainingAnswerProcessingStatus.PROCESSING) {
        return { status: 'PROCESSING' };
      }

      if (answer.processingStatus === TrainingAnswerProcessingStatus.FAILED) {
        return { status: 'FAILED' };
      }

      const duplicate = answer.segments.find(
        (segment) =>
          segment.telegramMessageId === input.telegramMessageId ||
          segment.telegramFileUniqueId === input.telegramFileUniqueId,
      );

      if (duplicate) {
        return {
          status: 'DUPLICATE',
          attemptQuestionId: currentQuestion.id,
          position: duplicate.position,
        };
      }

      const declaredSize = Number(input.sizeBytes ?? 0n);
      const declaredTotal = answer.segments.reduce(
        (total, segment) => total + Number(segment.sizeBytes ?? 0n),
        declaredSize,
      );

      if (
        answer.segments.length >= TRAINING_MAX_VOICE_SEGMENTS ||
        declaredSize > TRAINING_MAX_VOICE_SEGMENT_BYTES ||
        declaredTotal > TRAINING_MAX_VOICE_TOTAL_BYTES
      ) {
        throw new BadRequestException('Training voice answer exceeds the allowed size');
      }

      const position = answer.segments.length + 1;
      await transaction.trainingAnswerSegment.create({
        data: {
          answerId: answer.id,
          position,
          telegramMessageId: input.telegramMessageId,
          telegramFileId: input.telegramFileId,
          telegramFileUniqueId: input.telegramFileUniqueId,
          durationSeconds: input.durationSeconds,
          sizeBytes: input.sizeBytes,
        },
      });

      return { status: 'ADDED', attemptQuestionId: currentQuestion.id, position };
    });
  }

  async finishTelegramVoiceAnswer(
    attemptId: string,
    userId: string,
    attemptQuestionId: string,
  ): Promise<FinishTrainingVoiceAnswerResult> {
    return this.prisma.$transaction(async (transaction) => {
      const locked = await this.lockAttempt(transaction, attemptId, userId);

      if (!locked) {
        throw new NotFoundException('Training attempt not found');
      }

      const now = await this.getDatabaseNow(transaction);

      if (await this.finalizeTimeoutIfNeeded(transaction, attemptId, now)) {
        return { status: 'TIMED_OUT' };
      }

      const currentQuestion = await transaction.trainingAttemptQuestion.findFirst({
        where: {
          attemptId,
          status: TrainingAttemptQuestionStatus.PRESENTED,
        },
        include: {
          answer: {
            include: { _count: { select: { segments: true } } },
          },
        },
        orderBy: { sequence: 'asc' },
      });

      if (!currentQuestion || currentQuestion.id !== attemptQuestionId) {
        return { status: 'STALE' };
      }

      const answer = currentQuestion.answer;

      if (!answer || answer._count.segments === 0) {
        return { status: 'NO_SEGMENTS' };
      }

      if (answer.processingStatus === TrainingAnswerProcessingStatus.FAILED) {
        return { status: 'FAILED', answerId: answer.id };
      }

      if (answer.processingStatus === TrainingAnswerProcessingStatus.PROCESSING) {
        return { status: 'PROCESSING', answerId: answer.id };
      }

      if (answer.processingStatus !== TrainingAnswerProcessingStatus.COLLECTING) {
        return { status: 'STALE' };
      }

      await transaction.trainingAnswer.update({
        where: { id: answer.id },
        data: {
          processingStatus: TrainingAnswerProcessingStatus.PROCESSING,
          submittedAt: now,
          processingLockedAt: null,
          processingLockedBy: null,
          processingErrorCode: null,
        },
      });

      return { status: 'PROCESSING', answerId: answer.id };
    });
  }

  async completeTelegramVoiceAnswer(answerId: string, workerId: string, text: string) {
    const answerRef = await this.prisma.trainingAnswer.findUnique({
      where: { id: answerId },
      select: { attemptQuestion: { select: { attemptId: true } } },
    });

    if (!answerRef) return { status: 'STALE' as const, attemptId: null };

    return this.prisma.$transaction(async (transaction) => {
      const attemptId = answerRef.attemptQuestion.attemptId;
      const locked = await this.lockAttempt(transaction, attemptId);

      if (!locked) return { status: 'STALE' as const, attemptId: null };

      const now = await this.getDatabaseNow(transaction);

      if (await this.finalizeTimeoutIfNeeded(transaction, attemptId, now)) {
        return {
          status: 'TIMED_OUT' as const,
          attemptId,
          attemptStatus: TrainingAttemptStatus.TIMED_OUT,
        };
      }

      const attempt = await transaction.trainingAttempt.findUniqueOrThrow({
        where: { id: attemptId },
        include: {
          questions: {
            include: { answer: true },
            orderBy: { sequence: 'asc' },
          },
        },
      });
      const currentQuestion = attempt.questions.find(
        (question) => question.status === TrainingAttemptQuestionStatus.PRESENTED,
      );
      const answer = currentQuestion?.answer;

      if (
        !currentQuestion ||
        !answer ||
        answer.id !== answerId ||
        answer.source !== TrainingAnswerSource.TELEGRAM ||
        answer.processingStatus !== TrainingAnswerProcessingStatus.PROCESSING ||
        answer.processingLockedBy !== workerId ||
        answer.mergedAudioFileId === null
      ) {
        return { status: 'STALE' as const, attemptId };
      }

      await this.completeAnswerFromText(
        transaction,
        attempt,
        currentQuestion,
        text,
        now,
        answer.id,
      );

      const progressedAttempt = await transaction.trainingAttempt.findUniqueOrThrow({
        where: { id: attemptId },
        select: { status: true },
      });

      return {
        status: 'COMPLETED' as const,
        attemptId,
        attemptStatus: progressedAttempt.status,
      };
    });
  }

  async completeEvaluatedTelegramVoiceAnswer(answerId: string, workerId: string) {
    const answerRef = await this.prisma.trainingAnswer.findUnique({
      where: { id: answerId },
      select: { attemptQuestion: { select: { attemptId: true } } },
    });

    if (!answerRef) return { status: 'STALE' as const, attemptId: null };

    return this.prisma.$transaction(async (transaction) => {
      const attemptId = answerRef.attemptQuestion.attemptId;
      const locked = await this.lockAttempt(transaction, attemptId);

      if (!locked) return { status: 'STALE' as const, attemptId: null };
      const now = await this.getDatabaseNow(transaction);

      if (await this.finalizeTimeoutIfNeeded(transaction, attemptId, now)) {
        return {
          status: 'TIMED_OUT' as const,
          attemptId,
          attemptStatus: TrainingAttemptStatus.TIMED_OUT,
        };
      }

      const attempt = await transaction.trainingAttempt.findUniqueOrThrow({
        where: { id: attemptId },
        include: {
          questions: {
            include: { answer: true },
            orderBy: { sequence: 'asc' },
          },
        },
      });
      const currentQuestion = attempt.questions.find(
        (question) => question.status === TrainingAttemptQuestionStatus.PRESENTED,
      );
      const answer = currentQuestion?.answer;

      if (
        !currentQuestion ||
        !answer ||
        answer.id !== answerId ||
        answer.source !== TrainingAnswerSource.TELEGRAM ||
        answer.processingStatus !== TrainingAnswerProcessingStatus.PROCESSING ||
        answer.processingLockedBy !== workerId ||
        answer.transcriptionStatus !== TrainingAiStepStatus.COMPLETED ||
        answer.evaluationStatus !== TrainingAiStepStatus.COMPLETED ||
        answer.text === null ||
        answer.score === null ||
        answer.mergedAudioFileId === null ||
        answer.safeBreakdownJson === null ||
        answer.fakeOutcome === null ||
        answer.evaluationJson === null
      ) {
        return { status: 'STALE' as const, attemptId };
      }

      await transaction.trainingAnswer.update({
        where: { id: answer.id },
        data: {
          processingStatus: TrainingAnswerProcessingStatus.COMPLETED,
          processingLockedAt: null,
          processingLockedBy: null,
          processingErrorCode: null,
        },
      });
      await transaction.trainingAttemptQuestion.update({
        where: { id: currentQuestion.id },
        data: { status: TrainingAttemptQuestionStatus.ANSWERED, answeredAt: now },
      });

      if (currentQuestion.sequence === 1) {
        await this.createFollowUpQuestions(transaction, attempt, now);
      }

      await this.completeIfReady(transaction, attempt.id, now);
      const progressedAttempt = await transaction.trainingAttempt.findUniqueOrThrow({
        where: { id: attemptId },
        select: { status: true },
      });

      return {
        status: 'COMPLETED' as const,
        attemptId,
        attemptStatus: progressedAttempt.status,
      };
    });
  }

  async failTelegramVoiceAttempt(
    answerId: string,
    errorCode: string,
    failedStep: 'transcription' | 'evaluation' | 'processing',
    workerId?: string,
    providerAttempts = 0,
  ) {
    const answerRef = await this.prisma.trainingAnswer.findUnique({
      where: { id: answerId },
      select: { attemptQuestion: { select: { attemptId: true } } },
    });

    if (!answerRef) return false;

    return this.prisma.$transaction(async (transaction) => {
      const attemptId = answerRef.attemptQuestion.attemptId;
      const locked = await this.lockAttempt(transaction, attemptId);

      if (!locked) return false;
      const attempt = await transaction.trainingAttempt.findUnique({
        where: { id: attemptId },
        select: { status: true },
      });

      if (!attempt || attempt.status !== TrainingAttemptStatus.IN_PROGRESS) return false;
      const now = await this.getDatabaseNow(transaction);
      const failed = await transaction.trainingAnswer.updateMany({
        where: {
          id: answerId,
          processingStatus: TrainingAnswerProcessingStatus.PROCESSING,
          ...(workerId ? { processingLockedBy: workerId } : {}),
        },
        data: {
          processingStatus: TrainingAnswerProcessingStatus.FAILED,
          processingLockedAt: null,
          processingLockedBy: null,
          processingErrorCode: errorCode.slice(0, 64),
          ...(failedStep === 'transcription'
            ? {
                transcriptionStatus: TrainingAiStepStatus.FAILED,
                transcriptionAttempts: { increment: providerAttempts },
              }
            : failedStep === 'evaluation'
              ? {
                  evaluationStatus: TrainingAiStepStatus.FAILED,
                  evaluationAttempts: { increment: providerAttempts },
                }
              : {}),
        },
      });

      if (failed.count !== 1) return false;
      await transaction.trainingAttempt.update({
        where: { id: attemptId },
        data: {
          status: TrainingAttemptStatus.TECHNICAL_FAILED,
          completionReason: TrainingAttemptCompletionReason.TECHNICAL_FAILURE,
          completedAt: now,
          calculatedScore: null,
          finalScore: null,
          isPassed: false,
          countsTowardAttemptLimit: false,
        },
      });

      return true;
    });
  }

  async finalizeAttemptIfExpired(attemptId: string, userId?: string) {
    return this.prisma.$transaction(async (transaction) => {
      const locked = await this.lockAttempt(transaction, attemptId, userId);

      if (!locked) {
        return false;
      }

      return this.finalizeTimeoutIfNeeded(
        transaction,
        attemptId,
        await this.getDatabaseNow(transaction),
      );
    });
  }

  async finalizeExpiredForUser(userId: string) {
    const attempts = await this.prisma.trainingAttempt.findMany({
      where: { userId, status: TrainingAttemptStatus.IN_PROGRESS },
      select: { id: true },
    });

    for (const attempt of attempts) {
      await this.finalizeAttemptIfExpired(attempt.id, userId);
    }
  }

  async finalizeExpiredAttempts() {
    const attempts = await this.prisma.trainingAttempt.findMany({
      where: { status: TrainingAttemptStatus.IN_PROGRESS },
      select: { id: true },
    });

    for (const attempt of attempts) {
      await this.finalizeAttemptIfExpired(attempt.id);
    }
  }

  private async completeAnswerFromText(
    transaction: Prisma.TransactionClient,
    attempt: { id: string; projectSnapshotJson: Prisma.JsonValue },
    currentQuestion: { id: string; sequence: number; maxScore: number },
    text: string,
    now: Date,
    existingAnswerId?: string,
  ) {
    const evaluation = evaluateLegacyTrainingText(text, currentQuestion.maxScore);
    const evaluationData = {
      text,
      score: evaluation.score,
      fakeOutcome:
        evaluation.outcome === 'REQUIRES_REVIEW'
          ? TrainingFakeOutcome.REQUIRES_REVIEW
          : TrainingFakeOutcome.SCORED,
      safeBreakdownJson: evaluation.safeBreakdown,
      transcriptionStatus: TrainingAiStepStatus.COMPLETED,
      evaluationStatus: TrainingAiStepStatus.COMPLETED,
    };

    if (existingAnswerId) {
      await transaction.trainingAnswer.update({
        where: { id: existingAnswerId },
        data: {
          ...evaluationData,
          processingStatus: TrainingAnswerProcessingStatus.COMPLETED,
          processingLockedAt: null,
          processingLockedBy: null,
          processingErrorCode: null,
        },
      });
    } else {
      await transaction.trainingAnswer.create({
        data: {
          attemptQuestionId: currentQuestion.id,
          source: TrainingAnswerSource.TEXT,
          processingStatus: TrainingAnswerProcessingStatus.COMPLETED,
          ...evaluationData,
          submittedAt: now,
        },
      });
    }

    await transaction.trainingAttemptQuestion.update({
      where: { id: currentQuestion.id },
      data: {
        status: TrainingAttemptQuestionStatus.ANSWERED,
        answeredAt: now,
      },
    });

    if (currentQuestion.sequence === 1) {
      await this.createFollowUpQuestions(transaction, attempt, now);
    }

    await this.completeIfReady(transaction, attempt.id, now);
  }

  private async createFollowUpQuestions(
    transaction: Prisma.TransactionClient,
    attempt: { id: string; projectSnapshotJson: Prisma.JsonValue },
    now: Date,
  ) {
    const snapshot = parseTrainingProjectSnapshot(attempt.projectSnapshotJson);
    const candidates = snapshot.questions.filter(
      (question) => question.type === TrainingQuestionType.FOLLOW_UP,
    );
    const selected = this.followUpSelector.select(candidates);
    const liveQuestions = await transaction.trainingQuestion.findMany({
      where: { id: { in: selected.map((question) => question.sourceQuestionId) } },
      select: { id: true },
    });
    const liveQuestionIds = new Set(liveQuestions.map((question) => question.id));

    await transaction.trainingAttemptQuestion.createMany({
      data: selected.map((question, index) => ({
        attemptId: attempt.id,
        sourceQuestionId: liveQuestionIds.has(question.sourceQuestionId)
          ? question.sourceQuestionId
          : null,
        sequence: index + 2,
        type: TrainingQuestionType.FOLLOW_UP,
        questionTextSnapshot: question.text,
        maxScore: TRAINING_FOLLOW_UP_MAX_SCORE,
        presentedAt: now,
      })),
    });
  }

  private async completeIfReady(
    transaction: Prisma.TransactionClient,
    attemptId: string,
    now: Date,
  ) {
    const questions = await transaction.trainingAttemptQuestion.findMany({
      where: { attemptId },
      include: { answer: true },
    });

    if (
      questions.length !== 4 ||
      questions.some(
        (question) =>
          question.status !== TrainingAttemptQuestionStatus.ANSWERED ||
          question.answer?.processingStatus !== TrainingAnswerProcessingStatus.COMPLETED,
      )
    ) {
      return;
    }

    const attempt = await transaction.trainingAttempt.findUniqueOrThrow({
      where: { id: attemptId },
      select: { projectSnapshotJson: true },
    });
    const snapshot = parseTrainingProjectSnapshot(attempt.projectSnapshotJson);
    const requiresReview = questions.some(
      (question) => question.answer?.fakeOutcome === TrainingFakeOutcome.REQUIRES_REVIEW,
    );

    if (requiresReview) {
      await transaction.trainingAttempt.update({
        where: { id: attemptId },
        data: {
          status: TrainingAttemptStatus.REQUIRES_REVIEW,
          completionReason: TrainingAttemptCompletionReason.COMPLETED,
          completedAt: now,
          calculatedScore: clampTrainingTotalScore(
            questions.reduce((total, question) => total + (question.answer?.score ?? 0), 0),
          ),
          reviewStatus: TrainingReviewStatus.PENDING,
          finalScore: null,
          isPassed: null,
        },
      });
      return;
    }

    const finalScore = clampTrainingTotalScore(
      questions.reduce((total, question) => total + (question.answer?.score ?? 0), 0),
    );
    await transaction.trainingAttempt.update({
      where: { id: attemptId },
      data: {
        status: TrainingAttemptStatus.COMPLETED,
        completionReason: TrainingAttemptCompletionReason.COMPLETED,
        completedAt: now,
        calculatedScore: finalScore,
        finalScore,
        isPassed: finalScore >= snapshot.settings.passScore,
      },
    });
  }

  private async finalizeTimeoutIfNeeded(
    transaction: Prisma.TransactionClient,
    attemptId: string,
    now: Date,
  ) {
    const attempt = await transaction.trainingAttempt.findUnique({
      where: { id: attemptId },
      include: {
        questions: {
          include: { answer: true },
        },
      },
    });

    if (
      !attempt ||
      attempt.status !== TrainingAttemptStatus.IN_PROGRESS ||
      attempt.expiresAt.getTime() > now.getTime()
    ) {
      return false;
    }

    const finalScore = clampTrainingTotalScore(
      attempt.questions.reduce(
        (total, question) =>
          total + (
            question.status === TrainingAttemptQuestionStatus.ANSWERED &&
            question.answer?.processingStatus === TrainingAnswerProcessingStatus.COMPLETED
              ? question.answer.score ?? 0
              : 0
          ),
        0,
      ),
    );
    await transaction.trainingAnswer.updateMany({
      where: {
        attemptQuestion: { attemptId },
        source: TrainingAnswerSource.TELEGRAM,
        processingStatus: {
          in: [
            TrainingAnswerProcessingStatus.COLLECTING,
            TrainingAnswerProcessingStatus.PROCESSING,
          ],
        },
      },
      data: {
        processingStatus: TrainingAnswerProcessingStatus.FAILED,
        processingLockedAt: null,
        processingLockedBy: null,
        processingErrorCode: 'ATTEMPT_TIMED_OUT',
      },
    });
    await transaction.trainingAttemptQuestion.updateMany({
      where: {
        attemptId,
        status: TrainingAttemptQuestionStatus.PRESENTED,
      },
      data: { status: TrainingAttemptQuestionStatus.SKIPPED_TIMEOUT },
    });
    await transaction.trainingAttempt.update({
      where: { id: attemptId },
      data: {
        status: TrainingAttemptStatus.TIMED_OUT,
        completionReason: TrainingAttemptCompletionReason.TIMEOUT,
        completedAt: now,
        calculatedScore: finalScore,
        finalScore,
        isPassed: false,
      },
    });

    return true;
  }

  private createSnapshot(project: {
    title: string;
    contentSchemaVersion: number;
    realEstateObject: { title: string } | null;
    attemptLimit: number;
    timeLimitSeconds: number;
    passScore: number;
    allowRetakeAfterPass: boolean;
    questions: Array<{
      id: string;
      type: TrainingQuestionType;
      text: string;
      position: number;
      facts: Array<{
        id: string;
        statement: string;
        aliasesJson: Prisma.JsonValue;
        isRequired: boolean;
        position: number;
        sourceType: 'MANUAL' | 'MATERIAL';
        sourceRevisionId: string | null;
        sourceLabel: string;
        sourceLocator: string | null;
        sourceExcerpt: string | null;
        sourceRevision: null | {
          finalUrl: string | null;
          material: {
            type: 'PDF' | 'OFFICIAL_URL' | 'MANUAL_TEXT' | 'OBJECT_SNAPSHOT';
            sourceUrl: string | null;
          };
        };
      }>;
    }>;
    criteria: Array<{
      id: string;
      questionType: TrainingQuestionType;
      code: string;
      title: string;
      guidance: string;
      maxPoints: number;
      position: number;
    }>;
  }): TrainingProjectSnapshot {
    const main = project.questions.filter((question) => question.type === TrainingQuestionType.MAIN);
    const followUps = project.questions.filter(
      (question) => question.type === TrainingQuestionType.FOLLOW_UP,
    );

    if (!hasTrainingSnapshotQuestionStructure(project.questions)) {
      throw new BadRequestException('Training project must contain 1+10 active questions');
    }

    const common = {
      projectTitle: project.title,
      settings: {
        attemptLimit: project.attemptLimit,
        timeLimitSeconds: project.timeLimitSeconds,
        passScore: project.passScore,
        allowRetakeAfterPass: project.allowRetakeAfterPass,
      },
      questions: [...main, ...followUps]
        .sort((left, right) =>
          left.type === right.type ? left.position - right.position : left.type === TrainingQuestionType.MAIN ? -1 : 1,
        )
        .map((question) => ({
          sourceQuestionId: question.id,
          type: question.type,
          text: question.text,
          position: question.position,
        })),
    };

    if (project.contentSchemaVersion === TRAINING_LEGACY_SNAPSHOT_SCHEMA_VERSION) {
      return {
        schemaVersion: TRAINING_LEGACY_SNAPSHOT_SCHEMA_VERSION,
        ...common,
      };
    }

    if (
      project.contentSchemaVersion !== TRAINING_STAGE3_SNAPSHOT_SCHEMA_VERSION &&
      project.contentSchemaVersion !== TRAINING_SNAPSHOT_SCHEMA_VERSION
    ) {
      throw new BadRequestException('Unsupported training project content version');
    }

    const criteriaFor = (type: TrainingQuestionType) =>
      project.criteria
        .filter((criterion) => criterion.questionType === type)
        .map((criterion) => ({
          id: criterion.id,
          code: criterion.code,
          title: criterion.title,
          guidance: criterion.guidance,
          maxPoints: criterion.maxPoints,
          position: criterion.position,
        }));
    const snapshotBase = {
      projectTitle: common.projectTitle,
      relatedObjectTitle: project.realEstateObject?.title ?? null,
      settings: common.settings,
      scoringVersion: TRAINING_SCORING_VERSION,
      evaluationSchemaVersion: TRAINING_EVALUATION_SCHEMA_VERSION,
      criteria: {
        main: criteriaFor(TrainingQuestionType.MAIN),
        followUp: criteriaFor(TrainingQuestionType.FOLLOW_UP),
      },
      questions: [...main, ...followUps]
        .sort((left, right) =>
          left.type === right.type
            ? left.position - right.position
            : left.type === TrainingQuestionType.MAIN
              ? -1
              : 1,
        )
        .map((question) => ({
          sourceQuestionId: question.id,
          type: question.type,
          text: question.text,
          position: question.position,
          facts: question.facts.map((fact) => ({
            id: fact.id,
            statement: fact.statement,
            aliases: parseSnapshotAliases(fact.aliasesJson),
            required: fact.isRequired,
            position: fact.position,
            ...(project.contentSchemaVersion === TRAINING_SNAPSHOT_SCHEMA_VERSION
              ? {
                  sourceType: fact.sourceType,
                  sourceRevisionId: fact.sourceRevisionId,
                  sourceLabel: fact.sourceLabel,
                  sourceLocator: fact.sourceLocator,
                  sourceExcerpt: fact.sourceExcerpt,
                  sourceMaterialType: fact.sourceRevision?.material.type ?? null,
                  sourceUrl:
                    fact.sourceRevision?.finalUrl ?? fact.sourceRevision?.material.sourceUrl ?? null,
                }
              : {}),
          })),
        })),
    };
    const snapshot: TrainingProjectSnapshotV2 | TrainingProjectSnapshotV3 =
      project.contentSchemaVersion === TRAINING_SNAPSHOT_SCHEMA_VERSION
        ? { schemaVersion: TRAINING_SNAPSHOT_SCHEMA_VERSION, ...snapshotBase } as TrainingProjectSnapshotV3
        : { schemaVersion: TRAINING_STAGE3_SNAPSHOT_SCHEMA_VERSION, ...snapshotBase } as TrainingProjectSnapshotV2;

    try {
      return parseTrainingProjectSnapshot(snapshot);
    } catch {
      throw new BadRequestException('Training facts, sources and criteria are invalid');
    }
  }

  private async lockUser(transaction: Prisma.TransactionClient, userId: string) {
    const rows = await transaction.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT "id" FROM "users" WHERE "id" = CAST(${userId} AS uuid) FOR UPDATE`,
    );

    if (!rows.length) {
      throw new NotFoundException('User not found');
    }
  }

  private async lockProject(transaction: Prisma.TransactionClient, projectId: string) {
    await transaction.$queryRaw(
      Prisma.sql`SELECT "id" FROM "training_projects" WHERE "id" = CAST(${projectId} AS uuid) FOR SHARE`,
    );
  }

  private async lockAttempt(
    transaction: Prisma.TransactionClient,
    attemptId: string,
    userId?: string,
  ) {
    const rows = userId
      ? await transaction.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT "id" FROM "training_attempts" WHERE "id" = CAST(${attemptId} AS uuid) AND "user_id" = CAST(${userId} AS uuid) FOR UPDATE`,
        )
      : await transaction.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT "id" FROM "training_attempts" WHERE "id" = CAST(${attemptId} AS uuid) FOR UPDATE`,
        );

    return rows.length > 0;
  }

  private async getDatabaseNow(transaction: Prisma.TransactionClient) {
    const [row] = await transaction.$queryRaw<Array<{ now: Date }>>(
      Prisma.sql`SELECT CURRENT_TIMESTAMP AS "now"`,
    );

    if (!row) {
      throw new Error('Database timestamp unavailable');
    }

    return row.now;
  }
}

export function getTrainingRetakeAvailableAt(
  attempts: ReadonlyArray<{
    status: TrainingAttemptStatus;
    completedAt: Date | null;
    reviewedAt: Date | null;
    isPassed: boolean | null;
  }>,
) {
  const latestResult = attempts.reduce<{
    isPassed: boolean;
    resolvedAt: Date;
  } | null>((latest, attempt) => {
    if (
      attempt.status !== TrainingAttemptStatus.COMPLETED ||
      attempt.isPassed === null
    ) {
      return latest;
    }

    const resolvedAt = attempt.reviewedAt ?? attempt.completedAt;

    if (!resolvedAt || (latest && latest.resolvedAt.getTime() >= resolvedAt.getTime())) {
      return latest;
    }

    return { isPassed: attempt.isPassed, resolvedAt };
  }, null);

  if (!latestResult || latestResult.isPassed) return null;

  return new Date(latestResult.resolvedAt.getTime() + TRAINING_RETAKE_DELAY_MS);
}

export function isTrainingRetakeDelayActive(
  attempts: Parameters<typeof getTrainingRetakeAvailableAt>[0],
  now: Date,
) {
  const availableAt = getTrainingRetakeAvailableAt(attempts);

  return Boolean(availableAt && availableAt.getTime() > now.getTime());
}

function parseSnapshotAliases(value: Prisma.JsonValue) {
  if (!Array.isArray(value) || value.some((alias) => typeof alias !== 'string')) {
    throw new BadRequestException('Training fact aliases are invalid');
  }

  return value as string[];
}
