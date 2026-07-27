import { createHash, randomUUID } from 'node:crypto';

import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  FileStorage,
  Prisma,
  TrainingAnswerStatus,
  TrainingAttemptStatus,
  TrainingJobKind,
  TrainingJobStatus,
  TrainingPassStatus,
} from '@prisma/client';

import { FilesService } from '../../files/files.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TRAINING_ACTIVE_ATTEMPT_STATUSES } from '../training.domain';
import { enqueueAttemptTelegramOutboxEvent } from '../telegram/training-telegram-outbox';
import { TrainingAudioConfig } from './training-audio.config';
import { TrainingAudioError } from './training-audio.error';
import { TrainingFfmpegService } from './training-ffmpeg.service';
import {
  TRAINING_TELEGRAM_AUDIO_PROVIDER,
  type TrainingTelegramAudioProvider,
} from './training-telegram-audio.provider';

const AUDIO_JOB_LIMIT_PER_DRAIN = 100;
const AUDIO_JOB_KINDS = [
  TrainingJobKind.TELEGRAM_DOWNLOAD_SEGMENT,
  TrainingJobKind.ASSEMBLE_ANSWER_AUDIO,
] as const;

type ClaimedAudioJob = {
  id: string;
  kind: TrainingJobKind;
  payloadJson: Prisma.JsonValue;
  idempotencyKey: string;
  attempts: number;
  maxAttempts: number;
};

type AudioJobOutcome = 'COMPLETED' | 'RELEASED';

