import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  FileStorage,
  Prisma,
  TrainingMaterialOperationStatus,
  TrainingMaterialOperationType,
} from '@prisma/client';
import type {
  TrainingMaterialOperation as TrainingMaterialOperationContract,
  TrainingMaterialOperationItem as TrainingMaterialOperationItemContract,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

import type { UploadedFile } from '../files/uploaded-file.type';
import { S3StorageService } from '../files/s3-storage.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  TrainingMaterialService,
  type TrainingMaterialOperationClaim,
  type TrainingMaterialOperationItemProgress,
} from './training-material.service';
import { isTrainingModuleEnabled } from './training-runtime-config';

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_STALE_LOCK_MS = 5 * 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_SHUTDOWN_DRAIN_MS = 10_000;
const DEFAULT_CONCURRENCY = 1;

const operationInclude = {
  items: { orderBy: [{ ordinal: 'asc' as const }, { id: 'asc' as const }] },
} as const satisfies Prisma.TrainingMaterialOperationInclude;

type OperationRecord = Prisma.TrainingMaterialOperationGetPayload<{
  include: typeof operationInclude;
}>;

type ClaimedOperationRow = {
  id: string;
  lock_owner: string;
};

type PdfOperationInput = {
  title: string;
  replaceExistingQuestions: boolean;
  originalName: string;
  checksum: string;
  size: number;
};

type UrlOperationInput = {
  title: string;
  sourceUrl: string;
  replaceExistingQuestions: boolean;
};

type ObjectImportOperationInput = {
  objectId: string;
  replaceExistingQuestions: boolean;
};

