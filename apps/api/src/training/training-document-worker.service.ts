import { createHash, randomUUID } from 'node:crypto';

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import {
  Prisma,
  TrainingJobKind,
  TrainingJobStatus,
  TrainingProjectStatus,
  TrainingSourceExtractionStatus,
  TrainingVersionStatus,
} from '@prisma/client';

import { FilesService } from '../files/files.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  TRAINING_DOCUMENT_EXTRACTION_TIMEOUT_MS,
  TRAINING_DOCUMENT_JOB_POLL_MS,
} from './training-document.config';
import { TrainingDocumentExtractorRegistry } from './training-document-extractor';
import { TrainingConfigService } from './training.config';
import {
  formatTrainingErrorForLog,
  safeTrainingFailureMessage,
} from './training-safe-log';
import { lockTrainingVersionForContentMutation } from './training-version-lock';
import { TrainingWorkerHeartbeatService } from './training-worker-heartbeat.service';
import { waitForTrainingWorkerPromise as waitForPromise } from './training-worker-shutdown';
import { isTrainingUuid } from './training-uuid';

const DOCUMENT_JOB_LIMIT_PER_DRAIN = 25;
const DOCUMENT_JOB_LEASE_MS = Math.max(
  120_000,
  TRAINING_DOCUMENT_EXTRACTION_TIMEOUT_MS * 3,
);
const DOCUMENT_JOB_HEARTBEAT_MS = Math.max(
  1_000,
  Math.min(5_000, Math.floor(DOCUMENT_JOB_LEASE_MS / 3)),
);
const DOCUMENT_WORKER_DRAIN_TIMEOUT_MS = 30_000;
const DOCUMENT_WORKER_RELEASE_TIMEOUT_MS = 5_000;

type ClaimedDocumentJob = {
  id: string;
  payloadJson: Prisma.JsonValue;
  attempts: number;
  maxAttempts: number;
};

type DocumentJobClaimResult = ClaimedDocumentJob | 'ADVANCED' | null;

