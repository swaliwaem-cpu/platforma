import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  TrainingAnswerStatus,
  TrainingAttemptStatus,
  TrainingFactVerdict,
  TrainingPassStatus,
  TrainingProjectStatus,
  TrainingAttemptQuestionStatus,
  TrainingQuestionType,
  TrainingReviewStatus,
  TrainingVersionStatus,
} from '@prisma/client';
import type {
  TrainingAdminAttemptDetailResponse,
  TrainingAdminResultsResponse,
  TrainingEmployeeAttemptDetailResponse,
  TrainingEmployeeAttemptsResponse,
  TrainingEmployeeProjectsResponse,
  TrainingPagination,
  TrainingProjectEligibilityReason,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

import { PrismaService } from '../prisma/prisma.service';
import { TRAINING_ACTIVE_ATTEMPT_STATUSES } from './training.domain';

export type TrainingEmployeeAttemptFilters = {
  page: number;
  pageSize: number;
  projectId?: string;
  status?: TrainingAttemptStatus;
  dateFrom?: Date;
  dateTo?: Date;
};

export type TrainingAdminResultFilters = {
  page: number;
  pageSize: number;
  user?: string;
  userId?: string;
  projectId?: string;
  projectVersionId?: string;
  status?: TrainingAttemptStatus;
  reviewStatus?: TrainingReviewStatus;
  passStatus?: TrainingPassStatus;
  requiresReview?: boolean;
  dateFrom?: Date;
  dateTo?: Date;
  minScore?: number;
  maxScore?: number;
  sort?: 'newest' | 'oldest' | 'score_desc' | 'score_asc';
  sortField?: 'startedAt' | 'completedAt' | 'finalScore';
  sortDirection?: 'asc' | 'desc';
};

const FINAL_ATTEMPT_STATUSES = [
  TrainingAttemptStatus.COMPLETED,
  TrainingAttemptStatus.REQUIRES_REVIEW,
] as const;

const employeeAttemptSelect = {
  id: true,
  attemptNumber: true,
  status: true,
  isConsumed: true,
  startedAt: true,
  expiresAt: true,
  completedAt: true,
  totalDurationSeconds: true,
  finalScore: true,
  passStatus: true,
  reviewStatus: true,
  project: {
    select: {
      id: true,
      title: true,
      slug: true,
    },
  },
} satisfies Prisma.TrainingAttemptSelect;

const adminListSelect = {
  id: true,
  attemptNumber: true,
  status: true,
  isConsumed: true,
  startedAt: true,
  completedAt: true,
  totalDurationSeconds: true,
  aiScore: true,
  serverScore: true,
  adminScore: true,
  finalScore: true,
  passStatus: true,
  reviewStatus: true,
  summary: true,
  user: {
    select: {
      id: true,
      name: true,
      email: true,
    },
  },
  project: {
    select: {
      id: true,
      title: true,
      slug: true,
    },
  },
  projectVersion: {
    select: {
      id: true,
      versionNumber: true,
    },
  },
  attemptQuestions: {
    select: {
      answer: {
        select: {
          status: true,
          errorCode: true,
          activeEvaluation: {
            select: {
              scoreComponents: {
                where: { factVerdict: TrainingFactVerdict.UNSUPPORTED },
                select: { id: true },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.TrainingAttemptSelect;

@Injectable()
export class TrainingResultsService {
  constructor(private readonly prisma: PrismaService) {}

  async listEmployeeProjects(
    userId: string,
  ): Promise<TrainingEmployeeProjectsResponse> {
    const now = new Date();
    const [projects, telegramAccount] = await Promise.all([
      this.prisma.trainingProject.findMany({
        where: {
          status: TrainingProjectStatus.OPEN,
          activeVersion: { status: TrainingVersionStatus.PUBLISHED },
        },
        orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          slug: true,
          title: true,
          description: true,
          realEstateObject: {
            select: {
              id: true,
              title: true,
              slug: true,
              shortDescription: true,
            },
          },
          sortOrder: true,
          availableFrom: true,
          deadlineAt: true,
          activeVersion: {
            select: {
              passScore: true,
              attemptLimit: true,
              cooldownMinutes: true,
              totalTimeLimitSeconds: true,
              allowRetakeAfterPass: true,
            },
          },
        },
      }),
      this.prisma.trainingTelegramAccount.findFirst({
        where: { userId, revokedAt: null },
        select: { id: true },
      }),
    ]);
    const attempts = projects.length
      ? await this.prisma.trainingAttempt.findMany({
          where: {
            userId,
            projectId: { in: projects.map((project) => project.id) },
          },
          orderBy: [
            { projectId: 'asc' },
            { attemptNumber: 'desc' },
            { id: 'asc' },
          ],
          select: {
            id: true,
            projectId: true,
            status: true,
            isConsumed: true,
            startedAt: true,
            expiresAt: true,
            completedAt: true,
            finalScore: true,
            passStatus: true,
            reviewStatus: true,
          },
        })
      : [];
    const attemptsByProject = new Map<string, typeof attempts>();
    for (const attempt of attempts) {
      const current = attemptsByProject.get(attempt.projectId) ?? [];
      current.push(attempt);
      attemptsByProject.set(attempt.projectId, current);
    }

    return {
      items: projects.map((project) => {
        const projectAttempts = attemptsByProject.get(project.id) ?? [];
        const consumed = projectAttempts.filter((attempt) => attempt.isConsumed);
        const finalized = consumed.filter(isFinalReviewedAttempt);
        const best = finalized
          .filter((attempt) => attempt.finalScore !== null)
          .sort(compareFinalScore)[0];
        const lastFinalized = finalized
          .filter((attempt) => attempt.finalScore !== null)
          .sort(compareCompletedNewest)[0];
        const activeAttempt =
          projectAttempts.find((attempt) =>
            TRAINING_ACTIVE_ATTEMPT_STATUSES.includes(
              attempt.status as (typeof TRAINING_ACTIVE_ATTEMPT_STATUSES)[number],
            ),
          ) ?? null;
        const lastAttempt =
          [...projectAttempts].sort(
            (left, right) =>
              right.startedAt.getTime() - left.startedAt.getTime() ||
              left.id.localeCompare(right.id),
          )[0] ?? null;
        const eligibility = resolveEligibility({
          now,
          attempts: projectAttempts,
          attemptLimit: project.activeVersion!.attemptLimit,
          cooldownMinutes: project.activeVersion!.cooldownMinutes,
          allowRetakeAfterPass: project.activeVersion!.allowRetakeAfterPass,
          availableFrom: project.availableFrom,
          deadlineAt: project.deadlineAt,
          telegramConnected: Boolean(telegramAccount),
        });

        return {
          id: project.id,
          slug: project.slug,
          title: project.title,
          description: project.description,
          object: project.realEstateObject
            ? {
                id: project.realEstateObject.id,
                title: project.realEstateObject.title,
                slug: project.realEstateObject.slug,
                summary: project.realEstateObject.shortDescription,
              }
            : null,
          sortOrder: project.sortOrder,
          availableFrom: toIso(project.availableFrom),
          deadlineAt: toIso(project.deadlineAt),
          passScore: project.activeVersion!.passScore,
          attemptLimit: project.activeVersion!.attemptLimit,
          attemptsUsed: consumed.length,
          attemptsLeft: Math.max(
            0,
            project.activeVersion!.attemptLimit - consumed.length,
          ),
          cooldownMinutes: project.activeVersion!.cooldownMinutes,
          totalTimeLimitSeconds:
            project.activeVersion!.totalTimeLimitSeconds,
          allowRetakeAfterPass:
            project.activeVersion!.allowRetakeAfterPass,
          requiresTelegramConnection: true,
          telegramConnected: Boolean(telegramAccount),
          bestScore: decimalToString(best?.finalScore),
          lastScore: decimalToString(lastFinalized?.finalScore),
          lastAttemptStatus: lastAttempt?.status ?? null,
          activeAttempt: activeAttempt
            ? {
                id: activeAttempt.id,
                status: activeAttempt.status,
                startedAt: activeAttempt.startedAt.toISOString(),
                expiresAt: activeAttempt.expiresAt.toISOString(),
              }
            : null,
          eligibility,
        };
      }),
    };
  }

  async getEmployeeProject(userId: string, projectId: string) {
    const response = await this.listEmployeeProjects(userId);
    const project = response.items.find((item) => item.id === projectId);
    if (!project) {
      throw new NotFoundException('Open training project not found');
    }
    return { project };
  }

  async listEmployeeAttempts(
    userId: string,
    filters: TrainingEmployeeAttemptFilters,
  ): Promise<TrainingEmployeeAttemptsResponse> {
    const where: Prisma.TrainingAttemptWhereInput = {
      userId,
      ...(filters.projectId ? { projectId: filters.projectId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.dateFrom || filters.dateTo
        ? {
            startedAt: {
              ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
              ...(filters.dateTo ? { lte: filters.dateTo } : {}),
            },
          }
        : {}),
    };
    const [total, attempts] = await this.prisma.$transaction([
      this.prisma.trainingAttempt.count({ where }),
      this.prisma.trainingAttempt.findMany({
        where,
        orderBy: [{ startedAt: 'desc' }, { id: 'asc' }],
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
        select: employeeAttemptSelect,
      }),
    ]);

    return {
      items: attempts.map(serializeEmployeeAttempt),
      pagination: pagination(filters.page, filters.pageSize, total),
    };
  }

  async getEmployeeAttempt(
    userId: string,
    attemptId: string,
  ): Promise<TrainingEmployeeAttemptDetailResponse> {
    const attempt = await this.prisma.trainingAttempt.findFirst({
      where: { id: attemptId, userId },
      select: {
        ...employeeAttemptSelect,
        serverScore: true,
        projectVersion: { select: { attemptLimit: true } },
        project: {
          select: {
            id: true,
            title: true,
            slug: true,
            activeVersion: {
              select: { attemptLimit: true },
            },
          },
        },
        attemptQuestions: {
          orderBy: { sequence: 'asc' },
          select: {
            id: true,
            sequence: true,
            status: true,
            responseTimeSeconds: true,
            answerDurationSeconds: true,
            question: {
              select: {
                type: true,
                text: true,
              },
            },
            answer: {
              select: {
                activeEvaluation: {
                  select: {
                    serverScore: true,
                    scoreComponents: {
                      where: {
                        criterionId: { not: null },
                      },
                      orderBy: [{ componentKey: 'asc' }],
                      select: {
                        componentKey: true,
                        title: true,
                        awardedPoints: true,
                        maxPoints: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!attempt) {
      throw new NotFoundException('Training attempt not found');
    }

    const [attemptsUsed, best] = await Promise.all([
      this.prisma.trainingAttempt.count({
        where: {
          userId,
          projectId: attempt.project.id,
          isConsumed: true,
        },
      }),
      this.prisma.trainingAttempt.findFirst({
        where: {
          userId,
          projectId: attempt.project.id,
          isConsumed: true,
          finalScore: { not: null },
          reviewStatus: { not: TrainingReviewStatus.PENDING },
          status: { in: [...FINAL_ATTEMPT_STATUSES] },
        },
        orderBy: [
          { finalScore: 'desc' },
          { completedAt: 'asc' },
          { id: 'asc' },
        ],
        select: { finalScore: true },
      }),
    ]);
    const breakdownPresentation =
      resolveEmployeeBreakdownPresentation(attempt);

    return {
      attempt: {
        ...serializeEmployeeAttempt(attempt),
        attemptsLeft: Math.max(
          0,
          (attempt.project.activeVersion?.attemptLimit ??
            attempt.projectVersion.attemptLimit) - attemptsUsed,
        ),
        bestScore: decimalToString(best?.finalScore),
        breakdownStatus: breakdownPresentation.status,
        breakdown: breakdownPresentation.breakdown,
      },
    };
  }

  async listAdminResults(
    filters: TrainingAdminResultFilters,
  ): Promise<TrainingAdminResultsResponse> {
    const where = buildAdminWhere(filters);
    const [total, attempts] = await this.prisma.$transaction([
      this.prisma.trainingAttempt.count({ where }),
      this.prisma.trainingAttempt.findMany({
        where,
        orderBy: adminOrderBy(filters),
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
        select: adminListSelect,
      }),
    ]);
    const usageCounts = attempts.length
      ? await this.prisma.trainingAttempt.groupBy({
          by: ['userId', 'projectId'],
          where: {
            isConsumed: true,
            OR: attempts.map((attempt) => ({
              userId: attempt.user.id,
              projectId: attempt.project.id,
            })),
          },
          _count: { _all: true },
        })
      : [];
    const attemptsUsedByUserProject = new Map(
      usageCounts.map((item) => [
        userProjectKey(item.userId, item.projectId),
        item._count._all,
      ]),
    );

    return {
      items: attempts.map((attempt) =>
        serializeAdminListItem(
          attempt,
          attemptsUsedByUserProject.get(
            userProjectKey(attempt.user.id, attempt.project.id),
          ) ?? 0,
        ),
      ),
      pagination: pagination(filters.page, filters.pageSize, total),
    };
  }

  async getAdminAttempt(
    attemptId: string,
  ): Promise<TrainingAdminAttemptDetailResponse> {
    const attempt = await this.prisma.trainingAttempt.findUnique({
      where: { id: attemptId },
      select: {
        ...adminListSelect,
        expiresAt: true,
        graceExpiresAt: true,
        aiScore: true,
        serverScore: true,
        adminScore: true,
        summary: true,
        attemptQuestions: {
          orderBy: { sequence: 'asc' },
          select: {
            id: true,
            sequence: true,
            status: true,
            presentedAt: true,
            firstSegmentAt: true,
            finishedAt: true,
            responseTimeSeconds: true,
            answerDurationSeconds: true,
            question: {
              select: {
                type: true,
                text: true,
              },
            },
            answer: {
              select: {
                id: true,
                status: true,
                mergedAudioFileId: true,
                mergedAudioFile: {
                  select: {
                    mimeType: true,
                    sizeBytes: true,
                  },
                },
                mergedAudioDurationMilliseconds: true,
                combinedTranscript: true,
                normalizedLanguage: true,
                transcriptionProvider: true,
                transcriptionModel: true,
                transcriptionRequestId: true,
                acousticMetricsJson: true,
                activeTranscriptionId: true,
                activeEvaluationId: true,
                processingStartedAt: true,
                processingFinishedAt: true,
                errorCode: true,
                errorMessage: true,
                activeEvaluation: {
                  select: {
                    scoreComponents: {
                      where: {
                        factVerdict: TrainingFactVerdict.UNSUPPORTED,
                      },
                      select: { id: true },
                    },
                  },
                },
                voiceSegments: {
                  orderBy: { segmentIndex: 'asc' },
                  select: {
                    id: true,
                    segmentIndex: true,
                    mimeType: true,
                    sizeBytes: true,
                    durationMilliseconds: true,
                    downloadedAt: true,
                    receivedAt: true,
                  },
                },
                transcriptions: {
                  orderBy: { transcriptionNumber: 'asc' },
                  select: {
                    id: true,
                    transcriptionNumber: true,
                    transcript: true,
                    language: true,
                    wordCount: true,
                    createdAt: true,
                  },
                },
                evaluations: {
                  orderBy: { evaluationNumber: 'asc' },
                  select: {
                    id: true,
                    evaluationNumber: true,
                    actualModelId: true,
                    reasoningEffort: true,
                    promptVersion: true,
                    schemaVersion: true,
                    rubricVersion: true,
                    aiSuggestedScore: true,
                    serverScore: true,
                    summary: true,
                    requiresReview: true,
                    reviewReasonsJson: true,
                    providerUsageJson: true,
                    latencyMs: true,
                    requestId: true,
                    createdAt: true,
                    scoreComponents: {
                      orderBy: { componentKey: 'asc' },
                      select: {
                        componentKey: true,
                        title: true,
                        awardedPoints: true,
                        maxPoints: true,
                        penaltyPoints: true,
                        factVerdict: true,
                        evidenceJson: true,
                        criterion: { select: { code: true } },
                        fact: { select: { code: true } },
                      },
                    },
                  },
                },
                providerRuns: {
                  orderBy: { createdAt: 'asc' },
                  select: {
                    id: true,
                    kind: true,
                    runType: true,
                    status: true,
                    requestedModelId: true,
                    actualModelId: true,
                    requestId: true,
                    responseStatus: true,
                    promptVersion: true,
                    schemaVersion: true,
                    rubricVersion: true,
                    providerUsageJson: true,
                    latencyMs: true,
                    retryCount: true,
                    errorCode: true,
                    errorClass: true,
                    ambiguousOutcome: true,
                    startedAt: true,
                    completedAt: true,
                  },
                },
              },
            },
          },
        },
        reviews: {
          orderBy: { reviewNumber: 'asc' },
          select: {
            id: true,
            reviewNumber: true,
            previousFinalScore: true,
            adminScore: true,
            finalScore: true,
            decision: true,
            comment: true,
            unsupportedClaimsDecisionsJson: true,
            reviewedAt: true,
            reviewer: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        },
      },
    });
    if (!attempt) {
      throw new NotFoundException('Training attempt not found');
    }
    const [jobs, attemptsUsed] = await Promise.all([
      this.prisma.trainingJob.findMany({
        where: {
          OR: [
            {
              idempotencyKey: {
                startsWith: `attempt:${attempt.id}:`,
              },
            },
            {
              payloadJson: {
                path: ['attemptId'],
                equals: attempt.id,
              },
            },
          ],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          kind: true,
          status: true,
          attempts: true,
          lastErrorCode: true,
          lastErrorMessage: true,
          runAt: true,
          finishedAt: true,
        },
      }),
      this.prisma.trainingAttempt.count({
        where: {
          userId: attempt.user.id,
          projectId: attempt.project.id,
          isConsumed: true,
        },
      }),
    ]);
    const timeline = buildTimeline(attempt);

    return {
      attempt: {
        ...serializeAdminListItem(attempt, attemptsUsed),
        expiresAt: attempt.expiresAt.toISOString(),
        graceExpiresAt: attempt.graceExpiresAt.toISOString(),
        aiScore: decimalToString(attempt.aiScore),
        serverScore: decimalToString(attempt.serverScore),
        adminScore: decimalToString(attempt.adminScore),
        summary: attempt.summary,
        timeline,
        questions: attempt.attemptQuestions.map((question) => ({
          id: question.id,
          sequence: question.sequence,
          type: question.question.type,
          text: question.question.text,
          status: question.status,
          presentedAt: toIso(question.presentedAt),
          firstSegmentAt: toIso(question.firstSegmentAt),
          finishedAt: toIso(question.finishedAt),
          responseTimeSeconds: question.responseTimeSeconds,
          answerDurationSeconds: question.answerDurationSeconds,
          answer: question.answer
            ? {
                id: question.answer.id,
                status: question.answer.status,
                audioAvailable: Boolean(question.answer.mergedAudioFileId),
                audioUrl: question.answer.mergedAudioFileId
                  ? `/training/admin/answers/${question.answer.id}/audio`
                  : null,
                audioMimeType:
                  question.answer.mergedAudioFile?.mimeType ?? null,
                audioSizeBytes:
                  question.answer.mergedAudioFile?.sizeBytes?.toString() ??
                  null,
                audioDurationMilliseconds:
                  question.answer.mergedAudioDurationMilliseconds,
                combinedTranscript: question.answer.combinedTranscript,
                normalizedLanguage: question.answer.normalizedLanguage,
                transcriptionProvider:
                  question.answer.transcriptionProvider,
                transcriptionModel: question.answer.transcriptionModel,
                transcriptionRequestId:
                  question.answer.transcriptionRequestId,
                acousticMetrics: question.answer.acousticMetricsJson,
                processingStartedAt: toIso(
                  question.answer.processingStartedAt,
                ),
                processingFinishedAt: toIso(
                  question.answer.processingFinishedAt,
                ),
                errorCode: question.answer.errorCode,
                errorMessage: question.answer.errorMessage,
                segments: question.answer.voiceSegments.map((segment) => ({
                  id: segment.id,
                  segmentIndex: segment.segmentIndex,
                  mimeType: segment.mimeType,
                  sizeBytes: segment.sizeBytes?.toString() ?? null,
                  durationMilliseconds: segment.durationMilliseconds,
                  downloadedAt: toIso(segment.downloadedAt),
                  receivedAt: segment.receivedAt.toISOString(),
                })),
                transcriptions: question.answer.transcriptions.map(
                  (transcription) => ({
                    id: transcription.id,
                    transcriptionNumber:
                      transcription.transcriptionNumber,
                    transcript: transcription.transcript,
                    language: transcription.language,
                    wordCount: transcription.wordCount,
                    isActive:
                      transcription.id ===
                      question.answer?.activeTranscriptionId,
                    createdAt: transcription.createdAt.toISOString(),
                  }),
                ),
                evaluations: question.answer.evaluations.map((evaluation) => ({
                  id: evaluation.id,
                  evaluationNumber: evaluation.evaluationNumber,
                  actualModelId: evaluation.actualModelId,
                  reasoningEffort: evaluation.reasoningEffort,
                  promptVersion: evaluation.promptVersion,
                  schemaVersion: evaluation.schemaVersion,
                  rubricVersion: evaluation.rubricVersion,
                  aiSuggestedScore:
                    evaluation.aiSuggestedScore.toString(),
                  serverScore: evaluation.serverScore.toString(),
                  summary: evaluation.summary,
                  requiresReview: evaluation.requiresReview,
                  reviewReasons: evaluation.reviewReasonsJson,
                  usage: evaluation.providerUsageJson,
                  latencyMs: evaluation.latencyMs,
                  requestId: evaluation.requestId,
                  isActive:
                    evaluation.id === question.answer?.activeEvaluationId,
                  components: evaluation.scoreComponents.map((component) => ({
                    componentKey: component.componentKey,
                    title: component.title,
                    criterionCode: component.criterion?.code ?? null,
                    factCode: component.fact?.code ?? null,
                    awardedPoints: component.awardedPoints.toString(),
                    maxPoints: component.maxPoints.toString(),
                    penaltyPoints: component.penaltyPoints.toString(),
                    factVerdict: component.factVerdict,
                    evidence: component.evidenceJson,
                  })),
                  createdAt: evaluation.createdAt.toISOString(),
                })),
                providerRuns: question.answer.providerRuns.map((run) => ({
                  id: run.id,
                  kind: run.kind,
                  runType: run.runType,
                  status: run.status,
                  requestedModelId: run.requestedModelId,
                  actualModelId: run.actualModelId,
                  requestId: run.requestId,
                  responseStatus: run.responseStatus,
                  promptVersion: run.promptVersion,
                  schemaVersion: run.schemaVersion,
                  rubricVersion: run.rubricVersion,
                  latencyMs: run.latencyMs,
                  retryCount: run.retryCount,
                  errorCode: run.errorCode,
                  errorClass: run.errorClass,
                  ambiguousOutcome: run.ambiguousOutcome,
                  usage: run.providerUsageJson,
                  startedAt: toIso(run.startedAt),
                  completedAt: toIso(run.completedAt),
                })),
              }
            : null,
        })),
        reviews: attempt.reviews.map((review) => ({
          id: review.id,
          reviewNumber: review.reviewNumber,
          reviewer: review.reviewer,
          previousFinalScore: decimalToString(review.previousFinalScore),
          adminScore: decimalToString(review.adminScore),
          finalScore: review.finalScore.toString(),
          decision: review.decision,
          comment: review.comment,
          unsupportedClaimsDecisions:
            review.unsupportedClaimsDecisionsJson,
          reviewedAt: review.reviewedAt.toISOString(),
        })),
        jobs: jobs.map((job) => ({
          ...job,
          runAt: job.runAt.toISOString(),
          finishedAt: toIso(job.finishedAt),
        })),
      },
    };
  }
}

function buildAdminWhere(
  filters: TrainingAdminResultFilters,
): Prisma.TrainingAttemptWhereInput {
  return {
    ...(filters.userId ? { userId: filters.userId } : {}),
    ...(filters.user
      ? {
          user: {
            OR: [
              { name: { contains: filters.user, mode: 'insensitive' } },
              { email: { contains: filters.user, mode: 'insensitive' } },
            ],
          },
        }
      : {}),
    ...(filters.projectId ? { projectId: filters.projectId } : {}),
    ...(filters.projectVersionId
      ? { projectVersionId: filters.projectVersionId }
      : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.reviewStatus
      ? { reviewStatus: filters.reviewStatus }
      : {}),
    ...(filters.passStatus ? { passStatus: filters.passStatus } : {}),
    ...(filters.requiresReview !== undefined
      ? filters.requiresReview
        ? {
            OR: [
              { reviewStatus: TrainingReviewStatus.PENDING },
              { status: TrainingAttemptStatus.REQUIRES_REVIEW },
            ],
          }
        : {
            NOT: {
              OR: [
                { reviewStatus: TrainingReviewStatus.PENDING },
                { status: TrainingAttemptStatus.REQUIRES_REVIEW },
              ],
            },
          }
      : {}),
    ...(filters.dateFrom || filters.dateTo
      ? {
          startedAt: {
            ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
            ...(filters.dateTo ? { lte: filters.dateTo } : {}),
          },
        }
      : {}),
    ...(filters.minScore !== undefined || filters.maxScore !== undefined
      ? {
          finalScore: {
            ...(filters.minScore !== undefined
              ? { gte: filters.minScore }
              : {}),
            ...(filters.maxScore !== undefined
              ? { lte: filters.maxScore }
              : {}),
          },
        }
      : {}),
  };
}

function adminOrderBy(
  filters: TrainingAdminResultFilters,
): Prisma.TrainingAttemptOrderByWithRelationInput[] {
  if (filters.sortField === 'finalScore') {
    return [
      {
        finalScore: {
          sort: filters.sortDirection ?? 'desc',
          nulls: 'last',
        },
      },
      { id: 'asc' },
    ];
  }
  if (filters.sortField === 'completedAt') {
    return [
      {
        completedAt: {
          sort: filters.sortDirection ?? 'desc',
          nulls: 'last',
        },
      },
      { id: 'asc' },
    ];
  }
  if (filters.sortField === 'startedAt') {
    return [
      { startedAt: filters.sortDirection ?? 'desc' },
      { id: 'asc' },
    ];
  }
  const sort = filters.sort;
  if (sort === 'oldest') return [{ startedAt: 'asc' }, { id: 'asc' }];
  if (sort === 'score_desc') {
    return [{ finalScore: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }];
  }
  if (sort === 'score_asc') {
    return [{ finalScore: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }];
  }
  return [{ startedAt: 'desc' }, { id: 'asc' }];
}

function serializeEmployeeAttempt(
  attempt: Prisma.TrainingAttemptGetPayload<{
    select: typeof employeeAttemptSelect;
  }>,
) {
  const isVisibleFinal = isFinalReviewedAttempt(attempt);
  return {
    id: attempt.id,
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    isConsumed: attempt.isConsumed,
    startedAt: attempt.startedAt.toISOString(),
    expiresAt: attempt.expiresAt.toISOString(),
    completedAt: toIso(attempt.completedAt),
    totalDurationSeconds: attempt.totalDurationSeconds,
    finalScore: isVisibleFinal ? decimalToString(attempt.finalScore) : null,
    passStatus: attempt.passStatus,
    reviewStatus: attempt.reviewStatus,
    project: {
      id: attempt.project.id,
      title: attempt.project.title,
      slug: attempt.project.slug,
    },
  };
}

function resolveEmployeeBreakdownPresentation(attempt: {
  status: TrainingAttemptStatus;
  finalScore: Prisma.Decimal | null;
  serverScore: Prisma.Decimal | null;
  reviewStatus: TrainingReviewStatus;
  attemptQuestions: Array<{
    id: string;
    sequence: number;
    status: TrainingAttemptQuestionStatus;
    responseTimeSeconds: number | null;
    answerDurationSeconds: number | null;
    question: {
      type: TrainingQuestionType;
      text: string;
    };
    answer: {
      activeEvaluation: {
        serverScore: Prisma.Decimal;
        scoreComponents: Array<{
          componentKey: string;
          title: string | null;
          awardedPoints: Prisma.Decimal;
          maxPoints: Prisma.Decimal;
        }>;
      } | null;
    } | null;
  }>;
}) {
  if (!isFinalReviewedAttempt(attempt)) {
    return {
      status: 'PENDING_REVIEW' as const,
      breakdown: null,
    };
  }
  if (
    attempt.reviewStatus === TrainingReviewStatus.OVERRIDDEN ||
    attempt.serverScore === null ||
    !attempt.finalScore!.equals(attempt.serverScore)
  ) {
    return {
      status: 'MANUALLY_ADJUSTED_BREAKDOWN_UNAVAILABLE' as const,
      breakdown: null,
    };
  }

  const evaluations = attempt.attemptQuestions.map(
    (question) => question.answer?.activeEvaluation ?? null,
  );
  if (evaluations.some((evaluation) => evaluation === null)) {
    return {
      status: 'BREAKDOWN_UNAVAILABLE' as const,
      breakdown: null,
    };
  }
  const questionScoreTotal = evaluations.reduce(
    (sum, evaluation) => sum.add(evaluation!.serverScore),
    new Prisma.Decimal(0),
  );
  if (!questionScoreTotal.equals(attempt.finalScore!)) {
    return {
      status: 'BREAKDOWN_UNAVAILABLE' as const,
      breakdown: null,
    };
  }
  const hasInconsistentComponents = evaluations.some((evaluation) => {
    if (!evaluation!.scoreComponents.length) return false;
    const componentTotal = evaluation!.scoreComponents.reduce(
      (sum, component) => sum.add(component.awardedPoints),
      new Prisma.Decimal(0),
    );
    return !componentTotal.equals(evaluation!.serverScore);
  });
  if (hasInconsistentComponents) {
    return {
      status: 'BREAKDOWN_UNAVAILABLE' as const,
      breakdown: null,
    };
  }

  return {
    status: 'AVAILABLE' as const,
    breakdown: attempt.attemptQuestions.map((question) => {
      const evaluation = question.answer!.activeEvaluation!;
      return {
        id: question.id,
        sequence: question.sequence,
        type: question.question.type,
        text: question.question.text,
        status: question.status,
        responseTimeSeconds: question.responseTimeSeconds,
        answerDurationSeconds: question.answerDurationSeconds,
        score: evaluation.serverScore.toString(),
        components: evaluation.scoreComponents.map((component) => ({
          key: component.componentKey,
          title: component.title ?? component.componentKey,
          awardedPoints: component.awardedPoints.toString(),
          maxPoints: component.maxPoints.toString(),
        })),
      };
    }),
  };
}

function serializeAdminListItem(
  attempt: Prisma.TrainingAttemptGetPayload<{
    select: typeof adminListSelect;
  }>,
  attemptsUsed: number,
) {
  return {
    id: attempt.id,
    user: attempt.user,
    project: attempt.project,
    projectVersion: attempt.projectVersion,
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    isConsumed: attempt.isConsumed,
    startedAt: attempt.startedAt.toISOString(),
    completedAt: toIso(attempt.completedAt),
    totalDurationSeconds: attempt.totalDurationSeconds,
    aiScore: decimalToString(attempt.aiScore),
    serverScore: decimalToString(attempt.serverScore),
    adminScore: decimalToString(attempt.adminScore),
    finalScore: decimalToString(attempt.finalScore),
    passStatus: attempt.passStatus,
    reviewStatus: attempt.reviewStatus,
    answerErrorsCount: attempt.attemptQuestions.filter(
      (question) => Boolean(question.answer?.errorCode),
    ).length,
    unsupportedClaimsCount: attempt.attemptQuestions.reduce(
      (total, question) =>
        total +
        (question.answer?.activeEvaluation?.scoreComponents.length ?? 0),
      0,
    ),
    answersCompleted: attempt.attemptQuestions.filter(
      (question) =>
        question.answer?.status === TrainingAnswerStatus.SCORED,
    ).length,
    attemptsUsed,
    requiresReview:
      attempt.reviewStatus === TrainingReviewStatus.PENDING ||
      attempt.status === TrainingAttemptStatus.REQUIRES_REVIEW,
    summary: attempt.summary,
  };
}

function resolveEligibility(input: {
  now: Date;
  attempts: Array<{
    status: TrainingAttemptStatus;
    isConsumed: boolean;
    startedAt: Date;
    completedAt: Date | null;
    finalScore: Prisma.Decimal | null;
    passStatus: TrainingPassStatus;
    reviewStatus: TrainingReviewStatus;
  }>;
  attemptLimit: number;
  cooldownMinutes: number;
  allowRetakeAfterPass: boolean;
  availableFrom: Date | null;
  deadlineAt: Date | null;
  telegramConnected: boolean;
}): {
  canStart: boolean;
  reason: TrainingProjectEligibilityReason;
  retryAt: string | null;
} {
  if (input.availableFrom && input.availableFrom > input.now) {
    return {
      canStart: false,
      reason: 'NOT_YET_AVAILABLE',
      retryAt: input.availableFrom.toISOString(),
    };
  }
  if (input.deadlineAt && input.deadlineAt < input.now) {
    return {
      canStart: false,
      reason: 'DEADLINE_PASSED',
      retryAt: null,
    };
  }
  if (
    input.attempts.some((attempt) =>
      TRAINING_ACTIVE_ATTEMPT_STATUSES.includes(
        attempt.status as (typeof TRAINING_ACTIVE_ATTEMPT_STATUSES)[number],
      ),
    )
  ) {
    return {
      canStart: false,
      reason: 'ATTEMPT_IN_PROGRESS',
      retryAt: null,
    };
  }
  const consumed = input.attempts.filter((attempt) => attempt.isConsumed);
  if (consumed.length >= input.attemptLimit) {
    return {
      canStart: false,
      reason: 'ATTEMPT_LIMIT_REACHED',
      retryAt: null,
    };
  }
  if (
    !input.allowRetakeAfterPass &&
    consumed.some(
      (attempt) =>
        attempt.passStatus === TrainingPassStatus.PASSED &&
        attempt.finalScore !== null &&
        attempt.reviewStatus !== TrainingReviewStatus.PENDING,
    )
  ) {
    return {
      canStart: false,
      reason: 'ALREADY_PASSED',
      retryAt: null,
    };
  }
  const latest = [...consumed].sort(
    (left, right) => right.startedAt.getTime() - left.startedAt.getTime(),
  )[0];
  if (latest) {
    const cooldownStartedAt = latest.completedAt ?? latest.startedAt;
    const retryAt = new Date(
      cooldownStartedAt.getTime() + input.cooldownMinutes * 60_000,
    );
    if (input.now < retryAt) {
      return {
        canStart: false,
        reason: 'COOLDOWN_ACTIVE',
        retryAt: retryAt.toISOString(),
      };
    }
  }
  if (!input.telegramConnected) {
    return {
      canStart: false,
      reason: 'TELEGRAM_NOT_CONNECTED',
      retryAt: null,
    };
  }
  return { canStart: true, reason: 'AVAILABLE', retryAt: null };
}

function userProjectKey(userId: string, projectId: string) {
  return `${userId}:${projectId}`;
}

function buildTimeline(attempt: {
  startedAt: Date;
  completedAt: Date | null;
  attemptQuestions: Array<{
    sequence: number;
    presentedAt: Date | null;
    firstSegmentAt: Date | null;
    finishedAt: Date | null;
    answer: {
      processingStartedAt: Date | null;
      processingFinishedAt: Date | null;
    } | null;
  }>;
}) {
  const events = [
    {
      at: attempt.startedAt,
      kind: 'ATTEMPT_STARTED',
      label: 'Попытка начата',
    },
    ...attempt.attemptQuestions.flatMap((question) => [
      ...(question.presentedAt
        ? [
            {
              at: question.presentedAt,
              kind: 'QUESTION_PRESENTED',
              label: `Вопрос ${question.sequence} показан`,
            },
          ]
        : []),
      ...(question.firstSegmentAt
        ? [
            {
              at: question.firstSegmentAt,
              kind: 'ANSWER_STARTED',
              label: `Ответ ${question.sequence} начат`,
            },
          ]
        : []),
      ...(question.finishedAt
        ? [
            {
              at: question.finishedAt,
              kind: 'ANSWER_FINISHED',
              label: `Ответ ${question.sequence} завершён`,
            },
          ]
        : []),
      ...(question.answer?.processingStartedAt
        ? [
            {
              at: question.answer.processingStartedAt,
              kind: 'ANSWER_PROCESSING_STARTED',
              label: `Обработка ответа ${question.sequence} начата`,
            },
          ]
        : []),
      ...(question.answer?.processingFinishedAt
        ? [
            {
              at: question.answer.processingFinishedAt,
              kind: 'ANSWER_PROCESSING_FINISHED',
              label: `Обработка ответа ${question.sequence} завершена`,
            },
          ]
        : []),
    ]),
    ...(attempt.completedAt
      ? [
          {
            at: attempt.completedAt,
            kind: 'ATTEMPT_COMPLETED',
            label: 'Попытка завершена',
          },
        ]
      : []),
  ];
  return events
    .sort((left, right) => left.at.getTime() - right.at.getTime())
    .map((event) => ({
      ...event,
      at: event.at.toISOString(),
    }));
}

function pagination(
  page: number,
  pageSize: number,
  total: number,
): TrainingPagination {
  return {
    page,
    pageSize,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
  };
}

function isFinalReviewedAttempt(attempt: {
  status: TrainingAttemptStatus;
  finalScore: Prisma.Decimal | null;
  reviewStatus: TrainingReviewStatus;
}) {
  return (
    FINAL_ATTEMPT_STATUSES.includes(
      attempt.status as (typeof FINAL_ATTEMPT_STATUSES)[number],
    ) &&
    attempt.finalScore !== null &&
    attempt.reviewStatus !== TrainingReviewStatus.PENDING
  );
}

function compareFinalScore(
  left: { finalScore: Prisma.Decimal | null; completedAt: Date | null },
  right: { finalScore: Prisma.Decimal | null; completedAt: Date | null },
) {
  const score = Number(right.finalScore ?? 0) - Number(left.finalScore ?? 0);
  if (score !== 0) return score;
  return compareDateAscending(left.completedAt, right.completedAt);
}

function compareCompletedNewest(
  left: { completedAt: Date | null },
  right: { completedAt: Date | null },
) {
  return (right.completedAt?.getTime() ?? 0) -
    (left.completedAt?.getTime() ?? 0);
}

function compareDateAscending(left: Date | null, right: Date | null) {
  return (
    (left?.getTime() ?? Number.MAX_SAFE_INTEGER) -
    (right?.getTime() ?? Number.MAX_SAFE_INTEGER)
  );
}

function decimalToString(value: Prisma.Decimal | null | undefined) {
  return value?.toString() ?? null;
}

function toIso(value: Date | null | undefined) {
  return value?.toISOString() ?? null;
}
