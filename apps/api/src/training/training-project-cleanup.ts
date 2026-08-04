import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

export type TrainingProjectCleanupObject = {
  key: string;
  bucket: string | null;
  fileId?: string;
};

export async function recordTrainingProjectDeleteCleanupObject(
  prisma: PrismaService,
  projectId: string,
  object: TrainingProjectCleanupObject,
) {
  const storedObject: TrainingProjectCleanupObject = {
    key: object.key,
    bucket: object.bucket,
    ...(object.fileId ? { fileId: object.fileId } : {}),
  };
  await prisma.$transaction(async (transaction) => {
    const [row] = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "audit_logs"
      WHERE "action" = 'training.project.delete'
        AND "entity_type" = 'training_project'
        AND "entity_id" = ${projectId}
      ORDER BY "created_at" DESC
      LIMIT 1
      FOR UPDATE
    `);
    if (!row) return;

    const audit = await transaction.auditLog.findUnique({
      where: { id: row.id },
      select: { metadata: true },
    });
    if (!audit?.metadata || Array.isArray(audit.metadata) || typeof audit.metadata !== 'object') {
      return;
    }

    const metadata = audit.metadata as Record<string, Prisma.JsonValue>;
    const storageObjects = Array.isArray(metadata.storageObjects)
      ? metadata.storageObjects
      : [];
    const alreadyRecorded = storageObjects.some(
      (item) =>
        item !== null &&
        !Array.isArray(item) &&
        typeof item === 'object' &&
        item.key === storedObject.key &&
        item.bucket === storedObject.bucket &&
        item.fileId === storedObject.fileId,
    );
    const pendingMetadata = { ...metadata };
    delete pendingMetadata.cleanupCompletedAt;

    await transaction.auditLog.update({
      where: { id: row.id },
      data: {
        metadata: {
          ...pendingMetadata,
          cleanupStatus: 'PENDING',
          cleanupRevision:
            (typeof metadata.cleanupRevision === 'number' ? metadata.cleanupRevision : 0) + 1,
          storageObjects: alreadyRecorded
            ? storageObjects
            : [...storageObjects, storedObject],
        },
      },
    });
  });
}
