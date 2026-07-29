import {
  Prisma,
  TrainingProjectAudienceMode,
} from '@prisma/client';

export function trainingProjectAudienceWhere(
  userId: string,
): Prisma.TrainingProjectWhereInput {
  return {
    OR: [
      {
        audienceMode: TrainingProjectAudienceMode.ALL_ELIGIBLE,
      },
      {
        audienceMode: TrainingProjectAudienceMode.ASSIGNED_ONLY,
        assignments: {
          some: {
            userId,
            revokedAt: null,
          },
        },
      },
    ],
  };
}

export function activeTrainingAssignmentSelect(userId: string) {
  return {
    where: {
      userId,
      revokedAt: null,
    },
    orderBy: {
      assignedAt: 'desc' as const,
    },
    take: 1,
    select: {
      id: true,
    },
  };
}

export function resolveTrainingAttemptAssignmentId(project: {
  audienceMode?: TrainingProjectAudienceMode;
  assignments?: Array<{ id: string }>;
}) {
  if (
    project.audienceMode !== TrainingProjectAudienceMode.ASSIGNED_ONLY
  ) {
    return null;
  }
  return project.assignments?.[0]?.id ?? null;
}

export async function acquireTrainingProjectAudienceLock(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  projectId: string,
) {
  await tx.$queryRaw(
    Prisma.sql`SELECT 1 AS "locked" FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`training-audience:${projectId}`}, 0))) AS "lock_state"`,
  );
}

export async function acquireTrainingUserProjectLock(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  userId: string,
  projectId: string,
) {
  await tx.$queryRaw(
    Prisma.sql`SELECT 1 AS "locked" FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`training-attempt:${userId}:${projectId}`}, 0))) AS "lock_state"`,
  );
}
