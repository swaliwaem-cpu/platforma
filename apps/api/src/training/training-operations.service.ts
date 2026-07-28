import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  TrainingAttemptStatus,
  TrainingJobStatus,
  TrainingReviewStatus,
} from '@prisma/client';

import { S3StorageService } from '../files/s3-storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { TrainingOpenAiConfig } from './openai/training-openai.config';
import { TrainingTelegramConfig } from './telegram/training-telegram.config';
import { TrainingConfigService } from './training.config';

@Injectable()
export class TrainingOperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly trainingConfig: TrainingConfigService,
    private readonly telegramConfig: TrainingTelegramConfig,
    private readonly openAiConfig: TrainingOpenAiConfig,
    private readonly storage: S3StorageService,
  ) {}

  async getSummary() {
    const [
      jobs,
      providerRuns,
      attemptsRequiringReview,
      activeAttempts,
      stuckAttempts,
      oldestPendingJob,
      recentErrors,
      workerHeartbeats,
      lastSucceededJob,
      lastProcessedUpdate,
      activePolicy,
      recentAcceptances,
    ] = await Promise.all([
      this.prisma.trainingJob.groupBy({
        by: ['kind', 'status'],
        _count: { _all: true },
      }),
      this.prisma.trainingProviderRun.groupBy({
        by: ['kind', 'status'],
        _count: { _all: true },
      }),
      this.prisma.trainingAttempt.count({
        where: { reviewStatus: TrainingReviewStatus.PENDING },
      }),
      this.prisma.trainingAttempt.count({
        where: { status: { in: ACTIVE_ATTEMPT_STATUSES } },
      }),
      this.prisma.trainingAttempt.count({
        where: {
          status: { in: ACTIVE_ATTEMPT_STATUSES },
          updatedAt: { lt: new Date(Date.now() - STUCK_ATTEMPT_MS) },
        },
      }),
      this.prisma.trainingJob.findFirst({
        where: { status: TrainingJobStatus.PENDING },
        orderBy: [{ runAt: 'asc' }, { createdAt: 'asc' }],
        select: { runAt: true, createdAt: true },
      }),
      this.prisma.trainingJob.findMany({
        where: { lastErrorCode: { not: null } },
        orderBy: { updatedAt: 'desc' },
        distinct: ['lastErrorCode'],
        take: 20,
        select: {
          id: true,
          kind: true,
          status: true,
          lastErrorCode: true,
          updatedAt: true,
        },
      }),
      this.prisma.trainingWorkerHeartbeat.findMany({
        orderBy: { lastSeenAt: 'desc' },
        take: 40,
        select: {
          workerKind: true,
          startedAt: true,
          lastSeenAt: true,
        },
      }),
      this.prisma.trainingJob.findFirst({
        where: { status: TrainingJobStatus.SUCCEEDED },
        orderBy: { finishedAt: 'desc' },
        select: { finishedAt: true },
      }),
      this.prisma.trainingProcessedUpdate.findFirst({
        where: { processedAt: { not: null } },
        orderBy: { processedAt: 'desc' },
        select: { processedAt: true },
      }),
      this.prisma.trainingPolicyVersion.findFirst({
        where: { isActive: true },
        select: {
          id: true,
          version: true,
          title: true,
          effectiveAt: true,
          approvalStatus: true,
          checksum: true,
        },
      }),
      this.prisma.trainingPolicyAcceptance.findMany({
        orderBy: { acceptedAt: 'desc' },
        take: 20,
        select: {
          acceptedAt: true,
          revokedAt: true,
          source: true,
          user: { select: { id: true, name: true } },
          policyVersion: { select: { version: true } },
        },
      }),
    ]);

    const now = Date.now();
    return {
      generatedAt: new Date(now).toISOString(),
      training: this.trainingConfig.getConfig(),
      modes: {
        telegram: this.telegramConfig.transportMode,
        openAi: this.openAiConfig.providerMode,
      },
      audioPrivacy: this.storage.getTrainingAudioPrivacyStatus(),
      queue: jobs.map((item) => ({
        kind: item.kind,
        status: item.status,
        count: item._count._all,
      })),
      providerRuns: providerRuns.map((item) => ({
        kind: item.kind,
        status: item.status,
        count: item._count._all,
      })),
      oldestPendingAgeSeconds: oldestPendingJob
        ? Math.max(
            0,
            Math.floor(
              (now -
                Math.min(
                  oldestPendingJob.runAt.getTime(),
                  oldestPendingJob.createdAt.getTime(),
                )) /
                1_000,
            ),
          )
        : null,
      activeAttempts,
      stuckAttempts,
      attemptsRequiringReview,
      recentErrors: recentErrors.map((item) => ({
        jobId: item.id,
        kind: item.kind,
        status: item.status,
        code: item.lastErrorCode,
        occurredAt: item.updatedAt.toISOString(),
      })),
      workers: newestHeartbeatPerKind(workerHeartbeats).map((item) => ({
        kind: item.workerKind,
        status:
          now - item.lastSeenAt.getTime() <= 60_000 ? 'ONLINE' : 'STALE',
        startedAt: item.startedAt.toISOString(),
        lastSeenAt: item.lastSeenAt.toISOString(),
      })),
      lastSuccessfulProcessing: {
        jobAt: lastSucceededJob?.finishedAt?.toISOString() ?? null,
        telegramUpdateAt:
          lastProcessedUpdate?.processedAt?.toISOString() ?? null,
      },
      activePolicy: activePolicy
        ? {
            ...activePolicy,
            effectiveAt: activePolicy.effectiveAt.toISOString(),
          }
        : null,
      recentPolicyAcceptances: recentAcceptances.map((item) => ({
        user: item.user,
        policyVersion: item.policyVersion.version,
        source: item.source,
        acceptedAt: item.acceptedAt.toISOString(),
        revokedAt: item.revokedAt?.toISOString() ?? null,
      })),
    };
  }

  async retryJob(jobId: string, actorUserId: string, reason: unknown) {
    const normalizedReason = readRetryReason(reason);
    this.trainingConfig.assertEnabled();

    return this.prisma.$transaction(async (tx) => {
      const job = await tx.trainingJob.findUnique({
        where: { id: jobId },
        select: {
          id: true,
          kind: true,
          status: true,
          payloadJson: true,
          lastErrorCode: true,
        },
      });
      if (!job) throw new NotFoundException('Training job not found');
      if (
        job.status !== TrainingJobStatus.FAILED &&
        job.status !== TrainingJobStatus.DEAD
      ) {
        throw new ConflictException(
          'Only failed or dead training jobs can be retried',
        );
      }
      await assertJobCanBeRetried(tx, job);

      const retried = await tx.trainingJob.updateMany({
        where: {
          id: job.id,
          status: { in: [TrainingJobStatus.FAILED, TrainingJobStatus.DEAD] },
        },
        data: {
          status: TrainingJobStatus.PENDING,
          runAt: new Date(),
          attempts: 0,
          lockOwner: null,
          lockedAt: null,
          heartbeatAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          errorDetailsJson: Prisma.JsonNull,
          finishedAt: null,
        },
      });
      if (retried.count !== 1) {
        throw new ConflictException('Training job status changed');
      }
      await tx.auditLog.create({
        data: {
          actorUserId,
          action: 'training.operations.job.retry',
          entityType: 'training_job',
          entityId: job.id,
          metadata: {
            jobKind: job.kind,
            previousStatus: job.status,
            reason: normalizedReason,
          },
        },
      });
      return {
        job: {
          id: job.id,
          kind: job.kind,
          status: TrainingJobStatus.PENDING,
        },
      };
    });
  }
}

