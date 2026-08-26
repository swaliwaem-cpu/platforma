import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  AssistantKnowledgeSourceState,
  AssistantSourceJobStatus,
  AssistantSourceJobTrigger,
  Prisma,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../../prisma/prisma.service';
import { areAssistantExternalConnectorsEnabled } from '../assistant-runtime-config';
import {
  AssistantSourceIngestionService,
  reserveAssistantSourceAttempt,
} from './assistant-source-ingestion.service';

const pollIntervalMs = 5_000;
const leaseMilliseconds = 90_000;
const claimBatchSize = 5;

@Injectable()
export class AssistantSourceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AssistantSourceWorker.name);
  private readonly instanceId = randomUUID();
  private timer: NodeJS.Timeout | null = null;
  private tick: Promise<void> | null = null;
  private shuttingDown = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingestion: AssistantSourceIngestionService,
  ) {}

  async onModuleInit() {
    if (!isAssistantSourceWorkerRunnable()) return;
    await this.runOnce();
    this.timer = setInterval(() => this.schedule(), pollIntervalMs);
    this.timer.unref();
  }

  async onModuleDestroy() {
    this.shuttingDown = true;
    if (this.timer) clearInterval(this.timer);
    await this.tick;
  }

  async runOnce(now = new Date()) {
    await this.recoverStaleJobs(now);
    await this.failInactiveSourceJobs(now);
    await this.enqueueScheduledJobs(now);
    const jobs = await this.prisma.assistantSourceJob.findMany({
      where: {
        status: AssistantSourceJobStatus.PENDING,
        availableAt: { lte: now },
        source: { state: AssistantKnowledgeSourceState.ACTIVE },
      },
      orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: claimBatchSize,
      select: { id: true },
    });
    for (const { id } of jobs) {
      if (this.shuttingDown) break;
      await this.processJob(id, now);
    }
  }

  private schedule() {
    if (this.shuttingDown || this.tick) return;
    this.tick = this.runOnce().catch(() => {
      this.logger.error('Assistant source worker tick failed');
    }).finally(() => {
      this.tick = null;
    });
  }

  private async recoverStaleJobs(now: Date) {
    await this.prisma.assistantSourceJob.updateMany({
      where: {
        status: AssistantSourceJobStatus.RUNNING,
        leaseExpiresAt: { lte: now },
        attempt: { gte: this.prisma.assistantSourceJob.fields.maxAttempts },
      },
      data: {
        status: AssistantSourceJobStatus.FAILED,
        leaseOwner: null,
        leaseExpiresAt: null,
        errorCode: 'SOURCE_JOB_RETRY_EXHAUSTED',
        completedAt: now,
      },
    });
    await this.prisma.assistantSourceJob.updateMany({
      where: {
        status: AssistantSourceJobStatus.RUNNING,
        leaseExpiresAt: { lte: now },
        attempt: { lt: this.prisma.assistantSourceJob.fields.maxAttempts },
      },
      data: {
        status: AssistantSourceJobStatus.PENDING,
        availableAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        errorCode: 'SOURCE_JOB_LEASE_EXPIRED',
      },
    });
  }

  private async enqueueScheduledJobs(now: Date) {
    const sources = await this.prisma.assistantKnowledgeSource.findMany({
      where: {
        state: AssistantKnowledgeSourceState.ACTIVE,
        OR: [{ nextRefreshAt: null }, { nextRefreshAt: { lte: now } }],
      },
      orderBy: [{ nextRefreshAt: 'asc' }, { id: 'asc' }],
      take: 20,
      select: { id: true, scheduleMinutes: true },
    });
    for (const source of sources) {
      const scheduleBucket = Math.floor(now.getTime() / (source.scheduleMinutes * 60_000));
      await this.prisma.$transaction([
        this.prisma.assistantSourceJob.upsert({
          where: {
            sourceId_idempotencyKey: {
              sourceId: source.id,
              idempotencyKey: `scheduled:${scheduleBucket}`,
            },
          },
          update: {},
          create: {
            sourceId: source.id,
            trigger: AssistantSourceJobTrigger.SCHEDULED,
            idempotencyKey: `scheduled:${scheduleBucket}`,
          },
        }),
        this.prisma.assistantKnowledgeSource.update({
          where: { id: source.id },
          data: { nextRefreshAt: new Date(now.getTime() + source.scheduleMinutes * 60_000) },
        }),
      ]);
    }
  }

  private async failInactiveSourceJobs(now: Date) {
    await this.prisma.assistantSourceJob.updateMany({
      where: {
        status: AssistantSourceJobStatus.PENDING,
        source: { state: { not: AssistantKnowledgeSourceState.ACTIVE } },
      },
      data: {
        status: AssistantSourceJobStatus.FAILED,
        errorCode: 'ASSISTANT_SOURCE_NOT_ACTIVE',
        completedAt: now,
      },
    });
  }

  private async processJob(jobId: string, now: Date) {
    const job = await this.prisma.$transaction(async (transaction) => {
      const claimed = await transaction.assistantSourceJob.updateMany({
        where: {
          id: jobId,
          status: AssistantSourceJobStatus.PENDING,
          availableAt: { lte: now },
        },
        data: {
          status: AssistantSourceJobStatus.RUNNING,
          attempt: { increment: 1 },
          leaseOwner: this.instanceId,
          leaseExpiresAt: new Date(Date.now() + leaseMilliseconds),
        },
      });
      if (claimed.count !== 1) return null;
      const claimedJob = await transaction.assistantSourceJob.findUniqueOrThrow({
        where: { id: jobId },
        select: { sourceId: true, attempt: true, maxAttempts: true },
      });
      const attemptStartedAt = await reserveAssistantSourceAttempt(transaction, claimedJob.sourceId);
      return { ...claimedJob, attemptStartedAt };
    });
    if (!job) return;
    const { attemptStartedAt } = job;
    try {
      await this.withHeartbeat(jobId, () => this.ingestion.ingest(job.sourceId, {
        jobId,
        leaseOwner: this.instanceId,
        attemptStartedAt,
      }));
      await this.prisma.assistantSourceJob.updateMany({
        where: {
          id: jobId,
          status: AssistantSourceJobStatus.RUNNING,
          leaseOwner: this.instanceId,
          leaseExpiresAt: { gt: new Date() },
        },
        data: {
          status: AssistantSourceJobStatus.COMPLETED,
          leaseOwner: null,
          leaseExpiresAt: null,
          errorCode: null,
          completedAt: new Date(),
        },
      });
    } catch (error) {
      const failure = normalizeWorkerError(error);
      const retry = failure.retryable && job.attempt < job.maxAttempts;
      const completedAt = retry ? null : new Date();
      await this.prisma.$transaction(async (transaction) => {
        const owned = await transaction.assistantSourceJob.updateMany({
          where: {
            id: jobId,
            status: AssistantSourceJobStatus.RUNNING,
            leaseOwner: this.instanceId,
            leaseExpiresAt: { gt: new Date() },
          },
          data: {
            status: retry ? AssistantSourceJobStatus.PENDING : AssistantSourceJobStatus.FAILED,
            availableAt: retry
              ? new Date(Date.now() + retryDelayMilliseconds(job.attempt))
              : new Date(),
            leaseOwner: null,
            leaseExpiresAt: null,
            errorCode: failure.code,
            completedAt,
          },
        });
        if (owned.count !== 1) return;
        const [sourceHealth] = await transaction.$queryRaw<Array<{ lastAttemptAt: Date | null }>>(Prisma.sql`
          SELECT "last_attempt_at" AS "lastAttemptAt"
          FROM "assistant_knowledge_sources"
          WHERE "id" = ${job.sourceId}::uuid
          FOR UPDATE
        `);
        if (sourceHealth && (
          sourceHealth.lastAttemptAt?.getTime() === attemptStartedAt.getTime()
        )) {
          await transaction.assistantKnowledgeSource.update({
            where: { id: job.sourceId },
            data: {
              lastAttemptAt: attemptStartedAt,
              lastErrorCode: failure.code,
              lastErrorMessage: failure.code,
            },
          });
        }
      });
    }
  }

  private async withHeartbeat<Value>(jobId: string, action: () => Promise<Value>) {
    let leaseCurrent = true;
    let renewal = Promise.resolve();
    const timer = setInterval(() => {
      renewal = renewal.then(async () => {
        if (!leaseCurrent) return;
        const renewed = await this.prisma.assistantSourceJob.updateMany({
          where: {
            id: jobId,
            status: AssistantSourceJobStatus.RUNNING,
            leaseOwner: this.instanceId,
            leaseExpiresAt: { gt: new Date() },
          },
          data: { leaseExpiresAt: new Date(Date.now() + leaseMilliseconds) },
        });
        leaseCurrent = renewed.count === 1;
      }).catch(() => {
        leaseCurrent = false;
      });
    }, leaseMilliseconds / 3);
    timer.unref();
    try {
      const value = await action();
      await renewal;
      if (!leaseCurrent) throw new Error('SOURCE_JOB_LEASE_LOST');
      return value;
    } finally {
      clearInterval(timer);
      await renewal;
    }
  }
}

export function isSourceWorkerEnabled(environment: NodeJS.ProcessEnv = process.env) {
  const value = (environment.ASSISTANT_SOURCE_WORKER_ENABLED ?? 'false').trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('ASSISTANT_SOURCE_WORKER_ENABLED_INVALID');
}

export function isAssistantSourceWorkerRunnable(environment: NodeJS.ProcessEnv = process.env) {
  return isSourceWorkerEnabled(environment) && areAssistantExternalConnectorsEnabled(environment);
}

function normalizeWorkerError(error: unknown) {
  if (typeof error === 'object' && error !== null
    && typeof (error as { code?: unknown }).code === 'string'
    && typeof (error as { retryable?: unknown }).retryable === 'boolean') {
    return error as { code: string; retryable: boolean };
  }
  return { code: 'SOURCE_PROCESSING_FAILED', retryable: true };
}

function retryDelayMilliseconds(attempt: number) {
  return Math.min(60_000, 5_000 * 2 ** Math.max(0, attempt - 1));
}