@Injectable()
export class TrainingAudioWorkerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(TrainingAudioWorkerService.name);
  private readonly workerId = `training-audio:${process.pid}:${randomUUID()}`;
  private pollInterval: NodeJS.Timeout | null = null;
  private drainPromise: Promise<void> | null = null;
  private kickQueued = false;
  private destroyed = false;
  private readonly heartbeatIntervals = new Map<string, NodeJS.Timeout>();
  private readonly lostOwnership = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: TrainingAudioConfig,
    private readonly files: FilesService,
    private readonly ffmpeg: TrainingFfmpegService,
    @Inject(TRAINING_TELEGRAM_AUDIO_PROVIDER)
    private readonly telegramAudio: TrainingTelegramAudioProvider,
  ) {}

  onModuleInit() {
    this.destroyed = false;
    this.pollInterval = setInterval(() => this.kick(), this.config.workerPollMs);
    this.pollInterval.unref();
    this.kick();
  }

  async onModuleDestroy() {
    this.destroyed = true;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    const drained = this.drainPromise
      ? await waitForPromise(
          this.drainPromise,
          this.config.workerDrainTimeoutMs,
        )
      : true;
    if (!drained) {
      await this.releaseOwnedJobsAfterShutdown();
    }
    for (const interval of this.heartbeatIntervals.values()) {
      clearInterval(interval);
    }
    this.heartbeatIntervals.clear();
  }

  kick() {
    if (this.destroyed || this.kickQueued) return;
    this.kickQueued = true;
    setImmediate(() => {
      this.kickQueued = false;
      void this.drainNow().catch((error) => {
        this.logger.error(`Audio worker drain failed: ${safeError(error)}`);
      });
    });
  }

  async drainNow() {
    if (this.drainPromise) return this.drainPromise;
    if (this.destroyed) return;
    const drain = this.drainConcurrent().finally(() => {
      if (this.drainPromise === drain) this.drainPromise = null;
    });
    this.drainPromise = drain;
    return drain;
  }

  private async drainConcurrent() {
    if (this.destroyed) return;
    await this.recoverStaleJobs();
    await Promise.all(
      Array.from({ length: this.config.workerConcurrency }, () =>
        this.drainLane(),
      ),
    );
  }

  private async drainLane() {
    for (
      let index = 0;
      index < AUDIO_JOB_LIMIT_PER_DRAIN && !this.destroyed;
      index += 1
    ) {
      const job = await this.claimNextJob();
      if (!job) return;
      try {
        const outcome = await this.withHeartbeat(job.id, () =>
          this.processJob(job),
        );
        if (outcome === 'RELEASED') continue;
        await this.refreshOwnershipOrThrow(job.id);
        await this.completeJob(job.id);
      } catch (error) {
        if (error instanceof LostAudioJobOwnershipError) continue;
        await this.failJob(job, error);
      }
    }
  }

  private async claimNextJob(): Promise<ClaimedAudioJob | null> {
    while (!this.destroyed) {
      const now = new Date();
      const candidate = await this.prisma.trainingJob.findFirst({
        where: {
          kind: { in: [...AUDIO_JOB_KINDS] },
          status: TrainingJobStatus.PENDING,
          runAt: { lte: now },
        },
        orderBy: [{ runAt: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          kind: true,
          payloadJson: true,
          idempotencyKey: true,
          attempts: true,
          maxAttempts: true,
        },
      });
      if (this.destroyed) return null;
      if (!candidate) return null;
      if (candidate.attempts >= candidate.maxAttempts) {
        await this.failExhaustedCandidate(candidate, now);
        if (this.destroyed) return null;
        continue;
      }
      if (this.destroyed) return null;
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
      if (claimed.count !== 1) continue;
      this.lostOwnership.delete(candidate.id);
      return { ...candidate, attempts: candidate.attempts + 1 };
    }
    return null;
  }

  private async processJob(job: ClaimedAudioJob): Promise<AudioJobOutcome> {
    const payload = readAudioJobPayload(job.payloadJson);
    if (job.kind === TrainingJobKind.TELEGRAM_DOWNLOAD_SEGMENT) {
      if (!payload.segmentId) {
        throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
      }
      return this.downloadSegment(job, payload);
    }
    if (job.kind === TrainingJobKind.ASSEMBLE_ANSWER_AUDIO) {
      return this.assembleAnswer(job, payload);
    }
    throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
  }

  private async downloadSegment(
    job: ClaimedAudioJob,
    payload: AudioJobPayload,
  ): Promise<AudioJobOutcome> {
    if (!payload.segmentId) {
      throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
    }
    const segment = await this.prisma.trainingVoiceSegment.findFirst({
      where: {
        id: payload.segmentId,
        answerId: payload.answerId,
        answer: {
          attemptQuestion: {
            attemptId: payload.attemptId,
          },
        },
      },
      include: {
        originalFile: true,
        answer: {
          include: {
            attemptQuestion: {
              include: { attempt: true },
            },
          },
        },
      },
    });
    if (!segment) {
      throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
    }
    if (isTerminalAttempt(segment.answer.attemptQuestion.attempt.status)) {
      return 'COMPLETED';
    }
    if (segment.originalFile) {
      return 'COMPLETED';
    }

    await this.refreshOwnershipOrThrow(job.id);
    const downloaded = await this.telegramAudio.downloadVoice({
      fileId: segment.telegramFileId,
      declaredSizeBytes: segment.sizeBytes,
      declaredDurationSeconds: segment.durationSeconds,
    });
    if (
      downloaded.body.length === 0 ||
      downloaded.body.length > this.config.maxSegmentBytes
    ) {
      throw new TrainingAudioError('AUDIO_SIZE_LIMIT_EXCEEDED', false);
    }
    const checksum = createHash('sha256')
      .update(downloaded.body)
      .digest('hex');
    const extension = downloaded.mimeType === 'audio/wav' ? 'wav' : 'ogg';
    const storageKey = buildSegmentStorageKey(
      payload.answerId,
      segment.id,
      extension,
    );
    let uploaded = false;

    try {
      await this.refreshOwnershipOrThrow(job.id);
      await this.files.putPrivateTrainingAudioObject({
        key: storageKey,
        body: downloaded.body,
        mimeType: downloaded.mimeType,
      });
      uploaded = true;
      await this.runSerializable(async (tx) => {
        await acquireAttemptLock(tx, payload.attemptId);
        await this.assertOwnedJob(tx, job.id);
        const current = await tx.trainingVoiceSegment.findFirst({
          where: {
            id: segment.id,
            answerId: payload.answerId,
            answer: {
              attemptQuestion: { attemptId: payload.attemptId },
            },
          },
          include: { originalFile: true },
        });
        if (!current) {
          throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
        }
        if (current.originalFile) return;
        const bucket = this.files.getTrainingAudioBucket();
        let file = await tx.file.findFirst({
          where: {
            storage: FileStorage.MINIO,
            bucket,
            key: storageKey,
          },
        });
        if (file) {
          assertMatchingFile(
            file,
            downloaded.mimeType,
            downloaded.body.length,
            checksum,
          );
        } else {
          file = await tx.file.create({
            data: {
              storage: FileStorage.MINIO,
              bucket,
              key: storageKey,
              url: null,
              originalName: null,
              mimeType: downloaded.mimeType,
              sizeBytes: BigInt(downloaded.body.length),
              checksum,
              uploadedById: null,
            },
          });
        }
        await tx.trainingVoiceSegment.update({
          where: { id: current.id },
          data: {
            originalFileId: file.id,
            originalStorageBucket: bucket,
            originalStorageKey: storageKey,
            mimeType: downloaded.mimeType,
            sizeBytes: BigInt(downloaded.body.length),
            checksum,
            durationMilliseconds:
              current.durationSeconds === null
                ? null
                : current.durationSeconds * 1_000,
            downloadedAt: new Date(),
          },
        });
      });
      return 'COMPLETED';
    } catch (error) {
      if (
        uploaded &&
        !(error instanceof LostAudioJobOwnershipError)
      ) {
        await this.files
          .deletePrivateTrainingAudioObject(storageKey)
          .catch(() => undefined);
      }
      throw error;
    }
  }

  private async assembleAnswer(
    job: ClaimedAudioJob,
    payload: AudioJobPayload,
  ): Promise<AudioJobOutcome> {
    const answer = await this.prisma.trainingAnswer.findFirst({
      where: {
        id: payload.answerId,
        attemptQuestion: { attemptId: payload.attemptId },
      },
      include: {
        mergedAudioFile: true,
        voiceSegments: {
          orderBy: { segmentIndex: 'asc' },
          include: { originalFile: true },
        },
        attemptQuestion: {
          include: { attempt: true },
        },
      },
    });
    if (!answer) {
      throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
    }
    if (isTerminalAttempt(answer.attemptQuestion.attempt.status)) {
      return 'COMPLETED';
    }
    if (answer.status === TrainingAnswerStatus.COLLECTING) {
      throw new TrainingAudioError('ANSWER_NOT_READY', false);
    }
    if (answer.mergedAudioFile) {
      await this.ensureTranscriptionJob(
        payload.attemptId,
        payload.answerId,
      );
      return 'COMPLETED';
    }
    if (
      answer.voiceSegments.length === 0 ||
      answer.voiceSegments.some((segment) => !segment.originalFile)
    ) {
      await this.releaseWaitingJob(job);
      return 'RELEASED';
    }

    await this.prisma.trainingAnswer.updateMany({
      where: {
        id: answer.id,
        status: {
          in: [
            TrainingAnswerStatus.READY,
            TrainingAnswerStatus.DOWNLOADING,
          ],
        },
      },
      data: {
        status: TrainingAnswerStatus.DOWNLOADING,
        processingStartedAt: answer.processingStartedAt ?? new Date(),
      },
    });
    const storageKey = buildMergedStorageKey(answer.id);
    let uploaded = false;

    try {
      return await this.ffmpeg.withPreparedAudio(
        answer.voiceSegments.map((segment) => ({
          id: segment.id,
          answerId: answer.id,
          segmentIndex: segment.segmentIndex,
          receivedAt: segment.receivedAt,
          file: segment.originalFile!,
        })),
        async (prepared): Promise<AudioJobOutcome> => {
          await this.refreshOwnershipOrThrow(job.id);
          await this.files.putPrivateTrainingAudioFile({
            key: storageKey,
            filePath: prepared.path,
            mimeType: prepared.mimeType,
            checksum: prepared.checksum,
            sizeBytes: prepared.sizeBytes,
          });
          uploaded = true;
          await this.runSerializable(async (tx) => {
            await acquireAttemptLock(tx, payload.attemptId);
            await this.assertOwnedJob(tx, job.id);
            const current = await tx.trainingAnswer.findFirst({
              where: {
                id: answer.id,
                attemptQuestion: { attemptId: payload.attemptId },
              },
              include: { mergedAudioFile: true },
            });
            if (!current) {
              throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
            }
            const bucket = this.files.getTrainingAudioBucket();
            let file = current.mergedAudioFile;
            if (!file) {
              file = await tx.file.findFirst({
                where: {
                  storage: FileStorage.MINIO,
                  bucket,
                  key: storageKey,
                },
              });
            }
            if (file) {
              assertMatchingFile(
                file,
                prepared.mimeType,
                prepared.sizeBytes,
                prepared.checksum,
              );
            } else {
              file = await tx.file.create({
                data: {
                  storage: FileStorage.MINIO,
                  bucket,
                  key: storageKey,
                  url: null,
                  originalName: null,
                  mimeType: prepared.mimeType,
                  sizeBytes: BigInt(prepared.sizeBytes),
                  checksum: prepared.checksum,
                  uploadedById: null,
                },
              });
            }
            await tx.trainingAnswer.update({
              where: { id: current.id },
              data: {
                mergedAudioFileId: file.id,
                mergedAudioDurationMilliseconds:
                  prepared.durationMilliseconds,
                audioPreparedAt: new Date(),
                acousticMetricsJson:
                  prepared.metrics as unknown as Prisma.InputJsonObject,
                status: TrainingAnswerStatus.READY,
                errorCode: null,
                errorMessage: null,
              },
            });
            for (const segment of prepared.segments) {
              await tx.trainingVoiceSegment.update({
                where: { id: segment.id },
                data: {
                  durationMilliseconds: segment.durationMilliseconds,
                  durationSeconds: Math.round(
                    segment.durationMilliseconds / 1_000,
                  ),
                },
              });
            }
            await enqueueTranscriptionJob(
              tx,
              payload.attemptId,
              payload.answerId,
              new Date(),
            );
          });
          return 'COMPLETED';
        },
      );
    } catch (error) {
      if (
        uploaded &&
        !(error instanceof LostAudioJobOwnershipError)
      ) {
        await this.files
          .deletePrivateTrainingAudioObject(storageKey)
          .catch(() => undefined);
      }
      throw error;
    }
  }

  private async ensureTranscriptionJob(attemptId: string, answerId: string) {
    await this.prisma.$transaction(async (tx) => {
      await acquireAttemptLock(tx, attemptId);
      await enqueueTranscriptionJob(tx, attemptId, answerId, new Date());
    });
  }

  private async completeJob(jobId: string) {
    const completed = await this.prisma.trainingJob.updateMany({
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
        errorDetailsJson: Prisma.JsonNull,
      },
    });
    if (completed.count !== 1) {
      throw new LostAudioJobOwnershipError();
    }
  }

  private async releaseWaitingJob(job: ClaimedAudioJob) {
    const released = await this.prisma.trainingJob.updateMany({
      where: {
        id: job.id,
        status: TrainingJobStatus.RUNNING,
        lockOwner: this.workerId,
        attempts: job.attempts,
      },
      data: {
        status: TrainingJobStatus.PENDING,
        attempts: { decrement: 1 },
        runAt: new Date(Date.now() + this.config.workerPollMs),
        lockOwner: null,
        lockedAt: null,
        heartbeatAt: null,
        lastErrorCode: 'AUDIO_SEGMENTS_PENDING',
        lastErrorMessage: 'Answer audio segments are still downloading',
        errorDetailsJson: { retryable: true, waiting: true },
      },
    });
    if (released.count !== 1) {
      throw new LostAudioJobOwnershipError();
    }
    this.lostOwnership.add(job.id);
  }

  private async failJob(job: ClaimedAudioJob, error: unknown) {
    const failedAt = new Date();
    const audioError =
      error instanceof TrainingAudioError ? error : null;
    const retryable = audioError?.retryable ?? true;
    const shouldRetry = retryable && job.attempts < job.maxAttempts;
    const errorCode = audioError?.code ?? 'AUDIO_STORAGE_FAILED';
    const retryDelayMs = Math.max(
      Math.min(60_000, 500 * 2 ** Math.max(0, job.attempts - 1)),
      audioError?.retryAfterMs ?? 0,
    );
    const payload = readAudioJobPayload(job.payloadJson);

    await this.runSerializable(async (tx) => {
      await acquireAttemptLock(tx, payload.attemptId);
      const failed = await tx.trainingJob.updateMany({
        where: {
          id: job.id,
          status: TrainingJobStatus.RUNNING,
          lockOwner: this.workerId,
        },
        data: {
          status: shouldRetry
            ? TrainingJobStatus.PENDING
            : TrainingJobStatus.DEAD,
          runAt: shouldRetry
            ? new Date(failedAt.getTime() + retryDelayMs)
            : failedAt,
          finishedAt: shouldRetry ? null : failedAt,
          lockOwner: null,
          lockedAt: null,
          heartbeatAt: null,
          lastErrorCode: errorCode,
          lastErrorMessage: safeError(error),
          errorDetailsJson: {
            retryable,
            retryAfterMs: audioError?.retryAfterMs ?? null,
          },
        },
      });
      if (failed.count !== 1 || shouldRetry) return;
      await this.terminalizeAttempt(
        tx,
        payload,
        job.id,
        failedAt,
        errorCode,
        safeError(error),
      );
    });
  }

  private async failExhaustedCandidate(
    job: ClaimedAudioJob,
    failedAt: Date,
  ) {
    const payload = readAudioJobPayload(job.payloadJson);
    await this.runSerializable(async (tx) => {
      await acquireAttemptLock(tx, payload.attemptId);
      const failed = await tx.trainingJob.updateMany({
        where: {
          id: job.id,
          status: TrainingJobStatus.PENDING,
          attempts: job.attempts,
        },
        data: {
          status: TrainingJobStatus.DEAD,
          finishedAt: failedAt,
          lastErrorCode: 'AUDIO_ATTEMPTS_EXHAUSTED',
          lastErrorMessage: 'Training audio job attempts are exhausted',
          errorDetailsJson: { retryable: false },
        },
      });
      if (failed.count !== 1) return;
      await this.terminalizeAttempt(
        tx,
        payload,
        job.id,
        failedAt,
        'AUDIO_ATTEMPTS_EXHAUSTED',
        'Training audio job attempts are exhausted',
      );
    });
  }

  private async terminalizeAttempt(
    tx: Prisma.TransactionClient,
    payload: AudioJobPayload,
    failedJobId: string,
    failedAt: Date,
    errorCode: string,
    errorMessage: string,
  ) {
    await tx.trainingAnswer.updateMany({
      where: { id: payload.answerId },
      data: {
        status: TrainingAnswerStatus.FAILED,
        combinedTranscript: null,
        processingFinishedAt: failedAt,
        errorCode,
        errorMessage,
      },
    });
    const transitioned = await tx.trainingAttempt.updateMany({
      where: {
        id: payload.attemptId,
        status: { in: [...TRAINING_ACTIVE_ATTEMPT_STATUSES] },
      },
      data: {
        status: TrainingAttemptStatus.TECHNICAL_FAILURE,
        completedAt: failedAt,
        passStatus: TrainingPassStatus.PENDING,
      },
    });
    if (transitioned.count === 1) {
      await enqueueAttemptTelegramOutboxEvent(tx, {
        eventType: 'TECHNICAL_FAILURE',
        attemptId: payload.attemptId,
        idempotencyKey: `telegram:attempt-technical-failure:${payload.attemptId}`,
        runAt: failedAt,
      });
    }
    await tx.trainingJob.updateMany({
      where: {
        id: { not: failedJobId },
        idempotencyKey: { startsWith: `attempt:${payload.attemptId}:` },
        status: {
          in: [
            TrainingJobStatus.PENDING,
            TrainingJobStatus.RUNNING,
            TrainingJobStatus.FAILED,
          ],
        },
      },
      data: {
        status: TrainingJobStatus.SUCCEEDED,
        finishedAt: failedAt,
        lockOwner: null,
        lockedAt: null,
        heartbeatAt: null,
        errorDetailsJson: { terminalNoop: true },
      },
    });
  }

  private async recoverStaleJobs() {
    const staleAt = new Date(Date.now() - this.config.workerLeaseMs);
    const staleJobs = await this.prisma.trainingJob.findMany({
      where: {
        kind: { in: [...AUDIO_JOB_KINDS] },
        status: TrainingJobStatus.RUNNING,
        OR: [
          { heartbeatAt: { lt: staleAt } },
          { heartbeatAt: null, lockedAt: { lt: staleAt } },
        ],
      },
      select: {
        id: true,
        payloadJson: true,
        attempts: true,
        maxAttempts: true,
        heartbeatAt: true,
        lockedAt: true,
      },
      take: AUDIO_JOB_LIMIT_PER_DRAIN,
    });
    for (const job of staleJobs) {
      const retry = job.attempts < job.maxAttempts;
      const recoveredAt = new Date();
      const payload = readAudioJobPayload(job.payloadJson);
      await this.runSerializable(async (tx) => {
        await acquireAttemptLock(tx, payload.attemptId);
        const recovered = await tx.trainingJob.updateMany({
          where: {
            id: job.id,
            status: TrainingJobStatus.RUNNING,
            attempts: job.attempts,
            heartbeatAt: job.heartbeatAt,
            lockedAt: job.lockedAt,
          },
          data: {
            status: retry
              ? TrainingJobStatus.PENDING
              : TrainingJobStatus.DEAD,
            lockOwner: null,
            lockedAt: null,
            heartbeatAt: null,
            runAt: recoveredAt,
            finishedAt: retry ? null : recoveredAt,
            lastErrorCode: retry
              ? 'STALE_AUDIO_JOB'
              : 'STALE_AUDIO_JOB_DEAD',
            lastErrorMessage: retry
              ? 'Recovered stale training audio job lease'
              : 'Stale training audio job exhausted max attempts',
            errorDetailsJson: { retryable: retry },
          },
        });
        if (recovered.count !== 1 || retry) return;
        await this.terminalizeAttempt(
          tx,
          payload,
          job.id,
          recoveredAt,
          'STALE_AUDIO_JOB_DEAD',
          'Stale training audio job exhausted max attempts',
        );
      });
    }
  }

  private async withHeartbeat<T>(
    jobId: string,
    operation: () => Promise<T>,
  ) {
    const interval = setInterval(() => {
      void this.refreshOwnership(jobId).catch(() => undefined);
    }, this.config.workerHeartbeatMs);
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
    const owned = await this.prisma.trainingJob.updateMany({
      where: {
        id: jobId,
        status: TrainingJobStatus.RUNNING,
        lockOwner: this.workerId,
      },
      data: { heartbeatAt: new Date() },
    });
    if (owned.count !== 1) {
      this.lostOwnership.add(jobId);
      return false;
    }
    return true;
  }

  private async refreshOwnershipOrThrow(jobId: string) {
    if (!(await this.refreshOwnership(jobId))) {
      throw new LostAudioJobOwnershipError();
    }
  }

  private async assertOwnedJob(
    tx: Prisma.TransactionClient,
    jobId: string,
  ) {
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
      throw new LostAudioJobOwnershipError();
    }
  }

  private async releaseOwnedJobsAfterShutdown() {
    const jobs = await this.prisma.trainingJob.findMany({
      where: {
        kind: { in: [...AUDIO_JOB_KINDS] },
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
      const retry = job.attempts < job.maxAttempts;
      const releasedAt = new Date();
      const payload = readAudioJobPayload(job.payloadJson);
      await this.runSerializable(async (tx) => {
        await acquireAttemptLock(tx, payload.attemptId);
        const released = await tx.trainingJob.updateMany({
          where: {
            id: job.id,
            status: TrainingJobStatus.RUNNING,
            lockOwner: this.workerId,
            attempts: job.attempts,
          },
          data: {
            status: retry
              ? TrainingJobStatus.PENDING
              : TrainingJobStatus.DEAD,
            runAt: releasedAt,
            lockOwner: null,
            lockedAt: null,
            heartbeatAt: null,
            finishedAt: retry ? null : releasedAt,
            lastErrorCode: retry
              ? 'AUDIO_SHUTDOWN_RELEASE'
              : 'AUDIO_SHUTDOWN_DEAD',
            lastErrorMessage: retry
              ? 'Training audio job released during worker shutdown'
              : 'Training audio job exhausted attempts during worker shutdown',
            errorDetailsJson: { retryable: retry },
          },
        });
        if (released.count !== 1 || retry) return;
        await this.terminalizeAttempt(
          tx,
          payload,
          job.id,
          releasedAt,
          'AUDIO_SHUTDOWN_DEAD',
          'Training audio job exhausted attempts during worker shutdown',
        );
      });
    }
  }

  private async runSerializable<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        lastError = error;
        if (
          !(
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2034'
          ) ||
          attempt === 3
        ) {
          throw error;
        }
      }
    }
    throw lastError;
  }
}

