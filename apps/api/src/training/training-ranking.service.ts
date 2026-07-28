import { Injectable } from '@nestjs/common';
import {
  Prisma,
  TrainingAttemptStatus,
  TrainingFactVerdict,
  TrainingPassStatus,
  TrainingReviewStatus,
  UserStatus,
} from '@prisma/client';
import type {
  TrainingRankingItem,
  TrainingRankingProjectResult,
  TrainingRankingResponse,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

import { PrismaService } from '../prisma/prisma.service';

export type TrainingRankingFilters = {
  page: number;
  pageSize: number;
  user?: string;
  projectId?: string;
};

type NarrativeInput = {
  completedProjectsCount: number;
  passedProjectsCount: number;
  averageBestScore: string | null;
  projects: Array<{
    projectTitle: string;
    finalScore: string;
    components: Array<{
      title: string;
      awardedPoints: string;
      maxPoints: string;
    }>;
    errors: string[];
    unsupportedClaims: string[];
    scoreChangeFromFirst: string | null;
  }>;
};

const rankingAttemptSelect = {
  id: true,
  attemptNumber: true,
  userId: true,
  projectId: true,
  status: true,
  isConsumed: true,
  completedAt: true,
  totalDurationSeconds: true,
  finalScore: true,
  passStatus: true,
  reviewStatus: true,
  summary: true,
  project: {
    select: {
      id: true,
      title: true,
    },
  },
  attemptQuestions: {
    select: {
      answer: {
        select: {
          activeEvaluation: {
            select: {
              scoreComponents: {
                orderBy: { componentKey: 'asc' },
                select: {
                  componentKey: true,
                  title: true,
                  awardedPoints: true,
                  maxPoints: true,
                  factVerdict: true,
                  criterion: { select: { code: true, title: true } },
                  fact: { select: { code: true } },
                },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.TrainingAttemptSelect;

@Injectable()
export class TrainingRankingService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    filters: TrainingRankingFilters,
  ): Promise<TrainingRankingResponse> {
    const users = await this.prisma.user.findMany({
      where: {
        status: UserStatus.ACTIVE,
        deletedAt: null,
        role: {
          permissions: {
            some: {
              permission: { key: 'training:take' },
            },
          },
        },
        ...(filters.user
          ? {
              OR: [
                { name: { contains: filters.user, mode: 'insensitive' } },
                { email: { contains: filters.user, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        name: true,
        email: true,
      },
    });
    const [attempts, usageCounts, projects] = users.length
      ? await Promise.all([
          this.prisma.trainingAttempt.findMany({
            where: {
              userId: { in: users.map((user) => user.id) },
              ...(filters.projectId
                ? { projectId: filters.projectId }
                : {}),
              isConsumed: true,
              status: {
                in: [
                  TrainingAttemptStatus.COMPLETED,
                  TrainingAttemptStatus.REQUIRES_REVIEW,
                ],
              },
              finalScore: { not: null },
              completedAt: { not: null },
              reviewStatus: { not: TrainingReviewStatus.PENDING },
              passStatus: { not: TrainingPassStatus.PENDING },
            },
            select: rankingAttemptSelect,
          }),
          this.prisma.trainingAttempt.groupBy({
            by: ['userId', 'projectId'],
            where: {
              userId: { in: users.map((user) => user.id) },
              ...(filters.projectId
                ? { projectId: filters.projectId }
                : {}),
              isConsumed: true,
            },
            _count: { _all: true },
          }),
          this.listProjects(filters.projectId),
        ])
      : [[], [], await this.listProjects(filters.projectId)];

    const attemptsByUser = new Map<string, typeof attempts>();
    for (const attempt of attempts) {
      const current = attemptsByUser.get(attempt.userId) ?? [];
      current.push(attempt);
      attemptsByUser.set(attempt.userId, current);
    }
    const attemptsUsedByUserProject = new Map(
      usageCounts.map((item) => [
        userProjectKey(item.userId, item.projectId),
        item._count._all,
      ]),
    );
    const sorted = users
      .map((user) =>
        buildRankingItem(
          user,
          attemptsByUser.get(user.id) ?? [],
          attemptsUsedByUserProject,
        ),
      )
      .sort(compareRankingItems);
    const start = (filters.page - 1) * filters.pageSize;
    const items = sorted
      .slice(start, start + filters.pageSize)
      .map((item, index) => ({
        ...item,
        position: start + index + 1,
      }));

    return {
      items,
      pagination: {
        page: filters.page,
        pageSize: filters.pageSize,
        total: sorted.length,
        totalPages:
          sorted.length === 0
            ? 0
            : Math.ceil(sorted.length / filters.pageSize),
      },
      projects,
    };
  }

  async listForExport(filters: Omit<TrainingRankingFilters, 'page' | 'pageSize'>) {
    const first = await this.list({
      ...filters,
      page: 1,
      pageSize: 100,
    });
    if (first.pagination.total <= 100) return first;
    return this.list({
      ...filters,
      page: 1,
      pageSize: first.pagination.total,
    });
  }

  private listProjects(projectId?: string) {
    return this.prisma.trainingProject.findMany({
      where: {
        archivedAt: null,
        ...(projectId ? { id: projectId } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }, { id: 'asc' }],
      select: { id: true, title: true },
    });
  }
}

export function buildTrainingRankingNarrative(
  input: NarrativeInput,
): string {
  if (input.completedProjectsCount < 2) {
    return 'Недостаточно завершённых аттестаций для общей расшифровки.';
  }
  const components = input.projects.flatMap((project) =>
    project.components.map((component) => ({
      ...component,
      ratio:
        Number(component.maxPoints) > 0
          ? Number(component.awardedPoints) / Number(component.maxPoints)
          : 0,
    })),
  );
  const strongest = [...components].sort(
    (left, right) =>
      right.ratio - left.ratio || left.title.localeCompare(right.title, 'ru'),
  )[0];
  const weakest = [...components].sort(
    (left, right) =>
      left.ratio - right.ratio || left.title.localeCompare(right.title, 'ru'),
  )[0];
  const errors = input.projects.flatMap((project) => project.errors);
  const unsupported = input.projects.flatMap(
    (project) => project.unsupportedClaims,
  );
  const parts = [
    `Завершено проектов: ${input.completedProjectsCount}, пройдено: ${input.passedProjectsCount}, средний лучший балл: ${input.averageBestScore ?? '—'}.`,
  ];
  if (strongest) {
    parts.push(`Сильная сторона: ${strongest.title}.`);
  }
  if (weakest && weakest.title !== strongest?.title) {
    parts.push(`Зона внимания: ${weakest.title}.`);
  }
  if (errors.length) {
    parts.push(`Ошибок в лучших попытках: ${errors.length}.`);
  }
  if (unsupported.length) {
    parts.push(
      `Фактов сверх утверждённого материала: ${unsupported.length}.`,
    );
  }
  const scoreChanges = input.projects
    .map((project) => project.scoreChangeFromFirst)
    .filter((value): value is string => value !== null)
    .map(Number);
  if (scoreChanges.length) {
    const averageChange =
      scoreChanges.reduce((sum, value) => sum + value, 0) /
      scoreChanges.length;
    const formatted =
      averageChange > 0
        ? `+${averageChange.toFixed(2)}`
        : averageChange.toFixed(2);
    parts.push(
      `Средняя динамика от первой до лучшей попытки: ${formatted} по ${scoreChanges.length} проектам.`,
    );
  }
  return parts.join(' ');
}

function buildRankingItem(
  user: {
    id: string;
    name: string | null;
    email: string;
  },
  attempts: Array<
    Prisma.TrainingAttemptGetPayload<{
      select: typeof rankingAttemptSelect;
    }>
  >,
  attemptsUsedByUserProject: Map<string, number>,
): Omit<TrainingRankingItem, 'position'> {
  const finalized = attempts.filter(isEligibleFinalAttempt);
  const finalizedByProject = new Map<string, typeof finalized>();
  for (const attempt of finalized) {
    const current = finalizedByProject.get(attempt.projectId) ?? [];
    current.push(attempt);
    finalizedByProject.set(attempt.projectId, current);
  }
  const bestByProject = new Map<string, (typeof finalized)[number]>();
  for (const attempt of finalized) {
    const current = bestByProject.get(attempt.projectId);
    if (!current || compareBestAttempts(attempt, current) < 0) {
      bestByProject.set(attempt.projectId, attempt);
    }
  }
  const projects = [...bestByProject.values()]
    .sort(
      (left, right) =>
        left.project.title.localeCompare(right.project.title, 'ru') ||
        left.projectId.localeCompare(right.projectId),
    )
    .map((attempt) => {
      const projectAttempts = finalizedByProject.get(attempt.projectId) ?? [];
      const first = [...projectAttempts].sort(compareFirstAttempts)[0];
      return serializeProjectResult(
        attempt,
        first,
        attemptsUsedByUserProject.get(
          userProjectKey(user.id, attempt.projectId),
        ) ?? 0,
        projectAttempts.length > 1,
      );
    });
  const passedProjectsCount = projects.filter(
    (project) => project.passStatus === TrainingPassStatus.PASSED,
  ).length;
  const completedProjectsCount = projects.length;
  const averageBestScore =
    projects.length > 0
      ? (
          projects.reduce(
            (sum, project) => sum + Number(project.finalScore),
            0,
          ) / projects.length
        ).toFixed(2)
      : null;
  const completedDurations = finalized
    .map((attempt) => attempt.totalDurationSeconds)
    .filter((value): value is number => value !== null);
  const totalDurationSeconds = completedDurations.reduce(
    (sum, value) => sum + value,
    0,
  );
  const lastCompletedAt =
    finalized
      .map((attempt) => attempt.completedAt)
      .filter((value): value is Date => value !== null)
      .sort((left, right) => right.getTime() - left.getTime())[0] ?? null;
  const narrativeInput: NarrativeInput = {
    completedProjectsCount,
    passedProjectsCount,
    averageBestScore,
    projects,
  };
  const attemptsUsed = [...attemptsUsedByUserProject.entries()].reduce(
    (sum, [key, count]) =>
      key.startsWith(`${user.id}:`) ? sum + count : sum,
    0,
  );

  return {
    user,
    passedProjectsCount,
    completedProjectsCount,
    averageBestScore,
    attemptsUsed,
    lastCompletedAt: lastCompletedAt?.toISOString() ?? null,
    totalDurationSeconds,
    averageDurationSeconds:
      completedDurations.length > 0
        ? Math.round(totalDurationSeconds / completedDurations.length)
        : null,
    narrative: buildTrainingRankingNarrative(narrativeInput),
    projects,
  };
}

function serializeProjectResult(
  attempt: Prisma.TrainingAttemptGetPayload<{
    select: typeof rankingAttemptSelect;
  }>,
  firstAttempt: Prisma.TrainingAttemptGetPayload<{
    select: typeof rankingAttemptSelect;
  }> | undefined,
  attemptsUsed: number,
  hasMultipleFinalizedAttempts: boolean,
): TrainingRankingProjectResult {
  const rawComponents = attempt.attemptQuestions.flatMap(
    (question) =>
      question.answer?.activeEvaluation?.scoreComponents ?? [],
  );
  const criteria = new Map<
    string,
    { key: string; title: string; awarded: number; maximum: number }
  >();
  for (const component of rawComponents) {
    if (!component.criterion) continue;
    const key = component.criterion.code;
    const current = criteria.get(key) ?? {
      key,
      title:
        component.criterion.title ?? component.title ?? component.componentKey,
      awarded: 0,
      maximum: 0,
    };
    current.awarded += Number(component.awardedPoints);
    current.maximum += Number(component.maxPoints);
    criteria.set(key, current);
  }
  const describe = (component: (typeof rawComponents)[number]) =>
    component.title ??
    component.fact?.code ??
    component.criterion?.title ??
    component.componentKey;

  return {
    attemptId: attempt.id,
    attemptNumber: attempt.attemptNumber,
    projectId: attempt.projectId,
    projectTitle: attempt.project.title,
    finalScore: attempt.finalScore!.toString(),
    passStatus: attempt.passStatus,
    completedAt: attempt.completedAt!.toISOString(),
    attemptsUsed,
    summary: attempt.summary,
    scoreChangeFromFirst:
      firstAttempt && hasMultipleFinalizedAttempts
        ? (
            Number(attempt.finalScore) -
            Number(firstAttempt.finalScore)
          ).toFixed(2)
        : null,
    components: [...criteria.values()]
      .sort((left, right) => left.title.localeCompare(right.title, 'ru'))
      .map((component) => ({
        key: component.key,
        title: component.title,
        awardedPoints: component.awarded.toFixed(2),
        maxPoints: component.maximum.toFixed(2),
      })),
    errors: rawComponents
      .filter(
        (component) =>
          component.factVerdict === TrainingFactVerdict.INCORRECT ||
          component.factVerdict === TrainingFactVerdict.MISSING,
      )
      .map(describe),
    unsupportedClaims: rawComponents
      .filter(
        (component) =>
          component.factVerdict === TrainingFactVerdict.UNSUPPORTED,
      )
      .map(describe),
  };
}

function isEligibleFinalAttempt(
  attempt: Prisma.TrainingAttemptGetPayload<{
    select: typeof rankingAttemptSelect;
  }>,
) {
  return (
    attempt.isConsumed &&
    (attempt.status === TrainingAttemptStatus.COMPLETED ||
      attempt.status === TrainingAttemptStatus.REQUIRES_REVIEW) &&
    attempt.finalScore !== null &&
    attempt.completedAt !== null &&
    attempt.reviewStatus !== TrainingReviewStatus.PENDING &&
    attempt.passStatus !== TrainingPassStatus.PENDING
  );
}

function compareBestAttempts(
  left: Prisma.TrainingAttemptGetPayload<{
    select: typeof rankingAttemptSelect;
  }>,
  right: Prisma.TrainingAttemptGetPayload<{
    select: typeof rankingAttemptSelect;
  }>,
) {
  const scoreDifference =
    Number(right.finalScore ?? 0) - Number(left.finalScore ?? 0);
  if (scoreDifference !== 0) return scoreDifference;
  const completedDifference =
    (left.completedAt?.getTime() ?? Number.MAX_SAFE_INTEGER) -
    (right.completedAt?.getTime() ?? Number.MAX_SAFE_INTEGER);
  return completedDifference || left.id.localeCompare(right.id);
}

function compareFirstAttempts(
  left: Prisma.TrainingAttemptGetPayload<{
    select: typeof rankingAttemptSelect;
  }>,
  right: Prisma.TrainingAttemptGetPayload<{
    select: typeof rankingAttemptSelect;
  }>,
) {
  return (
    (left.completedAt?.getTime() ?? Number.MAX_SAFE_INTEGER) -
      (right.completedAt?.getTime() ?? Number.MAX_SAFE_INTEGER) ||
    left.id.localeCompare(right.id)
  );
}

function compareRankingItems(
  left: Omit<TrainingRankingItem, 'position'>,
  right: Omit<TrainingRankingItem, 'position'>,
) {
  return (
    right.passedProjectsCount - left.passedProjectsCount ||
    right.completedProjectsCount - left.completedProjectsCount ||
    compareNullableNumberDesc(
      left.averageBestScore,
      right.averageBestScore,
    ) ||
    compareNullableDateAsc(left.lastCompletedAt, right.lastCompletedAt) ||
    (left.user.name ?? '').localeCompare(right.user.name ?? '', 'ru') ||
    left.user.email.localeCompare(right.user.email, 'ru') ||
    left.user.id.localeCompare(right.user.id)
  );
}

function compareNullableNumberDesc(
  left: string | null,
  right: string | null,
) {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return Number(right) - Number(left);
}

function compareNullableDateAsc(left: string | null, right: string | null) {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return Date.parse(left) - Date.parse(right);
}

function userProjectKey(userId: string, projectId: string) {
  return `${userId}:${projectId}`;
}
