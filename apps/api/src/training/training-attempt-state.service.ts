import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  TrainingAnswerProcessingStatus,
  TrainingAnswerSource,
  TrainingAttemptCompletionReason,
  TrainingAttemptQuestionStatus,
  TrainingAttemptStatus,
  TrainingFakeOutcome,
  TrainingProjectStatus,
  TrainingQuestionType,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  clampTrainingTotalScore,
  TRAINING_FOLLOW_UP_MAX_SCORE,
  TRAINING_EVALUATOR,
  TRAINING_MAIN_MAX_SCORE,
  TrainingEvaluator,
} from './training-evaluator';
import { TrainingFollowUpSelector } from './training-follow-up-selector';
import {
  hasTrainingSnapshotQuestionStructure,
  parseTrainingProjectSnapshot,
  TRAINING_SNAPSHOT_SCHEMA_VERSION,
  TrainingProjectSnapshot,
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

const TRAINING_MAX_VOICE_SEGMENTS = 20;
const TRAINING_MAX_VOICE_SEGMENT_BYTES = 20 * 1024 * 1024;
const TRAINING_MAX_VOICE_TOTAL_BYTES = 60 * 1024 * 1024;

@Injectable()
export class TrainingAttemptStateService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(TRAINING_EVALUATOR) private readonly evaluator: TrainingEvaluator,
    private readonly followUpSelector: TrainingFollowUpSelector,
  ) {}

  async startAttempt(projectId: string, userId: string, input: StartTrainingAttemptInput) {
    return this.prisma.$transaction((transaction) =>
      this.startAttemptInTransaction(transaction, projectId, userId, input),
    );
  }

  async startAttemptFromTelegramLinkToken(tokenId: string, userId: string) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT "id" FROM "training_telegram_link_tokens" WHERE "id" = CAST(${tokenId} AS uuid) FOR UPDATE`,
      );
      const token = await transaction.trainingTelegramLinkToken.findFirst({
        where: { id: tokenId, userId },
      });

      if (!token || token.usedAt === null) {
        throw new NotFoundException('Training Telegram link not found');
      }

      if (token.revokedAt !== null) {
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

      const attemptId = await this.startAttemptInTransaction(
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
      const now = await this.getDatabaseNow(transaction);
      const project = await transaction.trainingProject.findUnique({
        where: { id: projectId },
        include: {
          questions: {
            where: { isActive: true },
            orderBy: [{ type: 'asc' }, { position: 'asc' }],
          },
        },
      });

      if (!project) {
        throw new NotFoundException('Training project not found');
      }

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

      if (project.status !== TrainingProjectStatus.PUBLISHED || !project.isOpen) {
        throw new ConflictException('Training project is not open');
      }

      const attemptsUsed = await transaction.trainingAttempt.count({
        where: { userId, projectId },
      });

      if (attemptsUsed >= project.attemptLimit) {
        throw new ConflictException('Training attempt limit reached');
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
        return { status: 'TIMED_OUT' as const, attemptId };
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

      return { status: 'COMPLETED' as const, attemptId };
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
    const evaluation = this.evaluator.evaluate(text, currentQuestion.maxScore);
    const evaluationData = {
      text,
      score: evaluation.score,
      fakeOutcome:
        evaluation.outcome === 'REQUIRES_REVIEW'
          ? TrainingFakeOutcome.REQUIRES_REVIEW
          : TrainingFakeOutcome.SCORED,
      safeBreakdownJson: evaluation.safeBreakdown,
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
        (total, question) => total + (question.answer?.score ?? 0),
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
        finalScore,
        isPassed: false,
      },
    });

    return true;
  }

  private createSnapshot(project: {
    title: string;
    attemptLimit: number;
    timeLimitSeconds: number;
    passScore: number;
    allowRetakeAfterPass: boolean;
    questions: Array<{
      id: string;
      type: TrainingQuestionType;
      text: string;
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

    return {
      schemaVersion: TRAINING_SNAPSHOT_SCHEMA_VERSION,
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
      Prisma.sql`SELECT "id" FROM "training_projects" WHERE "id" = CAST(${projectId} AS uuid) FOR UPDATE`,
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
