import { randomUUID } from 'node:crypto';

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

import {
  FilesService,
  runTrainingSnapshotDeleteWithTimeout,
} from '../files/files.service';
import { PrismaService } from '../prisma/prisma.service';
import { TrainingConfigService } from './training.config';
import {
  TRAINING_OFFICIAL_URL_DRAIN_DEADLINE_MS,
  TRAINING_OFFICIAL_URL_JOB_LEASE_MS,
  TRAINING_OFFICIAL_URL_JOB_POLL_MS,
  TRAINING_OFFICIAL_URL_MAX_JOBS_PER_DRAIN,
  TRAINING_OFFICIAL_URL_ORPHAN_BATCH_SIZE,
  TRAINING_OFFICIAL_URL_ORPHAN_DELETE_TIMEOUT_MS,
  TRAINING_OFFICIAL_URL_ORPHAN_GRACE_MS,
  TRAINING_OFFICIAL_URL_ORPHAN_SWEEP_DEADLINE_MS,
  TRAINING_OFFICIAL_URL_SHUTDOWN_TIMEOUT_MS,
} from './training-official-url.config';
import { extractTrainingOfficialUrlText } from './training-official-url-extractor';
import {
  TrainingOfficialUrlFetchError,
  TrainingOfficialUrlFetcher,
} from './training-official-url-fetcher';
import {
  formatTrainingErrorForLog,
  safeTrainingFailureMessage,
} from './training-safe-log';
import { lockTrainingVersionForContentMutation } from './training-version-lock';
import { TrainingWorkerHeartbeatService } from './training-worker-heartbeat.service';
import { isTrainingUuid } from './training-uuid';

type ClaimedOfficialUrlJob = {
  id: string;
  payloadJson: Prisma.JsonValue;
  attempts: number;
  maxAttempts: number;
};

type OfficialUrlJobPayload = {
  sourceId: string;
  fetchGeneration: number;
};

class OfficialUrlLeaseLostError extends Error {
  constructor() {
    super('Official URL source worker lease was lost');
  }
}

