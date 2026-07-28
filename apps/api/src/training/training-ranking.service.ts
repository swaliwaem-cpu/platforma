import { Injectable } from '@nestjs/common';
import {
  Prisma,
  TrainingAttemptStatus,
  TrainingFactVerdict,
  TrainingPassStatus,
  TrainingReviewStatus,
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

type RankingPageRow = {
  userId: string;
  userName: string | null;
  userEmail: string;
  passedProjectsCount: number;
  completedProjectsCount: number;
  averageBestScore: string | null;
  attemptsUsed: number;
  lastCompletedAt: Date | null;
  totalDurationSeconds: bigint;
  averageDurationSeconds: number | null;
  bestAttemptIds: string[];
  position: bigint;
  total: bigint;
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

const eligibleFinalAttemptWhere = {
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
} satisfies Prisma.TrainingAttemptWhereInput;

@Injectable()
export class TrainingRankingService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    filters: TrainingRankingFilters,
  ): Promise<TrainingRankingResponse> {
    const start = (filters.page - 1) * filters.pageSize;
    const pageRows = await this.prisma.$queryRaw<RankingPageRow[]>(
      buildTrainingRankingPageQuery(filters, start),
    );
    const total = pageRows[0] ? toSafeNumber(pageRows[0].total) : 0;
    const userIds = pageRows.map((row) => row.userId);
    const [attempts, usageCounts, projects] = await Promise.all([
      userIds.length
        ? this.prisma.trainingAttempt.findMany({
            where: {
              userId: { in: userIds },
              ...(filters.projectId
                ? { projectId: filters.projectId }
                : {}),
              ...eligibleFinalAttemptWhere,
            },
            select: rankingAttemptSelect,
          })
        : Promise.resolve([]),
      userIds.length
        ? this.prisma.trainingAttempt.groupBy({
            by: ['userId', 'projectId'],
            where: {
              userId: { in: userIds },
              ...(filters.projectId
                ? { projectId: filters.projectId }
                : {}),
              isConsumed: true,
            },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      this.listProjects(filters.projectId),
    ]);
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
    const items = pageRows.map((row) =>
      buildRankingItemFromPageRow(
        row,
        attemptsByUser.get(row.userId) ?? [],
        attemptsUsedByUserProject,
      ),
    );

    return {
      items,
      pagination: {
        page: filters.page,
        pageSize: filters.pageSize,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / filters.pageSize),
      },
      projects,
    };
  }

  async listForExport(
    filters: Omit<TrainingRankingFilters, 'page' | 'pageSize'>,
  ) {
    const items: TrainingRankingItem[] = [];
    let projects: TrainingRankingResponse['projects'] = [];
    let total = 0;
    let page = 1;
    do {
      const batch = await this.list({
        ...filters,
        page,
        pageSize: 100,
      });
      if (page === 1) {
        projects = batch.projects;
        total = batch.pagination.total;
      }
      items.push(...batch.items);
      if (!batch.items.length) break;
      page += 1;
    } while (items.length < total);
    return {
      items,
      projects,
      pagination: {
        page: 1,
        pageSize: items.length,
        total,
        totalPages: total === 0 ? 0 : 1,
      },
    };
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

export function buildTrainingRankingPageQuery(
  filters: TrainingRankingFilters,
  offset: number,
) {
  const searchPattern = filters.user
    ? `%${escapeLikePattern(filters.user)}%`
    : null;
  const searchCondition = searchPattern
    ? Prisma.sql`
        AND (
          COALESCE(u."name", '') ILIKE ${searchPattern} ESCAPE '\'
          OR u."email" ILIKE ${searchPattern} ESCAPE '\'
        )
      `
    : Prisma.sql``;
  const projectAttemptCondition = filters.projectId
    ? Prisma.sql`AND ta."project_id" = ${filters.projectId}::uuid`
    : Prisma.sql``;
  const projectUserCondition = filters.projectId
    ? Prisma.sql`WHERE COALESCE(bm."completedProjectsCount", 0) > 0`
    : Prisma.sql``;

  return Prisma.sql`
    WITH eligible_users AS (
      SELECT
        u."id",
        u."name",
        u."email"
      FROM "users" u
      INNER JOIN "role_permissions" rp
        ON rp."role_id" = u."role_id"
      INNER JOIN "permissions" p
        ON p."id" = rp."permission_id"
       AND p."key" = 'training:take'
      WHERE u."status"::text = 'active'
        AND u."deleted_at" IS NULL
        ${searchCondition}
    ),
    eligible_attempts AS (
      SELECT
        ta."id",
        ta."user_id",
        ta."project_id",
        ta."final_score",
        ta."pass_status",
        ta."completed_at",
        ta."total_duration_seconds",
        ROW_NUMBER() OVER (
          PARTITION BY ta."user_id", ta."project_id"
          ORDER BY
            ta."final_score" DESC,
            ta."completed_at" ASC,
            ta."id" ASC
        ) AS "bestRank"
      FROM "training_attempts" ta
      INNER JOIN eligible_users eu
        ON eu."id" = ta."user_id"
      WHERE ta."is_consumed" = TRUE
        AND ta."status"::text IN ('completed', 'requires_review')
        AND ta."final_score" IS NOT NULL
        AND ta."completed_at" IS NOT NULL
        AND ta."review_status"::text <> 'pending'
        AND ta."pass_status"::text <> 'pending'
        ${projectAttemptCondition}
    ),
    best_attempts AS (
      SELECT *
      FROM eligible_attempts
      WHERE "bestRank" = 1
    ),
    best_metrics AS (
      SELECT
        ba."user_id",
        COUNT(*)::integer AS "completedProjectsCount",
        COUNT(*) FILTER (
          WHERE ba."pass_status"::text = 'passed'
        )::integer AS "passedProjectsCount",
        AVG(ba."final_score") AS "averageBestScoreExact",
        ROUND(AVG(ba."final_score"), 2)::text AS "averageBestScore",
        ARRAY_AGG(ba."id" ORDER BY ba."project_id") AS "bestAttemptIds"
      FROM best_attempts ba
      GROUP BY ba."user_id"
    ),
    final_metrics AS (
      SELECT
        ea."user_id",
        MAX(ea."completed_at") AS "lastCompletedAt",
        COALESCE(SUM(ea."total_duration_seconds"), 0)::bigint
          AS "totalDurationSeconds",
        ROUND(AVG(ea."total_duration_seconds"))::integer
          AS "averageDurationSeconds"
      FROM eligible_attempts ea
      GROUP BY ea."user_id"
    ),
    usage_metrics AS (
      SELECT
        ta."user_id",
        COUNT(*)::integer AS "attemptsUsed"
      FROM "training_attempts" ta
      INNER JOIN eligible_users eu
        ON eu."id" = ta."user_id"
      WHERE ta."is_consumed" = TRUE
        ${projectAttemptCondition}
      GROUP BY ta."user_id"
    ),
    user_aggregates AS (
      SELECT
        eu."id" AS "userId",
        eu."name" AS "userName",
        eu."email" AS "userEmail",
        COALESCE(bm."passedProjectsCount", 0)::integer
          AS "passedProjectsCount",
        COALESCE(bm."completedProjectsCount", 0)::integer
          AS "completedProjectsCount",
        bm."averageBestScoreExact",
        bm."averageBestScore",
        COALESCE(um."attemptsUsed", 0)::integer AS "attemptsUsed",
        fm."lastCompletedAt",
        COALESCE(fm."totalDurationSeconds", 0)::bigint
          AS "totalDurationSeconds",
        fm."averageDurationSeconds",
        COALESCE(bm."bestAttemptIds", ARRAY[]::uuid[]) AS "bestAttemptIds"
      FROM eligible_users eu
      LEFT JOIN best_metrics bm
        ON bm."user_id" = eu."id"
      LEFT JOIN final_metrics fm
        ON fm."user_id" = eu."id"
      LEFT JOIN usage_metrics um
        ON um."user_id" = eu."id"
      ${projectUserCondition}
    ),
    ranked_users AS (
      SELECT
        ua.*,
        ROW_NUMBER() OVER (
          ORDER BY
            ua."passedProjectsCount" DESC,
            ua."completedProjectsCount" DESC,
            ua."averageBestScoreExact" DESC NULLS LAST,
            ua."lastCompletedAt" ASC NULLS LAST,
            ua."userId" ASC
        ) AS "position",
        COUNT(*) OVER () AS "total"
      FROM user_aggregates ua
    )
    SELECT
      "userId",
      "userName",
      "userEmail",
      "passedProjectsCount",
      "completedProjectsCount",
      "averageBestScore",
      "attemptsUsed",
      "lastCompletedAt",
      "totalDurationSeconds",
      "averageDurationSeconds",
      "bestAttemptIds",
      "position",
      "total"
    FROM ranked_users
    ORDER BY "position"
    LIMIT ${filters.pageSize}
    OFFSET ${offset}
  `;
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

type RankingAttempt = Prisma.TrainingAttemptGetPayload<{
  select: typeof rankingAttemptSelect;
}>;

function buildRankingItemFromPageRow(
  row: RankingPageRow,
  attempts: RankingAttempt[],
  attemptsUsedByUserProject: Map<string, number>,
): TrainingRankingItem {
  const finalized = attempts.filter(isEligibleFinalAttempt);
  const finalizedByProject = new Map<string, typeof finalized>();
  const attemptsById = new Map(finalized.map((attempt) => [attempt.id, attempt]));
  for (const attempt of finalized) {
    const current = finalizedByProject.get(attempt.projectId) ?? [];
    current.push(attempt);
    finalizedByProject.set(attempt.projectId, current);
  }
  const projects = row.bestAttemptIds
    .map((attemptId) => attemptsById.get(attemptId))
    .filter((attempt): attempt is RankingAttempt => Boolean(attempt))
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
          userProjectKey(row.userId, attempt.projectId),
        ) ?? 0,
        projectAttempts.length > 1,
      );
    });
  const narrativeInput: NarrativeInput = {
    completedProjectsCount: row.completedProjectsCount,
    passedProjectsCount: row.passedProjectsCount,
    averageBestScore: row.averageBestScore,
    projects,
  };

  return {
    position: toSafeNumber(row.position),
    user: {
      id: row.userId,
      name: row.userName,
      email: row.userEmail,
    },
    passedProjectsCount: row.passedProjectsCount,
    completedProjectsCount: row.completedProjectsCount,
    averageBestScore: row.averageBestScore,
    attemptsUsed: row.attemptsUsed,
    lastCompletedAt: row.lastCompletedAt?.toISOString() ?? null,
    totalDurationSeconds: toSafeNumber(row.totalDurationSeconds),
    averageDurationSeconds: row.averageDurationSeconds,
    narrative: buildTrainingRankingNarrative(narrativeInput),
    projects,
  };
}

