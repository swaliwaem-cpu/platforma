import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
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

@Injectable()
export class TrainingAttemptStateService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(TRAINING_EVALUATOR) private readonly evaluator: TrainingEvaluator,
    private readonly followUpSelector: TrainingFollowUpSelector,
  ) {}

  async startAttempt(projectId: string, userId: string, input: StartTrainingAttemptInput) {
    return this.prisma.$transaction(async (transaction) => {
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
    });
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

      const evaluation = this.evaluator.evaluate(input.text, currentQuestion.maxScore);
      await transaction.trainingAnswer.create({
        data: {
          attemptQuestionId: currentQuestion.id,
          text: input.text,
          score: evaluation.score,
          fakeOutcome:
            evaluation.outcome === 'REQUIRES_REVIEW'
              ? TrainingFakeOutcome.REQUIRES_REVIEW
              : TrainingFakeOutcome.SCORED,
          safeBreakdownJson: evaluation.safeBreakdown,
          submittedAt: now,
        },
      });
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
      return attempt.id;
    });

    if (!submittedAttemptId) throw new ConflictException('Training attempt time has expired');

    return submittedAttemptId;
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

    if (questions.length !== 4 || questions.some((question) => !question.answer)) {
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