@Injectable()
export class TrainingOfficialUrlWorkerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(TrainingOfficialUrlWorkerService.name);
  private readonly workerId = `training-official-url:${process.pid}:${randomUUID()}`;
  private interval: NodeJS.Timeout | null = null;
  private running = false;
  private kickQueued = false;
  private stopping = false;
  private activeDrain: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly fetcher: TrainingOfficialUrlFetcher,
    @Optional()
    private readonly trainingConfig?: TrainingConfigService,
    @Optional()
    private readonly workerHeartbeat?: TrainingWorkerHeartbeatService,
  ) {}

  onModuleInit() {
    if (this.trainingConfig?.isEnabled() === false) return;
    void this.workerHeartbeat
      ?.register('official-url', this.workerId)
      .catch(() => undefined);
    this.interval = setInterval(
      () => this.kick(),
      TRAINING_OFFICIAL_URL_JOB_POLL_MS,
    );
    this.interval.unref();
    this.kick();
  }

  async onModuleDestroy() {
    this.stopping = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    const drain = this.activeDrain;
    if (drain) {
      await Promise.race([
        drain,
        waitForShutdownTimeout(TRAINING_OFFICIAL_URL_SHUTDOWN_TIMEOUT_MS),
      ]);
    }
  }

  kick() {
    if (
      this.running ||
      this.kickQueued ||
      this.stopping ||
      this.trainingConfig?.isEnabled() === false
    ) {
      return;
    }
    void this.workerHeartbeat?.touch(this.workerId).catch(() => undefined);
    this.kickQueued = true;
    queueMicrotask(() => {
      this.kickQueued = false;
      if (this.stopping) return;
      const drain = this.drain();
      this.activeDrain = drain;
      void drain.finally(() => {
        if (this.activeDrain === drain) {
          this.activeDrain = null;
        }
      });
    });
  }

  private async drain() {
    if (
      this.running ||
      this.stopping ||
      this.trainingConfig?.isEnabled() === false
    ) {
      return;
    }
    this.running = true;
    const deadlineAt = Date.now() + TRAINING_OFFICIAL_URL_DRAIN_DEADLINE_MS;
    let reachedBound = false;

    try {
      await this.recoverOrphanSnapshots();
      await this.recoverStaleJobs();
      for (
        let processed = 0;
        processed < TRAINING_OFFICIAL_URL_MAX_JOBS_PER_DRAIN;
        processed += 1
      ) {
        if (this.stopping || Date.now() >= deadlineAt) {
          reachedBound = true;
          break;
        }
        if (!(await this.processNext())) {
          break;
        }
        if (processed + 1 === TRAINING_OFFICIAL_URL_MAX_JOBS_PER_DRAIN) {
          reachedBound = true;
        }
      }
    } catch (error) {
      this.logger.error(
        `Official URL source worker loop failed: ${formatTrainingErrorForLog(error)}`,
      );
    } finally {
      this.running = false;
      if (reachedBound && !this.stopping) {
        this.kick();
      }
    }
  }

  private async processNext() {
    const candidate = await this.prisma.trainingJob.findFirst({
      where: {
        kind: TrainingJobKind.FETCH_OFFICIAL_URL_SOURCE,
        status: TrainingJobStatus.PENDING,
        runAt: { lte: new Date() },
      },
      orderBy: [{ runAt: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        payloadJson: true,
        attempts: true,
        maxAttempts: true,
      },
    });
    if (!candidate) return false;

    const claimed = await this.prisma.trainingJob.updateMany({
      where: {
        id: candidate.id,
        status: TrainingJobStatus.PENDING,
      },
      data: {
        status: TrainingJobStatus.RUNNING,
        attempts: { increment: 1 },
        lockOwner: this.workerId,
        lockedAt: new Date(),
        heartbeatAt: new Date(),
        finishedAt: null,
      },
    });
    if (claimed.count === 0) return true;

    await this.processClaimed({
      ...candidate,
      attempts: candidate.attempts + 1,
    });
    return true;
  }

  private async processClaimed(job: ClaimedOfficialUrlJob) {
    const payload = readOfficialUrlJobPayload(job.payloadJson);
    if (!payload) {
      await this.failOwnedJob(
        job,
        null,
        new TrainingOfficialUrlFetchError(
          'INVALID_JOB_PAYLOAD',
          'Задание официального URL-источника повреждено',
        ),
      );
      return;
    }

    let leaseLost = false;
    let uploadedSnapshotId: string | null = null;
    let previousSnapshotId: string | null = null;
    const heartbeat = setInterval(() => {
      void this.refreshLease(job.id).then((owned) => {
        if (!owned) leaseLost = true;
      });
    }, Math.max(1_000, Math.floor(TRAINING_OFFICIAL_URL_JOB_LEASE_MS / 3)));
    heartbeat.unref();

    try {
      const source = await this.prisma.trainingOfficialUrlSource.findUnique({
        where: { id: payload.sourceId },
        include: {
          projectVersion: {
            select: {
              id: true,
              status: true,
            },
          },
        },
      });
      if (!source) {
        throw new Error('Official URL source no longer exists');
      }
      if (
        source.fetchGeneration !== payload.fetchGeneration ||
        source.projectVersion.status !== TrainingVersionStatus.DRAFT
      ) {
        await this.completeObsoleteJob(job.id);
        return;
      }

      const markedProcessing = await this.prisma.$transaction(async (tx) => {
        if (!(await this.isMutableVersionLocked(tx, source.projectVersionId))) {
          return { count: 0 };
        }
        const owned = await tx.trainingJob.updateMany({
          where: {
            id: job.id,
            status: TrainingJobStatus.RUNNING,
            lockOwner: this.workerId,
            attempts: job.attempts,
          },
          data: {
            heartbeatAt: new Date(),
          },
        });
        if (owned.count !== 1) {
          return { count: 0 };
        }
        return tx.trainingOfficialUrlSource.updateMany({
          where: {
            id: source.id,
            fetchGeneration: payload.fetchGeneration,
            extractionStatus: {
              in: [
                TrainingSourceExtractionStatus.PENDING,
                TrainingSourceExtractionStatus.PROCESSING,
              ],
            },
          },
          data: {
            extractionStatus: TrainingSourceExtractionStatus.PROCESSING,
            errorCode: null,
            errorMessage: null,
          },
        });
      });
      if (markedProcessing.count === 0) {
        await this.completeObsoleteJob(job.id);
        return;
      }

      const fetched = await this.fetcher.fetch({
        url: source.normalizedUrl,
        confirmedOfficialHost: source.hostname,
      });
      if (leaseLost || !(await this.refreshLease(job.id))) {
        throw new OfficialUrlLeaseLostError();
      }

      const extraction = await extractTrainingOfficialUrlText(
        fetched.text,
        fetched.normalizedUrl,
      );
      const snapshot = await this.files.uploadPrivateTrainingSourceSnapshot(
        {
          buffer: fetched.body,
          originalName: `${source.hostname}-${source.id}.html`,
          mimeType: fetched.contentType,
        },
        source.confirmedById,
      );
      uploadedSnapshotId = snapshot.id;
      previousSnapshotId = source.snapshotFileId;

      if (leaseLost || !(await this.refreshLease(job.id))) {
        throw new OfficialUrlLeaseLostError();
      }

      const completedAt = new Date();
      const sourceStatus = extraction.needsManualText
        ? TrainingSourceExtractionStatus.NEEDS_MANUAL_TEXT
        : TrainingSourceExtractionStatus.READY;
      const persisted = await this.prisma.$transaction(async (tx) => {
        const mutableVersion = await this.isMutableVersionLocked(
          tx,
          source.projectVersionId,
        );
        if (!mutableVersion) {
          const obsolete = await tx.trainingJob.updateMany({
            where: {
              id: job.id,
              status: TrainingJobStatus.RUNNING,
              lockOwner: this.workerId,
            },
            data: {
              status: TrainingJobStatus.SUCCEEDED,
              finishedAt: completedAt,
              lockOwner: null,
              lockedAt: null,
              heartbeatAt: null,
              lastErrorCode: null,
              lastErrorMessage: null,
              errorDetailsJson: {
                obsolete: true,
              },
            },
          });
          if (obsolete.count === 0) {
            throw new OfficialUrlLeaseLostError();
          }
          return false;
        }
        const owned = await tx.trainingJob.updateMany({
          where: {
            id: job.id,
            status: TrainingJobStatus.RUNNING,
            lockOwner: this.workerId,
          },
          data: {
            heartbeatAt: completedAt,
          },
        });
        if (owned.count === 0) {
          throw new OfficialUrlLeaseLostError();
        }
        const updated = await tx.trainingOfficialUrlSource.updateMany({
          where: {
            id: source.id,
            fetchGeneration: payload.fetchGeneration,
            extractionStatus: TrainingSourceExtractionStatus.PROCESSING,
          },
          data: {
            snapshotFileId: snapshot.id,
            finalUrl: fetched.finalUrl,
            extractionStatus: sourceStatus,
            extractedText: extraction.text || null,
            contentHash: fetched.contentHash,
            extractionMetadataJson: {
              source: 'official_url_snapshot',
              fetch: fetched.metadata,
              title: extraction.title,
              segments: extraction.segments,
              truncated: extraction.truncated,
              scoringEligible: false,
              snapshot: {
                fileId: snapshot.id,
                checksum: snapshot.checksum,
                sizeBytes: snapshot.sizeBytes?.toString() ?? null,
              },
            },
            errorCode: null,
            errorMessage: null,
            fetchedAt: completedAt,
          },
        });
        if (updated.count === 0) {
          throw new OfficialUrlLeaseLostError();
        }
        await tx.trainingJob.updateMany({
          where: {
            id: job.id,
            status: TrainingJobStatus.RUNNING,
            lockOwner: this.workerId,
          },
          data: {
            status: TrainingJobStatus.SUCCEEDED,
            finishedAt: completedAt,
            lockOwner: null,
            lockedAt: null,
            heartbeatAt: null,
            lastErrorCode: null,
            lastErrorMessage: null,
            errorDetailsJson: Prisma.JsonNull,
          },
        });
        return true;
      });
      if (!persisted) return;
      uploadedSnapshotId = null;

      if (
        previousSnapshotId &&
        previousSnapshotId !== snapshot.id
      ) {
        await this.files.deleteUnlinkedFile(previousSnapshotId);
      }
    } catch (error) {
      if (!(error instanceof OfficialUrlLeaseLostError)) {
        await this.failOwnedJob(job, payload, error);
      }
    } finally {
      clearInterval(heartbeat);
      if (uploadedSnapshotId) {
        await this.files.deleteUnlinkedFile(uploadedSnapshotId);
      }
    }
  }

  private async failOwnedJob(
    job: ClaimedOfficialUrlJob,
    payload: OfficialUrlJobPayload | null,
    error: unknown,
  ) {
    const retryable = isRetryableOfficialUrlError(error);
    const shouldRetry = retryable && job.attempts < job.maxAttempts;
    const code =
      error instanceof TrainingOfficialUrlFetchError
        ? error.code
        : 'OFFICIAL_URL_PROCESSING_FAILED';
    const message =
      error instanceof TrainingOfficialUrlFetchError
        ? error.message
        : safeTrainingFailureMessage(
            error,
            'Не удалось обработать официальный URL-источник',
          );
    const now = new Date();
    const source = payload
      ? await this.prisma.trainingOfficialUrlSource.findUnique({
          where: { id: payload.sourceId },
          select: {
            id: true,
            projectVersionId: true,
            fetchGeneration: true,
          },
        })
      : null;

    const changed = await this.prisma.$transaction(async (tx) => {
      const mutableVersion =
        source && source.fetchGeneration === payload?.fetchGeneration
          ? await this.isMutableVersionLocked(tx, source.projectVersionId)
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
            ? new Date(now.getTime() + Math.min(job.attempts, 10) * 2_000)
            : undefined,
          finishedAt: shouldRetry ? null : now,
          lockOwner: null,
          lockedAt: null,
          heartbeatAt: null,
          lastErrorCode: code,
          lastErrorMessage: message,
          errorDetailsJson: {
            retryable,
          },
        },
      });
      if (failed.count !== 1) return false;

      if (source && mutableVersion) {
        await tx.trainingOfficialUrlSource.updateMany({
          where: {
            id: source.id,
            fetchGeneration: source.fetchGeneration,
            extractionStatus: TrainingSourceExtractionStatus.PROCESSING,
          },
          data: {
            extractionStatus: shouldRetry
              ? TrainingSourceExtractionStatus.PENDING
              : TrainingSourceExtractionStatus.FAILED,
            errorCode: code,
            errorMessage: message,
          },
        });
      }
      return true;
    });

    if (changed) {
      this.logger.warn(`Official URL source job ${job.id} failed: ${code}`);
    }
  }

  private async refreshLease(jobId: string) {
    const refreshed = await this.prisma.trainingJob.updateMany({
      where: {
        id: jobId,
        status: TrainingJobStatus.RUNNING,
        lockOwner: this.workerId,
      },
      data: {
        heartbeatAt: new Date(),
      },
    });
    return refreshed.count === 1;
  }

  private async completeObsoleteJob(jobId: string) {
    await this.prisma.trainingJob.updateMany({
      where: {
        id: jobId,
        status: TrainingJobStatus.RUNNING,
        lockOwner: this.workerId,
      },
      data: {
        status: TrainingJobStatus.SUCCEEDED,
        finishedAt: new Date(),
        lockOwner: null,
        lockedAt: null,
        heartbeatAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        errorDetailsJson: {
          obsolete: true,
        },
      },
    });
  }

  private async isMutableVersionLocked(
    tx: Prisma.TransactionClient,
    projectVersionId: string,
  ) {
    const version = await lockTrainingVersionForContentMutation(
      tx,
      projectVersionId,
    );
    return (
      version?.status === TrainingVersionStatus.DRAFT &&
      version.projectStatus !== TrainingProjectStatus.ARCHIVED
    );
  }

  private async recoverStaleJobs() {
    const staleBefore = new Date(
      Date.now() - TRAINING_OFFICIAL_URL_JOB_LEASE_MS,
    );
    const jobs = await this.prisma.trainingJob.findMany({
      where: {
        kind: TrainingJobKind.FETCH_OFFICIAL_URL_SOURCE,
        status: TrainingJobStatus.RUNNING,
        OR: [
          {
            heartbeatAt: {
              lt: staleBefore,
            },
          },
          {
            heartbeatAt: null,
            lockedAt: {
              lt: staleBefore,
            },
          },
        ],
      },
      orderBy: { lockedAt: 'asc' },
      take: 25,
      select: {
        id: true,
        payloadJson: true,
        attempts: true,
        maxAttempts: true,
        lockOwner: true,
      },
    });

    for (const job of jobs) {
      const payload = readOfficialUrlJobPayload(job.payloadJson);
      const shouldRetry = job.attempts < job.maxAttempts;
      const source = payload
        ? await this.prisma.trainingOfficialUrlSource.findUnique({
            where: { id: payload.sourceId },
            select: {
              id: true,
              projectVersionId: true,
              fetchGeneration: true,
            },
          })
        : null;
      await this.prisma.$transaction(async (tx) => {
        const mutableVersion =
          source && source.fetchGeneration === payload?.fetchGeneration
            ? await this.isMutableVersionLocked(tx, source.projectVersionId)
            : false;
        const updated = await tx.trainingJob.updateMany({
          where: {
            id: job.id,
            status: TrainingJobStatus.RUNNING,
            lockOwner: job.lockOwner,
            OR: [
              {
                heartbeatAt: {
                  lt: staleBefore,
                },
              },
              {
                heartbeatAt: null,
                lockedAt: {
                  lt: staleBefore,
                },
              },
            ],
          },
          data: {
            status: shouldRetry
              ? TrainingJobStatus.PENDING
              : TrainingJobStatus.DEAD,
            runAt: shouldRetry ? new Date() : undefined,
            finishedAt: shouldRetry ? null : new Date(),
            lockOwner: null,
            lockedAt: null,
            heartbeatAt: null,
            lastErrorCode: shouldRetry
              ? 'STALE_OFFICIAL_URL_JOB_RECOVERED'
              : 'STALE_OFFICIAL_URL_JOB_DEAD',
            lastErrorMessage: shouldRetry
              ? 'Recovered stale official URL source job'
              : 'Official URL source job exhausted its lease retries',
            errorDetailsJson: {
              retryable: shouldRetry,
            },
          },
        });
        if (
          updated.count === 0 ||
          !source ||
          source.fetchGeneration !== payload?.fetchGeneration ||
          !mutableVersion
        ) {
          return;
        }
        await tx.trainingOfficialUrlSource.updateMany({
          where: {
            id: source.id,
            fetchGeneration: source.fetchGeneration,
            extractionStatus: TrainingSourceExtractionStatus.PROCESSING,
          },
          data: {
            extractionStatus: shouldRetry
              ? TrainingSourceExtractionStatus.PENDING
              : TrainingSourceExtractionStatus.FAILED,
            errorCode: shouldRetry
              ? 'STALE_JOB_RECOVERED'
              : 'STALE_JOB_DEAD',
            errorMessage: shouldRetry
              ? 'Обработка источника восстановлена после перезапуска'
              : 'Обработка источника не завершилась после повторных попыток',
          },
        });
      });
    }
  }

  private async recoverOrphanSnapshots() {
    const sweepDeadlineAt =
      Date.now() + TRAINING_OFFICIAL_URL_ORPHAN_SWEEP_DEADLINE_MS;
    const orphanedFiles = await this.prisma.file.findMany({
      where: {
        key: {
          startsWith: 'training-source-snapshots/',
        },
        createdAt: {
          lt: new Date(Date.now() - TRAINING_OFFICIAL_URL_ORPHAN_GRACE_MS),
        },
        trainingOfficialUrlSnapshots: {
          none: {},
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
      take: TRAINING_OFFICIAL_URL_ORPHAN_BATCH_SIZE,
      select: {
        id: true,
      },
    });

    for (const file of orphanedFiles) {
      const remainingMs = sweepDeadlineAt - Date.now();
      if (this.stopping || remainingMs <= 0) return;
      await runTrainingSnapshotDeleteWithTimeout(
        (signal) => this.files.deleteUnlinkedFile(file.id, signal),
        Math.min(
          TRAINING_OFFICIAL_URL_ORPHAN_DELETE_TIMEOUT_MS,
          remainingMs,
        ),
      );
    }
  }
}

function readOfficialUrlJobPayload(
  value: Prisma.JsonValue,
): OfficialUrlJobPayload | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !isTrainingUuid(value.sourceId) ||
    !Number.isInteger(value.fetchGeneration) ||
    Number(value.fetchGeneration) < 1
  ) {
    return null;
  }
  return {
    sourceId: value.sourceId,
    fetchGeneration: Number(value.fetchGeneration),
  };
}

function isRetryableOfficialUrlError(error: unknown) {
  if (!(error instanceof TrainingOfficialUrlFetchError)) return true;
  return new Set([
    'CONNECT_TIMEOUT',
    'DNS_LOOKUP_FAILED',
    'DNS_LOOKUP_TIMEOUT',
    'NETWORK_ERROR',
    'READ_TIMEOUT',
    'TOTAL_TIMEOUT',
    'UPSTREAM_STATUS',
  ]).has(error.code);
}

function waitForShutdownTimeout(timeoutMs: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref();
  });
}