function serializeProjectResult(
  attempt: RankingAttempt,
  firstAttempt: RankingAttempt | undefined,
  attemptsUsed: number,
  hasMultipleFinalizedAttempts: boolean,
): TrainingRankingProjectResult {
  const rawComponents = attempt.attemptQuestions.flatMap(
    (question) =>
      question.answer?.activeEvaluation?.scoreComponents ?? [],
  );
  const criteria = new Map<
    string,
    {
      key: string;
      title: string;
      awarded: Prisma.Decimal;
      maximum: Prisma.Decimal;
    }
  >();
  for (const component of rawComponents) {
    if (!component.criterion) continue;
    const key = component.criterion.code;
    const current = criteria.get(key) ?? {
      key,
      title:
        component.criterion.title ?? component.title ?? component.componentKey,
      awarded: new Prisma.Decimal(0),
      maximum: new Prisma.Decimal(0),
    };
    current.awarded = current.awarded.add(component.awardedPoints);
    current.maximum = current.maximum.add(component.maxPoints);
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
        ? attempt.finalScore!.sub(firstAttempt.finalScore!).toFixed(2)
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

function compareFirstAttempts(
  left: RankingAttempt,
  right: RankingAttempt,
) {
  return (
    (left.completedAt?.getTime() ?? Number.MAX_SAFE_INTEGER) -
      (right.completedAt?.getTime() ?? Number.MAX_SAFE_INTEGER) ||
    left.id.localeCompare(right.id)
  );
}

function userProjectKey(userId: string, projectId: string) {
  return `${userId}:${projectId}`;
}

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

function toSafeNumber(value: bigint) {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted)) {
    throw new RangeError('Training ranking aggregate exceeds safe integer range');
  }
  return converted;
}