type AudioJobPayload = {
  attemptId: string;
  answerId: string;
  segmentId: string | null;
};

class LostAudioJobOwnershipError extends Error {}

function readAudioJobPayload(value: Prisma.JsonValue): AudioJobPayload {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.attemptId !== 'string' ||
    typeof value.answerId !== 'string'
  ) {
    throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
  }
  return {
    attemptId: value.attemptId,
    answerId: value.answerId,
    segmentId: typeof value.segmentId === 'string' ? value.segmentId : null,
  };
}

function buildSegmentStorageKey(
  answerId: string,
  segmentId: string,
  extension: 'ogg' | 'wav',
) {
  return `training-audio/answers/${answerId}/segments/${segmentId}.${extension}`;
}

function buildMergedStorageKey(answerId: string) {
  return `training-audio/answers/${answerId}/normalized.wav`;
}

function assertMatchingFile(
  file: {
    url: string | null;
    mimeType: string | null;
    sizeBytes: bigint | null;
    checksum: string | null;
  },
  mimeType: string,
  sizeBytes: number,
  checksum: string,
) {
  if (
    file.url !== null ||
    file.mimeType !== mimeType ||
    file.sizeBytes !== BigInt(sizeBytes) ||
    file.checksum !== checksum
  ) {
    throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
  }
}