async function assertJobCanBeRetried(
  tx: Prisma.TransactionClient,
  job: {
    kind: string;
    payloadJson: Prisma.JsonValue;
    lastErrorCode: string | null;
  },
) {
  if (
    job.lastErrorCode &&
    /(?:INVALID|MALFORMED|SECURITY|NOT_RETRYABLE|PERMANENT)/u.test(
      job.lastErrorCode,
    )
  ) {
    throw new ConflictException(
      'Terminal invalid training job cannot be retried',
    );
  }
  if (
    !job.payloadJson ||
    typeof job.payloadJson !== 'object' ||
    Array.isArray(job.payloadJson)
  ) {
    throw new ConflictException('Training job payload cannot be validated');
  }
  const payload = job.payloadJson as Prisma.JsonObject;
  let referencesChecked = 0;
  referencesChecked += await assertStringReference(
    payload.attemptId,
    (id) => tx.trainingAttempt.findUnique({ where: { id }, select: { id: true } }),
  );
  referencesChecked += await assertStringReference(
    payload.answerId,
    (id) => tx.trainingAnswer.findUnique({ where: { id }, select: { id: true } }),
  );
  referencesChecked += await assertStringReference(
    payload.segmentId,
    (id) => tx.trainingVoiceSegment.findUnique({ where: { id }, select: { id: true } }),
  );
  referencesChecked += await assertStringReference(
    payload.intentId,
    (id) => tx.trainingAudioUploadIntent.findUnique({ where: { id }, select: { id: true } }),
  );
  referencesChecked += await assertStringReference(
    payload.sourceDocumentId,
    (id) => tx.trainingSourceDocument.findUnique({ where: { id }, select: { id: true } }),
  );
  if (payload.updateId !== undefined) {
    const updateId = readBigIntReference(payload.updateId);
    const update = await tx.trainingProcessedUpdate.findUnique({
      where: { updateId },
      select: { updateId: true },
    });
    if (!update) throw missingJobReference();
    referencesChecked += 1;
  }
  if (referencesChecked === 0 && payload.chatId !== undefined) {
    const telegramChatId = readBigIntReference(payload.chatId);
    const account = await tx.trainingTelegramAccount.findFirst({
      where: { telegramChatId, revokedAt: null },
      select: { id: true },
    });
    if (!account) throw missingJobReference();
    referencesChecked += 1;
  }
  if (referencesChecked === 0) {
    throw new ConflictException(
      `Training job ${job.kind} has no verifiable domain reference`,
    );
  }
}

