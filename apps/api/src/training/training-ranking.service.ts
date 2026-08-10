import { Injectable } from '@nestjs/common';
import { Prisma, TrainingProjectAccessMode } from '@prisma/client';
import type {
  TrainingAdminRankingResponse,
  TrainingAdminRankingRow,
  TrainingAssignmentStatus,
  TrainingRankingCriterionSummary,
  TrainingRankingProjectResult,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

import { PrismaService } from '../prisma/prisma.service';
import { TrainingAttemptStateService } from './training-attempt-state.service';
import { TrainingProjectAccessService } from './training-project-access.service';
import {
  isTrainingProjectSnapshotWithFacts,
  parseTrainingProjectSnapshot,
} from './training-snapshot';

export type TrainingAdminRankingQueryInput = {
  page: number;
  limit: number;
  search: string | null;
  project: string | null;
  accessMode: TrainingProjectAccessMode | null;
  currentlyAssigned: boolean | null;
  currentlyEligible: boolean | null;
};

type RankingCoreRow = {
  userId: string;
  userEmail: string;
  userName: string | null;
  passedProjectsCount: bigint;
  completedProjectsCount: bigint;
  averageBestScoreExact: Prisma.Decimal | null;
  attemptsUsed: bigint;
  lastCompletedAt: Date | null;
  totalDurationSeconds: bigint;
  averageDurationSecondsExact: Prisma.Decimal | null;
  currentEligibleProjectsCount: bigint;
  currentCompletedEligibleProjectsCount: bigint;
  currentPassedEligibleProjectsCount: bigint;
  currentCoveragePercentExact: Prisma.Decimal | null;
  allParticipantsProjectsCount: bigint;
  assignedProjectsCount: bigint;
  activeAssignmentsCount: bigint;
  total: bigint;
};

type RankingDetailRow = {
  attemptId: string;
  userId: string;
  projectId: string;
  projectTitle: string;
  accessMode: string;
  assignmentStatus: TrainingAssignmentStatus;
  currentlyEligible: boolean;
  finalScore: number;
  isPassed: boolean;
  completedAt: Date;
  durationSeconds: number;
  reviewDecision: string | null;
  projectSnapshotJson: unknown;
  evaluations: unknown;
};

type CsvDetailRow = {
  userId: string;
  attemptId: string;
  projectId: string;
  projectTitle: string;
  finalScore: number;
  isPassed: boolean;
  factualErrorsCount: bigint;
  unsupportedClaimsCount: bigint;
  harmlessExtraClaimsCount: bigint;
  reviewRequiredClaimsCount: bigint;
};

type CriterionAggregate = {
  code: string;
  title: string;
  awardedPoints: number;
  maxPoints: number;
};

const CSV_BATCH_SIZE = 100;

@Injectable()
export class TrainingRankingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly attemptState: TrainingAttemptStateService,
    private readonly projectAccess: TrainingProjectAccessService,
  ) {}

  async listRanking(
    query: TrainingAdminRankingQueryInput,
  ): Promise<TrainingAdminRankingResponse> {
    await this.attemptState.finalizeExpiredAttempts();
    const rows = await this.loadCore(query);
    const details = await this.loadPageDetails(rows.map((row) => row.userId), query);
    const detailsByUser = groupBy(details, (detail) => detail.userId);
    const fallbackRows = rows.length === 0 && query.page > 1
      ? await this.loadCore({ ...query, page: 1, limit: 1 })
      : [];
    const total = toNumber(rows[0]?.total ?? fallbackRows[0]?.total ?? 0n);

    return {
      items: rows.map((row) => this.serializeRow(row, detailsByUser.get(row.userId) ?? [])),
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async exportCsv(query: TrainingAdminRankingQueryInput) {
    await this.attemptState.finalizeExpiredAttempts();
    const lines = [CSV_HEADERS.map(escapeTrainingRankingCsvCell).join(',')];
    let page = 1;
    let exported = 0;

    for (;;) {
      const batchQuery = { ...query, page, limit: CSV_BATCH_SIZE };
      const rows = await this.loadCore(batchQuery);
      if (!rows.length) break;
      const details = await this.loadCsvDetails(rows.map((row) => row.userId), query);
      const detailsByUser = groupBy(details, (detail) => detail.userId);

      for (const row of rows) {
        const rowDetails = detailsByUser.get(row.userId) ?? [];
        const factualErrors = rowDetails.reduce(
          (total, detail) => total + toNumber(detail.factualErrorsCount),
          0,
        );
        const unsupportedClaims = rowDetails.reduce(
          (total, detail) => total + toNumber(detail.unsupportedClaimsCount),
          0,
        );
        const harmlessExtraClaims = rowDetails.reduce(
          (total, detail) => total + toNumber(detail.harmlessExtraClaimsCount),
          0,
        );
        const reviewRequiredClaims = rowDetails.reduce(
          (total, detail) => total + toNumber(detail.reviewRequiredClaimsCount),
          0,
        );
        lines.push(serializeTrainingRankingCsv([
          row.userId,
          row.userName ?? '',
          row.userEmail,
          formatDecimal(row.averageBestScoreExact),
          toNumber(row.passedProjectsCount),
          toNumber(row.completedProjectsCount),
          toNumber(row.attemptsUsed),
          row.lastCompletedAt?.toISOString() ?? '',
          toNumber(row.totalDurationSeconds),
          formatDecimal(row.averageDurationSecondsExact),
          toNumber(row.currentEligibleProjectsCount),
          toNumber(row.currentCompletedEligibleProjectsCount),
          toNumber(row.currentPassedEligibleProjectsCount),
          formatDecimal(row.currentCoveragePercentExact),
          rowDetails.map((detail) =>
            `${detail.projectTitle}: ${detail.finalScore}/100 (${detail.isPassed ? 'passed' : 'failed'})`,
          ).join('; '),
          buildAccessSummary(row),
          factualErrors,
          unsupportedClaims,
          harmlessExtraClaims,
          reviewRequiredClaims,
        ]));
      }

      exported += rows.length;
      const total = toNumber(rows[0]?.total ?? 0n);
      if (exported >= total) break;
      page += 1;
    }

    return `\uFEFF${lines.join('\r\n')}\r\n`;
  }

  private async loadCore(query: TrainingAdminRankingQueryInput) {
    const scopedProjectsWhere = buildScopedProjectsWhere(query);
    const searchWhere = query.search
      ? Prisma.sql`(
          COALESCE(u."name", '') ILIKE ${likePattern(query.search)} ESCAPE '\\'
          OR u."email" ILIKE ${likePattern(query.search)} ESCAPE '\\'
        )`
      : Prisma.sql`TRUE`;
    const assignedWhere = query.currentlyAssigned === null
      ? Prisma.sql`TRUE`
      : query.currentlyAssigned
        ? Prisma.sql`COALESCE(active_assignments."count", 0) > 0`
        : Prisma.sql`COALESCE(active_assignments."count", 0) = 0`;
    const eligibleWhere = query.currentlyEligible === null
      ? Prisma.sql`TRUE`
      : query.currentlyEligible
        ? Prisma.sql`COALESCE(coverage."eligibleCount", 0) > 0`
        : Prisma.sql`COALESCE(coverage."eligibleCount", 0) = 0`;
    const offset = (query.page - 1) * query.limit;
    const eligibility = this.projectAccess.currentEligibilitySql();

    return this.prisma.$queryRaw<RankingCoreRow[]>(Prisma.sql`
      WITH scoped_projects AS (
        SELECT p."id", p."title", p."status", p."is_open", p."access_mode"
        FROM "training_projects" p
        WHERE ${scopedProjectsWhere}
      ),
      confirmed_attempts AS (
        SELECT
          ta."id",
          ta."user_id" AS "userId",
          ta."project_id" AS "projectId",
          ta."final_score" AS "finalScore",
          ta."is_passed" AS "isPassed",
          ta."started_at" AS "startedAt",
          ta."completed_at" AS "completedAt",
          GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (
            CASE WHEN ta."status"::text = 'timed_out' THEN ta."expires_at"
            ELSE ta."completed_at" END - ta."started_at"
          )))::int) AS "durationSeconds"
        FROM "training_attempts" ta
        JOIN scoped_projects p ON p."id" = ta."project_id"
        WHERE ta."status"::text IN ('completed', 'timed_out')
          AND ta."review_status"::text IN ('not_required', 'resolved')
          AND ta."counts_toward_attempt_limit" = TRUE
          AND ta."final_score" IS NOT NULL
          AND ta."is_passed" IS NOT NULL
          AND ta."completed_at" IS NOT NULL
      ),
      best_ranked AS (
        SELECT confirmed_attempts.*,
          ROW_NUMBER() OVER (
            PARTITION BY "userId", "projectId"
            ORDER BY "finalScore" DESC, "startedAt" DESC, "id" DESC
          ) AS "bestRank"
        FROM confirmed_attempts
      ),
      best_results AS (
        SELECT * FROM best_ranked WHERE "bestRank" = 1
      ),
      historical AS (
        SELECT
          "userId",
          COUNT(*)::bigint AS "completedProjectsCount",
          COUNT(*) FILTER (WHERE "isPassed")::bigint AS "passedProjectsCount",
          AVG("finalScore"::numeric) AS "averageBestScoreExact",
          MAX("completedAt") AS "lastCompletedAt",
          SUM("durationSeconds")::bigint AS "totalDurationSeconds",
          AVG("durationSeconds"::numeric) AS "averageDurationSecondsExact"
        FROM best_results
        GROUP BY "userId"
      ),
      attempts_used AS (
        SELECT ta."user_id" AS "userId", COUNT(*)::bigint AS "count"
        FROM "training_attempts" ta
        JOIN scoped_projects p ON p."id" = ta."project_id"
        WHERE ta."counts_toward_attempt_limit" = TRUE
        GROUP BY ta."user_id"
      ),
      eligible_pairs AS (
        SELECT u."id" AS "userId", p."id" AS "projectId", p."access_mode" AS "accessMode"
        FROM "users" u
        CROSS JOIN scoped_projects p
        WHERE ${eligibility}
      ),
      coverage AS (
        SELECT
          eligible_pairs."userId",
          COUNT(*)::bigint AS "eligibleCount",
          COUNT(best_results."id")::bigint AS "completedCount",
          COUNT(best_results."id") FILTER (WHERE best_results."isPassed")::bigint AS "passedCount",
          COUNT(*) FILTER (WHERE eligible_pairs."accessMode"::text = 'all_participants')::bigint
            AS "allParticipantsCount",
          COUNT(*) FILTER (WHERE eligible_pairs."accessMode"::text = 'assigned_users')::bigint
            AS "assignedCount"
        FROM eligible_pairs
        LEFT JOIN best_results
          ON best_results."userId" = eligible_pairs."userId"
          AND best_results."projectId" = eligible_pairs."projectId"
        GROUP BY eligible_pairs."userId"
      ),
      active_assignments AS (
        SELECT assignment."user_id" AS "userId", COUNT(*)::bigint AS "count"
        FROM "training_project_assignments" assignment
        JOIN scoped_projects p ON p."id" = assignment."project_id"
        WHERE assignment."revoked_at" IS NULL
        GROUP BY assignment."user_id"
      ),
      candidate_users AS (
        SELECT "userId" FROM historical
        UNION
        SELECT "userId" FROM coverage
      ),
      filtered_rows AS (
        SELECT
          u."id" AS "userId",
          u."email" AS "userEmail",
          u."name" AS "userName",
          COALESCE(historical."passedProjectsCount", 0)::bigint AS "passedProjectsCount",
          COALESCE(historical."completedProjectsCount", 0)::bigint AS "completedProjectsCount",
          historical."averageBestScoreExact",
          COALESCE(attempts_used."count", 0)::bigint AS "attemptsUsed",
          historical."lastCompletedAt",
          COALESCE(historical."totalDurationSeconds", 0)::bigint AS "totalDurationSeconds",
          historical."averageDurationSecondsExact",
          COALESCE(coverage."eligibleCount", 0)::bigint AS "currentEligibleProjectsCount",
          COALESCE(coverage."completedCount", 0)::bigint AS "currentCompletedEligibleProjectsCount",
          COALESCE(coverage."passedCount", 0)::bigint AS "currentPassedEligibleProjectsCount",
          CASE WHEN COALESCE(coverage."eligibleCount", 0) > 0
            THEN coverage."completedCount"::numeric * 100 / coverage."eligibleCount"::numeric
            ELSE NULL
          END AS "currentCoveragePercentExact",
          COALESCE(coverage."allParticipantsCount", 0)::bigint AS "allParticipantsProjectsCount",
          COALESCE(coverage."assignedCount", 0)::bigint AS "assignedProjectsCount",
          COALESCE(active_assignments."count", 0)::bigint AS "activeAssignmentsCount"
        FROM candidate_users
        JOIN "users" u ON u."id" = candidate_users."userId"
        LEFT JOIN historical ON historical."userId" = u."id"
        LEFT JOIN attempts_used ON attempts_used."userId" = u."id"
        LEFT JOIN coverage ON coverage."userId" = u."id"
        LEFT JOIN active_assignments ON active_assignments."userId" = u."id"
        WHERE ${searchWhere} AND ${assignedWhere} AND ${eligibleWhere}
      )
      SELECT filtered_rows.*, COUNT(*) OVER()::bigint AS "total"
      FROM filtered_rows
      ORDER BY
        "passedProjectsCount" DESC,
        "completedProjectsCount" DESC,
        "averageBestScoreExact" DESC NULLS LAST,
        "currentCoveragePercentExact" DESC NULLS LAST,
        "lastCompletedAt" ASC NULLS LAST,
        "userId" ASC
      LIMIT ${query.limit}
      OFFSET ${offset}
    `);
  }

  private async loadPageDetails(
    userIds: string[],
    query: TrainingAdminRankingQueryInput,
  ): Promise<RankingDetailRow[]> {
    if (!userIds.length) return [];
    const scopedProjectsWhere = buildScopedProjectsWhere(query);
    const eligibility = this.projectAccess.currentEligibilitySql();

    return this.prisma.$queryRaw<RankingDetailRow[]>(Prisma.sql`
      WITH scoped_projects AS (
        SELECT p."id", p."title", p."status", p."is_open", p."access_mode"
        FROM "training_projects" p
        WHERE ${scopedProjectsWhere}
      ),
      best_ranked AS (
        SELECT ta."id", ta."user_id" AS "userId", ta."project_id" AS "projectId",
          ta."final_score", ta."is_passed", ta."started_at", ta."completed_at",
          ta."expires_at", ta."status", ta."review_decision", ta."project_snapshot_json",
          ROW_NUMBER() OVER (
            PARTITION BY ta."user_id", ta."project_id"
            ORDER BY ta."final_score" DESC, ta."started_at" DESC, ta."id" DESC
          ) AS "bestRank"
        FROM "training_attempts" ta
        JOIN scoped_projects p ON p."id" = ta."project_id"
        WHERE ta."user_id" IN (${Prisma.join(userIds.map(uuidSql))})
          AND ta."status"::text IN ('completed', 'timed_out')
          AND ta."review_status"::text IN ('not_required', 'resolved')
          AND ta."counts_toward_attempt_limit" = TRUE
          AND ta."final_score" IS NOT NULL
          AND ta."is_passed" IS NOT NULL
          AND ta."completed_at" IS NOT NULL
      ),
      best_results AS (SELECT * FROM best_ranked WHERE "bestRank" = 1)
      SELECT
        best_results."id" AS "attemptId",
        best_results."userId",
        best_results."projectId",
        COALESCE(best_results."project_snapshot_json" ->> 'projectTitle', p."title") AS "projectTitle",
        UPPER(p."access_mode"::text) AS "accessMode",
        CASE
          WHEN assignment."id" IS NULL THEN 'NEVER_ASSIGNED'
          WHEN assignment."revoked_at" IS NULL THEN 'ASSIGNED'
          ELSE 'REVOKED'
        END AS "assignmentStatus",
        (${eligibility}) AS "currentlyEligible",
        best_results."final_score" AS "finalScore",
        best_results."is_passed" AS "isPassed",
        best_results."completed_at" AS "completedAt",
        GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (
          CASE WHEN best_results."status"::text = 'timed_out' THEN best_results."expires_at"
          ELSE best_results."completed_at" END - best_results."started_at"
        )))::int) AS "durationSeconds",
        UPPER(best_results."review_decision"::text) AS "reviewDecision",
        best_results."project_snapshot_json" AS "projectSnapshotJson",
        COALESCE(
          jsonb_agg(answer."evaluation_json")
            FILTER (WHERE answer."evaluation_json" IS NOT NULL),
          '[]'::jsonb
        ) AS "evaluations"
      FROM best_results
      JOIN scoped_projects p ON p."id" = best_results."projectId"
      JOIN "users" u ON u."id" = best_results."userId"
      LEFT JOIN "training_project_assignments" assignment
        ON assignment."project_id" = p."id" AND assignment."user_id" = u."id"
      LEFT JOIN "training_attempt_questions" question
        ON question."attempt_id" = best_results."id"
      LEFT JOIN "training_answers" answer
        ON answer."attempt_question_id" = question."id"
      GROUP BY best_results."id", best_results."userId", best_results."projectId",
        best_results."final_score", best_results."is_passed", best_results."completed_at",
        best_results."started_at", best_results."expires_at", best_results."status",
        best_results."review_decision", best_results."project_snapshot_json",
        p."id", p."title", p."status", p."is_open", p."access_mode",
        u."id", u."status", u."deleted_at", u."role_id",
        assignment."id", assignment."revoked_at"
      ORDER BY best_results."userId", best_results."final_score" DESC,
        best_results."projectId"
    `);
  }

  private async loadCsvDetails(
    userIds: string[],
    query: TrainingAdminRankingQueryInput,
  ): Promise<CsvDetailRow[]> {
    if (!userIds.length) return [];
    const scopedProjectsWhere = buildScopedProjectsWhere(query);

    return this.prisma.$queryRaw<CsvDetailRow[]>(Prisma.sql`
      WITH scoped_projects AS (
        SELECT p."id", p."title", p."status", p."is_open", p."access_mode"
        FROM "training_projects" p WHERE ${scopedProjectsWhere}
      ),
      best_ranked AS (
        SELECT ta."id", ta."user_id" AS "userId", ta."project_id" AS "projectId",
          ta."final_score", ta."is_passed", ta."started_at", ta."project_snapshot_json",
          ROW_NUMBER() OVER (
            PARTITION BY ta."user_id", ta."project_id"
            ORDER BY ta."final_score" DESC, ta."started_at" DESC, ta."id" DESC
          ) AS "bestRank"
        FROM "training_attempts" ta
        JOIN scoped_projects p ON p."id" = ta."project_id"
        WHERE ta."user_id" IN (${Prisma.join(userIds.map(uuidSql))})
          AND ta."status"::text IN ('completed', 'timed_out')
          AND ta."review_status"::text IN ('not_required', 'resolved')
          AND ta."counts_toward_attempt_limit" = TRUE
          AND ta."final_score" IS NOT NULL
          AND ta."is_passed" IS NOT NULL
      ),
      best_results AS (SELECT * FROM best_ranked WHERE "bestRank" = 1)
      SELECT
        best_results."userId",
        best_results."id" AS "attemptId",
        best_results."projectId",
        COALESCE(best_results."project_snapshot_json" ->> 'projectTitle', p."title") AS "projectTitle",
        best_results."final_score" AS "finalScore",
        best_results."is_passed" AS "isPassed",
        COALESCE(SUM(answer_metrics."factualErrorsCount"), 0)::bigint
          AS "factualErrorsCount",
        COALESCE(SUM(answer_metrics."unsupportedClaimsCount"), 0)::bigint
          AS "unsupportedClaimsCount",
        COALESCE(SUM(answer_metrics."harmlessExtraClaimsCount"), 0)::bigint
          AS "harmlessExtraClaimsCount",
        COALESCE(SUM(answer_metrics."reviewRequiredClaimsCount"), 0)::bigint
          AS "reviewRequiredClaimsCount"
      FROM best_results
      JOIN scoped_projects p ON p."id" = best_results."projectId"
      LEFT JOIN "training_attempt_questions" question ON question."attempt_id" = best_results."id"
      LEFT JOIN "training_answers" answer ON answer."attempt_question_id" = question."id"
      LEFT JOIN LATERAL (
        SELECT
          COUNT(DISTINCT fact_assessment.value ->> 'fact_id')
            FILTER (WHERE fact_assessment.value ->> 'verdict' = 'INCORRECT')::bigint
            AS "factualErrorsCount",
          jsonb_array_length(
            CASE WHEN jsonb_typeof(answer."evaluation_json" -> 'unsupported_claims') = 'array'
              THEN answer."evaluation_json" -> 'unsupported_claims' ELSE '[]'::jsonb END
          )::bigint AS "unsupportedClaimsCount",
          (
            SELECT COUNT(*)::bigint
            FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(answer."evaluation_json" -> 'unsupported_claims') = 'array'
                THEN answer."evaluation_json" -> 'unsupported_claims' ELSE '[]'::jsonb END
            ) unsupported_claim(value)
            WHERE unsupported_claim.value ->> 'category' = 'HARMLESS_EXTRA'
          ) AS "harmlessExtraClaimsCount",
          (
            SELECT COUNT(*)::bigint
            FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(answer."evaluation_json" -> 'unsupported_claims') = 'array'
                THEN answer."evaluation_json" -> 'unsupported_claims' ELSE '[]'::jsonb END
            ) unsupported_claim(value)
            WHERE COALESCE(unsupported_claim.value ->> 'category', 'LEGACY_REVIEW')
              <> 'HARMLESS_EXTRA'
          ) AS "reviewRequiredClaimsCount"
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(answer."evaluation_json" -> 'fact_assessments') = 'array'
            THEN answer."evaluation_json" -> 'fact_assessments' ELSE '[]'::jsonb END
        ) fact_assessment(value)
      ) answer_metrics ON TRUE
      GROUP BY best_results."userId", best_results."id", best_results."projectId",
        best_results."project_snapshot_json", best_results."final_score",
        best_results."is_passed", p."title"
      ORDER BY best_results."userId", best_results."final_score" DESC,
        best_results."projectId"
    `);
  }

  private serializeRow(
    row: RankingCoreRow,
    details: RankingDetailRow[],
  ): TrainingAdminRankingRow {
    const analytics = aggregateDetails(details);
    const averageBestScore = formatDecimal(row.averageBestScoreExact);
    const coverage = formatDecimal(row.currentCoveragePercentExact);
    const completed = toNumber(row.completedProjectsCount);
    const passed = toNumber(row.passedProjectsCount);
    const bestResults: TrainingRankingProjectResult[] = details.map((detail) => ({
      attemptId: detail.attemptId,
      projectId: detail.projectId,
      projectTitle: detail.projectTitle,
      accessMode: detail.accessMode as TrainingProjectAccessMode,
      assignmentStatus: detail.assignmentStatus,
      currentlyEligible: detail.currentlyEligible,
      finalScore: detail.finalScore,
      isPassed: detail.isPassed,
      completedAt: detail.completedAt.toISOString(),
      durationSeconds: detail.durationSeconds,
      factualErrorsCount: analytics.byAttempt.get(detail.attemptId)?.factualErrorsCount ?? 0,
      unsupportedClaimsCount: analytics.byAttempt.get(detail.attemptId)?.unsupportedClaimsCount ?? 0,
      harmlessExtraClaimsCount: analytics.byAttempt.get(detail.attemptId)?.harmlessExtraClaimsCount ?? 0,
      reviewRequiredClaimsCount: analytics.byAttempt.get(detail.attemptId)?.reviewRequiredClaimsCount ?? 0,
    }));

    return {
      user: { id: row.userId, email: row.userEmail, name: row.userName },
      passedProjectsCount: passed,
      completedProjectsCount: completed,
      averageBestScore,
      attemptsUsed: toNumber(row.attemptsUsed),
      lastCompletedAt: row.lastCompletedAt?.toISOString() ?? null,
      totalDurationSeconds: toNumber(row.totalDurationSeconds),
      averageDurationSeconds: formatDecimal(row.averageDurationSecondsExact),
      currentEligibleProjectsCount: toNumber(row.currentEligibleProjectsCount),
      currentCompletedEligibleProjectsCount: toNumber(
        row.currentCompletedEligibleProjectsCount,
      ),
      currentPassedEligibleProjectsCount: toNumber(row.currentPassedEligibleProjectsCount),
      currentCoveragePercent: coverage,
      currentAccess: {
        allParticipantsProjectsCount: toNumber(row.allParticipantsProjectsCount),
        assignedProjectsCount: toNumber(row.assignedProjectsCount),
        activeAssignmentsCount: toNumber(row.activeAssignmentsCount),
      },
      bestResults,
      summary: {
        text: buildSummaryText({ passed, completed, averageBestScore, coverage, analytics }),
        strongestCriterion: analytics.strongest,
        weakestCriterion: analytics.weakest,
        factualErrorsCount: analytics.factualErrorsCount,
        unsupportedClaimsCount: analytics.unsupportedClaimsCount,
        harmlessExtraClaimsCount: analytics.harmlessExtraClaimsCount,
        reviewRequiredClaimsCount: analytics.reviewRequiredClaimsCount,
      },
    };
  }
}

function buildScopedProjectsWhere(query: TrainingAdminRankingQueryInput) {
  const clauses: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (query.accessMode) {
    clauses.push(Prisma.sql`p."access_mode"::text = LOWER(${query.accessMode})`);
  }
  if (query.project) {
    const titleClause = Prisma.sql`p."title" ILIKE ${likePattern(query.project)} ESCAPE '\\'`;
    clauses.push(UUID_PATTERN.test(query.project)
      ? Prisma.sql`(p."id" = CAST(${query.project} AS uuid) OR ${titleClause})`
      : titleClause);
  }
  return Prisma.join(clauses, ' AND ');
}

function aggregateDetails(details: RankingDetailRow[]) {
  const criteria = new Map<string, CriterionAggregate>();
  const byAttempt = new Map<string, {
    factualErrorsCount: number;
    unsupportedClaimsCount: number;
    harmlessExtraClaimsCount: number;
    reviewRequiredClaimsCount: number;
  }>();
  let factualErrorsCount = 0;
  let unsupportedClaimsCount = 0;
  let harmlessExtraClaimsCount = 0;
  let reviewRequiredClaimsCount = 0;

  for (const detail of details) {
    const attemptMetrics = {
      factualErrorsCount: 0,
      unsupportedClaimsCount: 0,
      harmlessExtraClaimsCount: 0,
      reviewRequiredClaimsCount: 0,
    };
    const evaluations = Array.isArray(detail.evaluations) ? detail.evaluations : [];
    let snapshot;
    try {
      snapshot = parseTrainingProjectSnapshot(detail.projectSnapshotJson);
    } catch {
      byAttempt.set(detail.attemptId, attemptMetrics);
      continue;
    }
    const criterionLookup = new Map(
      isTrainingProjectSnapshotWithFacts(snapshot)
        ? [...snapshot.criteria.main, ...snapshot.criteria.followUp].map((criterion) => [criterion.id, criterion])
        : [],
    );

    for (const evaluation of evaluations) {
      if (!isRecord(evaluation)) continue;
      const factAssessments = Array.isArray(evaluation.fact_assessments)
        ? evaluation.fact_assessments
        : [];
      const incorrectIds = new Set(
        factAssessments
          .filter((assessment) => isRecord(assessment) && assessment.verdict === 'INCORRECT')
          .map((assessment) => String((assessment as Record<string, unknown>).fact_id)),
      );
      attemptMetrics.factualErrorsCount += incorrectIds.size;
      const unsupportedClaims = Array.isArray(evaluation.unsupported_claims)
        ? evaluation.unsupported_claims
        : [];
      attemptMetrics.unsupportedClaimsCount += unsupportedClaims.length;
      for (const claim of unsupportedClaims) {
        if (isRecord(claim) && claim.category === 'HARMLESS_EXTRA') {
          attemptMetrics.harmlessExtraClaimsCount += 1;
        } else {
          attemptMetrics.reviewRequiredClaimsCount += 1;
        }
      }

      if (detail.reviewDecision === 'OVERRIDDEN') continue;
      const criterionAssessments = Array.isArray(evaluation.criterion_assessments)
        ? evaluation.criterion_assessments
        : [];
      for (const assessment of criterionAssessments) {
        if (!isRecord(assessment) || typeof assessment.criterion_id !== 'string') continue;
        const criterion = criterionLookup.get(assessment.criterion_id);
        if (!criterion || typeof assessment.awarded_points !== 'number') continue;
        const current = criteria.get(criterion.code) ?? {
          code: criterion.code,
          title: criterion.title,
          awardedPoints: 0,
          maxPoints: 0,
        };
        current.awardedPoints += assessment.awarded_points;
        current.maxPoints += criterion.maxPoints;
        criteria.set(criterion.code, current);
      }
    }
    byAttempt.set(detail.attemptId, attemptMetrics);
    factualErrorsCount += attemptMetrics.factualErrorsCount;
    unsupportedClaimsCount += attemptMetrics.unsupportedClaimsCount;
    harmlessExtraClaimsCount += attemptMetrics.harmlessExtraClaimsCount;
    reviewRequiredClaimsCount += attemptMetrics.reviewRequiredClaimsCount;
  }

  const criterionSummaries = [...criteria.values()]
    .filter((criterion) => criterion.maxPoints > 0)
    .map(serializeCriterion)
    .sort((left, right) => Number(right.percent) - Number(left.percent) || left.code.localeCompare(right.code));

  return {
    byAttempt,
    factualErrorsCount,
    unsupportedClaimsCount,
    harmlessExtraClaimsCount,
    reviewRequiredClaimsCount,
    strongest: criterionSummaries[0] ?? null,
    weakest: criterionSummaries.length > 1 ? criterionSummaries.at(-1) ?? null : null,
  };
}

function serializeCriterion(criterion: CriterionAggregate): TrainingRankingCriterionSummary {
  const percent = new Prisma.Decimal(criterion.awardedPoints)
    .mul(100)
    .div(criterion.maxPoints);
  return { ...criterion, percent: formatDecimal(percent) ?? '0.00' };
}

function buildSummaryText(input: {
  passed: number;
  completed: number;
  averageBestScore: string | null;
  coverage: string | null;
  analytics: ReturnType<typeof aggregateDetails>;
}) {
  if (input.completed === 0 || input.averageBestScore === null) return 'Недостаточно данных.';
  const criterionText = input.analytics.strongest && input.analytics.weakest
    ? ` Сильнейший критерий: ${input.analytics.strongest.title}; слабейший: ${input.analytics.weakest.title}.`
    : ' Недостаточно данных для сравнения критериев.';
  const coverageText = input.coverage === null ? 'нет текущих доступных проектов' : `текущий охват ${input.coverage}%`;
  return `Пройдено ${input.passed} из ${input.completed} завершённых проектов; средний лучший балл ${input.averageBestScore}; ${coverageText}. Ошибок в фактах: ${input.analytics.factualErrorsCount}; неподтверждённых утверждений: ${input.analytics.unsupportedClaimsCount} (безобидных: ${input.analytics.harmlessExtraClaimsCount}; требующих проверки: ${input.analytics.reviewRequiredClaimsCount}).${criterionText}`;
}

function buildAccessSummary(row: RankingCoreRow) {
  return [
    `ALL eligible: ${toNumber(row.allParticipantsProjectsCount)}`,
    `ASSIGNED eligible: ${toNumber(row.assignedProjectsCount)}`,
    `active assignments: ${toNumber(row.activeAssignmentsCount)}`,
  ].join('; ');
}

export function escapeTrainingRankingCsvCell(value: unknown) {
  const source = value === null || value === undefined ? '' : String(value);
  const dangerous = /^[\t\r\n]/u.test(source) || /^[\s]*[=+\-@]/u.test(source);
  const protectedValue = dangerous ? `'${source}` : source;
  return `"${protectedValue.replaceAll('"', '""')}"`;
}

export function serializeTrainingRankingCsv(values: unknown[]) {
  return values.map(escapeTrainingRankingCsvCell).join(',');
}

function formatDecimal(value: Prisma.Decimal | null) {
  return value === null
    ? null
    : value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2);
}

function likePattern(value: string) {
  return `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

function uuidSql(value: string) {
  return Prisma.sql`CAST(${value} AS uuid)`;
}

function toNumber(value: bigint) {
  return Number(value);
}

function groupBy<Item, Key>(items: Item[], key: (item: Item) => Key) {
  const grouped = new Map<Key, Item[]>();
  for (const item of items) grouped.set(key(item), [...(grouped.get(key(item)) ?? []), item]);
  return grouped;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CSV_HEADERS = [
  'userId',
  'name',
  'email',
  'averageBestScore',
  'passedProjectsCount',
  'completedProjectsCount',
  'attemptsUsed',
  'lastCompletedAt',
  'totalDurationSeconds',
  'averageDurationSeconds',
  'currentEligibleProjectsCount',
  'currentCompletedEligibleProjectsCount',
  'currentPassedEligibleProjectsCount',
  'currentCoveragePercent',
  'bestResults',
  'currentAccessSummary',
  'factualErrorsCount',
  'unsupportedClaimsCount',
  'harmlessExtraClaimsCount',
  'reviewRequiredClaimsCount',
];
