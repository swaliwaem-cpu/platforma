import { Injectable } from '@nestjs/common';
import {
  Prisma,
  TrainingAnswerSource,
  TrainingAttemptStatus,
  TrainingProjectAccessMode,
  TrainingReviewStatus,
} from '@prisma/client';
import type {
  TrainingAdminResultSort,
  TrainingAdminResultsResponse,
  TrainingAssignmentStatus,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

import { PrismaService } from '../prisma/prisma.service';
import { TrainingAttemptStateService } from './training-attempt-state.service';

export type TrainingAdminResultsQueryInput = {
  page: number;
  limit: number;
  search: string | null;
  userId: string | null;
  projectId: string | null;
  accessMode: TrainingProjectAccessMode | null;
  assignmentStatus: TrainingAssignmentStatus | null;
  startedFrom: Date | null;
  startedTo: Date | null;
  attemptStatus: TrainingAttemptStatus | null;
  reviewStatus: TrainingReviewStatus | null;
  passed: boolean | null;
  scoreMin: number | null;
  scoreMax: number | null;
  durationMin: number | null;
  durationMax: number | null;
  source: TrainingAnswerSource | null;
  sort: TrainingAdminResultSort;
};

type ResultRow = {
  id: string;
  userId: string;
  userEmail: string;
  userName: string | null;
  projectId: string;
  projectTitle: string;
  accessMode: string;
  assignmentStatus: TrainingAssignmentStatus;
  hasCurrentAccess: boolean;
  attemptNumber: number;
  status: string;
  completionReason: string | null;
  reviewStatus: string;
  reviewDecision: string | null;
  countsTowardAttemptLimit: boolean;
  finalScore: number | null;
  isPassed: boolean | null;
  startedAt: Date;
  completedAt: Date | null;
  durationSeconds: number;
  answerCount: number;
  answerSources: string[];
};

@Injectable()
export class TrainingResultsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly attemptState: TrainingAttemptStateService,
  ) {}

  async listAdminResults(
    query: TrainingAdminResultsQueryInput,
  ): Promise<TrainingAdminResultsResponse> {
    await this.attemptState.finalizeExpiredAttempts();
    const where = buildWhere(query);
    const duration = durationSql();
    const offset = (query.page - 1) * query.limit;
    const [countRows, rows] = await this.prisma.$transaction([
      this.prisma.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`
        SELECT COUNT(*)::bigint AS "total"
        FROM "training_attempts" ta
        JOIN "users" u ON u."id" = ta."user_id"
        JOIN "training_projects" p ON p."id" = ta."project_id"
        LEFT JOIN "training_project_assignments" tpa
          ON tpa."project_id" = ta."project_id" AND tpa."user_id" = ta."user_id"
        WHERE ${where}
      `),
      this.prisma.$queryRaw<ResultRow[]>(Prisma.sql`
        SELECT
          ta."id",
          ta."user_id" AS "userId",
          u."email" AS "userEmail",
          u."name" AS "userName",
          ta."project_id" AS "projectId",
          COALESCE(ta."project_snapshot_json" ->> 'projectTitle', p."title") AS "projectTitle",
          UPPER(p."access_mode"::text) AS "accessMode",
          CASE
            WHEN tpa."id" IS NULL THEN 'NEVER_ASSIGNED'
            WHEN tpa."revoked_at" IS NULL THEN 'ASSIGNED'
            ELSE 'REVOKED'
          END AS "assignmentStatus",
          (
            u."status"::text = 'active'
            AND u."deleted_at" IS NULL
            AND p."status"::text = 'published'
            AND p."is_open" = TRUE
            AND EXISTS (
              SELECT 1
              FROM "role_permissions" rp
              JOIN "permissions" permission ON permission."id" = rp."permission_id"
              WHERE rp."role_id" = u."role_id" AND permission."key" = 'training:participate'
            )
            AND (
              p."access_mode"::text = 'all_participants'
              OR (
                p."access_mode"::text = 'assigned_users'
                AND tpa."id" IS NOT NULL
                AND tpa."revoked_at" IS NULL
              )
            )
          ) AS "hasCurrentAccess",
          ta."attempt_number" AS "attemptNumber",
          UPPER(ta."status"::text) AS "status",
          UPPER(ta."completion_reason"::text) AS "completionReason",
          UPPER(ta."review_status"::text) AS "reviewStatus",
          UPPER(ta."review_decision"::text) AS "reviewDecision",
          ta."counts_toward_attempt_limit" AS "countsTowardAttemptLimit",
          ta."final_score" AS "finalScore",
          ta."is_passed" AS "isPassed",
          ta."started_at" AS "startedAt",
          ta."completed_at" AS "completedAt",
          ${duration} AS "durationSeconds",
          (
            SELECT COUNT(*)::int
            FROM "training_attempt_questions" taq
            JOIN "training_answers" answer ON answer."attempt_question_id" = taq."id"
            WHERE taq."attempt_id" = ta."id"
          ) AS "answerCount",
          ARRAY(
            SELECT DISTINCT UPPER(answer."source"::text)
            FROM "training_attempt_questions" taq
            JOIN "training_answers" answer ON answer."attempt_question_id" = taq."id"
            WHERE taq."attempt_id" = ta."id"
            ORDER BY UPPER(answer."source"::text)
          ) AS "answerSources"
        FROM "training_attempts" ta
        JOIN "users" u ON u."id" = ta."user_id"
        JOIN "training_projects" p ON p."id" = ta."project_id"
        LEFT JOIN "training_project_assignments" tpa
          ON tpa."project_id" = ta."project_id" AND tpa."user_id" = ta."user_id"
        WHERE ${where}
        ORDER BY ${orderBySql(query.sort)}
        OFFSET ${offset}
        LIMIT ${query.limit}
      `),
    ]);
    const total = Number(countRows[0]?.total ?? 0n);

    return {
      items: rows.map((row) => ({
        id: row.id,
        user: { id: row.userId, email: row.userEmail, name: row.userName },
        project: { id: row.projectId, title: row.projectTitle },
        currentAccess: {
          accessMode: row.accessMode as TrainingProjectAccessMode,
          assignmentStatus: row.assignmentStatus,
          hasCurrentAccess: row.hasCurrentAccess,
        },
        attemptNumber: row.attemptNumber,
        status: row.status as TrainingAttemptStatus,
        completionReason: row.completionReason as TrainingAdminResultsResponse['items'][number]['completionReason'],
        reviewStatus: row.reviewStatus as TrainingReviewStatus,
        reviewDecision: row.reviewDecision as TrainingAdminResultsResponse['items'][number]['reviewDecision'],
        countsTowardAttemptLimit: row.countsTowardAttemptLimit,
        finalScore: row.finalScore,
        isPassed: row.status === TrainingAttemptStatus.TECHNICAL_FAILED ? null : row.isPassed,
        startedAt: row.startedAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
        durationSeconds: row.durationSeconds,
        answerCount: row.answerCount,
        answerSources: row.answerSources as TrainingAnswerSource[],
        hasPendingReview: row.status === TrainingAttemptStatus.REQUIRES_REVIEW,
        hasTechnicalFailure: row.status === TrainingAttemptStatus.TECHNICAL_FAILED,
      })),
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
    };
  }
}