async function assertStringReference(
  value: Prisma.JsonValue | undefined,
  lookup: (id: string) => Promise<unknown>,
) {
  if (value === undefined) return 0;
  if (typeof value !== 'string' || value.length === 0) {
    throw missingJobReference();
  }
  if (!(await lookup(value))) throw missingJobReference();
  return 1;
}

function readBigIntReference(value: Prisma.JsonValue) {
  if (typeof value !== 'string' || !/^-?\d+$/u.test(value)) {
    throw missingJobReference();
  }
  try {
    return BigInt(value);
  } catch {
    throw missingJobReference();
  }
}

function missingJobReference() {
  return new ConflictException(
    'Training job domain reference is missing or invalid',
  );
}

const STUCK_ATTEMPT_MS = 15 * 60 * 1_000;
const ACTIVE_ATTEMPT_STATUSES: TrainingAttemptStatus[] = [
  TrainingAttemptStatus.STARTED,
  TrainingAttemptStatus.AWAITING_MAIN,
  TrainingAttemptStatus.PROCESSING_MAIN,
  TrainingAttemptStatus.AWAITING_FOLLOW_UP,
  TrainingAttemptStatus.PROCESSING_FOLLOW_UP,
  TrainingAttemptStatus.FINALIZING,
];

function readRetryReason(value: unknown) {
  if (typeof value !== 'string') {
    throw new BadRequestException('reason is required');
  }
  const reason = value.trim();
  if (reason.length < 3 || reason.length > 500) {
    throw new BadRequestException('reason must contain from 3 to 500 characters');
  }
  return reason;
}

function newestHeartbeatPerKind<
  T extends { workerKind: string; lastSeenAt: Date },
>(heartbeats: T[]) {
  const newest = new Map<string, T>();
  for (const heartbeat of heartbeats) {
    if (!newest.has(heartbeat.workerKind)) {
      newest.set(heartbeat.workerKind, heartbeat);
    }
  }
  return [...newest.values()];
}
