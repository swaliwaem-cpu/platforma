import { Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  TrainingAnswerProcessingStatus,
  TrainingAttemptQuestionStatus,
  TrainingAttemptStatus,
  TrainingReviewDecision,
} from '@prisma/client';
import type {
  TrainingAdminAttempt,
  TrainingAdminAttemptsResponse,
  TrainingEmployeeAttempt,
  TrainingEmployeeAttemptSummary,
  TrainingEmployeeAttemptsResponse,
  TrainingEmployeeProjectsResponse,
  TrainingSafeBreakdown,
  TrainingObjectiveMetrics,
  TrainingStructuredEvaluation,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

import { PrismaService } from '../prisma/prisma.service';
import {
  TrainingAttemptStateService,
  type StartTrainingAttemptInput,
  type SubmitTrainingAnswerInput,
} from './training-attempt-state.service';
import {
  isTrainingProjectSnapshotWithFacts,
  parseTrainingProjectSnapshot,
} from './training-snapshot';
import { TrainingProjectAccessService } from './training-project-access.service';

@Injectable()
export class TrainingAttemptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly state: TrainingAttemptStateService,
    private readonly projectAccess: TrainingProjectAccessService,
  ) {}

  async listEmployeeProjects(userId: string): Promise<TrainingEmployeeProjectsResponse> {
    await this.state.finalizeExpiredForUser(userId);
    await this.projectAccess.assertParticipant(userId);
    const projects = await this.prisma.trainingProject.findMany({
      where: this.projectAccess.employeeProjectWhere(userId),
      include: {
        assignments: {
          where: { userId, revokedAt: null },
          select: { id: true },
          take: 1,
        },
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    const attempts = projects.length
      ? await this.prisma.trainingAttempt.findMany({
          where: { userId, projectId: { in: projects.map((project) => project.id) } },
          orderBy: { startedAt: 'desc' },
        })
      : [];

    return {
      items: projects.map((project) => {
        const projectAttempts = attempts.filter((attempt) => attempt.projectId === project.id);
        const activeAttempt = projectAttempts.find(
          (attempt) => attempt.status === TrainingAttemptStatus.IN_PROGRESS,
        );
        const countingAttempts = projectAttempts.filter(
          (attempt) => attempt.countsTowardAttemptLimit,
        );
        const confirmedAttempts = projectAttempts.filter(
          (attempt) =>
            attempt.status === TrainingAttemptStatus.COMPLETED &&
            attempt.finalScore !== null &&
            attempt.isPassed !== null,
        );
        const bestConfirmed = confirmedAttempts.reduce<(typeof confirmedAttempts)[number] | null>(
          (best, attempt) =>
            !best || (attempt.finalScore ?? -1) > (best.finalScore ?? -1) ? attempt : best,
          null,
        );
        const hasPendingReview = projectAttempts.some(
          (attempt) => attempt.status === TrainingAttemptStatus.REQUIRES_REVIEW,
        );
        const attemptsLeft = Math.max(0, project.attemptLimit - countingAttempts.length);
        const blockedByPass = Boolean(bestConfirmed?.isPassed && !project.allowRetakeAfterPass);
        const hasCurrentAccess = this.projectAccess.hasCurrentAccess(project);
        const canStart =
          hasCurrentAccess &&
          !activeAttempt &&
          attemptsLeft > 0 &&
          !blockedByPass;

        return {
          id: project.id,
          title: project.title,
          description: project.description,
          attemptLimit: project.attemptLimit,
          timeLimitSeconds: project.timeLimitSeconds,
          passScore: project.passScore,
          attemptsUsed: countingAttempts.length,
          attemptsLeft,
          eligibility: activeAttempt
            ? 'ACTIVE_ATTEMPT'
            : canStart
              ? 'ELIGIBLE'
              : blockedByPass
                ? 'PASSED'
                : attemptsLeft === 0
                  ? 'LIMIT_REACHED'
                  : 'CLOSED',
          canStart,
          activeAttempt: activeAttempt
            ? {
                id: activeAttempt.id,
                expiresAt: activeAttempt.expiresAt.toISOString(),
              }
            : null,
          bestConfirmedScore: bestConfirmed?.finalScore ?? null,
          bestConfirmedStatus: bestConfirmed
            ? bestConfirmed.isPassed
              ? 'PASSED'
              : 'FAILED'
            : null,
          hasPendingReview,
          newAttemptAccessRevoked: Boolean(
            activeAttempt &&
              this.projectAccess.isAssignmentAccessRevoked(project),
          ),
          status: bestConfirmed
            ? bestConfirmed.isPassed
              ? 'PASSED'
              : 'FAILED'
            : hasPendingReview
              ? 'REQUIRES_REVIEW'
              : null,
        };
      }),
    };
  }

  async startAttempt(
    projectId: string,
    userId: string,
    input: StartTrainingAttemptInput,
  ) {
    const attemptId = await this.state.startAttempt(projectId, userId, input);

    return this.getEmployeeAttempt(attemptId, userId);
  }

  async listEmployeeAttempts(userId: string): Promise<TrainingEmployeeAttemptsResponse> {
    await this.state.finalizeExpiredForUser(userId);
    const attempts = await this.prisma.trainingAttempt.findMany({
      where: { userId },
      include: trainingAttemptDetailInclude,
      orderBy: { startedAt: 'desc' },
    });

    return { items: attempts.map(serializeEmployeeAttemptSummary) };
  }

  async getEmployeeAttempt(attemptId: string, userId: string): Promise<TrainingEmployeeAttempt> {
    await this.state.finalizeAttemptIfExpired(attemptId, userId);
    const attempt = await this.prisma.trainingAttempt.findFirst({
      where: { id: attemptId, userId },
      include: trainingAttemptDetailInclude,
    });

    if (!attempt) {
      throw new NotFoundException('Training attempt not found');
    }

    return serializeEmployeeAttempt(attempt);
  }

  async submitAnswer(
    attemptId: string,
    userId: string,
    input: SubmitTrainingAnswerInput,
  ) {
    await this.state.submitAnswer(attemptId, userId, input);

    return this.getEmployeeAttempt(attemptId, userId);
  }

  async listAdminAttempts(): Promise<TrainingAdminAttemptsResponse> {
    await this.state.finalizeExpiredAttempts();
    const attempts = await this.prisma.trainingAttempt.findMany({
      include: {
        user: { select: { id: true, email: true, name: true } },
        project: { select: { id: true, title: true } },
      },
      orderBy: { startedAt: 'desc' },
    });

    return {
      items: attempts.map((attempt) => ({
        id: attempt.id,
        user: attempt.user,
        project: {
          id: attempt.projectId,
          title: parseTrainingProjectSnapshot(attempt.projectSnapshotJson).projectTitle,
        },
        attemptNumber: attempt.attemptNumber,
        status: attempt.status,
        finalScore: attempt.finalScore,
        isPassed: attempt.isPassed,
        startedAt: attempt.startedAt.toISOString(),
        completedAt: attempt.completedAt?.toISOString() ?? null,
      })),
    };
  }

  async getAdminAttempt(attemptId: string): Promise<TrainingAdminAttempt> {
    await this.state.finalizeAttemptIfExpired(attemptId);
    const attempt = await this.prisma.trainingAttempt.findUnique({
      where: { id: attemptId },
      include: trainingAttemptDetailInclude,
    });

    if (!attempt) {
      throw new NotFoundException('Training attempt not found');
    }

    return serializeAdminAttempt(attempt);
  }
}

const trainingAttemptDetailInclude = {
  project: {
    select: {
      id: true,
      title: true,
    },
  },
  user: {
    select: {
      id: true,
      email: true,
      name: true,
    },
  },
  questions: {
    include: {
      answer: true,
    },
    orderBy: {
      sequence: 'asc' as const,
    },
  },
} as const satisfies Prisma.TrainingAttemptInclude;

type TrainingAttemptDetailRecord = Prisma.TrainingAttemptGetPayload<{
  include: typeof trainingAttemptDetailInclude;
}>;

function serializeEmployeeAttempt(
  attempt: TrainingAttemptDetailRecord,
): TrainingEmployeeAttempt {
  const currentQuestion = attempt.questions.find(
    (question) => question.status === TrainingAttemptQuestionStatus.PRESENTED,
  );
  const isTerminal = attempt.status !== TrainingAttemptStatus.IN_PROGRESS;
  const hideBreakdown =
    attempt.status === TrainingAttemptStatus.REQUIRES_REVIEW ||
    attempt.status === TrainingAttemptStatus.TECHNICAL_FAILED ||
    attempt.reviewDecision === TrainingReviewDecision.OVERRIDDEN;

  return {
    id: attempt.id,
    project: {
      id: attempt.project.id,
      title: parseTrainingProjectSnapshot(attempt.projectSnapshotJson).projectTitle,
    },
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    completionReason: attempt.completionReason,
    startedAt: attempt.startedAt.toISOString(),
    expiresAt: attempt.expiresAt.toISOString(),
    completedAt: attempt.completedAt?.toISOString() ?? null,
    answeredCount: attempt.questions.filter(
      (question) => question.status === TrainingAttemptQuestionStatus.ANSWERED,
    ).length,
    totalQuestions: 4,
    currentQuestion: currentQuestion
      ? {
          id: currentQuestion.id,
          sequence: currentQuestion.sequence,
          type: currentQuestion.type,
          text: currentQuestion.questionTextSnapshot,
          maxScore: currentQuestion.maxScore,
        }
      : null,
    result: isTerminal
      ? {
          status: attempt.status,
          finalScore: attempt.finalScore,
          isPassed: attempt.isPassed,
          safeBreakdown: hideBreakdown
            ? []
            : attempt.questions.flatMap((question) =>
            isCompletedAnswer(question.answer)
              ? [
                  {
                    sequence: question.sequence,
                    type: question.type,
                    score: question.answer.score,
                    maxScore: question.maxScore,
                    details: serializeSafeBreakdown(question.answer.safeBreakdownJson),
                  },
                ]
              : [],
          ),
          message: attempt.status === TrainingAttemptStatus.TECHNICAL_FAILED
            ? 'Произошла техническая ошибка. Попытка возвращена.'
            : attempt.reviewDecision === TrainingReviewDecision.OVERRIDDEN
              ? 'Итог скорректирован после проверки.'
              : attempt.status === TrainingAttemptStatus.REQUIRES_REVIEW
                ? 'Требует проверки.'
                : null,
          attemptRefunded: attempt.status === TrainingAttemptStatus.TECHNICAL_FAILED,
        }
      : null,
  };
}

function serializeEmployeeAttemptSummary(
  attempt: TrainingAttemptDetailRecord,
): TrainingEmployeeAttemptSummary {
  return {
    id: attempt.id,
    projectId: attempt.projectId,
    projectTitle: parseTrainingProjectSnapshot(attempt.projectSnapshotJson).projectTitle,
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    finalScore: attempt.finalScore,
    isPassed: attempt.isPassed,
    startedAt: attempt.startedAt.toISOString(),
    completedAt: attempt.completedAt?.toISOString() ?? null,
  };
}

function serializeAdminAttempt(attempt: TrainingAttemptDetailRecord): TrainingAdminAttempt {
  const snapshot = parseTrainingProjectSnapshot(attempt.projectSnapshotJson);

  return {
    id: attempt.id,
    user: attempt.user,
    project: {
      id: attempt.projectId,
      title: snapshot.projectTitle,
      settings: snapshot.settings,
    },
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    completionReason: attempt.completionReason,
    calculatedScore: attempt.calculatedScore,
    reviewStatus: attempt.reviewStatus,
    reviewDecision: attempt.reviewDecision,
    reviewedAt: attempt.reviewedAt?.toISOString() ?? null,
    reviewComment: attempt.reviewComment,
    reviewFinalScore: attempt.reviewFinalScore,
    countsTowardAttemptLimit: attempt.countsTowardAttemptLimit,
    finalScore: attempt.finalScore,
    isPassed: attempt.isPassed,
    fakeEvaluationVersion: attempt.fakeEvaluationVersion,
    startedAt: attempt.startedAt.toISOString(),
    expiresAt: attempt.expiresAt.toISOString(),
    completedAt: attempt.completedAt?.toISOString() ?? null,
    questions: attempt.questions.map((question) => {
      const snapshotQuestion = isTrainingProjectSnapshotWithFacts(snapshot)
        ? snapshot.questions.find((item) => item.sourceQuestionId === question.sourceQuestionId)
        : null;
      const criteria = isTrainingProjectSnapshotWithFacts(snapshot)
        ? question.type === 'MAIN'
          ? snapshot.criteria.main
          : snapshot.criteria.followUp
        : [];

      return {
      id: question.id,
      sourceQuestionId: question.sourceQuestionId,
      sequence: question.sequence,
      type: question.type,
      text: question.questionTextSnapshot,
      maxScore: question.maxScore,
      status: question.status,
      presentedAt: question.presentedAt.toISOString(),
      answeredAt: question.answeredAt?.toISOString() ?? null,
      facts: snapshotQuestion?.facts ?? [],
      criteria,
      answer: question.answer
        ? {
            text: question.answer.text,
            score: question.answer.score,
            processingStatus: question.answer.processingStatus,
            safeBreakdown: serializeSafeBreakdownNullable(question.answer.safeBreakdownJson),
            submittedAt: question.answer.submittedAt?.toISOString() ?? null,
            transcriptionModel: question.answer.transcriptionModel,
            evaluationModel: question.answer.evaluationModel,
            evaluation: serializeStructuredEvaluation(question.answer.evaluationJson),
            objectiveMetrics: serializeObjectiveMetrics(
              question.answer.objectiveMetricsJson,
            ),
            technicalErrorCode: question.answer.processingErrorCode,
          }
        : null,
      };
    }),
  };
}

function isCompletedAnswer(
  answer: TrainingAttemptDetailRecord['questions'][number]['answer'],
): answer is NonNullable<TrainingAttemptDetailRecord['questions'][number]['answer']> & {
  text: string;
  score: number;
  fakeOutcome: NonNullable<
    TrainingAttemptDetailRecord['questions'][number]['answer']
  >['fakeOutcome'] & {};
  safeBreakdownJson: Prisma.JsonValue;
  submittedAt: Date;
} {
  return Boolean(
    answer &&
      answer.processingStatus === TrainingAnswerProcessingStatus.COMPLETED &&
      answer.text !== null &&
      answer.score !== null &&
      answer.fakeOutcome !== null &&
      answer.safeBreakdownJson !== null &&
      answer.submittedAt !== null,
  );
}

function serializeSafeBreakdown(value: Prisma.JsonValue): TrainingSafeBreakdown {
  const parsed = serializeSafeBreakdownNullable(value);
  if (!parsed) throw new Error('Invalid training safe breakdown');
  return parsed;
}

function serializeSafeBreakdownNullable(value: Prisma.JsonValue | null): TrainingSafeBreakdown | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    typeof value.version !== 'string' ||
    typeof value.basis !== 'string' ||
    typeof value.awardedScore !== 'number' ||
    typeof value.maxScore !== 'number'
  ) {
    return null;
  }

  if (value.basis === 'AI_CRITERIA') {
    if (
      value.version !== 'training-v2-evaluation-v1' ||
      typeof value.criteriaPoints !== 'number' ||
      typeof value.incorrectFactCount !== 'number' ||
      typeof value.penaltyPoints !== 'number'
    ) return null;

    return {
      version: 'training-v2-evaluation-v1',
      basis: 'AI_CRITERIA',
      criteriaPoints: value.criteriaPoints,
      incorrectFactCount: value.incorrectFactCount,
      penaltyPoints: value.penaltyPoints,
      awardedScore: value.awardedScore,
      maxScore: value.maxScore,
    };
  }

  if (!['TEXT_LENGTH', 'FAKE_PASS', 'FAKE_FAIL', 'FAKE_REVIEW'].includes(value.basis)) {
    return null;
  }

  return {
    version: value.version,
    basis: value.basis as 'TEXT_LENGTH' | 'FAKE_PASS' | 'FAKE_FAIL' | 'FAKE_REVIEW',
    awardedScore: value.awardedScore,
    maxScore: value.maxScore,
  };
}

function serializeStructuredEvaluation(value: Prisma.JsonValue | null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as unknown as TrainingStructuredEvaluation;
}

function serializeObjectiveMetrics(value: Prisma.JsonValue | null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as unknown as TrainingObjectiveMetrics;
}
