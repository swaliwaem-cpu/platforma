import { randomUUID } from 'node:crypto';

import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  FileStorage,
  Prisma,
  TrainingAudioDeletionItemStatus,
  TrainingAudioDeletionManifestStatus,
  TrainingAudioStorageObjectKind,
} from '@prisma/client';
import type {
  TrainingAudioDeletionManifestResponse,
  TrainingAudioStorageItem,
  TrainingAudioStorageReport,
  TrainingAudioStorageState,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

import { S3StorageService, type S3ListedObject } from '../files/s3-storage.service';
import { PrismaService } from '../prisma/prisma.service';

const TRAINING_AUDIO_PREFIX = 'training-v2/answers/';
const DEFAULT_RECONCILIATION_LIMIT = 10_000;
const MAX_RECONCILIATION_LIMIT = 50_000;
const PROCESSING_STALE_MS = 15 * 60 * 1000;

const audioFileInclude = {
  variants: { select: { key: true } },
  _count: {
    select: {
      profilePhotoUsers: true,
      objectImages: true,
      objectFiles: true,
      feedXmlSources: true,
      feedMediaAssets: true,
      lotPresentationDocuments: true,
      projectPresentationDraftCovers: true,
      projectPresentationDocuments: true,
      projectPresentationAssets: true,
      trainingAnswerSegments: true,
      trainingMergedAnswers: true,
      trainingMaterialOperations: true,
      trainingMaterialRevisions: true,
    },
  },
} satisfies Prisma.FileInclude;

type AudioFileWithConsumers = Prisma.FileGetPayload<{ include: typeof audioFileInclude }>;

export type TrainingAudioStorageQuery = {
  page: number;
  limit: number;
  project: string;
  user: string;
  createdFrom: Date | null;
  createdToExclusive: Date | null;
  state: TrainingAudioStorageState | '';
};

export type CreateTrainingAudioDeletionManifestInput = {
  selectionIds: string[];
  reason: string;
};

export type TrainingAudioStorageSnapshot = {
  fileId?: string | null;
  kind: TrainingAudioStorageObjectKind;
  bucket: string;
  key: string;
  checksum?: string | null;
  etag?: string | null;
  sizeBytes?: bigint | number | null;
  mimeType?: string | null;
  projectId?: string | null;
  projectTitle?: string | null;
  userId?: string | null;
  userName?: string | null;
  userEmail?: string | null;
  attemptId?: string | null;
  answerId?: string | null;
  objectCreatedAt?: Date;
};

type AudioCatalogClient = Pick<
  Prisma.TransactionClient,
  '$queryRaw' | 'trainingAudioDeletionManifestItem' | 'trainingAudioStorageEntry'
>;

export async function lockTrainingAudioStorageObject(
  client: Pick<Prisma.TransactionClient, '$queryRaw'>,
  bucket: string,
  key: string,
) {
  await client.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`training-audio-storage:${bucket.length}:${bucket}${key}`}, 0)
    )::text AS "lock"
  `);
}

export async function assertTrainingAudioStorageObjectWritable(
  client: AudioCatalogClient,
  bucket: string,
  key: string,
) {
  await lockTrainingAudioStorageObject(client, bucket, key);
  const reserved = await client.trainingAudioDeletionManifestItem.findFirst({
    where: { bucket, key },
    select: { id: true },
  });

  if (reserved) {
    throw new ConflictException(
      'Training audio object is reserved by a manual deletion manifest',
    );
  }
}

export async function upsertTrainingAudioStorageEntry(
  client: AudioCatalogClient,
  snapshot: TrainingAudioStorageSnapshot,
) {
  await assertTrainingAudioStorageObjectWritable(client, snapshot.bucket, snapshot.key);
  const sizeBytes = snapshot.sizeBytes === null || snapshot.sizeBytes === undefined
    ? null
    : BigInt(snapshot.sizeBytes);
  const optionalSnapshotData = {
    ...(snapshot.fileId ? { fileId: snapshot.fileId } : {}),
    ...(snapshot.checksum ? { checksum: snapshot.checksum } : {}),
    ...(snapshot.etag ? { etag: snapshot.etag } : {}),
    ...(sizeBytes !== null ? { sizeBytes } : {}),
    ...(snapshot.mimeType ? { mimeType: snapshot.mimeType } : {}),
    ...(snapshot.projectId ? { projectIdSnapshot: snapshot.projectId } : {}),
    ...(snapshot.projectTitle ? { projectTitleSnapshot: snapshot.projectTitle } : {}),
    ...(snapshot.userId ? { userIdSnapshot: snapshot.userId } : {}),
    ...(snapshot.userName ? { userNameSnapshot: snapshot.userName } : {}),
    ...(snapshot.userEmail ? { userEmailSnapshot: snapshot.userEmail } : {}),
    ...(snapshot.attemptId ? { attemptIdSnapshot: snapshot.attemptId } : {}),
    ...(snapshot.answerId ? { answerIdSnapshot: snapshot.answerId } : {}),
  };

  return client.trainingAudioStorageEntry.upsert({
    where: { bucket_key: { bucket: snapshot.bucket, key: snapshot.key } },
    update: {
      kind: snapshot.kind,
      ...optionalSnapshotData,
      deletedAt: null,
    },
    create: {
      kind: snapshot.kind,
      bucket: snapshot.bucket,
      key: snapshot.key,
      fileId: snapshot.fileId ?? null,
      checksum: snapshot.checksum ?? null,
      etag: snapshot.etag ?? null,
      sizeBytes,
      mimeType: snapshot.mimeType ?? null,
      projectIdSnapshot: snapshot.projectId ?? null,
      projectTitleSnapshot: snapshot.projectTitle ?? null,
      userIdSnapshot: snapshot.userId ?? null,
      userNameSnapshot: snapshot.userName ?? null,
      userEmailSnapshot: snapshot.userEmail ?? null,
      attemptIdSnapshot: snapshot.attemptId ?? null,
      answerIdSnapshot: snapshot.answerId ?? null,
      objectCreatedAt: snapshot.objectCreatedAt ?? new Date(),
    },
  });
}

@Injectable()
export class TrainingAudioStorageService {
  private readonly logger = new Logger(TrainingAudioStorageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: S3StorageService,
  ) {}

  async report(query: TrainingAudioStorageQuery): Promise<TrainingAudioStorageReport> {
    const reconciled = await this.reconcile();
    const filtered = reconciled.items
      .filter((item) => matchesQuery(item, query))
      .sort(compareStorageItems);
    const offset = (query.page - 1) * query.limit;
    const pageItems = filtered.slice(offset, offset + query.limit);
    const totalBytes = filtered.reduce((total, item) => total + Number(item.sizeBytes ?? 0), 0);

    return {
      items: pageItems,
      total: filtered.length,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(filtered.length / query.limit),
      summary: {
        linked: filtered.filter((item) => item.state === 'LINKED').length,
        deletable: filtered.filter((item) => item.canDelete).length,
        missing: filtered.filter((item) => item.state === 'DB_ONLY' || item.state === 'MISSING').length,
        totalBytes: String(totalBytes),
      },
      facets: buildFacets(reconciled.items),
      pendingManifests: reconciled.pendingManifests,
      reportGeneratedAt: new Date().toISOString(),
      readOnly: true,
    };
  }

  async createDeletionManifest(
    actorUserId: string,
    input: CreateTrainingAudioDeletionManifestInput,
  ): Promise<TrainingAudioDeletionManifestResponse> {
    const reconciled = await this.reconcile();
    const itemBySelectionId = new Map(reconciled.items.map((item) => [item.selectionId, item]));
    const selected = input.selectionIds.map((selectionId) => itemBySelectionId.get(selectionId));

    if (selected.some((item) => !item)) {
      throw new ConflictException('Audio storage selection changed; refresh the report');
    }
    const items = selected as TrainingAudioStorageItem[];
    if (items.some((item) => !item.canDelete || item.pendingManifestId)) {
      throw new ConflictException('Linked or pending audio cannot be added to a delete manifest');
    }

    const manifest = await this.prisma.$transaction(async (transaction) => {
      for (const item of [...items].sort(compareStorageObjectIdentity)) {
        await lockTrainingAudioStorageObject(transaction, item.bucket, item.key);
        const [lockedFile] = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id"
          FROM "files"
          WHERE "storage" = 'minio'
            AND "bucket" = ${item.bucket}
            AND "key" = ${item.key}
          FOR UPDATE
        `);
        const [currentFile, reserved] = await Promise.all([
          lockedFile
            ? transaction.file.findUnique({
                where: { id: lockedFile.id },
                include: audioFileInclude,
              })
            : null,
          transaction.trainingAudioDeletionManifestItem.findFirst({
            where: { bucket: item.bucket, key: item.key },
            select: { id: true },
          }),
        ]);
        if (reserved || (currentFile && isFileLinked(currentFile))) {
          throw new ConflictException(
            'Audio storage selection changed; refresh the report',
          );
        }
      }

      const created = await transaction.trainingAudioDeletionManifest.create({
        data: {
          createdById: actorUserId,
          reason: input.reason,
          items: {
            create: items.map((item) => ({
              storageEntryId: item.storageEntryId,
              fileIdSnapshot: item.fileId,
              bucket: item.bucket,
              key: item.key,
              checksum: item.checksum,
              etag: item.etag,
              sizeBytes: item.sizeBytes === null ? null : BigInt(item.sizeBytes),
              projectTitleSnapshot: item.project?.title ?? null,
              userNameSnapshot: item.user?.name ?? null,
              userEmailSnapshot: item.user?.email ?? null,
              objectCreatedAt: new Date(item.createdAt),
            })),
          },
        },
        include: { items: { select: { status: true } } },
      });
      await transaction.auditLog.create({
        data: {
          actorUserId,
          action: 'training.audio_storage.delete_manifest.create',
          entityType: 'training_audio_deletion_manifest',
          entityId: created.id,
          metadata: {
            itemCount: items.length,
            reason: input.reason,
          },
        },
      });

      return created;
    });

    return serializeManifest(manifest);
  }

  async executeDeletionManifest(
    manifestId: string,
    actorUserId: string,
  ): Promise<TrainingAudioDeletionManifestResponse> {
    const existing = await this.prisma.trainingAudioDeletionManifest.findUnique({
      where: { id: manifestId },
      include: { items: { orderBy: { createdAt: 'asc' } } },
    });

    if (!existing) throw new NotFoundException('Audio deletion manifest not found');
    if (existing.status === TrainingAudioDeletionManifestStatus.COMPLETED) {
      return serializeManifest(existing);
    }

    for (const item of existing.items) {
      if (item.status === TrainingAudioDeletionItemStatus.DELETED) continue;
      const claimed = await this.claimManifestItem(item.id);
      if (!claimed) continue;

      try {
        await this.deleteClaimedItem(claimed);
      } catch (error) {
        const errorCode = error instanceof ManualAudioDeletionBlockedError
          ? error.code
          : 'STORAGE_DELETE_FAILED';
        await this.releaseManifestItem(claimed.id, claimed.executionToken!, errorCode);
        this.logger.warn({
          event: 'training_audio_manual_delete_failed',
          manifestId,
          itemId: claimed.id,
          errorCode,
        });
      }
    }

    const completed = await this.prisma.$transaction(async (transaction) => {
      const pendingCount = await transaction.trainingAudioDeletionManifestItem.count({
        where: {
          manifestId,
          status: { not: TrainingAudioDeletionItemStatus.DELETED },
        },
      });
      const completedUpdate = pendingCount === 0
        ? await transaction.trainingAudioDeletionManifest.updateMany({
            where: {
              id: manifestId,
              status: TrainingAudioDeletionManifestStatus.PENDING,
            },
            data: {
              status: TrainingAudioDeletionManifestStatus.COMPLETED,
              completedAt: new Date(),
            },
          })
        : { count: 0 };
      const manifest = await transaction.trainingAudioDeletionManifest.findUniqueOrThrow({
        where: { id: manifestId },
        include: { items: { orderBy: { createdAt: 'asc' } } },
      });

      if (completedUpdate.count === 1) {
        await transaction.auditLog.create({
          data: {
            actorUserId,
            action: 'training.audio_storage.delete_manifest.complete',
            entityType: 'training_audio_deletion_manifest',
            entityId: manifestId,
            metadata: { itemCount: manifest.items.length },
          },
        });
      }

      return manifest;
    });

    return serializeManifest(completed);
  }

  private async reconcile() {
    const bucket = getPrivateAudioBucket(this.storage.getBucket());
    const maxObjects = getReconciliationLimit();
    const [entries, legacyFiles, storageObjects, pendingItems, pendingManifests] = await Promise.all([
      this.prisma.trainingAudioStorageEntry.findMany({
        where: { bucket },
        include: { file: { include: audioFileInclude } },
        take: maxObjects + 1,
      }),
      this.prisma.file.findMany({
        where: {
          storage: FileStorage.MINIO,
          bucket,
          key: { startsWith: TRAINING_AUDIO_PREFIX },
          trainingAudioStorageEntry: { is: null },
        },
        include: audioFileInclude,
        take: maxObjects + 1,
      }),
      this.storage.listObjects({
        bucket,
        prefix: TRAINING_AUDIO_PREFIX,
        maxObjects,
      }),
      this.prisma.trainingAudioDeletionManifestItem.findMany({
        where: {
          manifest: { status: TrainingAudioDeletionManifestStatus.PENDING },
          status: { not: TrainingAudioDeletionItemStatus.DELETED },
          bucket,
        },
        select: { bucket: true, key: true, manifestId: true },
      }),
      this.prisma.trainingAudioDeletionManifest.findMany({
        where: { status: TrainingAudioDeletionManifestStatus.PENDING },
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: { items: { select: { status: true, lastErrorCode: true } } },
      }),
    ]);

    if (entries.length > maxObjects || legacyFiles.length > maxObjects) {
      throw new ServiceUnavailableException(
        `Audio storage report exceeds the configured limit of ${maxObjects} objects`,
      );
    }

    const storageByKey = new Map(storageObjects.map((object) => [objectId(bucket, object.key), object]));
    const pendingByKey = new Map(
      pendingItems.map((item) => [objectId(item.bucket, item.key), item.manifestId]),
    );
    const knownObjects = new Set<string>();
    const items: TrainingAudioStorageItem[] = [];

    for (const entry of entries) {
      const id = objectId(entry.bucket, entry.key);
      const storageObject = storageByKey.get(id) ?? null;
      knownObjects.add(id);
      items.push(buildStorageItem({
        selectionId: `entry:${entry.id}`,
        storageEntryId: entry.id,
        file: entry.file,
        storageObject,
        pendingManifestId: pendingByKey.get(id) ?? null,
        bucket: entry.bucket,
        key: entry.key,
        checksum: entry.checksum,
        etag: entry.etag,
        sizeBytes: entry.sizeBytes,
        mimeType: entry.mimeType,
        kind: entry.kind,
        project: entry.projectTitleSnapshot
          ? { id: entry.projectIdSnapshot, title: entry.projectTitleSnapshot }
          : null,
        user: entry.userEmailSnapshot || entry.userNameSnapshot
          ? {
              id: entry.userIdSnapshot,
              name: entry.userNameSnapshot,
              email: entry.userEmailSnapshot,
            }
          : null,
        createdAt: entry.objectCreatedAt,
        deletedAt: entry.deletedAt,
      }));
    }

    for (const file of legacyFiles) {
      const id = objectId(file.bucket ?? bucket, file.key);
      const storageObject = storageByKey.get(id) ?? null;
      knownObjects.add(id);
      items.push(buildStorageItem({
        selectionId: `file:${file.id}`,
        storageEntryId: null,
        file,
        storageObject,
        pendingManifestId: pendingByKey.get(id) ?? null,
        bucket: file.bucket ?? bucket,
        key: file.key,
        checksum: file.checksum,
        etag: null,
        sizeBytes: file.sizeBytes,
        mimeType: file.mimeType,
        kind: inferKind(file.key),
        project: null,
        user: null,
        createdAt: file.createdAt,
        deletedAt: null,
      }));
    }

    for (const object of storageObjects) {
      const id = objectId(bucket, object.key);
      if (knownObjects.has(id) || !isTrainingAudioKey(object.key)) continue;
      items.push(buildStorageItem({
        selectionId: encodeStorageSelection(bucket, object.key),
        storageEntryId: null,
        file: null,
        storageObject: object,
        pendingManifestId: pendingByKey.get(id) ?? null,
        bucket,
        key: object.key,
        checksum: null,
        etag: object.etag,
        sizeBytes: object.size === null ? null : BigInt(object.size),
        mimeType: inferMimeType(object.key),
        kind: inferKind(object.key),
        project: null,
        user: null,
        createdAt: object.lastModified ?? new Date(0),
        deletedAt: null,
      }));
    }

    return {
      items,
      pendingManifests: pendingManifests.map((manifest) => ({
        id: manifest.id,
        reason: manifest.reason,
        createdAt: manifest.createdAt.toISOString(),
        pendingItems: manifest.items.filter(
          (item) => item.status !== TrainingAudioDeletionItemStatus.DELETED,
        ).length,
        deletedItems: manifest.items.filter(
          (item) => item.status === TrainingAudioDeletionItemStatus.DELETED,
        ).length,
        lastErrorCodes: [...new Set(manifest.items.flatMap(
          (item) => item.lastErrorCode ? [item.lastErrorCode] : [],
        ))],
      })),
    };
  }

  private async claimManifestItem(itemId: string) {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - PROCESSING_STALE_MS);
    const executionToken = randomUUID();
    const updated = await this.prisma.trainingAudioDeletionManifestItem.updateMany({
      where: {
        id: itemId,
        OR: [
          { status: TrainingAudioDeletionItemStatus.PENDING },
          {
            status: TrainingAudioDeletionItemStatus.PROCESSING,
            executionStartedAt: { lt: staleBefore },
          },
        ],
      },
      data: {
        status: TrainingAudioDeletionItemStatus.PROCESSING,
        executionToken,
        executionStartedAt: now,
        lastErrorCode: null,
      },
    });

    if (updated.count !== 1) return null;

    return this.prisma.trainingAudioDeletionManifestItem.findUniqueOrThrow({
      where: { id: itemId },
    });
  }

  private async deleteClaimedItem(item: {
    id: string;
    storageEntryId: string | null;
    fileIdSnapshot: string | null;
    bucket: string;
    key: string;
    checksum: string | null;
    executionToken: string | null;
  }) {
    await this.prisma.$transaction(async (transaction) => {
      await lockTrainingAudioStorageObject(transaction, item.bucket, item.key);
      const [locked] = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "files"
        WHERE "storage" = 'minio'
          AND "bucket" = ${item.bucket}
          AND "key" = ${item.key}
        FOR UPDATE
      `);
      const file = locked
        ? await transaction.file.findUnique({
            where: { id: locked.id },
            include: audioFileInclude,
          })
        : null;

      if (!file) return;
      if (
        (item.fileIdSnapshot && file.id !== item.fileIdSnapshot) ||
        (item.checksum && file.checksum !== item.checksum) ||
        file.bucket !== item.bucket ||
        file.key !== item.key
      ) {
        throw new ManualAudioDeletionBlockedError('FILE_IDENTITY_CHANGED');
      }
      if (file.variants.length > 0 || isFileLinked(file)) {
        throw new ManualAudioDeletionBlockedError('FILE_LINKED');
      }

      await transaction.file.delete({ where: { id: file.id } });
    });

    await this.storage.deleteObject(item.key, item.bucket);

    await this.prisma.$transaction(async (transaction) => {
      await transaction.trainingAudioStorageEntry.updateMany({
        where: { bucket: item.bucket, key: item.key },
        data: { fileId: null, deletedAt: new Date() },
      });
      const updated = await transaction.trainingAudioDeletionManifestItem.updateMany({
        where: { id: item.id, executionToken: item.executionToken },
        data: {
          status: TrainingAudioDeletionItemStatus.DELETED,
          executionToken: null,
          executionStartedAt: null,
          lastErrorCode: null,
          deletedAt: new Date(),
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException('Audio deletion manifest item lost its execution claim');
      }
    });
  }

  private async releaseManifestItem(itemId: string, executionToken: string, errorCode: string) {
    await this.prisma.trainingAudioDeletionManifestItem.updateMany({
      where: { id: itemId, executionToken },
      data: {
        status: TrainingAudioDeletionItemStatus.PENDING,
        executionToken: null,
        executionStartedAt: null,
        lastErrorCode: errorCode,
      },
    });
  }
}

class ManualAudioDeletionBlockedError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ManualAudioDeletionBlockedError';
  }
}

function buildStorageItem(input: {
  selectionId: string;
  storageEntryId: string | null;
  file: AudioFileWithConsumers | null;
  storageObject: S3ListedObject | null;
  pendingManifestId: string | null;
  bucket: string;
  key: string;
  checksum: string | null;
  etag: string | null;
  sizeBytes: bigint | null;
  mimeType: string | null;
  kind: TrainingAudioStorageObjectKind;
  project: { id: string | null; title: string } | null;
  user: { id: string | null; name: string | null; email: string | null } | null;
  createdAt: Date;
  deletedAt: Date | null;
}): TrainingAudioStorageItem {
  const linked = input.file ? isFileLinked(input.file) : false;
  const state: TrainingAudioStorageState = input.deletedAt
    ? 'DELETED'
    : input.pendingManifestId
      ? 'PENDING_DELETE'
      : input.file && input.storageObject
        ? linked ? 'LINKED' : 'UNLINKED'
        : input.file
          ? 'DB_ONLY'
          : input.storageObject
            ? 'STORAGE_ONLY'
            : 'MISSING';

  return {
    selectionId: input.selectionId,
    storageEntryId: input.storageEntryId,
    fileId: input.file?.id ?? null,
    kind: input.kind,
    bucket: input.bucket,
    key: input.key,
    checksum: input.checksum ?? input.file?.checksum ?? null,
    etag: input.etag ?? input.storageObject?.etag ?? null,
    sizeBytes: (input.sizeBytes ?? input.file?.sizeBytes ?? null)?.toString() ?? null,
    mimeType: input.mimeType ?? input.file?.mimeType ?? null,
    project: input.project,
    user: input.user,
    createdAt: input.createdAt.toISOString(),
    state,
    isLinked: linked,
    objectExists: Boolean(input.storageObject),
    dbRowExists: Boolean(input.file),
    canDelete: !input.deletedAt && !input.pendingManifestId && !linked,
    pendingManifestId: input.pendingManifestId,
  };
}

function isFileLinked(file: AudioFileWithConsumers) {
  const counts = file._count;

  return (
    counts.profilePhotoUsers > 0 ||
    counts.objectImages > 0 ||
    counts.objectFiles > 0 ||
    counts.feedXmlSources > 0 ||
    counts.feedMediaAssets > 0 ||
    counts.lotPresentationDocuments > 0 ||
    counts.projectPresentationDraftCovers > 0 ||
    counts.projectPresentationDocuments > 0 ||
    counts.projectPresentationAssets > 0 ||
    counts.trainingAnswerSegments > 0 ||
    counts.trainingMergedAnswers > 0 ||
    counts.trainingMaterialOperations > 0 ||
    counts.trainingMaterialRevisions > 0
  );
}

function matchesQuery(item: TrainingAudioStorageItem, query: TrainingAudioStorageQuery) {
  if (query.state && item.state !== query.state) return false;
  if (!query.state && item.state === 'DELETED') return false;
  const project = normalizeSearch(query.project);
  const user = normalizeSearch(query.user);

  if (project && !normalizeSearch(item.project?.title ?? '').includes(project)) return false;
  if (
    user &&
    !normalizeSearch(`${item.user?.name ?? ''} ${item.user?.email ?? ''}`).includes(user)
  ) return false;

  const createdAt = new Date(item.createdAt);
  if (query.createdFrom && createdAt < query.createdFrom) return false;
  if (query.createdToExclusive && createdAt >= query.createdToExclusive) return false;

  return true;
}

function buildFacets(items: TrainingAudioStorageItem[]) {
  const projects = new Map<string, { id: string | null; title: string }>();
  const users = new Map<string, { id: string | null; name: string | null; email: string | null }>();

  for (const item of items) {
    if (item.project) projects.set(`${item.project.id ?? ''}\0${item.project.title}`, item.project);
    if (item.user) {
      users.set(
        `${item.user.id ?? ''}\0${item.user.name ?? ''}\0${item.user.email ?? ''}`,
        item.user,
      );
    }
  }

  return {
    projects: [...projects.values()].sort((left, right) => left.title.localeCompare(right.title, 'ru')),
    users: [...users.values()].sort((left, right) =>
      (left.name ?? left.email ?? '').localeCompare(right.name ?? right.email ?? '', 'ru')),
  };
}

function serializeManifest(manifest: {
  id: string;
  reason: string;
  status: TrainingAudioDeletionManifestStatus;
  createdAt: Date;
  completedAt: Date | null;
  items: Array<{ status: TrainingAudioDeletionItemStatus; lastErrorCode?: string | null }>;
}): TrainingAudioDeletionManifestResponse {
  return {
    id: manifest.id,
    reason: manifest.reason,
    status: manifest.status,
    createdAt: manifest.createdAt.toISOString(),
    completedAt: manifest.completedAt?.toISOString() ?? null,
    totalItems: manifest.items.length,
    deletedItems: manifest.items.filter(
      (item) => item.status === TrainingAudioDeletionItemStatus.DELETED,
    ).length,
    pendingItems: manifest.items.filter(
      (item) => item.status !== TrainingAudioDeletionItemStatus.DELETED,
    ).length,
    lastErrorCodes: [...new Set(manifest.items.flatMap(
      (item) => item.lastErrorCode ? [item.lastErrorCode] : [],
    ))],
  };
}

function getPrivateAudioBucket(publicBucket: string) {
  const bucket = (process.env.TRAINING_AUDIO_BUCKET ?? 'platforma-training-audio').trim();

  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket) ||
    bucket === publicBucket
  ) {
    throw new ServiceUnavailableException('Private training audio bucket is invalid');
  }

  return bucket;
}

function getReconciliationLimit() {
  const raw = process.env.TRAINING_AUDIO_RECONCILIATION_MAX_OBJECTS;
  if (!raw) return DEFAULT_RECONCILIATION_LIMIT;
  const value = Number(raw);

  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RECONCILIATION_LIMIT) {
    throw new ServiceUnavailableException(
      'TRAINING_AUDIO_RECONCILIATION_MAX_OBJECTS is invalid',
    );
  }

  return value;
}

function inferKind(key: string) {
  return key.includes('/segments/')
    ? TrainingAudioStorageObjectKind.SEGMENT
    : TrainingAudioStorageObjectKind.MERGED;
}

function inferMimeType(key: string) {
  if (key.endsWith('.ogg')) return 'audio/ogg';
  if (key.endsWith('.wav')) return 'audio/wav';
  if (key.endsWith('.webm')) return 'audio/webm';
  return null;
}

function isTrainingAudioKey(key: string) {
  return /^training-v2\/answers\/[0-9a-f-]{36}\/(?:merged\.(?:wav|webm)|segments\/[0-9a-f-]{36}\.ogg)$/iu.test(key);
}

function encodeStorageSelection(bucket: string, key: string) {
  return `object:${Buffer.from(`${bucket}\0${key}`, 'utf8').toString('base64url')}`;
}

function objectId(bucket: string, key: string) {
  return `${bucket}\0${key}`;
}

function normalizeSearch(value: string) {
  return value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ru-RU');
}

function compareStorageItems(left: TrainingAudioStorageItem, right: TrainingAudioStorageItem) {
  return right.createdAt.localeCompare(left.createdAt) || left.key.localeCompare(right.key);
}

function compareStorageObjectIdentity(
  left: Pick<TrainingAudioStorageItem, 'bucket' | 'key'>,
  right: Pick<TrainingAudioStorageItem, 'bucket' | 'key'>,
) {
  return left.bucket.localeCompare(right.bucket) || left.key.localeCompare(right.key);
}