async function enqueueTranscriptionJob(
  tx: Prisma.TransactionClient,
  attemptId: string,
  answerId: string,
  runAt: Date,
) {
  await tx.trainingJob.createMany({
    data: [
      {
        kind: TrainingJobKind.TRANSCRIBE_ANSWER,
        status: TrainingJobStatus.PENDING,
        payloadJson: { attemptId, answerId },
        idempotencyKey: `attempt:${attemptId}:answer:${answerId}:transcribe`,
        runAt,
        maxAttempts: 5,
      },
    ],
    skipDuplicates: true,
  });
}

async function acquireAttemptLock(
  tx: Prisma.TransactionClient,
  attemptId: string,
) {
  await tx.$queryRaw(
    Prisma.sql`SELECT 1 AS "locked" FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`training-attempt-id:${attemptId}`}, 0))) AS "lock_state"`,
  );
}

function isTerminalAttempt(status: TrainingAttemptStatus) {
  const terminalStatuses = [
    TrainingAttemptStatus.COMPLETED,
    TrainingAttemptStatus.REQUIRES_REVIEW,
    TrainingAttemptStatus.EXPIRED,
    TrainingAttemptStatus.TECHNICAL_FAILURE,
  ] as const;
  return terminalStatuses.includes(
    status as (typeof terminalStatuses)[number],
  );
}

function safeError(error: unknown) {
  if (error instanceof TrainingAudioError) {
    return error.message;
  }
  return 'Training audio job failed';
}

async function waitForPromise(promise: Promise<void>, timeoutMs: number) {
  let timeout: NodeJS.Timeout | null = null;
  const timedOut = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
    timeout.unref();
  });
  const result = await Promise.race([
    promise.then(() => true as const),
    timedOut,
  ]);
  if (timeout) clearTimeout(timeout);
  return result;
}
