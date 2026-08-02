import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  TrainingAttemptCompletionReason,
  TrainingAttemptStatus,
  TrainingReviewDecision,
  TrainingReviewStatus,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { parseTrainingProjectSnapshot } from './training-snapshot';

export type ReviewTrainingAttemptInput =
  | { decision: 'APPROVE'; finalScore: null; comment: string | null }
  | { decision: 'OVERRIDE'; finalScore: number; comment: string };

@Injectable()
export class TrainingReviewService {
  constructor(private readonly prisma: PrismaService) {}

  async reviewAttempt(
    attemptId: string,
    reviewedById: string,
    input: ReviewTrainingAttemptInput,
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT "id" FROM "training_attempts" WHERE "id" = CAST(${attemptId} AS uuid) FOR UPDATE`,
      );
      const attempt = await transaction.trainingAttempt.findUnique({
        where: { id: attemptId },
      });

      if (!attempt) throw new NotFoundException('Training attempt not found');

      if (attempt.reviewStatus === TrainingReviewStatus.RESOLVED) {
        if (isSameResolvedReview(attempt, input)) return serializeReview(attempt);
        throw new ConflictException('Training attempt review is already resolved');
      }

      if (
        attempt.status !== TrainingAttemptStatus.REQUIRES_REVIEW ||
        attempt.reviewStatus !== TrainingReviewStatus.PENDING ||
        attempt.calculatedScore === null
      ) {
        throw new ConflictException('Training attempt does not require review');
      }

      const finalScore = input.decision === 'APPROVE'
        ? attempt.calculatedScore
        : input.finalScore;
      const snapshot = parseTrainingProjectSnapshot(attempt.projectSnapshotJson);
      const reviewed = await transaction.trainingAttempt.update({
        where: { id: attempt.id },
        data: {
          status: TrainingAttemptStatus.COMPLETED,
          completionReason: TrainingAttemptCompletionReason.COMPLETED,
          finalScore,
          isPassed: finalScore >= snapshot.settings.passScore,
          reviewStatus: TrainingReviewStatus.RESOLVED,
          reviewDecision: input.decision === 'APPROVE'
            ? TrainingReviewDecision.APPROVED
            : TrainingReviewDecision.OVERRIDDEN,
          reviewedById,
          reviewedAt: new Date(),
          reviewComment: input.comment,
          reviewFinalScore: input.decision === 'OVERRIDE' ? input.finalScore : null,
        },
      });

      return serializeReview(reviewed);
    });
  }
}

function isSameResolvedReview(
  attempt: {
    reviewDecision: TrainingReviewDecision | null;
    reviewComment: string | null;
    reviewFinalScore: number | null;
  },
  input: ReviewTrainingAttemptInput,
) {
  return input.decision === 'APPROVE'
    ? attempt.reviewDecision === TrainingReviewDecision.APPROVED &&
        attempt.reviewComment === input.comment &&
        attempt.reviewFinalScore === null
    : attempt.reviewDecision === TrainingReviewDecision.OVERRIDDEN &&
        attempt.reviewComment === input.comment &&
        attempt.reviewFinalScore === input.finalScore;
}

function serializeReview(attempt: {
  id: string;
  status: TrainingAttemptStatus;
  calculatedScore: number | null;
  finalScore: number | null;
  isPassed: boolean | null;
  reviewStatus: TrainingReviewStatus;
  reviewDecision: TrainingReviewDecision | null;
  reviewedAt: Date | null;
}) {
  return {
    attemptId: attempt.id,
    status: attempt.status,
    calculatedScore: attempt.calculatedScore,
    finalScore: attempt.finalScore,
    isPassed: attempt.isPassed,
    reviewStatus: attempt.reviewStatus,
    reviewDecision: attempt.reviewDecision,
    reviewedAt: attempt.reviewedAt?.toISOString() ?? null,
  };
}
