import {
  Prisma,
  TrainingProjectStatus,
  TrainingVersionStatus,
} from '@prisma/client';

type TrainingVersionLockTransaction = Pick<Prisma.TransactionClient, '$queryRaw'>;

export type LockedTrainingVersion = {
  id: string;
  projectId: string;
  status: TrainingVersionStatus;
  projectStatus: TrainingProjectStatus;
};

type TrainingVersionIdentity = {
  projectId: string;
};

type LockedTrainingProjectRow = {
  id: string;
  status: string;
};

type LockedTrainingVersionRow = {
  id: string;
  projectId: string;
  status: string;
};

/**
 * Lock contract for every transaction that mutates version-owned content:
 *
 * 1. resolve the immutable version -> project identity;
 * 2. lock training_projects first;
 * 3. lock training_project_versions second;
 * 4. re-read and validate DRAFT after the locks are held;
 * 5. mutate version-owned rows.
 *
 * Content mutations use shared locks so they can run concurrently while
 * publication uses exclusive locks and therefore waits for all in-flight
 * mutations before it builds the validation snapshot.
 */
export async function lockTrainingVersionForContentMutation(
  tx: TrainingVersionLockTransaction,
  versionId: string,
): Promise<LockedTrainingVersion | null> {
  return lockTrainingVersion(tx, versionId, 'CONTENT');
}

/**
 * Use for operations that update or delete the version row itself. The project
 * lock remains shared, but the version row is exclusive to avoid lock upgrades.
 */
export async function lockTrainingVersionForExclusiveMutation(
  tx: TrainingVersionLockTransaction,
  versionId: string,
): Promise<LockedTrainingVersion | null> {
  return lockTrainingVersion(tx, versionId, 'VERSION');
}

/**
 * Publication is exclusive at both levels. Keeping the same project -> version
 * order prevents deadlocks with ordinary content and version mutations.
 */
export async function lockTrainingVersionForPublication(
  tx: TrainingVersionLockTransaction,
  versionId: string,
): Promise<LockedTrainingVersion | null> {
  return lockTrainingVersion(tx, versionId, 'PUBLICATION');
}

async function lockTrainingVersion(
  tx: TrainingVersionLockTransaction,
  versionId: string,
  mode: 'CONTENT' | 'VERSION' | 'PUBLICATION',
): Promise<LockedTrainingVersion | null> {
  const identities = await tx.$queryRaw<TrainingVersionIdentity[]>(Prisma.sql`
    SELECT "project_id" AS "projectId"
    FROM "training_project_versions"
    WHERE "id" = ${versionId}::uuid
  `);
  const identity = identities[0];
  if (!identity) {
    return null;
  }

  const projects =
    mode === 'PUBLICATION'
      ? await tx.$queryRaw<LockedTrainingProjectRow[]>(Prisma.sql`
          SELECT "id", "status"
          FROM "training_projects"
          WHERE "id" = ${identity.projectId}::uuid
          FOR UPDATE
        `)
      : await tx.$queryRaw<LockedTrainingProjectRow[]>(Prisma.sql`
          SELECT "id", "status"
          FROM "training_projects"
          WHERE "id" = ${identity.projectId}::uuid
          FOR SHARE
        `);
  const project = projects[0];
  if (!project) {
    return null;
  }

  const versions =
    mode === 'CONTENT'
      ? await tx.$queryRaw<LockedTrainingVersionRow[]>(Prisma.sql`
          SELECT
            "id",
            "project_id" AS "projectId",
            "status"
          FROM "training_project_versions"
          WHERE "id" = ${versionId}::uuid
            AND "project_id" = ${project.id}::uuid
          FOR SHARE
        `)
      : await tx.$queryRaw<LockedTrainingVersionRow[]>(Prisma.sql`
          SELECT
            "id",
            "project_id" AS "projectId",
            "status"
          FROM "training_project_versions"
          WHERE "id" = ${versionId}::uuid
            AND "project_id" = ${project.id}::uuid
          FOR UPDATE
        `);
  const version = versions[0];
  if (!version) {
    return null;
  }

  return {
    ...version,
    status: normalizeVersionStatus(version.status),
    projectStatus: normalizeProjectStatus(project.status),
  };
}

function normalizeProjectStatus(status: string): TrainingProjectStatus {
  switch (status.toLowerCase()) {
    case 'draft':
      return TrainingProjectStatus.DRAFT;
    case 'open':
      return TrainingProjectStatus.OPEN;
    case 'closed':
      return TrainingProjectStatus.CLOSED;
    case 'archived':
      return TrainingProjectStatus.ARCHIVED;
    default:
      throw new Error(`Unknown training project status: ${status}`);
  }
}

function normalizeVersionStatus(status: string): TrainingVersionStatus {
  switch (status.toLowerCase()) {
    case 'draft':
      return TrainingVersionStatus.DRAFT;
    case 'published':
      return TrainingVersionStatus.PUBLISHED;
    case 'superseded':
      return TrainingVersionStatus.SUPERSEDED;
    default:
      throw new Error(`Unknown training version status: ${status}`);
  }
}