function buildWhere(query: TrainingAdminResultsQueryInput) {
  const clauses: Prisma.Sql[] = [Prisma.sql`TRUE`];

  if (query.search) {
    clauses.push(Prisma.sql`(
      COALESCE(u."name", '') ILIKE ${`%${query.search}%`}
      OR u."email" ILIKE ${`%${query.search}%`}
    )`);
  }
  if (query.userId) clauses.push(Prisma.sql`ta."user_id" = CAST(${query.userId} AS uuid)`);
  if (query.projectId) clauses.push(Prisma.sql`ta."project_id" = CAST(${query.projectId} AS uuid)`);
  if (query.accessMode) {
    clauses.push(Prisma.sql`p."access_mode"::text = LOWER(${query.accessMode})`);
  }
  if (query.assignmentStatus === 'ASSIGNED') {
    clauses.push(Prisma.sql`tpa."id" IS NOT NULL AND tpa."revoked_at" IS NULL`);
  } else if (query.assignmentStatus === 'REVOKED') {
    clauses.push(Prisma.sql`tpa."revoked_at" IS NOT NULL`);
  } else if (query.assignmentStatus === 'NEVER_ASSIGNED') {
    clauses.push(Prisma.sql`tpa."id" IS NULL`);
  }
  if (query.startedFrom) clauses.push(Prisma.sql`ta."started_at" >= ${query.startedFrom}`);
  if (query.startedTo) clauses.push(Prisma.sql`ta."started_at" <= ${query.startedTo}`);
  if (query.attemptStatus) {
    clauses.push(Prisma.sql`ta."status"::text = LOWER(${query.attemptStatus})`);
  }
  if (query.reviewStatus) {
    clauses.push(Prisma.sql`ta."review_status"::text = LOWER(${query.reviewStatus})`);
  }
  if (query.passed !== null) clauses.push(Prisma.sql`ta."is_passed" = ${query.passed}`);
  if (query.scoreMin !== null) clauses.push(Prisma.sql`ta."final_score" >= ${query.scoreMin}`);
  if (query.scoreMax !== null) clauses.push(Prisma.sql`ta."final_score" <= ${query.scoreMax}`);
  if (query.durationMin !== null) clauses.push(Prisma.sql`${durationSql()} >= ${query.durationMin}`);
  if (query.durationMax !== null) clauses.push(Prisma.sql`${durationSql()} <= ${query.durationMax}`);
  if (query.source) {
    clauses.push(Prisma.sql`EXISTS (
      SELECT 1
      FROM "training_attempt_questions" taq
      JOIN "training_answers" answer ON answer."attempt_question_id" = taq."id"
      WHERE taq."attempt_id" = ta."id" AND answer."source"::text = LOWER(${query.source})
    )`);
  }

  return Prisma.join(clauses, ' AND ');
}

function durationSql() {
  return Prisma.sql`GREATEST(
    0,
    FLOOR(EXTRACT(EPOCH FROM (
      CASE WHEN ta."status"::text = 'timed_out' THEN ta."expires_at"
      ELSE COALESCE(ta."completed_at", CURRENT_TIMESTAMP) END - ta."started_at"
    )))::int
  )`;
}

function orderBySql(sort: TrainingAdminResultSort) {
  const order = {
    STARTED_DESC: Prisma.sql`ta."started_at" DESC, ta."id" DESC`,
    STARTED_ASC: Prisma.sql`ta."started_at" ASC, ta."id" ASC`,
    COMPLETED_DESC: Prisma.sql`ta."completed_at" DESC NULLS LAST, ta."id" DESC`,
    COMPLETED_ASC: Prisma.sql`ta."completed_at" ASC NULLS LAST, ta."id" ASC`,
    SCORE_DESC: Prisma.sql`ta."final_score" DESC NULLS LAST, ta."id" DESC`,
    SCORE_ASC: Prisma.sql`ta."final_score" ASC NULLS LAST, ta."id" ASC`,
    DURATION_DESC: Prisma.sql`${durationSql()} DESC, ta."id" DESC`,
    DURATION_ASC: Prisma.sql`${durationSql()} ASC, ta."id" ASC`,
  } satisfies Record<TrainingAdminResultSort, Prisma.Sql>;

  return order[sort];
}