@Injectable()
export class TrainingMaterialOperationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TrainingMaterialOperationService.name);
  private readonly workerId = `training-material-${process.pid}-${randomUUID()}`;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pumpTask: Promise<void> | null = null;
  private stopping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: S3StorageService,
    private readonly materials: TrainingMaterialService,
  ) {}

  async onModuleInit() {
    if (!isWorkerEnabled() || !isTrainingModuleEnabled()) return;
    this.timer = setInterval(() => void this.poll(), getPollIntervalMs());
    this.kick();
  }

  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.pumpTask) await settlesWithin(this.pumpTask, getShutdownDrainMs());
  }

  async list(projectId: string) {
    await this.materials.requireProjectForMaterials(projectId);
    const operations = await this.prisma.trainingMaterialOperation.findMany({
      where: { projectId },
      include: operationInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 25,
    });
    return { items: operations.map(serializeOperation) };
  }

  async get(operationId: string) {
    return serializeOperation(await this.findOperation(operationId));
  }

  async queueOfficialUrl(input: {
    projectId: string;
    actorId: string;
    idempotencyKey: string;
    title: string;
    sourceUrl: string;
    officialConfirmed: boolean;
    replaceExistingQuestions: boolean;
  }) {
    if (!input.officialConfirmed) throw new BadRequestException('OFFICIAL_CONFIRMATION_REQUIRED');
    const title = normalizeTitle(input.title);
    const sourceUrl = normalizeOfficialUrl(input.sourceUrl);
    const operationInput: UrlOperationInput = {
      title,
      sourceUrl,
      replaceExistingQuestions: input.replaceExistingQuestions,
    };
    const existing = await this.findIdempotentOperation(
      input.projectId,
      input.actorId,
      input.idempotencyKey,
    );
    if (existing) {
      return serializeOperation(assertSameOperation(
        existing,
        fingerprintOperation(TrainingMaterialOperationType.CREATE_OFFICIAL_URL, operationInput),
      ));
    }
    const project = await this.materials.assertAsyncCreationAllowed(
      input.projectId,
      input.replaceExistingQuestions,
    );
    const operation = await this.createOrReuseOperation({
      projectId: input.projectId,
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey,
      type: TrainingMaterialOperationType.CREATE_OFFICIAL_URL,
      baseKnowledgeVersion: project.knowledgeVersion,
      input: operationInput,
      resultMaterialId: randomUUID(),
      resultRevisionId: randomUUID(),
    });
    this.kick();
    return serializeOperation(operation);
  }

  async queueObjectImport(input: {
    projectId: string;
    actorId: string;
    idempotencyKey: string;
    objectId: string;
    replaceExistingQuestions: boolean;
  }) {
    const operationInput: ObjectImportOperationInput = {
      objectId: input.objectId,
      replaceExistingQuestions: input.replaceExistingQuestions,
    };
    const existing = await this.findIdempotentOperation(
      input.projectId,
      input.actorId,
      input.idempotencyKey,
    );
    if (existing) {
      return serializeOperation(assertSameOperation(
        existing,
        fingerprintOperation(TrainingMaterialOperationType.IMPORT_OBJECT, operationInput),
      ));
    }
    const project = await this.materials.assertAsyncObjectImportAllowed(
      input.projectId,
      input.objectId,
      input.replaceExistingQuestions,
    );
    const operation = await this.createOrReuseOperation({
      projectId: input.projectId,
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey,
      type: TrainingMaterialOperationType.IMPORT_OBJECT,
      baseKnowledgeVersion: project.knowledgeVersion,
      input: operationInput,
    });
    this.kick();
    return serializeOperation(operation);
  }

  async queuePdf(input: {
    projectId: string;
    actorId: string;
    idempotencyKey: string;
    title: string;
    file: UploadedFile | undefined;
    replaceExistingQuestions: boolean;
  }) {
    const file = await validateStoredPdfUpload(input.file);
    const title = normalizeTitle(input.title);
    const operationInput: PdfOperationInput = {
      title,
      replaceExistingQuestions: input.replaceExistingQuestions,
      originalName: file.originalname,
      checksum: file.checksum,
      size: file.size,
    };
    const fingerprint = fingerprintOperation(TrainingMaterialOperationType.CREATE_PDF, operationInput);
    const existing = await this.findIdempotentOperation(
      input.projectId,
      input.actorId,
      input.idempotencyKey,
    );
    if (existing) return serializeOperation(assertSameOperation(existing, fingerprint));

    const project = await this.materials.assertAsyncCreationAllowed(
      input.projectId,
      input.replaceExistingQuestions,
    );

    const operationId = randomUUID();
    const materialId = randomUUID();
    const revisionId = randomUUID();
    let operation: OperationRecord;
    try {
      operation = await this.prisma.trainingMaterialOperation.create({
        data: {
          id: operationId,
          projectId: input.projectId,
          createdById: input.actorId,
          type: TrainingMaterialOperationType.CREATE_PDF,
          status: TrainingMaterialOperationStatus.STORING,
          idempotencyKey: input.idempotencyKey,
          inputFingerprint: fingerprint,
          inputJson: operationInput,
          resultMaterialId: materialId,
          resultRevisionId: revisionId,
          baseKnowledgeVersion: project.knowledgeVersion,
          progressTotal: 1,
        },
        include: operationInclude,
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const raced = await this.findIdempotentOperation(
        input.projectId,
        input.actorId,
        input.idempotencyKey,
      );
      if (!raced) throw error;
      return serializeOperation(assertSameOperation(raced, fingerprint));
    }

    const bucket = materialBucket();
    const key = `training-v2/material-operations/${operation.id}/source.pdf`;
    let stored = false;
    try {
      await this.storage.putObjectFromFile({
        key,
        bucket,
        filePath: file.path,
        contentType: 'application/pdf',
        checksum: file.checksum,
        contentLength: file.size,
      });
      stored = true;
      operation = await this.prisma.$transaction(async (transaction) => {
        const sourceFile = await transaction.file.create({
          data: {
            storage: FileStorage.MINIO,
            bucket,
            key,
            url: null,
            originalName: file.originalname,
            mimeType: 'application/pdf',
            sizeBytes: BigInt(file.size),
            checksum: file.checksum,
            uploadedById: input.actorId,
          },
        });
        return transaction.trainingMaterialOperation.update({
          where: { id: operation.id },
          data: {
            sourceFileId: sourceFile.id,
            status: TrainingMaterialOperationStatus.QUEUED,
            availableAt: new Date(),
          },
          include: operationInclude,
        });
      });
    } catch (error) {
      if (stored) await this.storage.deleteObject(key, bucket).catch(() => undefined);
      await this.prisma.trainingMaterialOperation.deleteMany({
        where: { id: operation.id, status: TrainingMaterialOperationStatus.STORING },
      }).catch(() => undefined);
      throw error;
    }

    this.kick();
    return serializeOperation(operation);
  }

  async retry(operationId: string) {
    const operation = await this.findOperation(operationId);
    if (operation.status !== TrainingMaterialOperationStatus.FAILED) {
      throw new ConflictException('MATERIAL_OPERATION_NOT_FAILED');
    }
    if (operation.type === TrainingMaterialOperationType.CREATE_PDF && !operation.sourceFileId) {
      throw new ConflictException('MATERIAL_OPERATION_SOURCE_REQUIRED');
    }
    await this.materials.requireEditableProjectForMaterials(operation.projectId);
    const project = await this.prisma.trainingProject.findUniqueOrThrow({
      where: { id: operation.projectId },
      select: { knowledgeVersion: true },
    });
    const nextRevisionId = operation.type === TrainingMaterialOperationType.CREATE_PDF &&
      operation.resultMaterialId
      ? randomUUID()
      : operation.resultRevisionId;

    await this.prisma.$transaction(async (transaction) => {
      await transaction.trainingMaterialOperationItem.updateMany({
        where: { operationId, status: TrainingMaterialOperationStatus.FAILED },
        data: {
          status: TrainingMaterialOperationStatus.QUEUED,
          errorCode: null,
          sourceHash: null,
          resultRevisionId: null,
          startedAt: null,
          finishedAt: null,
        },
      });
      const grouped = await transaction.trainingMaterialOperationItem.groupBy({
        by: ['status'],
        where: { operationId },
        _count: { _all: true },
      });
      const completed = grouped.find((item) => item.status === TrainingMaterialOperationStatus.READY)?._count._all ?? 0;
      await transaction.trainingMaterialOperation.update({
        where: { id: operationId },
        data: {
          status: TrainingMaterialOperationStatus.QUEUED,
          baseKnowledgeVersion: project.knowledgeVersion,
          resultRevisionId: nextRevisionId,
          sourceHash: null,
          completedKnowledgeVersion: null,
          progressCompleted: completed,
          progressFailed: 0,
          errorCode: null,
          resultJson: Prisma.DbNull,
          availableAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          startedAt: null,
          finishedAt: null,
        },
      });
    });
    this.kick();
    return this.get(operationId);
  }

  kick() {
    if (this.stopping || !isWorkerEnabled() || !isTrainingModuleEnabled() || this.pumpTask) return;
    const task = this.pump();
    this.pumpTask = task;
    void task.finally(() => {
      if (this.pumpTask === task) this.pumpTask = null;
    });
  }

  async runOnce() {
    if (this.stopping || !isTrainingModuleEnabled()) return false;
    await this.recoverStoringOperations();
    const operation = await this.claimNext();
    if (!operation) return false;
    await this.processClaim(operation);
    return true;
  }

  private async poll() {
    if (this.stopping || !isTrainingModuleEnabled()) return;
    this.kick();
  }

  private async pump() {
    while (!this.stopping && isTrainingModuleEnabled() && (await this.runOnce())) {
      // Drain the currently available queue within the configured global capacity.
    }
  }

  private async recoverStoringOperations() {
    const staleBefore = new Date(Date.now() - getStaleLockMs());
    const operations = await this.prisma.trainingMaterialOperation.findMany({
      where: {
        type: TrainingMaterialOperationType.CREATE_PDF,
        status: TrainingMaterialOperationStatus.STORING,
        updatedAt: { lt: staleBefore },
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: 10,
    });
    for (const operation of operations) {
      const bucket = materialBucket();
      const key = `training-v2/material-operations/${operation.id}/source.pdf`;
      const input = parsePdfInput(operation.inputJson);
      const stored = await this.storage.statObject(key, bucket);
      if (!stored || (stored.size !== null && stored.size !== input.size)) {
        await this.prisma.trainingMaterialOperation.updateMany({
          where: { id: operation.id, status: TrainingMaterialOperationStatus.STORING },
          data: {
            status: TrainingMaterialOperationStatus.FAILED,
            progressFailed: 1,
            errorCode: 'MATERIAL_SOURCE_UPLOAD_INTERRUPTED',
            finishedAt: new Date(),
          },
        });
        continue;
      }
      await this.prisma.$transaction(async (transaction) => {
        const current = await transaction.trainingMaterialOperation.findUnique({
          where: { id: operation.id },
          select: { status: true },
        });
        if (current?.status !== TrainingMaterialOperationStatus.STORING) return;
        const sourceFile = await transaction.file.upsert({
          where: { storage_bucket_key: { storage: FileStorage.MINIO, bucket, key } },
          update: {},
          create: {
            storage: FileStorage.MINIO,
            bucket,
            key,
            url: null,
            originalName: input.originalName,
            mimeType: 'application/pdf',
            sizeBytes: BigInt(input.size),
            checksum: input.checksum,
            uploadedById: operation.createdById,
          },
        });
        await transaction.trainingMaterialOperation.update({
          where: { id: operation.id },
          data: {
            sourceFileId: sourceFile.id,
            status: TrainingMaterialOperationStatus.QUEUED,
            availableAt: new Date(),
          },
        });
      });
    }
  }

  private async claimNext(): Promise<OperationRecord & { lockOwner: string } | null> {
    const staleLockMs = getStaleLockMs();
    const concurrency = getWorkerConcurrency();
    const lockOwner = `${this.workerId}-${randomUUID()}`;
    const row = await this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(
          hashtext('platforma'),
          hashtext('training_material_worker_concurrency')
        ) IS NULL AS "lockAcquired"
      `);
      const rows = await transaction.$queryRaw<ClaimedOperationRow[]>(Prisma.sql`
        WITH capacity AS MATERIALIZED (
          SELECT COUNT(*)::integer AS "activeClaims"
          FROM "training_material_operations"
          WHERE "status" IN ('extracting', 'generating', 'persisting')
            AND "locked_at" >= CURRENT_TIMESTAMP - (${staleLockMs} * INTERVAL '1 millisecond')
        ),
        candidate AS (
          SELECT operation."id"
          FROM "training_material_operations" AS operation
          CROSS JOIN capacity
          WHERE capacity."activeClaims" < ${concurrency}
            AND (
              (operation."status" = 'queued' AND operation."available_at" <= CURRENT_TIMESTAMP)
              OR (
                operation."status" IN ('extracting', 'generating', 'persisting')
                AND operation."locked_at" < CURRENT_TIMESTAMP - (${staleLockMs} * INTERVAL '1 millisecond')
              )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM "training_material_operations" AS active
              WHERE active."project_id" = operation."project_id"
                AND active."id" <> operation."id"
                AND active."status" IN ('extracting', 'generating', 'persisting')
                AND active."locked_at" >= CURRENT_TIMESTAMP - (${staleLockMs} * INTERVAL '1 millisecond')
            )
          ORDER BY operation."available_at" ASC, operation."created_at" ASC, operation."id" ASC
          FOR UPDATE OF operation SKIP LOCKED
          LIMIT 1
        )
        UPDATE "training_material_operations" AS operation
        SET
          "status" = 'extracting',
          "attempts" = "attempts" + 1,
          "locked_at" = CURRENT_TIMESTAMP,
          "locked_by" = ${lockOwner},
          "started_at" = COALESCE("started_at", CURRENT_TIMESTAMP),
          "error_code" = NULL,
          "finished_at" = NULL,
          "updated_at" = CURRENT_TIMESTAMP
        FROM candidate
        WHERE operation."id" = candidate."id"
        RETURNING operation."id", operation."locked_by" AS "lock_owner"
      `);
      return rows[0] ?? null;
    });
    if (!row) return null;
    const operation = await this.prisma.trainingMaterialOperation.findUnique({
      where: { id: row.id },
      include: operationInclude,
    });
    return operation ? { ...operation, lockOwner: row.lock_owner } : null;
  }

  private async processClaim(operation: OperationRecord & { lockOwner: string }) {
    const heartbeat = setInterval(
      () => void this.refreshHeartbeat(operation.id, operation.lockOwner),
      getHeartbeatIntervalMs(),
    );
    const claim: TrainingMaterialOperationClaim = {
      id: operation.id,
      lockOwner: operation.lockOwner,
      baseKnowledgeVersion: operation.baseKnowledgeVersion,
      attempt: operation.attempts,
    };
    try {
      if (operation.type === TrainingMaterialOperationType.CREATE_PDF) {
        const input = parsePdfInput(operation.inputJson);
        if (!operation.sourceFileId || !operation.resultMaterialId || !operation.resultRevisionId) {
          throw new Error('MATERIAL_OPERATION_INPUT_INVALID');
        }
        const result = await this.materials.processQueuedPdfOperation({
          claim,
          actorId: operation.createdById,
          projectId: operation.projectId,
          sourceFileId: operation.sourceFileId,
          materialId: operation.resultMaterialId,
          revisionId: operation.resultRevisionId,
          ...input,
          onStage: (status) => this.updateStage(claim, status),
        });
        if (result.errorCode) {
          await this.failClaim(claim, result.errorCode, {
            materialId: result.material.id,
            revisionId: result.material.latestRevision?.id ?? null,
          });
          return;
        }
        await this.completeClaim(claim, {
          materialId: result.material.id,
          revisionId: result.material.latestRevision?.id ?? null,
        }, result.sourceHash);
        return;
      }

      if (operation.type === TrainingMaterialOperationType.CREATE_OFFICIAL_URL) {
        if (!operation.resultMaterialId || !operation.resultRevisionId) {
          throw new Error('MATERIAL_OPERATION_INPUT_INVALID');
        }
        const result = await this.materials.processQueuedOfficialUrlOperation({
          claim,
          actorId: operation.createdById,
          projectId: operation.projectId,
          materialId: operation.resultMaterialId,
          revisionId: operation.resultRevisionId,
          ...parseUrlInput(operation.inputJson),
          onStage: (status) => this.updateStage(claim, status),
        });
        await this.completeClaim(claim, {
          materialId: result.material.id,
          revisionId: result.material.latestRevision?.id ?? null,
        }, result.sourceHash);
        return;
      }

      const persistedObjectResult = parsePersistedObjectResult(operation.resultJson);
      if (persistedObjectResult) {
        await this.completeClaim(claim, persistedObjectResult, operation.sourceHash);
        return;
      }
      const objectInput = parseObjectInput(operation.inputJson);
      const checkpointedItemKeys = new Set(
        operation.items
          .filter((item) => item.status !== TrainingMaterialOperationStatus.QUEUED)
          .map((item) => item.itemKey),
      );
      const result = await this.materials.importObjectContent(
        operation.projectId,
        operation.createdById,
        objectInput.objectId,
        objectInput.replaceExistingQuestions,
        {
          claim,
          checkpointedItemKeys,
          onStage: (status) => this.updateStage(claim, status),
          onItems: (items) => this.discoverItems(claim, items),
          onItem: (item) => this.updateItem(claim, item),
        },
      );
      const project = await this.prisma.trainingProject.findUniqueOrThrow({
        where: { id: operation.projectId },
        select: { knowledgeSourceHash: true },
      });
      await this.completeClaim(claim, {
        objectId: result.object.id,
        objectTitle: result.object.title,
        objectSnapshotMaterialId: result.objectSnapshotMaterialId,
        importedPdfCount: result.importedPdfCount,
        failedPdfTitles: result.failedPdfTitles,
        questionGenerationModel: result.questionGenerationModel,
        questionGenerationSourceChars: result.questionGenerationSourceChars,
      }, project.knowledgeSourceHash);
    } catch (error) {
      await this.failClaim(claim, safeOperationErrorCode(error));
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async updateStage(
    claim: TrainingMaterialOperationClaim,
    status: 'EXTRACTING' | 'GENERATING' | 'PERSISTING',
  ) {
    const updated = await this.prisma.trainingMaterialOperation.updateMany({
      where: { id: claim.id, lockedBy: claim.lockOwner },
      data: { status },
    });
    if (updated.count !== 1) throw new Error('MATERIAL_OPERATION_CLAIM_LOST');
  }

  private async discoverItems(
    claim: TrainingMaterialOperationClaim,
    items: Array<{ itemKey: string; ordinal: number; title: string; sourceFileId?: string | null }>,
  ) {
    await this.prisma.$transaction(async (transaction) => {
      await assertClaimOwned(transaction, claim);
      for (const item of items) {
        await transaction.trainingMaterialOperationItem.upsert({
          where: { operationId_itemKey: { operationId: claim.id, itemKey: item.itemKey } },
          update: { ordinal: item.ordinal, title: item.title, sourceFileId: item.sourceFileId ?? null },
          create: {
            operationId: claim.id,
            itemKey: item.itemKey,
            ordinal: item.ordinal,
            title: item.title,
            sourceFileId: item.sourceFileId ?? null,
          },
        });
      }
      await transaction.trainingMaterialOperation.update({
        where: { id: claim.id },
        data: { progressTotal: await transaction.trainingMaterialOperationItem.count({ where: { operationId: claim.id } }) },
      });
    });
  }

  private async updateItem(
    claim: TrainingMaterialOperationClaim,
    item: TrainingMaterialOperationItemProgress,
  ) {
    await this.prisma.$transaction(async (transaction) => {
      await assertClaimOwned(transaction, claim);
      const current = await transaction.trainingMaterialOperationItem.findUnique({
        where: { operationId_itemKey: { operationId: claim.id, itemKey: item.itemKey } },
      });
      if (!current) throw new Error('MATERIAL_OPERATION_ITEM_MISSING');
      await transaction.trainingMaterialOperationItem.update({
        where: { id: current.id },
        data: {
          status: item.status,
          ...(item.status === 'EXTRACTING' ? { startedAt: current.startedAt ?? new Date() } : {}),
          ...(item.status === 'READY' || item.status === 'FAILED' ? { finishedAt: new Date() } : {}),
          errorCode: item.errorCode ?? null,
          sourceHash: item.sourceHash ?? null,
          resultMaterialId: item.resultMaterialId ?? null,
          resultRevisionId: item.resultRevisionId ?? null,
        },
      });
      const grouped = await transaction.trainingMaterialOperationItem.groupBy({
        by: ['status'],
        where: { operationId: claim.id },
        _count: { _all: true },
      });
      await transaction.trainingMaterialOperation.update({
        where: { id: claim.id },
        data: {
          progressCompleted: grouped.find((value) => value.status === TrainingMaterialOperationStatus.READY)?._count._all ?? 0,
          progressFailed: grouped.find((value) => value.status === TrainingMaterialOperationStatus.FAILED)?._count._all ?? 0,
        },
      });
    });
  }

  private async completeClaim(
    claim: TrainingMaterialOperationClaim,
    result: Record<string, Prisma.JsonValue | undefined | null>,
    sourceHash: string | null,
  ) {
    const operation = await this.findOperation(claim.id);
    const project = await this.prisma.trainingProject.findUnique({
      where: { id: operation.projectId },
      select: { knowledgeVersion: true },
    });
    const updated = await this.prisma.trainingMaterialOperation.updateMany({
      where: { id: claim.id, lockedBy: claim.lockOwner },
      data: {
        status: TrainingMaterialOperationStatus.READY,
        sourceHash,
        completedKnowledgeVersion: operation.completedKnowledgeVersion ?? project?.knowledgeVersion ?? null,
        progressCompleted: { set: Math.max(1, (await this.countItems(claim.id)).ready) },
        errorCode: null,
        resultJson: stripUndefined(result) as Prisma.InputJsonValue,
        lockedAt: null,
        lockedBy: null,
        finishedAt: new Date(),
      },
    });
    if (updated.count !== 1) throw new Error('MATERIAL_OPERATION_CLAIM_LOST');
  }

  private async failClaim(
    claim: TrainingMaterialOperationClaim,
    errorCode: string,
    result?: Record<string, Prisma.JsonValue | undefined | null>,
  ) {
    const operation = await this.prisma.trainingMaterialOperation.findUnique({
      where: { id: claim.id },
      select: { type: true, progressFailed: true },
    });
    const updated = await this.prisma.trainingMaterialOperation.updateMany({
      where: { id: claim.id, lockedBy: claim.lockOwner },
      data: {
        status: TrainingMaterialOperationStatus.FAILED,
        errorCode,
        progressFailed: operation?.type === TrainingMaterialOperationType.IMPORT_OBJECT
          ? operation.progressFailed
          : 1,
        ...(result ? { resultJson: stripUndefined(result) as Prisma.InputJsonValue } : {}),
        lockedAt: null,
        lockedBy: null,
        finishedAt: new Date(),
      },
    });
    if (updated.count !== 1) return;
    this.logger.warn({ event: 'training_material_operation_failed', type: 'material', code: errorCode });
  }

  private async refreshHeartbeat(operationId: string, lockOwner: string) {
    await this.prisma.trainingMaterialOperation.updateMany({
      where: { id: operationId, lockedBy: lockOwner },
      data: { lockedAt: new Date() },
    }).catch(() => undefined);
  }

  private async createOrReuseOperation(input: {
    projectId: string;
    actorId: string;
    idempotencyKey: string;
    type: TrainingMaterialOperationType;
    baseKnowledgeVersion: number;
    input: UrlOperationInput | ObjectImportOperationInput;
    resultMaterialId?: string;
    resultRevisionId?: string;
  }) {
    const fingerprint = fingerprintOperation(input.type, input.input);
    try {
      return await this.prisma.trainingMaterialOperation.create({
        data: {
          projectId: input.projectId,
          createdById: input.actorId,
          type: input.type,
          idempotencyKey: input.idempotencyKey,
          inputFingerprint: fingerprint,
          inputJson: input.input,
          baseKnowledgeVersion: input.baseKnowledgeVersion,
          resultMaterialId: input.resultMaterialId,
          resultRevisionId: input.resultRevisionId,
          progressTotal: input.type === TrainingMaterialOperationType.IMPORT_OBJECT ? 0 : 1,
        },
        include: operationInclude,
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const existing = await this.findIdempotentOperation(
        input.projectId,
        input.actorId,
        input.idempotencyKey,
      );
      if (!existing) throw error;
      return assertSameOperation(existing, fingerprint);
    }
  }

  private findIdempotentOperation(projectId: string, actorId: string, idempotencyKey: string) {
    return this.prisma.trainingMaterialOperation.findUnique({
      where: {
        projectId_createdById_idempotencyKey: { projectId, createdById: actorId, idempotencyKey },
      },
      include: operationInclude,
    });
  }

  private async findOperation(operationId: string) {
    const operation = await this.prisma.trainingMaterialOperation.findUnique({
      where: { id: operationId },
      include: operationInclude,
    });
    if (!operation) throw new NotFoundException('Training material operation not found');
    return operation;
  }

  private async countItems(operationId: string) {
    const grouped = await this.prisma.trainingMaterialOperationItem.groupBy({
      by: ['status'],
      where: { operationId },
      _count: { _all: true },
    });
    return {
      ready: grouped.find((value) => value.status === TrainingMaterialOperationStatus.READY)?._count._all ?? 0,
      failed: grouped.find((value) => value.status === TrainingMaterialOperationStatus.FAILED)?._count._all ?? 0,
    };
  }
}

async function assertClaimOwned(
  transaction: Prisma.TransactionClient,
  claim: TrainingMaterialOperationClaim,
) {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "training_material_operations"
    WHERE "id" = CAST(${claim.id} AS uuid)
      AND "locked_by" = ${claim.lockOwner}
    FOR UPDATE
  `);
  if (!rows[0]) throw new Error('MATERIAL_OPERATION_CLAIM_LOST');
}

function serializeOperation(operation: OperationRecord): TrainingMaterialOperationContract {
  return {
    id: operation.id,
    projectId: operation.projectId,
    type: operation.type,
    status: operation.status,
    baseKnowledgeVersion: operation.baseKnowledgeVersion,
    completedKnowledgeVersion: operation.completedKnowledgeVersion,
    sourceHash: operation.sourceHash,
    progress: {
      total: operation.progressTotal,
      completed: operation.progressCompleted,
      failed: operation.progressFailed,
    },
    attempts: operation.attempts,
    errorCode: operation.errorCode,
    result: isRecord(operation.resultJson) ? operation.resultJson : null,
    items: operation.items.map(serializeOperationItem),
    startedAt: operation.startedAt?.toISOString() ?? null,
    finishedAt: operation.finishedAt?.toISOString() ?? null,
    createdAt: operation.createdAt.toISOString(),
    updatedAt: operation.updatedAt.toISOString(),
  };
}

function serializeOperationItem(
  item: OperationRecord['items'][number],
): TrainingMaterialOperationItemContract {
  return {
    id: item.id,
    itemKey: item.itemKey,
    ordinal: item.ordinal,
    title: item.title,
    status: item.status,
    resultMaterialId: item.resultMaterialId,
    resultRevisionId: item.resultRevisionId,
    sourceHash: item.sourceHash,
    errorCode: item.errorCode,
    startedAt: item.startedAt?.toISOString() ?? null,
    finishedAt: item.finishedAt?.toISOString() ?? null,
  };
}

async function validateStoredPdfUpload(file: UploadedFile | undefined) {
  const maxBytes = readPdfMaxBytes();
  if (!file?.path || !file.checksum || file.size <= 0) throw new BadRequestException('PDF_FILE_REQUIRED');
  if (file.mimetype.toLocaleLowerCase('en-US') !== 'application/pdf' ||
    !file.originalname.toLocaleLowerCase('en-US').endsWith('.pdf')) {
    throw new BadRequestException('PDF_TYPE_INVALID');
  }
  if (file.size > maxBytes) throw new BadRequestException('PDF_SIZE_EXCEEDED');
  const handle = await open(file.path, 'r');
  try {
    const magic = Buffer.alloc(5);
    const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
    if (bytesRead !== magic.length || !magic.equals(Buffer.from('%PDF-'))) {
      throw new BadRequestException('PDF_MAGIC_INVALID');
    }
  } finally {
    await handle.close();
  }
  return {
    path: file.path,
    size: file.size,
    checksum: file.checksum,
    originalname: file.originalname.slice(0, 255),
  };
}

function parsePdfInput(value: Prisma.JsonValue): PdfOperationInput {
  if (!isRecord(value) || typeof value.title !== 'string' ||
    typeof value.replaceExistingQuestions !== 'boolean' ||
    typeof value.originalName !== 'string' || typeof value.checksum !== 'string' ||
    typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size <= 0) {
    throw new Error('MATERIAL_OPERATION_INPUT_INVALID');
  }
  return {
    title: value.title,
    replaceExistingQuestions: value.replaceExistingQuestions,
    originalName: value.originalName,
    checksum: value.checksum,
    size: value.size,
  };
}

function parseUrlInput(value: Prisma.JsonValue): UrlOperationInput {
  if (!isRecord(value) || typeof value.title !== 'string' ||
    typeof value.sourceUrl !== 'string' || typeof value.replaceExistingQuestions !== 'boolean') {
    throw new Error('MATERIAL_OPERATION_INPUT_INVALID');
  }
  return {
    title: value.title,
    sourceUrl: value.sourceUrl,
    replaceExistingQuestions: value.replaceExistingQuestions,
  };
}

function parseObjectInput(value: Prisma.JsonValue): ObjectImportOperationInput {
  if (!isRecord(value) || typeof value.objectId !== 'string' ||
    typeof value.replaceExistingQuestions !== 'boolean') {
    throw new Error('MATERIAL_OPERATION_INPUT_INVALID');
  }
  return {
    objectId: value.objectId,
    replaceExistingQuestions: value.replaceExistingQuestions,
  };
}

function parsePersistedObjectResult(value: Prisma.JsonValue | null) {
  if (!isRecord(value) || value.checkpoint !== 'QUESTIONS_PERSISTED') return null;
  const { checkpoint: _checkpoint, ...result } = value;
  return result as Record<string, Prisma.JsonValue>;
}

function fingerprintOperation(type: TrainingMaterialOperationType, input: object) {
  return createHash('sha256').update(JSON.stringify({ type, input })).digest('hex');
}

function assertSameOperation(operation: OperationRecord, fingerprint: string) {
  if (operation.inputFingerprint !== fingerprint) {
    throw new ConflictException('IDEMPOTENCY_KEY_REUSED');
  }
  return operation;
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function normalizeTitle(value: string) {
  const title = value.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (!title || title.length > 240) throw new BadRequestException('MATERIAL_TITLE_INVALID');
  return title;
}

function normalizeOfficialUrl(value: string) {
  const sourceUrl = value.trim();
  if (!sourceUrl || sourceUrl.length > 2_048) throw new BadRequestException('MATERIAL_URL_INVALID');
  try {
    const parsed = new URL(sourceUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('scheme');
    }
  } catch {
    throw new BadRequestException('MATERIAL_URL_INVALID');
  }
  return sourceUrl;
}

function readPdfMaxBytes() {
  return readBoundedInteger(
    process.env.TRAINING_MATERIAL_MAX_BYTES,
    25 * 1024 * 1024,
    1_024,
    100 * 1024 * 1024,
  );
}

function materialBucket() {
  return process.env.TRAINING_MATERIAL_BUCKET?.trim() || 'training-materials';
}

function safeOperationErrorCode(error: unknown) {
  const response = isRecord(error) && typeof error.getResponse === 'function'
    ? (error.getResponse as () => unknown)()
    : null;
  const responseMessage = isRecord(response) && typeof response.message === 'string'
    ? response.message
    : null;
  const message = responseMessage ?? (error instanceof Error ? error.message : '');
  const normalized = message.toLocaleUpperCase('en-US').replace(/[^A-Z0-9_]/gu, '_').slice(0, 120);
  return /^[A-Z][A-Z0-9_]{2,119}$/u.test(normalized) ? normalized : 'MATERIAL_OPERATION_FAILED';
}

function stripUndefined(value: Record<string, Prisma.JsonValue | undefined | null>) {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWorkerEnabled() {
  const explicit = process.env.TRAINING_MATERIAL_WORKER_ENABLED;
  if (explicit !== undefined) return explicit === 'true';
  return process.env.NODE_ENV !== 'test';
}

function getWorkerConcurrency() {
  return readBoundedInteger(process.env.TRAINING_MATERIAL_WORKER_CONCURRENCY, DEFAULT_CONCURRENCY, 1, 3);
}

function getPollIntervalMs() {
  return readBoundedInteger(process.env.TRAINING_MATERIAL_WORKER_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS, 250, 60_000);
}

function getStaleLockMs() {
  return readBoundedInteger(process.env.TRAINING_MATERIAL_WORKER_STALE_LOCK_MS, DEFAULT_STALE_LOCK_MS, 5_000, 30 * 60_000);
}

function getHeartbeatIntervalMs() {
  const configured = readBoundedInteger(
    process.env.TRAINING_MATERIAL_WORKER_HEARTBEAT_INTERVAL_MS,
    DEFAULT_HEARTBEAT_INTERVAL_MS,
    250,
    60_000,
  );
  return Math.min(configured, Math.max(250, Math.floor(getStaleLockMs() / 3)));
}

function getShutdownDrainMs() {
  return readBoundedInteger(
    process.env.TRAINING_MATERIAL_WORKER_SHUTDOWN_DRAIN_MS,
    DEFAULT_SHUTDOWN_DRAIN_MS,
    250,
    60_000,
  );
}

function readBoundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    promise.catch(() => undefined),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
}
