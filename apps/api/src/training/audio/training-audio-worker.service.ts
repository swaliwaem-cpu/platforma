import { createHash, randomUUID } from 'node:crypto';

import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  FileStorage,
  Prisma,
  TrainingAudioUploadKind,
  TrainingAudioUploadState,
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
import {
  TrainingFfmpegService,
  type TrainingPreparedAudio,
} from './training-ffmpeg.service';
import {
  TRAINING_TELEGRAM_AUDIO_PROVIDER,
  type TrainingTelegramAudioProvider,
} from './training-telegram-audio.provider';

const AUDIO_JOB_LIMIT_PER_DRAIN = 100;
const AUDIO_JOB_KINDS = [
  TrainingJobKind.TELEGRAM_DOWNLOAD_SEGMENT,
  TrainingJobKind.ASSEMBLE_ANSWER_AUDIO,
  TrainingJobKind.CLEANUP_TRAINING_AUDIO_OBJECT,
] as const;

export const TRAINING_AUDIO_FAULT_INJECTION = Symbol(
  'TRAINING_AUDIO_FAULT_INJECTION',
);

export interface TrainingAudioFaultInjection {
  afterObjectUpload(input: {
    intentId: string;
    kind: TrainingAudioUploadKind;
  }): Promise<void>;
}

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
    @Optional()
    @Inject(TRAINING_AUDIO_FAULT_INJECTION)
    private readonly faultInjection: TrainingAudioFaultInjection | null = null,
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
    if (job.kind === TrainingJobKind.CLEANUP_TRAINING_AUDIO_OBJECT) {
      if (!payload.intentId || !payload.cleanupMode) {
        throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
      }
      return this.cleanupAudioObject(job, payload);
    }
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
      await this.scheduleOwnerIntentCleanup(
        job.id,
        payload,
        { segmentId: segment.id },
        'TERMINAL',
      );
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
    const intent = await this.persistUploadIntent(job.id, payload, {
      kind: TrainingAudioUploadKind.ORIGINAL_SEGMENT,
      segmentId: segment.id,
      answerId: null,
      bucket: this.files.getTrainingAudioBucket(),
      objectKey: storageKey,
      expectedChecksum: checksum,
      expectedSizeBytes: downloaded.body.length,
      expectedMimeType: downloaded.mimeType,
      recoveryKey: `training-audio:segment:${segment.id}`,
    });
    if (!intent) return 'COMPLETED';
    await this.ensureIntentObject(job.id, payload, intent, async () => {
      await this.files.putPrivateTrainingAudioObject({
        bucket: intent.bucket,
        key: intent.objectKey,
        body: downloaded.body,
        mimeType: downloaded.mimeType,
        checksum,
      });
    });
    await this.commitSegmentIntent(
      job.id,
      payload,
      segment.id,
      intent.id,
    );
    return 'COMPLETED';
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
      await this.scheduleOwnerIntentCleanup(
        job.id,
        payload,
        { answerId: answer.id },
        'TERMINAL',
      );
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
    return this.ffmpeg.withPreparedAudio(
      answer.voiceSegments.map((segment) => ({
        id: segment.id,
        answerId: answer.id,
        segmentIndex: segment.segmentIndex,
        receivedAt: segment.receivedAt,
        file: segment.originalFile!,
      })),
      async (prepared): Promise<AudioJobOutcome> => {
        const intent = await this.persistUploadIntent(job.id, payload, {
          kind: TrainingAudioUploadKind.MERGED_ANSWER,
          segmentId: null,
          answerId: answer.id,
          bucket: this.files.getTrainingAudioBucket(),
          objectKey: storageKey,
          expectedChecksum: prepared.checksum,
          expectedSizeBytes: prepared.sizeBytes,
          expectedMimeType: prepared.mimeType,
          recoveryKey: `training-audio:answer:${answer.id}`,
        });
        if (!intent) return 'COMPLETED';
        await this.ensureIntentObject(
          job.id,
          payload,
          intent,
          async () => {
            await this.files.putPrivateTrainingAudioFile({
              bucket: intent.bucket,
              key: intent.objectKey,
              filePath: prepared.path,
              mimeType: prepared.mimeType,
              checksum: prepared.checksum,
              sizeBytes: prepared.sizeBytes,
            });
          },
        );
        await this.commitMergedIntent(
          job.id,
          payload,
          answer.id,
          intent.id,
          prepared,
        );
        return 'COMPLETED';
      },
    );
  }

  private async persistUploadIntent(
    jobId: string,
    payload: AudioJobPayload,
    spec: UploadIntentSpec,
  ): Promise<UploadIntentRecord | null> {
    return this.runSerializable(async (tx) => {
      await acquireAttemptLock(tx, payload.attemptId);
      await this.assertOwnedJob(tx, jobId);
      const attempt = await tx.trainingAttempt.findUnique({
        where: { id: payload.attemptId },
        select: { status: true },
      });
      if (!attempt) {
        throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
      }
      if (isTerminalAttempt(attempt.status)) {
        const existing =
          await tx.trainingAudioUploadIntent.findUnique({
            where: { recoveryKey: spec.recoveryKey },
          });
        if (
          existing &&
          existing.state !== TrainingAudioUploadState.COMMITTED &&
          existing.state !== TrainingAudioUploadState.CLEANED
        ) {
          await this.scheduleIntentCleanupTx(
            tx,
            payload,
            existing,
            'TERMINAL',
          );
        }
        return null;
      }

      const existing =
        await tx.trainingAudioUploadIntent.findUnique({
          where: { recoveryKey: spec.recoveryKey },
        });
      if (existing) {
        assertMatchingIntent(existing, spec);
        if (existing.state === TrainingAudioUploadState.CLEANED) {
          throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
        }
        return existing;
      }
      return tx.trainingAudioUploadIntent.create({
        data: {
          kind: spec.kind,
          state: TrainingAudioUploadState.PENDING,
          segmentId: spec.segmentId,
          answerId: spec.answerId,
          bucket: spec.bucket,
          objectKey: spec.objectKey,
          expectedChecksum: spec.expectedChecksum,
          expectedSizeBytes: BigInt(spec.expectedSizeBytes),
          expectedMimeType: spec.expectedMimeType,
          recoveryKey: spec.recoveryKey,
        },
      });
    });
  }

  private async ensureIntentObject(
    jobId: string,
    payload: AudioJobPayload,
    intent: UploadIntentRecord,
    upload: () => Promise<void>,
  ) {
    const current =
      await this.prisma.trainingAudioUploadIntent.findUnique({
        where: { id: intent.id },
      });
    if (!current) {
      throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
    }
    if (current.state === TrainingAudioUploadState.COMMITTED) return;
    if (current.state === TrainingAudioUploadState.CLEANUP_PENDING) {
      throw new TrainingAudioError('AUDIO_STORAGE_FAILED', true);
    }
    if (current.state === TrainingAudioUploadState.CLEANED) {
      throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
    }

    await this.refreshOwnershipOrThrow(jobId);
    const object = await this.files.headPrivateTrainingAudioObject(
      current.bucket,
      current.objectKey,
    );
    if (object.exists) {
      if (!doesObjectMatchIntent(object, current)) {
        await this.scheduleIntentCleanup(
          jobId,
          payload,
          current.id,
          'RETRY_UPLOAD',
        );
        throw new TrainingAudioError('AUDIO_STORAGE_FAILED', true);
      }
      await this.markIntentUploaded(jobId, payload, current.id);
      return;
    }

    await upload();
    await this.faultInjection?.afterObjectUpload({
      intentId: current.id,
      kind: current.kind,
    });
    await this.markIntentUploaded(jobId, payload, current.id);
  }

  private async markIntentUploaded(
    jobId: string,
    payload: AudioJobPayload,
    intentId: string,
  ) {
    await this.runSerializable(async (tx) => {
      await acquireAttemptLock(tx, payload.attemptId);
      await this.assertOwnedJob(tx, jobId);
      const updated = await tx.trainingAudioUploadIntent.updateMany({
        where: {
          id: intentId,
          state: {
            in: [
              TrainingAudioUploadState.PENDING,
              TrainingAudioUploadState.UPLOADED,
            ],
          },
        },
        data: {
          state: TrainingAudioUploadState.UPLOADED,
          uploadedAt: new Date(),
        },
      });
      if (updated.count !== 1) {
        throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
      }
    });
  }

  private async commitSegmentIntent(
    jobId: string,
    payload: AudioJobPayload,
    segmentId: string,
    intentId: string,
  ) {
    await this.runSerializable(async (tx) => {
      await acquireAttemptLock(tx, payload.attemptId);
      await this.assertOwnedJob(tx, jobId);
      const attempt = await tx.trainingAttempt.findUnique({
        where: { id: payload.attemptId },
        select: { status: true },
      });
      const intent = await tx.trainingAudioUploadIntent.findUnique({
        where: { id: intentId },
      });
      if (!attempt || !intent) {
        throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
      }
      if (isTerminalAttempt(attempt.status)) {
        await this.scheduleIntentCleanupTx(
          tx,
          payload,
          intent,
          'TERMINAL',
        );
        return;
      }
      if (intent.state !== TrainingAudioUploadState.UPLOADED) {
        throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
      }
      const current = await tx.trainingVoiceSegment.findFirst({
        where: {
          id: segmentId,
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
      const file = await findOrCreateIntentFile(tx, intent);
      if (current.originalFile) {
        assertMatchingFile(
          current.originalFile,
          intent.expectedMimeType,
          Number(intent.expectedSizeBytes),
          intent.expectedChecksum,
        );
        if (current.originalFile.id !== file.id) {
          throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
        }
      } else {
        await tx.trainingVoiceSegment.update({
          where: { id: current.id },
          data: {
            originalFileId: file.id,
            originalStorageBucket: intent.bucket,
            originalStorageKey: intent.objectKey,
            mimeType: intent.expectedMimeType,
            sizeBytes: intent.expectedSizeBytes,
            checksum: intent.expectedChecksum,
            durationMilliseconds:
              current.durationSeconds === null
                ? null
                : current.durationSeconds * 1_000,
            downloadedAt: new Date(),
          },
        });
      }
      await tx.trainingAudioUploadIntent.update({
        where: { id: intent.id },
        data: {
          state: TrainingAudioUploadState.COMMITTED,
          committedFileId: file.id,
          committedAt: new Date(),
        },
      });
    });
  }

  private async commitMergedIntent(
    jobId: string,
    payload: AudioJobPayload,
    answerId: string,
    intentId: string,
    prepared: TrainingPreparedAudio,
  ) {
    await this.runSerializable(async (tx) => {
      await acquireAttemptLock(tx, payload.attemptId);
      await this.assertOwnedJob(tx, jobId);
      const attempt = await tx.trainingAttempt.findUnique({
        where: { id: payload.attemptId },
        select: { status: true },
      });
      const intent = await tx.trainingAudioUploadIntent.findUnique({
        where: { id: intentId },
      });
      if (!attempt || !intent) {
        throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
      }
      if (isTerminalAttempt(attempt.status)) {
        await this.scheduleIntentCleanupTx(
          tx,
          payload,
          intent,
          'TERMINAL',
        );
        return;
      }
      if (intent.state !== TrainingAudioUploadState.UPLOADED) {
        throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
      }
      const current = await tx.trainingAnswer.findFirst({
        where: {
          id: answerId,
          attemptQuestion: { attemptId: payload.attemptId },
        },
        include: { mergedAudioFile: true },
      });
      if (!current) {
        throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
      }
      const file = await findOrCreateIntentFile(tx, intent);
      if (current.mergedAudioFile) {
        assertMatchingFile(
          current.mergedAudioFile,
          intent.expectedMimeType,
          Number(intent.expectedSizeBytes),
          intent.expectedChecksum,
        );
        if (current.mergedAudioFile.id !== file.id) {
          throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
        }
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
      await tx.trainingAudioUploadIntent.update({
        where: { id: intent.id },
        data: {
          state: TrainingAudioUploadState.COMMITTED,
          committedFileId: file.id,
          committedAt: new Date(),
        },
      });
      await enqueueTranscriptionJob(
        tx,
        payload.attemptId,
        payload.answerId,
        new Date(),
      );
    });
  }

  private async scheduleOwnerIntentCleanup(
    jobId: string,
    payload: AudioJobPayload,
    owner: { segmentId?: string; answerId?: string },
    mode: CleanupMode,
  ) {
    await this.runSerializable(async (tx) => {
      await acquireAttemptLock(tx, payload.attemptId);
      await this.assertOwnedJob(tx, jobId);
      const intent = await tx.trainingAudioUploadIntent.findFirst({
        where: {
          ...(owner.segmentId
            ? { segmentId: owner.segmentId }
            : { answerId: owner.answerId }),
          state: {
            notIn: [
              TrainingAudioUploadState.COMMITTED,
              TrainingAudioUploadState.CLEANED,
            ],
          },
        },
      });
      if (intent) {
        await this.scheduleIntentCleanupTx(
          tx,
          payload,
          intent,
          mode,
        );
      }
    });
  }

  private async scheduleIntentCleanup(
    jobId: string,
    payload: AudioJobPayload,
    intentId: string,
    mode: CleanupMode,
  ) {
    await this.runSerializable(async (tx) => {
      await acquireAttemptLock(tx, payload.attemptId);
      await this.assertOwnedJob(tx, jobId);
      const intent = await tx.trainingAudioUploadIntent.findUnique({
        where: { id: intentId },
      });
      if (!intent) {
        throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
      }
      await this.scheduleIntentCleanupTx(
        tx,
        payload,
        intent,
        mode,
      );
    });
  }

  private async scheduleIntentCleanupTx(
    tx: Prisma.TransactionClient,
    payload: AudioJobPayload,
    intent: UploadIntentRecord,
    mode: CleanupMode,
  ) {
    if (
      intent.state === TrainingAudioUploadState.COMMITTED ||
      intent.state === TrainingAudioUploadState.CLEANED ||
      intent.state === TrainingAudioUploadState.CLEANUP_PENDING
    ) {
      return;
    }
    const scheduled = await tx.trainingAudioUploadIntent.update({
      where: { id: intent.id },
      data: {
        state: TrainingAudioUploadState.CLEANUP_PENDING,
        cleanupRequestedAt: new Date(),
        cleanupGeneration: { increment: 1 },
      },
    });
    await tx.trainingJob.createMany({
      data: [
        {
          kind: TrainingJobKind.CLEANUP_TRAINING_AUDIO_OBJECT,
          status: TrainingJobStatus.PENDING,
          payloadJson: {
            attemptId: payload.attemptId,
            answerId: payload.answerId,
            intentId: intent.id,
            cleanupMode: mode,
          },
          idempotencyKey: `training-audio:cleanup:${intent.id}:${scheduled.cleanupGeneration}`,
          runAt: new Date(),
          maxAttempts: 5,
        },
      ],
      skipDuplicates: true,
    });
  }

  private async cleanupAudioObject(
    job: ClaimedAudioJob,
    payload: AudioJobPayload,
  ): Promise<AudioJobOutcome> {
    const intent =
      await this.prisma.trainingAudioUploadIntent.findUnique({
        where: { id: payload.intentId! },
      });
    if (!intent) return 'COMPLETED';
    if (
      intent.state === TrainingAudioUploadState.COMMITTED ||
      intent.state === TrainingAudioUploadState.CLEANED
    ) {
      return 'COMPLETED';
    }
    if (intent.state !== TrainingAudioUploadState.CLEANUP_PENDING) {
      return 'COMPLETED';
    }

    await this.refreshOwnershipOrThrow(job.id);
    try {
      await this.files.deletePrivateTrainingAudioObject(
        intent.bucket,
        intent.objectKey,
      );
      if (
        (
          await this.files.headPrivateTrainingAudioObject(
            intent.bucket,
            intent.objectKey,
          )
        ).exists
      ) {
        throw new Error('Persisted training audio object still exists');
      }
    } catch {
      throw new TrainingAudioError('AUDIO_STORAGE_FAILED', true);
    }
    await this.runSerializable(async (tx) => {
      await acquireAttemptLock(tx, payload.attemptId);
      await this.assertOwnedJob(tx, job.id);
      const attempt = await tx.trainingAttempt.findUnique({
        where: { id: payload.attemptId },
        select: { status: true },
      });
      const current = await tx.trainingAudioUploadIntent.findUnique({
        where: { id: intent.id },
      });
      if (!current) return;
      if (current.state !== TrainingAudioUploadState.CLEANUP_PENDING) {
        throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
      }
      const resumeUpload =
        payload.cleanupMode === 'RETRY_UPLOAD' &&
        attempt &&
        !isTerminalAttempt(attempt.status);
      await tx.trainingAudioUploadIntent.update({
        where: { id: current.id },
        data: resumeUpload
          ? {
              state: TrainingAudioUploadState.PENDING,
              uploadedAt: null,
              cleanupRequestedAt: null,
              cleanedAt: null,
            }
          : {
              state: TrainingAudioUploadState.CLEANED,
              cleanedAt: new Date(),
            },
      });
    });
    return 'COMPLETED';
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
      if (
        job.kind ===
        TrainingJobKind.CLEANUP_TRAINING_AUDIO_OBJECT
      ) {
        this.logger.error(
          JSON.stringify({
            event: 'training-audio-cleanup-dead',
            jobId: job.id,
            intentId: payload.intentId,
            errorCode,
          }),
        );
        return;
      }
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
      if (
        job.kind ===
        TrainingJobKind.CLEANUP_TRAINING_AUDIO_OBJECT
      ) {
        this.logger.error(
          JSON.stringify({
            event: 'training-audio-cleanup-dead',
            jobId: job.id,
            intentId: payload.intentId,
            errorCode: 'AUDIO_ATTEMPTS_EXHAUSTED',
          }),
        );
        return;
      }
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
        kind: true,
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
        if (
          job.kind ===
          TrainingJobKind.CLEANUP_TRAINING_AUDIO_OBJECT
        ) {
          this.logger.error(
            JSON.stringify({
              event: 'training-audio-cleanup-dead',
              jobId: job.id,
              intentId: payload.intentId,
              errorCode: 'STALE_AUDIO_JOB_DEAD',
            }),
          );
          return;
        }
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
      void this.refreshOwnership(jobId).catch((error) => {
        this.logger.warn(
          JSON.stringify({
            event: 'training-audio-heartbeat-failed',
            jobId,
            error: safeError(error),
          }),
        );
      });
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
        kind: true,
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
        if (
          job.kind ===
          TrainingJobKind.CLEANUP_TRAINING_AUDIO_OBJECT
        ) {
          this.logger.error(
            JSON.stringify({
              event: 'training-audio-cleanup-dead',
              jobId: job.id,
              intentId: payload.intentId,
              errorCode: 'AUDIO_SHUTDOWN_DEAD',
            }),
          );
          return;
        }
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
  intentId: string | null;
  cleanupMode: CleanupMode | null;
};

type CleanupMode = 'RETRY_UPLOAD' | 'TERMINAL';

type UploadIntentSpec = {
  kind: TrainingAudioUploadKind;
  segmentId: string | null;
  answerId: string | null;
  bucket: string;
  objectKey: string;
  expectedChecksum: string;
  expectedSizeBytes: number;
  expectedMimeType: string;
  recoveryKey: string;
};

type UploadIntentRecord = {
  id: string;
  kind: TrainingAudioUploadKind;
  state: TrainingAudioUploadState;
  segmentId: string | null;
  answerId: string | null;
  bucket: string;
  objectKey: string;
  expectedChecksum: string;
  expectedSizeBytes: bigint;
  expectedMimeType: string;
  recoveryKey: string;
  cleanupGeneration: number;
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
    intentId: typeof value.intentId === 'string' ? value.intentId : null,
    cleanupMode:
      value.cleanupMode === 'RETRY_UPLOAD' ||
      value.cleanupMode === 'TERMINAL'
        ? value.cleanupMode
        : null,
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

function assertMatchingIntent(
  intent: UploadIntentRecord,
  spec: UploadIntentSpec,
) {
  if (
    intent.kind !== spec.kind ||
    intent.segmentId !== spec.segmentId ||
    intent.answerId !== spec.answerId ||
    intent.objectKey !== spec.objectKey ||
    intent.expectedChecksum !== spec.expectedChecksum ||
    intent.expectedSizeBytes !== BigInt(spec.expectedSizeBytes) ||
    intent.expectedMimeType !== spec.expectedMimeType ||
    intent.recoveryKey !== spec.recoveryKey
  ) {
    throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
  }
}

function doesObjectMatchIntent(
  object: {
    exists: boolean;
    contentLength: number | null;
    contentType: string | null;
    sha256: string | null;
  },
  intent: UploadIntentRecord,
) {
  return (
    object.exists &&
    object.contentLength !== null &&
    BigInt(object.contentLength) === intent.expectedSizeBytes &&
    object.contentType === intent.expectedMimeType &&
    object.sha256 === intent.expectedChecksum
  );
}

async function findOrCreateIntentFile(
  tx: Prisma.TransactionClient,
  intent: UploadIntentRecord,
) {
  let file = await tx.file.findFirst({
    where: {
      storage: FileStorage.MINIO,
      bucket: intent.bucket,
      key: intent.objectKey,
    },
  });
  if (file) {
    assertMatchingFile(
      file,
      intent.expectedMimeType,
      Number(intent.expectedSizeBytes),
      intent.expectedChecksum,
    );
    return file;
  }
  file = await tx.file.create({
    data: {
      storage: FileStorage.MINIO,
      bucket: intent.bucket,
      key: intent.objectKey,
      url: null,
      originalName: null,
      mimeType: intent.expectedMimeType,
      sizeBytes: intent.expectedSizeBytes,
      checksum: intent.expectedChecksum,
      uploadedById: null,
    },
  });
  return file;
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