@Injectable()
export class TrainingDocumentWorkerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(TrainingDocumentWorkerService.name);
  private readonly workerId = `training-document:${process.pid}:${randomUUID()}`;
  private readonly extractors = new TrainingDocumentExtractorRegistry();
  private pollInterval: NodeJS.Timeout | null = null;
  private drainPromise: Promise<void> | null = null;
  private kickQueued = false;
  private destroyed = false;
  private readonly heartbeatIntervals = new Map<string, NodeJS.Timeout>();
  private readonly lostOwnership = new Set<string>();
  private readonly claimedDocuments = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    @Optional()
    private readonly trainingConfig?: TrainingConfigService,
    @Optional()
    private readonly workerHeartbeat?: TrainingWorkerHeartbeatService,
  ) {}

  onModuleInit() {
    this.destroyed = false;
    if (this.trainingConfig?.isEnabled() === false) return;
    void this.workerHeartbeat
      ?.register('document', this.workerId)
      .catch(() => undefined);
    this.pollInterval = setInterval(
      () => this.kick(),
      TRAINING_DOCUMENT_JOB_POLL_MS,
    );
    this.pollInterval.unref();
    this.kick();
  }

  async onModuleDestroy() {
    this.destroyed = true;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    try {
      const drained = this.drainPromise
        ? await waitForPromise(
            this.drainPromise,
            DOCUMENT_WORKER_DRAIN_TIMEOUT_MS,
          )
        : true;
      if (!drained) {
        const releasePromise = this.releaseOwnedJobsAfterShutdown().catch(
          (error) => {
            this.logger.warn(
              `Document worker shutdown release failed: ${formatTrainingErrorForLog(error)}`,
            );
          },
        );
        const released = await waitForPromise(
          releasePromise,
          DOCUMENT_WORKER_RELEASE_TIMEOUT_MS,
        );
        if (!released) {
          this.logger.warn(
            'Document worker shutdown release timed out; stale lease recovery will resume the job',
          );
        }
      }
    } catch (error) {
      this.logger.warn(
        `Document worker shutdown release failed: ${formatTrainingErrorForLog(error)}`,
      );
    } finally {
      for (const interval of this.heartbeatIntervals.values()) {
        clearInterval(interval);
      }
      this.heartbeatIntervals.clear();
    }
  }

  kick() {
    if (
      this.destroyed ||
      this.kickQueued ||
      this.trainingConfig?.isEnabled() === false
    ) {
      return;
    }
    void this.workerHeartbeat?.touch(this.workerId).catch(() => undefined);
    this.kickQueued = true;
    setImmediate(() => {
      this.kickQueued = false;
      void this.drain();
    });
  }

  private drain() {
    if (this.drainPromise) return this.drainPromise;
    if (this.destroyed || this.trainingConfig?.isEnabled() === false) {
      return;
    }
    const drain = this.drainLoop()
      .catch((error) => {
        this.logger.error(
          `Training document worker loop failed: ${formatTrainingErrorForLog(error)}`,
        );
      })
      .finally(() => {
        if (this.drainPromise === drain) {
          this.drainPromise = null;
        }
      });
    this.drainPromise = drain;
    return drain;
  }

  private async drainLoop() {
    if (this.destroyed || this.trainingConfig?.isEnabled() === false) return;
    await this.recoverStaleJobs();

    for (
      let index = 0;
      index < DOCUMENT_JOB_LIMIT_PER_DRAIN &&
      !this.destroyed &&
      this.trainingConfig?.isEnabled() !== false;
      index += 1
    ) {
      const job = await this.claimNextJob();
      if (!job) return;
      if (job === 'ADVANCED') continue;

      try {
        await this.withHeartbeat(job.id, () => this.processClaimed(job));
      } catch (error) {
        if (error instanceof LostDocumentJobOwnershipError) continue;
        await this.failJob(job, readSourceDocumentId(job.payloadJson), error);
      } finally {
        this.claimedDocuments.delete(job.id);
      }
    }
  }

  private async claimNextJob(): Promise<DocumentJobClaimResult> {
    if (this.destroyed) return null;
    const now = new Date();
    const candidate = await this.prisma.trainingJob.findFirst({
      where: {
        kind: TrainingJobKind.EXTRACT_SOURCE_DOCUMENT,
        status: TrainingJobStatus.PENDING,
        runAt: { lte: now },
      },
      orderBy: [{ runAt: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        payloadJson: true,
        attempts: true,
        maxAttempts: true,
      },
    });
    if (this.destroyed || !candidate) return null;

    if (candidate.attempts >= candidate.maxAttempts) {
      await this.failExhaustedCandidate(candidate, now);
      return 'ADVANCED';
    }

    const claimed = await this.prisma.trainingJob.updateMany({
      where: {
        id: candidate.id,
        status: TrainingJobStatus.PENDING,
        runAt: { lte: now },
        attempts: candidate.attempts,
        maxAttempts: candidate.maxAttempts,
      },
      data: {
        status: TrainingJobStatus.RUNNING,
        attempts: { increment: 1 },
        lockOwner: this.workerId,
        lockedAt: now,
        heartbeatAt: now,
        finishedAt: null,
      },
    });
    if (claimed.count !== 1) return 'ADVANCED';

    const job = {
      ...candidate,
      attempts: candidate.attempts + 1,
    };
    this.lostOwnership.delete(job.id);
    if (this.destroyed) {
      await this.releaseClaimedJobAfterShutdown(job);
      return null;
    }
    return job;
  }

  private async processClaimed(job: ClaimedDocumentJob) {
    const sourceDocumentId = readSourceDocumentId(job.payloadJson);
    if (!sourceDocumentId) {
      throw new Error('Extraction job payload has no sourceDocumentId');
    }

    await this.refreshOwnershipOrThrow(job.id);
    const document = await this.prisma.trainingSourceDocument.findUnique({
      where: { id: sourceDocumentId },
      include: { file: true },
    });

    if (!document) {
      throw new Error('Training source document no longer exists');
    }

    const decision = await this.prepareDocumentForExtraction(job, document.id);
    if (decision !== 'PROCESS') return;
    this.claimedDocuments.set(job.id, document.id);

    const buffer = await this.files.readStoredFile(document.file);
    const checksum = createHash('sha256').update(buffer).digest('hex');
    if (checksum !== document.checksum.toLocaleLowerCase('en-US')) {
      throw new Error('Stored training document checksum does not match');
    }
    const extraction = await this.extractors.extract(
      document.documentType,
      buffer,
    );
    await this.refreshOwnershipOrThrow(job.id);
    const status = extraction.needsManualText
      ? TrainingSourceExtractionStatus.NEEDS_MANUAL_TEXT
      : TrainingSourceExtractionStatus.READY;
    const completedAt = new Date();

    await this.prisma.$transaction(async (tx) => {
      const mutableVersion = await this.lockMutableVersionForDocument(
        tx,
        document.id,
      );
      await this.assertOwnedJob(tx, job.id);
      if (!mutableVersion) {
        await this.completeOwnedJob(tx, job.id, { obsolete: true });
        return;
      }
      const updated = await tx.trainingSourceDocument.updateMany({
        where: {
          id: document.id,
          extractionStatus: TrainingSourceExtractionStatus.PROCESSING,
        },
        data: {
          extractionStatus: status,
          extractedText: extraction.text || null,
          extractionMetadataJson: {
            source: 'automatic',
            segments: extraction.segments,
            truncated: extraction.truncated,
            scoringEligible: false,
          },
          errorMessage: null,
        },
      });
      if (updated.count !== 1) {
        throw new LostDocumentSourceClaimError();
      }
      await this.completeOwnedJob(tx, job.id, Prisma.JsonNull, completedAt);
    });
  }

  private async prepareDocumentForExtraction(
    job: ClaimedDocumentJob,
    sourceDocumentId: string,
  ): Promise<'PROCESS' | 'RELEASED' | 'OBSOLETE'> {
    return this.prisma.$transaction(async (tx) => {
      const mutableVersion = await this.lockMutableVersionForDocument(
        tx,
        sourceDocumentId,
      );
      await this.assertOwnedJob(tx, job.id);
      if (!mutableVersion) {
        await this.completeOwnedJob(tx, job.id, { obsolete: true });
        return 'OBSOLETE';
      }
      const marked = await tx.trainingSourceDocument.updateMany({
        where: {
          id: sourceDocumentId,
          extractionStatus: {
            in: [
              TrainingSourceExtractionStatus.PENDING,
              TrainingSourceExtractionStatus.FAILED,
            ],
          },
        },
        data: {
          extractionStatus: TrainingSourceExtractionStatus.PROCESSING,
          errorMessage: null,
        },
      });
      if (marked.count === 1) return 'PROCESS';

      const document = await tx.trainingSourceDocument.findUnique({
        where: { id: sourceDocumentId },
        select: { extractionStatus: true },
      });
      if (!document) {
        throw new Error('Training source document no longer exists');
      }

      if (
        document.extractionStatus ===
        TrainingSourceExtractionStatus.PROCESSING
      ) {
        const otherActiveJob = await tx.trainingJob.findFirst({
          where: {
            id: { not: job.id },
            kind: TrainingJobKind.EXTRACT_SOURCE_DOCUMENT,
            status: TrainingJobStatus.RUNNING,
            payloadJson: {
              path: ['sourceDocumentId'],
              equals: sourceDocumentId,
            },
          },
          select: { id: true },
        });
        if (!otherActiveJob) {
          return 'PROCESS';
        }
        const released = await tx.trainingJob.updateMany({
          where: {
            id: job.id,
            status: TrainingJobStatus.RUNNING,
            lockOwner: this.workerId,
            attempts: job.attempts,
          },
          data: {
            status: TrainingJobStatus.PENDING,
            attempts: { decrement: 1 },
            runAt: new Date(Date.now() + TRAINING_DOCUMENT_JOB_POLL_MS),
            finishedAt: null,
            lockOwner: null,
            lockedAt: null,
            heartbeatAt: null,
            lastErrorCode: 'DOCUMENT_EXTRACTION_ALREADY_RUNNING',
            lastErrorMessage:
              'Another worker is already extracting this document',
            errorDetailsJson: { retryable: true, waiting: true },
          },
        });
        if (released.count !== 1) {
          throw new LostDocumentJobOwnershipError();
        }
        return 'RELEASED';
      }

      await this.completeOwnedJob(tx, job.id, { obsolete: true });
      return 'OBSOLETE';
    });
  }

  private async failJob(
    job: ClaimedDocumentJob,
    sourceDocumentId: string | null,
    error: unknown,
  ) {
    const shouldRetry = job.attempts < job.maxAttempts;
    const message = toSafeErrorMessage(error);
    const failedAt = new Date();
    const ownsDocument =
      sourceDocumentId !== null &&
      this.claimedDocuments.get(job.id) === sourceDocumentId;
    const changed = await this.prisma.$transaction(async (tx) => {
      const mutableVersion =
        sourceDocumentId && ownsDocument
          ? await this.lockMutableVersionForDocument(tx, sourceDocumentId)
          : false;
      const failed = await tx.trainingJob.updateMany({
        where: {
          id: job.id,
          status: TrainingJobStatus.RUNNING,
          lockOwner: this.workerId,
          attempts: job.attempts,
        },
        data: {
          status: shouldRetry
            ? TrainingJobStatus.PENDING
            : TrainingJobStatus.DEAD,
          runAt: shouldRetry
            ? new Date(
                failedAt.getTime() + Math.min(job.attempts, 10) * 2_000,
              )
            : undefined,
          finishedAt: shouldRetry ? null : failedAt,
          lockOwner: null,
          lockedAt: null,
          heartbeatAt: null,
          lastErrorCode: 'DOCUMENT_EXTRACTION_FAILED',
          lastErrorMessage: message,
          errorDetailsJson: { retryable: shouldRetry },
        },
      });
      if (failed.count !== 1) return false;

      if (sourceDocumentId && mutableVersion) {
        await tx.trainingSourceDocument.updateMany({
          where: {
            id: sourceDocumentId,
            extractionStatus: TrainingSourceExtractionStatus.PROCESSING,
          },
          data: {
            extractionStatus: shouldRetry
              ? TrainingSourceExtractionStatus.PENDING
              : TrainingSourceExtractionStatus.FAILED,
            errorMessage: message,
          },
        });
      }
      return true;
    });

    if (changed) {
      this.logger.warn(`Document extraction job ${job.id} failed: ${message}`);
    }
  }

  private async failExhaustedCandidate(
    job: ClaimedDocumentJob,
    failedAt: Date,
  ) {
    const sourceDocumentId = readSourceDocumentId(job.payloadJson);
    const message = 'Document extraction attempts are exhausted';
    await this.prisma.$transaction(async (tx) => {
      const mutableVersion = sourceDocumentId
        ? await this.lockMutableVersionForDocument(tx, sourceDocumentId)
        : false;
      const failed = await tx.trainingJob.updateMany({
        where: {
          id: job.id,
          kind: TrainingJobKind.EXTRACT_SOURCE_DOCUMENT,
          status: TrainingJobStatus.PENDING,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
        },
        data: {
          status: TrainingJobStatus.DEAD,
          finishedAt: failedAt,
          lockOwner: null,
          lockedAt: null,
          heartbeatAt: null,
          lastErrorCode: 'DOCUMENT_ATTEMPTS_EXHAUSTED',
          lastErrorMessage: message,
          errorDetailsJson: { retryable: false },
        },
      });
      if (failed.count !== 1 || !sourceDocumentId || !mutableVersion) return;
      await this.resetDocumentAfterLeaseEnd(
        tx,
        job.id,
        sourceDocumentId,
        false,
        message,
      );
    });
  }

  private async recoverStaleJobs() {
    const staleAt = new Date(Date.now() - DOCUMENT_JOB_LEASE_MS);
    const staleJobs = await this.prisma.trainingJob.findMany({
      where: {
        kind: TrainingJobKind.EXTRACT_SOURCE_DOCUMENT,
        status: TrainingJobStatus.RUNNING,
        OR: [
          { heartbeatAt: { lt: staleAt } },
          { heartbeatAt: null, lockedAt: { lt: staleAt } },
        ],
      },
      orderBy: { lockedAt: 'asc' },
      take: DOCUMENT_JOB_LIMIT_PER_DRAIN,
      select: {
        id: true,
        payloadJson: true,
        attempts: true,
        maxAttempts: true,
        lockOwner: true,
        lockedAt: true,
        heartbeatAt: true,
      },
    });

    for (const job of staleJobs) {
      const sourceDocumentId = readSourceDocumentId(job.payloadJson);
      const shouldRetry = job.attempts < job.maxAttempts;
      const recoveredAt = new Date();
      await this.prisma.$transaction(async (tx) => {
        const mutableVersion = sourceDocumentId
          ? await this.lockMutableVersionForDocument(tx, sourceDocumentId)
          : false;
        const recovered = await tx.trainingJob.updateMany({
          where: {
            id: job.id,
            status: TrainingJobStatus.RUNNING,
            attempts: job.attempts,
            lockOwner: job.lockOwner,
            lockedAt: job.lockedAt,
            heartbeatAt: job.heartbeatAt,
          },
          data: {
            status: shouldRetry
              ? TrainingJobStatus.PENDING
              : TrainingJobStatus.DEAD,
            runAt: recoveredAt,
            finishedAt: shouldRetry ? null : recoveredAt,
            lockOwner: null,
            lockedAt: null,
            heartbeatAt: null,
            lastErrorCode: shouldRetry
              ? 'STALE_DOCUMENT_JOB_RECOVERED'
              : 'STALE_DOCUMENT_JOB_DEAD',
            lastErrorMessage: shouldRetry
              ? 'Recovered stale document extraction job lease'
              : 'Stale document extraction job exhausted max attempts',
            errorDetailsJson: { retryable: shouldRetry },
          },
        });
        if (
          recovered.count !== 1 ||
          !sourceDocumentId ||
          !mutableVersion
        ) {
          return;
        }
        await this.resetDocumentAfterLeaseEnd(
          tx,
          job.id,
          sourceDocumentId,
          shouldRetry,
          'Document extraction stopped after a stale worker lease',
        );
      });
    }
  }

  private async withHeartbeat<T>(
    jobId: string,
    operation: () => Promise<T>,
  ) {
    const interval = setInterval(() => {
      void this.refreshOwnership(jobId).catch((error) => {
        this.logger.warn(
          `Document extraction heartbeat failed: ${formatTrainingErrorForLog(error)}`,
        );
      });
    }, DOCUMENT_JOB_HEARTBEAT_MS);
    interval.unref();
    this.heartbeatIntervals.set(jobId, interval);
    try {
      return await operation();
    } finally {
      clearInterval(interval);
      this.heartbeatIntervals.delete(jobId);
    }
  }

  private async refreshOwnership(jobId: string) {
    if (this.lostOwnership.has(jobId)) return false;
    const refreshed = await this.prisma.trainingJob.updateMany({
      where: {
        id: jobId,
        status: TrainingJobStatus.RUNNING,
        lockOwner: this.workerId,
      },
      data: { heartbeatAt: new Date() },
    });
    if (refreshed.count !== 1) {
      this.lostOwnership.add(jobId);
      return false;
    }
    return true;
  }

  private async refreshOwnershipOrThrow(jobId: string) {
    if (!(await this.refreshOwnership(jobId))) {
      throw new LostDocumentJobOwnershipError();
    }
  }

  private async assertOwnedJob(
    tx: Prisma.TransactionClient,
    jobId: string,
  ) {
    if (this.lostOwnership.has(jobId)) {
      throw new LostDocumentJobOwnershipError();
    }
    const owned = await tx.trainingJob.updateMany({
      where: {
        id: jobId,
        status: TrainingJobStatus.RUNNING,
        lockOwner: this.workerId,
      },
      data: { heartbeatAt: new Date() },
    });
    if (owned.count !== 1) {
      this.lostOwnership.add(jobId);
      throw new LostDocumentJobOwnershipError();
    }
  }

  private async releaseClaimedJobAfterShutdown(job: ClaimedDocumentJob) {
    this.lostOwnership.add(job.id);
    await this.prisma.trainingJob.updateMany({
      where: {
        id: job.id,
        status: TrainingJobStatus.RUNNING,
        lockOwner: this.workerId,
        attempts: job.attempts,
      },
      data: {
        status: TrainingJobStatus.PENDING,
        attempts: { decrement: 1 },
        runAt: new Date(),
        finishedAt: null,
        lockOwner: null,
        lockedAt: null,
        heartbeatAt: null,
        lastErrorCode: 'DOCUMENT_SHUTDOWN_BEFORE_PROCESSING',
        lastErrorMessage:
          'Document extraction claim released before processing started',
        errorDetailsJson: { retryable: true },
      },
    });
  }

  private async releaseOwnedJobsAfterShutdown() {
    const jobs = await this.prisma.trainingJob.findMany({
      where: {
        kind: TrainingJobKind.EXTRACT_SOURCE_DOCUMENT,
        status: TrainingJobStatus.RUNNING,
        lockOwner: this.workerId,
      },
      select: {
        id: true,
        payloadJson: true,
        attempts: true,
        maxAttempts: true,
      },
    });
    for (const job of jobs) {
      this.lostOwnership.add(job.id);
      await this.releaseOwnedJobAfterShutdown(job);
    }
  }

  private async releaseOwnedJobAfterShutdown(job: ClaimedDocumentJob) {
    const sourceDocumentId = readSourceDocumentId(job.payloadJson);
    const ownsDocument =
      sourceDocumentId !== null &&
      this.claimedDocuments.get(job.id) === sourceDocumentId;
    const shouldRetry = job.attempts < job.maxAttempts;
    const releasedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      const mutableVersion =
        sourceDocumentId && ownsDocument
          ? await this.lockMutableVersionForDocument(tx, sourceDocumentId)
          : false;
      const released = await tx.trainingJob.updateMany({
        where: {
          id: job.id,
          status: TrainingJobStatus.RUNNING,
          lockOwner: this.workerId,
          attempts: job.attempts,
        },
        data: {
          status: shouldRetry
            ? TrainingJobStatus.PENDING
            : TrainingJobStatus.DEAD,
          runAt: releasedAt,
          finishedAt: shouldRetry ? null : releasedAt,
          lockOwner: null,
          lockedAt: null,
          heartbeatAt: null,
          lastErrorCode: shouldRetry
            ? 'DOCUMENT_SHUTDOWN_RELEASE'
            : 'DOCUMENT_SHUTDOWN_DEAD',
          lastErrorMessage: shouldRetry
            ? 'Document extraction job released during worker shutdown'
            : 'Document extraction job exhausted attempts during worker shutdown',
          errorDetailsJson: { retryable: shouldRetry },
        },
      });
      if (released.count !== 1 || !sourceDocumentId || !mutableVersion) return;
      await this.resetDocumentAfterLeaseEnd(
        tx,
        job.id,
        sourceDocumentId,
        shouldRetry,
        'Document extraction stopped during worker shutdown',
      );
    });
  }

  private async lockMutableVersionForDocument(
    tx: Prisma.TransactionClient,
    sourceDocumentId: string,
  ) {
    const identity = await tx.trainingSourceDocument.findUnique({
      where: { id: sourceDocumentId },
      select: { projectVersionId: true },
    });
    if (!identity) return false;

    const version = await lockTrainingVersionForContentMutation(
      tx,
      identity.projectVersionId,
    );
    if (
      version?.status !== TrainingVersionStatus.DRAFT ||
      version.projectStatus === TrainingProjectStatus.ARCHIVED
    ) {
      return false;
    }

    await tx.$queryRaw`SELECT "id" FROM "training_source_documents" WHERE "id" = ${sourceDocumentId}::uuid FOR UPDATE`;
    const lockedDocument = await tx.trainingSourceDocument.findUnique({
      where: { id: sourceDocumentId },
      select: { projectVersionId: true },
    });
    return lockedDocument?.projectVersionId === version.id;
  }

  private async completeOwnedJob(
    tx: Prisma.TransactionClient,
    jobId: string,
    errorDetailsJson: Prisma.InputJsonValue | typeof Prisma.JsonNull,
    finishedAt = new Date(),
  ) {
    const completed = await tx.trainingJob.updateMany({
      where: {
        id: jobId,
        status: TrainingJobStatus.RUNNING,
        lockOwner: this.workerId,
      },
      data: {
        status: TrainingJobStatus.SUCCEEDED,
        finishedAt,
        lockOwner: null,
        lockedAt: null,
        heartbeatAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        errorDetailsJson,
      },
    });
    if (completed.count !== 1) {
      throw new LostDocumentJobOwnershipError();
    }
  }

  private async resetDocumentAfterLeaseEnd(
    tx: Prisma.TransactionClient,
    releasedJobId: string,
    sourceDocumentId: string,
    shouldRetry: boolean,
    terminalMessage: string,
  ) {
    const otherActiveJob = await tx.trainingJob.findFirst({
      where: {
        id: { not: releasedJobId },
        kind: TrainingJobKind.EXTRACT_SOURCE_DOCUMENT,
        status: TrainingJobStatus.RUNNING,
        payloadJson: {
          path: ['sourceDocumentId'],
          equals: sourceDocumentId,
        },
      },
      select: { id: true },
    });
    if (otherActiveJob) return;
    await tx.trainingSourceDocument.updateMany({
      where: {
        id: sourceDocumentId,
        extractionStatus: {
          in: [
            TrainingSourceExtractionStatus.PENDING,
            TrainingSourceExtractionStatus.PROCESSING,
          ],
        },
      },
      data: {
        extractionStatus: shouldRetry
          ? TrainingSourceExtractionStatus.PENDING
          : TrainingSourceExtractionStatus.FAILED,
        errorMessage: shouldRetry ? null : terminalMessage,
      },
    });
  }
}

class LostDocumentJobOwnershipError extends Error {}
class LostDocumentSourceClaimError extends Error {}

function readSourceDocumentId(value: Prisma.JsonValue) {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    typeof value.sourceDocumentId !== 'string' ||
    !isTrainingUuid(value.sourceDocumentId, 8)
  ) {
    return null;
  }

  return value.sourceDocumentId;
}

function toSafeErrorMessage(error: unknown) {
  return safeTrainingFailureMessage(error, 'Document extraction failed');
}
