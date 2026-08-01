import { randomUUID } from 'node:crypto';

import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import {
  Prisma,
  TrainingFactSuggestionRunStatus,
  TrainingFactSuggestionStatus,
  TrainingJobKind,
  TrainingJobStatus,
  TrainingProviderRunStatus,
  TrainingSourceExtractionStatus,
  TrainingVersionStatus,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { TrainingOpenAiRequestError } from '../openai/training-openai.http';
import {
  formatTrainingErrorForLog,
  safeTrainingFailureMessage,
  writeSafeTrainingLog,
} from '../training-safe-log';
import { TrainingConfigService } from '../training.config';
import { lockTrainingVersionForContentMutation } from '../training-version-lock';
import { TrainingWorkerHeartbeatService } from '../training-worker-heartbeat.service';
import { waitForTrainingWorkerPromise as waitForPromise } from '../training-worker-shutdown';
import { hashCanonicalTrainingFactSuggestionJson as canonicalHash } from './training-fact-suggestion-canonical-json';
import { buildTrainingFactSuggestionChunks } from './training-fact-suggestion.chunking';
import {
  hashTrainingFactSuggestionText,
  TRAINING_FACT_SUGGESTION_PROVIDER,
  type TrainingExistingFactInput,
  type TrainingFactSuggestionProvider,
  type TrainingFactSuggestionProviderResult,
} from './training-fact-suggestion.provider';

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
const MAX_JOBS_PER_DRAIN = 25;
const TERMINAL_PROVIDER_STATUSES = new Set<TrainingProviderRunStatus>([
  TrainingProviderRunStatus.SUCCEEDED,
  TrainingProviderRunStatus.FAILED,
  TrainingProviderRunStatus.AMBIGUOUS,
]);

type ClaimedJob = {
  id: string;
  payloadJson: Prisma.JsonValue;
  attempts: number;
  maxAttempts: number;
};

type JobPayload = {
  suggestionRunId: string;
  providerRunId: string;
};

export const TRAINING_FACT_SUGGESTION_WORKER_OPTIONS = Symbol(
  'TRAINING_FACT_SUGGESTION_WORKER_OPTIONS',
);

export type TrainingFactSuggestionWorkerOptions = {
  workerId?: string;
  pollIntervalMs?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  drainTimeoutMs?: number;
  now?: () => Date;
};

@Injectable()
export class TrainingFactSuggestionWorkerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(
    TrainingFactSuggestionWorkerService.name,
  );
  private readonly workerId: string;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly drainTimeoutMs: number;
  private readonly now: () => Date;
  private interval: NodeJS.Timeout | null = null;
  private drainPromise: Promise<void> | null = null;
  private kickQueued = false;
  private stopping = false;
  private readonly heartbeatIntervals = new Map<string, NodeJS.Timeout>();
  private readonly lostOwnership = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(TRAINING_FACT_SUGGESTION_PROVIDER)
    private readonly provider: TrainingFactSuggestionProvider,
    @Optional()
    private readonly trainingConfig?: TrainingConfigService,
    @Optional()
    private readonly workerHeartbeat?: TrainingWorkerHeartbeatService,
    @Optional()
    @Inject(TRAINING_FACT_SUGGESTION_WORKER_OPTIONS)
    options?: TrainingFactSuggestionWorkerOptions,
  ) {
    this.workerId =
      options?.workerId ??
      `training-fact-suggestion:${process.pid}:${randomUUID()}`;
    this.pollIntervalMs = readBoundedWorkerOption(
      options?.pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS,
      50,
      60_000,
      'pollIntervalMs',
    );
    this.leaseMs = readBoundedWorkerOption(
      options?.leaseMs,
      DEFAULT_LEASE_MS,
      1_000,
      600_000,
      'leaseMs',
    );
    this.heartbeatMs = readBoundedWorkerOption(
      options?.heartbeatMs,
      DEFAULT_HEARTBEAT_MS,
      100,
      60_000,
      'heartbeatMs',
    );
    this.drainTimeoutMs = readBoundedWorkerOption(
      options?.drainTimeoutMs,
      DEFAULT_DRAIN_TIMEOUT_MS,
      100,
      180_000,
      'drainTimeoutMs',
    );
    if (this.heartbeatMs >= this.leaseMs) {
      throw new Error('heartbeatMs must be less than leaseMs');
    }
    this.now = options?.now ?? (() => new Date());
  }

  onModuleInit() {
    if (this.trainingConfig?.isEnabled() === false) return;
    this.stopping = false;
    void this.workerHeartbeat
      ?.register('fact-suggestion', this.workerId)
      .catch(() => undefined);
    this.interval = setInterval(() => this.kick(), this.pollIntervalMs);
    this.interval.unref();
    this.kick();
  }

  async onModuleDestroy() {
    this.stopping = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    let drained = true;
    try {
      drained = this.drainPromise
        ? await waitForPromise(this.drainPromise, this.drainTimeoutMs)
        : true;
    } catch (error) {
      drained = false;
      writeSafeTrainingLog(
        this.logger,
        'error',
        'training.fact-suggestion.shutdown-drain-failed',
        {
          workerKind: 'fact-suggestion',
          errorCode: readErrorCode(error),
        },
      );
    }
    try {
      if (!drained) {
        const released = await waitForPromise(
          this.releaseOwnedJobsAfterShutdown(),
          this.drainTimeoutMs,
        );
        if (!released) {
          writeSafeTrainingLog(
            this.logger,
            'error',
            'training.fact-suggestion.shutdown-release-timeout',
            {
              workerKind: 'fact-suggestion',
              errorCode: 'FACT_SUGGESTION_SHUTDOWN_RELEASE_TIMEOUT',
            },
          );
        }
      }
    } catch (error) {
      writeSafeTrainingLog(
        this.logger,
        'error',
        'training.fact-suggestion.shutdown-release-failed',
        {
          workerKind: 'fact-suggestion',
          errorCode: readErrorCode(error),
        },
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
      this.kickQueued ||
      this.stopping ||
      this.trainingConfig?.isEnabled() === false
    ) {
      return;
    }
    void this.workerHeartbeat?.touch(this.workerId).catch(() => undefined);
    this.kickQueued = true;
    setImmediate(() => {
      this.kickQueued = false;
      void this.drainNow().catch((error) => {
        writeSafeTrainingLog(
          this.logger,
          'error',
          'training.fact-suggestion.worker-loop-failed',
          {
            workerKind: 'fact-suggestion',
            errorCode: readErrorCode(error),
          },
        );
      });
    });
  }

  async drainNow() {
    if (this.drainPromise) return this.drainPromise;
    if (this.stopping || this.trainingConfig?.isEnabled() === false) return;
    const drain = this.drainBounded().finally(() => {
      if (this.drainPromise === drain) this.drainPromise = null;
    });
    this.drainPromise = drain;
    return drain;
  }

  private async drainBounded() {
    await this.recoverStaleJobs();
    for (
      let index = 0;
      index < MAX_JOBS_PER_DRAIN &&
      !this.stopping &&
      this.trainingConfig?.isEnabled() !== false;
      index += 1
    ) {
      if (!(await this.processNext())) return;
    }
  }

  private async processNext() {
    while (!this.stopping) {
      const now = this.now();
      const candidate = await this.prisma.trainingJob.findFirst({
        where: {
          kind: TrainingJobKind.SUGGEST_FACTS,
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
      if (!candidate) return false;
      if (this.stopping) return false;
      if (candidate.attempts >= candidate.maxAttempts) {
        await this.failExhaustedCandidate(candidate, now);
        if (this.stopping) return false;
        continue;
      }

      if (this.stopping) return false;
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
      if (claimed.count === 0) continue;

      const job = {
        ...candidate,
        attempts: candidate.attempts + 1,
      };
      this.lostOwnership.delete(job.id);
      await this.withHeartbeat(job.id, job.attempts, () =>
        this.processClaimed(job),
      );
      return true;
    }
    return false;
  }

  private async processClaimed(job: ClaimedJob) {
    const payload = readJobPayload(job.payloadJson);
    if (!payload) {
      await this.failUnclaimedProviderRun(
        job,
        'FACT_SUGGESTION_JOB_PAYLOAD_INVALID',
        'Fact suggestion job payload is invalid',
      );
      return;
    }

    try {
      await this.refreshOwnershipOrThrow(job.id, job.attempts);
      const providerRun =
        await this.prisma.trainingFactSuggestionProviderRun.findFirst({
          where: {
            id: payload.providerRunId,
            suggestionRunId: payload.suggestionRunId,
          },
          include: {
            suggestionRun: {
              select: {
                status: true,
              },
            },
            sourceDocument: {
              select: {
                id: true,
                checksum: true,
                extractionStatus: true,
                extractedText: true,
                extractionMetadataJson: true,
              },
            },
            sourceOfficialUrl: {
              select: {
                id: true,
                contentHash: true,
                extractionStatus: true,
                extractedText: true,
                extractionMetadataJson: true,
              },
            },
          },
        });
      if (!providerRun) {
        await this.failUnclaimedProviderRun(
          job,
          'FACT_SUGGESTION_PROVIDER_RUN_NOT_FOUND',
          'Fact suggestion provider run no longer exists',
        );
        return;
      }
      if (
        providerRun.suggestionRun.status ===
        TrainingFactSuggestionRunStatus.DISMISSED
      ) {
        await this.completeJob(job, providerRun.suggestionRunId);
        return;
      }
      if (providerRun.status === TrainingProviderRunStatus.SUCCEEDED) {
        await this.completeJob(job, providerRun.suggestionRunId);
        return;
      }
      if (providerRun.status === TrainingProviderRunStatus.REQUESTING) {
        await this.markRecoveredRequestAmbiguous(
          job,
          providerRun.id,
          providerRun.suggestionRunId,
        );
        return;
      }
      if (TERMINAL_PROVIDER_STATUSES.has(providerRun.status)) {
        await this.failTerminalJob(
          job,
          providerRun.suggestionRunId,
          providerRun.errorCode ?? 'FACT_SUGGESTION_PROVIDER_RUN_TERMINAL',
          'Fact suggestion provider run requires an explicit retry',
        );
        return;
      }

      const prepared = await this.prepareProviderInput(providerRun);
      if (!prepared) {
        await this.markInputStale(
          job,
          providerRun.id,
          providerRun.suggestionRunId,
        );
        return;
      }
      if (
        this.stopping ||
        this.trainingConfig?.isEnabled() === false
      ) {
        await this.releaseJob(job);
        return;
      }

      const providerClaimed = await this.claimProviderRequest(
        job,
        providerRun,
      );
      if (!providerClaimed) {
        return;
      }

      if (
        this.stopping ||
        this.trainingConfig?.isEnabled() === false
      ) {
        await this.releaseClaimedProviderRequest(
          job,
          providerRun.id,
          providerRun.suggestionRunId,
        );
        return;
      }

      await this.refreshOwnershipOrThrow(job.id, job.attempts);
      let result: TrainingFactSuggestionProviderResult;
      try {
        result = await this.provider.suggest(prepared.input);
      } catch (error) {
        await this.recordProviderFailure(
          job,
          providerRun.id,
          providerRun.suggestionRunId,
          error,
        );
        return;
      }

      try {
        await this.persistProviderResult(
          job,
          providerRun.id,
          providerRun.suggestionRunId,
          result,
        );
      } catch (error) {
        if (error instanceof LostFactSuggestionJobOwnershipError) throw error;
        await this.markProviderResultPersistenceAmbiguous(
          job,
          providerRun.id,
          providerRun.suggestionRunId,
          error,
        );
      }
    } catch (error) {
      if (error instanceof LostFactSuggestionJobOwnershipError) return;
      try {
        await this.failUnclaimedProviderRun(
          job,
          readErrorCode(error) ?? 'FACT_SUGGESTION_WORKER_FAILED',
          safeTrainingFailureMessage(error, 'Fact suggestion worker failed'),
        );
      } catch (failureError) {
        if (failureError instanceof LostFactSuggestionJobOwnershipError) return;
        throw failureError;
      }
      writeSafeTrainingLog(
        this.logger,
        'warn',
        'training.fact-suggestion.job-failed',
        {
          jobId: job.id,
          errorCode: readErrorCode(error),
        },
      );
    }
  }

  private async prepareProviderInput(providerRun: {
    id: string;
    projectVersionId: string;
    suggestionRunId: string;
    chunkIndex: number;
    inputHash: string;
    sourceContentHash: string;
    inputMetadataJson: Prisma.JsonValue;
    sourceDocument: {
      id: string;
      checksum: string;
      extractionStatus: TrainingSourceExtractionStatus;
      extractedText: string | null;
      extractionMetadataJson: Prisma.JsonValue;
    } | null;
    sourceOfficialUrl: {
      id: string;
      contentHash: string | null;
      extractionStatus: TrainingSourceExtractionStatus;
      extractedText: string | null;
      extractionMetadataJson: Prisma.JsonValue;
    } | null;
  }) {
    const version = await this.prisma.trainingProjectVersion.findUnique({
      where: { id: providerRun.projectVersionId },
      select: { status: true },
    });
    if (version?.status !== TrainingVersionStatus.DRAFT) return null;
    const source = providerRun.sourceDocument
      ? {
          id: providerRun.sourceDocument.id,
          checksum: providerRun.sourceDocument.checksum,
          extractedText: providerRun.sourceDocument.extractedText ?? '',
          extractionMetadata:
            providerRun.sourceDocument.extractionMetadataJson,
          extractionStatus: providerRun.sourceDocument.extractionStatus,
        }
      : providerRun.sourceOfficialUrl
        ? {
            id: providerRun.sourceOfficialUrl.id,
            checksum: providerRun.sourceOfficialUrl.contentHash ?? '',
            extractedText: providerRun.sourceOfficialUrl.extractedText ?? '',
            extractionMetadata:
              providerRun.sourceOfficialUrl.extractionMetadataJson,
            extractionStatus:
              providerRun.sourceOfficialUrl.extractionStatus,
          }
        : null;
    if (
      source?.extractionStatus !== TrainingSourceExtractionStatus.READY ||
      !source.extractedText.trim()
    ) {
      return null;
    }

    const chunked = buildTrainingFactSuggestionChunks([source]);
    const chunk = chunked.chunks.find(
      (candidate) => candidate.index === providerRun.chunkIndex,
    );
    if (
      !chunk ||
      hashTrainingFactSuggestionText(source.extractedText) !==
        providerRun.sourceContentHash
    ) {
      return null;
    }

    const existingFacts = await this.loadExistingFacts(
      providerRun.suggestionRunId,
    );
    const metadata = readRecord(providerRun.inputMetadataJson);
    const existingFactsHash = canonicalHash(existingFacts);
    const expectedInputHash = canonicalHash({
      chunkInputHash: chunk.inputHash,
      existingFactsHash,
    });
    if (
      metadata?.chunkInputHash !== chunk.inputHash ||
      metadata?.existingFactsHash !== existingFactsHash ||
      providerRun.inputHash !== expectedInputHash
    ) {
      return null;
    }

    return {
      input: {
        runId: providerRun.suggestionRunId,
        chunkId: chunk.id,
        segments: chunk.segments,
        existingFacts,
      },
    };
  }

  private async loadExistingFacts(suggestionRunId: string) {
    const run = await this.prisma.trainingFactSuggestionRun.findUnique({
      where: { id: suggestionRunId },
      select: { projectVersionId: true },
    });
    if (!run) return [];
    const facts = await this.prisma.trainingFact.findMany({
      where: { projectVersionId: run.projectVersionId },
      select: {
        id: true,
        code: true,
        statement: true,
        acceptedAliasesJson: true,
      },
      orderBy: { id: 'asc' },
    });
    return facts.map(
      (fact): TrainingExistingFactInput => ({
        id: fact.id,
        code: fact.code,
        statement: fact.statement,
        acceptedAliases: readStringArray(fact.acceptedAliasesJson),
      }),
    );
  }

  private async claimProviderRequest(
    job: ClaimedJob,
    providerRun: {
      id: string;
      projectVersionId: string;
      suggestionRunId: string;
    },
  ) {
    return this.runSerializable(async (tx) => {
      const context = await this.lockGenerationContext(
        tx,
        providerRun.id,
        providerRun.suggestionRunId,
        TrainingProviderRunStatus.PENDING,
      );
      await this.assertOwnedJob(tx, job);
      if (!context.valid) {
        await tx.trainingFactSuggestionProviderRun.updateMany({
          where: {
            id: providerRun.id,
            status: TrainingProviderRunStatus.PENDING,
          },
          data: {
            status: TrainingProviderRunStatus.FAILED,
            errorCode: context.code,
            errorClass: 'stale_context',
            completedAt: this.now(),
          },
        });
        await this.finishOwnedJob(
          tx,
          job,
          deadJobData(
            context.code,
            'Fact suggestion context is not editable',
            this.now(),
          ),
        );
        await this.recalculateRunInTransaction(
          tx,
          providerRun.suggestionRunId,
        );
        return false;
      }

      const startedAt = this.now();
      const claimed =
        await tx.trainingFactSuggestionProviderRun.updateMany({
          where: {
            id: providerRun.id,
            status: TrainingProviderRunStatus.PENDING,
          },
          data: {
            status: TrainingProviderRunStatus.REQUESTING,
            startedAt,
            errorCode: null,
            errorClass: null,
            ambiguousOutcome: false,
          },
        });
      if (claimed.count !== 1) {
        throw new LostFactSuggestionJobOwnershipError();
      }
      const activated = await tx.trainingFactSuggestionRun.updateMany({
        where: {
          id: providerRun.suggestionRunId,
          status: {
            not: TrainingFactSuggestionRunStatus.DISMISSED,
          },
        },
        data: {
          status: TrainingFactSuggestionRunStatus.RUNNING,
          startedAt,
          completedAt: null,
          errorCode: null,
          errorMessage: null,
        },
      });
      if (activated.count !== 1) {
        throw new LostFactSuggestionJobOwnershipError();
      }
      return true;
    });
  }

  private async releaseClaimedProviderRequest(
    job: ClaimedJob,
    providerRunId: string,
    suggestionRunId: string,
  ) {
    await this.runSerializable(async (tx) => {
      const identity =
        await tx.trainingFactSuggestionProviderRun.findUnique({
          where: { id: providerRunId },
          select: { projectVersionId: true },
        });
      if (identity) {
        await lockTrainingVersionForContentMutation(
          tx,
          identity.projectVersionId,
        );
      }
      await this.lockRunAndProvider(
        tx,
        suggestionRunId,
        providerRunId,
      );
      await this.assertOwnedJob(tx, job);
      const releasedProvider =
        await tx.trainingFactSuggestionProviderRun.updateMany({
          where: {
            id: providerRunId,
            status: TrainingProviderRunStatus.REQUESTING,
          },
          data: {
            status: TrainingProviderRunStatus.PENDING,
            startedAt: null,
          },
        });
      if (releasedProvider.count !== 1) {
        throw new LostFactSuggestionJobOwnershipError();
      }
      await this.finishOwnedJob(tx, job, releaseJobData(job, this.now()));
      await this.recalculateRunInTransaction(tx, suggestionRunId);
    });
    this.lostOwnership.add(job.id);
  }

  private async lockGenerationContext(
    tx: Prisma.TransactionClient,
    providerRunId: string,
    suggestionRunId: string,
    expectedStatus: TrainingProviderRunStatus,
  ): Promise<
    | {
        valid: true;
        projectVersionId: string;
        sourceContentHash: string;
      }
    | { valid: false; code: string }
  > {
    const identity =
      await tx.trainingFactSuggestionProviderRun.findFirst({
        where: {
          id: providerRunId,
          suggestionRunId,
        },
        select: {
          projectVersionId: true,
          sourceDocumentId: true,
          sourceOfficialUrlId: true,
        },
      });
    if (!identity) {
      return {
        valid: false,
        code: 'FACT_SUGGESTION_PROVIDER_RUN_NOT_FOUND',
      };
    }

    const version = await lockTrainingVersionForContentMutation(
      tx,
      identity.projectVersionId,
    );
    if (
      !version ||
      version.status !== TrainingVersionStatus.DRAFT ||
      version.projectStatus === 'ARCHIVED'
    ) {
      return {
        valid: false,
        code: 'FACT_SUGGESTION_VERSION_NOT_EDITABLE',
      };
    }
    await tx.$queryRaw`SELECT "id" FROM "training_fact_suggestion_runs" WHERE "id" = ${suggestionRunId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "training_fact_suggestion_provider_runs" WHERE "id" = ${providerRunId}::uuid FOR UPDATE`;
    if (identity.sourceDocumentId) {
      await tx.$queryRaw`SELECT "id" FROM "training_source_documents" WHERE "id" = ${identity.sourceDocumentId}::uuid FOR SHARE`;
    } else if (identity.sourceOfficialUrlId) {
      await tx.$queryRaw`SELECT "id" FROM "training_official_url_sources" WHERE "id" = ${identity.sourceOfficialUrlId}::uuid FOR SHARE`;
    } else {
      return {
        valid: false,
        code: 'FACT_SUGGESTION_SOURCE_MISSING',
      };
    }
    await tx.$queryRaw`SELECT "id" FROM "training_facts" WHERE "project_version_id" = ${identity.projectVersionId}::uuid ORDER BY "id" FOR SHARE`;

    const [run, providerRun, facts] = await Promise.all([
      tx.trainingFactSuggestionRun.findUnique({
        where: { id: suggestionRunId },
        select: {
          projectVersionId: true,
          status: true,
        },
      }),
      tx.trainingFactSuggestionProviderRun.findUnique({
        where: { id: providerRunId },
        include: {
          sourceDocument: {
            select: {
              id: true,
              checksum: true,
              extractionStatus: true,
              extractedText: true,
              extractionMetadataJson: true,
            },
          },
          sourceOfficialUrl: {
            select: {
              id: true,
              contentHash: true,
              extractionStatus: true,
              extractedText: true,
              extractionMetadataJson: true,
            },
          },
        },
      }),
      tx.trainingFact.findMany({
        where: { projectVersionId: identity.projectVersionId },
        select: {
          id: true,
          code: true,
          statement: true,
          acceptedAliasesJson: true,
        },
        orderBy: { id: 'asc' },
      }),
    ]);
    if (
      !run ||
      run.projectVersionId !== identity.projectVersionId ||
      run.status === TrainingFactSuggestionRunStatus.DISMISSED
    ) {
      return {
        valid: false,
        code: 'FACT_SUGGESTION_RUN_NOT_ACTIVE',
      };
    }
    if (!providerRun || providerRun.status !== expectedStatus) {
      return {
        valid: false,
        code: 'FACT_SUGGESTION_PROVIDER_STATE_CHANGED',
      };
    }
    if (!isProviderInputCurrent(providerRun, facts)) {
      return {
        valid: false,
        code: 'FACT_SUGGESTION_INPUT_STALE',
      };
    }
    return {
      valid: true,
      projectVersionId: identity.projectVersionId,
      sourceContentHash: providerRun.sourceContentHash,
    };
  }

  private async lockVersionForProviderRun(
    tx: Prisma.TransactionClient,
    providerRunId: string,
  ) {
    const providerRun =
      await tx.trainingFactSuggestionProviderRun.findUnique({
        where: { id: providerRunId },
        select: { projectVersionId: true },
      });
    if (!providerRun) return null;
    return lockTrainingVersionForContentMutation(
      tx,
      providerRun.projectVersionId,
    );
  }

  private async lockVersionForSuggestionRun(
    tx: Prisma.TransactionClient,
    suggestionRunId: string,
  ) {
    const run = await tx.trainingFactSuggestionRun.findUnique({
      where: { id: suggestionRunId },
      select: { projectVersionId: true },
    });
    if (!run) return null;
    return lockTrainingVersionForContentMutation(tx, run.projectVersionId);
  }

  private async lockRunAndProvider(
    tx: Prisma.TransactionClient,
    suggestionRunId: string,
    providerRunId: string,
  ) {
    await tx.$queryRaw`SELECT "id" FROM "training_fact_suggestion_runs" WHERE "id" = ${suggestionRunId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "training_fact_suggestion_provider_runs" WHERE "id" = ${providerRunId}::uuid FOR UPDATE`;
  }

  private async assertOwnedJob(
    tx: Prisma.TransactionClient,
    job: ClaimedJob,
  ) {
    if (this.lostOwnership.has(job.id)) {
      throw new LostFactSuggestionJobOwnershipError();
    }
    const owned = await tx.trainingJob.updateMany({
      where: ownedJobWhere(job, this.workerId),
      data: { heartbeatAt: this.now() },
    });
    if (owned.count !== 1) {
      this.lostOwnership.add(job.id);
      throw new LostFactSuggestionJobOwnershipError();
    }
  }

  private async finishOwnedJob(
    tx: Prisma.TransactionClient,
    job: ClaimedJob,
    data: Prisma.TrainingJobUpdateManyMutationInput,
  ) {
    const finished = await tx.trainingJob.updateMany({
      where: ownedJobWhere(job, this.workerId),
      data,
    });
    if (finished.count !== 1) {
      this.lostOwnership.add(job.id);
      throw new LostFactSuggestionJobOwnershipError();
    }
  }

  private async withHeartbeat<T>(
    jobId: string,
    attempts: number,
    operation: () => Promise<T>,
  ) {
    const interval = setInterval(() => {
      void this.refreshOwnership(jobId, attempts).catch((error) => {
        writeSafeTrainingLog(
          this.logger,
          'warn',
          'training.fact-suggestion.heartbeat-failed',
          {
            jobId,
            errorCode: readErrorCode(error),
          },
        );
      });
    }, this.heartbeatMs);
    interval.unref();
    this.heartbeatIntervals.set(jobId, interval);
    try {
      return await operation();
    } finally {
      clearInterval(interval);
      this.heartbeatIntervals.delete(jobId);
    }
  }

  private async refreshOwnership(jobId: string, attempts: number) {
    if (this.lostOwnership.has(jobId)) return false;
    const owned = await this.prisma.trainingJob.updateMany({
      where: {
        id: jobId,
        status: TrainingJobStatus.RUNNING,
        lockOwner: this.workerId,
        attempts,
      },
      data: { heartbeatAt: this.now() },
    });
    if (owned.count !== 1) {
      this.lostOwnership.add(jobId);
      return false;
    }
    return true;
  }

  private async refreshOwnershipOrThrow(jobId: string, attempts: number) {
    if (!(await this.refreshOwnership(jobId, attempts))) {
      throw new LostFactSuggestionJobOwnershipError();
    }
  }

  private async recoverStaleJobs() {
    const staleAt = new Date(this.now().getTime() - this.leaseMs);
    const staleJobs = await this.prisma.trainingJob.findMany({
      where: {
        kind: TrainingJobKind.SUGGEST_FACTS,
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
        lockOwner: true,
        heartbeatAt: true,
        lockedAt: true,
      },
      take: MAX_JOBS_PER_DRAIN,
    });

    for (const job of staleJobs) {
      const payload = readJobPayload(job.payloadJson);
      await this.runSerializable(async (tx) => {
        const providerRun = payload
          ? await tx.trainingFactSuggestionProviderRun.findFirst({
              where: {
                id: payload.providerRunId,
                suggestionRunId: payload.suggestionRunId,
              },
              select: {
                id: true,
                projectVersionId: true,
                status: true,
              },
            })
          : null;
        if (providerRun) {
          await lockTrainingVersionForContentMutation(
            tx,
            providerRun.projectVersionId,
          );
          await this.lockRunAndProvider(
            tx,
            payload!.suggestionRunId,
            providerRun.id,
          );
        }
        const recovery = resolveStaleFactSuggestionRecovery(
          providerRun?.status ?? null,
          job.attempts,
          job.maxAttempts,
        );
        const retry = recovery === 'RETRY_PENDING';
        const requesting = recovery === 'AMBIGUOUS';
        const succeeded = recovery === 'SUCCEEDED';
        const recoveredAt = this.now();
        const recovered = await tx.trainingJob.updateMany({
          where: {
            id: job.id,
            status: TrainingJobStatus.RUNNING,
            attempts: job.attempts,
            lockOwner: job.lockOwner,
            heartbeatAt: job.heartbeatAt,
            lockedAt: job.lockedAt,
          },
          data: retry
            ? {
                status: TrainingJobStatus.PENDING,
                runAt: recoveredAt,
                lockOwner: null,
                lockedAt: null,
                heartbeatAt: null,
                finishedAt: null,
                lastErrorCode: 'STALE_FACT_SUGGESTION_JOB',
                lastErrorMessage:
                  'Recovered stale fact suggestion job before provider request',
                errorDetailsJson: { retryable: true },
              }
            : succeeded
              ? succeededJobData(recoveredAt)
              : deadJobData(
                  requesting
                    ? 'OPENAI_RECOVERED_REQUEST_AMBIGUOUS'
                    : 'STALE_FACT_SUGGESTION_JOB_DEAD',
                  requesting
                    ? 'Interrupted provider request has an ambiguous outcome'
                    : 'Stale fact suggestion job cannot be retried',
                  recoveredAt,
                ),
        });
        if (recovered.count !== 1 || !providerRun || retry || succeeded) {
          return;
        }
        if (requesting) {
          await tx.trainingFactSuggestionProviderRun.updateMany({
            where: {
              id: providerRun.id,
              status: TrainingProviderRunStatus.REQUESTING,
            },
            data: {
              status: TrainingProviderRunStatus.AMBIGUOUS,
              ambiguousOutcome: true,
              errorCode: 'OPENAI_RECOVERED_REQUEST_AMBIGUOUS',
              errorClass: 'stale_recovery',
              responseStatus: 'ambiguous',
              completedAt: recoveredAt,
            },
          });
        } else if (
          providerRun.status === TrainingProviderRunStatus.PENDING
        ) {
          await tx.trainingFactSuggestionProviderRun.updateMany({
            where: {
              id: providerRun.id,
              status: TrainingProviderRunStatus.PENDING,
            },
            data: {
              status: TrainingProviderRunStatus.FAILED,
              errorCode: 'STALE_FACT_SUGGESTION_JOB_DEAD',
              errorClass: 'stale_recovery',
              completedAt: recoveredAt,
            },
          });
        }
        if (payload) {
          await this.recalculateRunInTransaction(
            tx,
            payload.suggestionRunId,
          );
        }
      });
    }
  }

  private async releaseOwnedJobsAfterShutdown() {
    const jobs = await this.prisma.trainingJob.findMany({
      where: {
        kind: TrainingJobKind.SUGGEST_FACTS,
        status: TrainingJobStatus.RUNNING,
        lockOwner: this.workerId,
      },
      select: {
        id: true,
        payloadJson: true,
        attempts: true,
        maxAttempts: true,
      },
      take: MAX_JOBS_PER_DRAIN,
    });
    for (const job of jobs) {
      const claimed: ClaimedJob = job;
      const payload = readJobPayload(job.payloadJson);
      await this.runSerializable(async (tx) => {
        const providerRun = payload
          ? await tx.trainingFactSuggestionProviderRun.findFirst({
              where: {
                id: payload.providerRunId,
                suggestionRunId: payload.suggestionRunId,
              },
              select: {
                id: true,
                projectVersionId: true,
                status: true,
              },
            })
          : null;
        if (providerRun) {
          await lockTrainingVersionForContentMutation(
            tx,
            providerRun.projectVersionId,
          );
          await this.lockRunAndProvider(
            tx,
            payload!.suggestionRunId,
            providerRun.id,
          );
        }
        await this.assertOwnedJob(tx, claimed);
        const shutdownAt = this.now();
        if (
          providerRun?.status === TrainingProviderRunStatus.REQUESTING
        ) {
          const ambiguous =
            await tx.trainingFactSuggestionProviderRun.updateMany({
              where: {
                id: providerRun.id,
                status: TrainingProviderRunStatus.REQUESTING,
              },
              data: {
                status: TrainingProviderRunStatus.AMBIGUOUS,
                ambiguousOutcome: true,
                errorCode: 'OPENAI_SHUTDOWN_REQUEST_AMBIGUOUS',
                errorClass: 'shutdown',
                responseStatus: 'ambiguous',
                completedAt: shutdownAt,
              },
            });
          if (ambiguous.count !== 1) {
            throw new LostFactSuggestionJobOwnershipError();
          }
          await this.finishOwnedJob(
            tx,
            claimed,
            deadJobData(
              'OPENAI_SHUTDOWN_REQUEST_AMBIGUOUS',
              'Provider request was interrupted during worker shutdown',
              shutdownAt,
            ),
          );
        } else {
          await this.finishOwnedJob(
            tx,
            claimed,
            releaseJobData(claimed, shutdownAt),
          );
        }
        if (payload) {
          await this.recalculateRunInTransaction(
            tx,
            payload.suggestionRunId,
          );
        }
      });
      this.lostOwnership.add(job.id);
    }
  }

  private async failExhaustedCandidate(
    candidate: ClaimedJob,
    failedAt: Date,
  ) {
    const code = 'FACT_SUGGESTION_ATTEMPTS_EXHAUSTED';
    const message = 'Fact suggestion job exhausted max attempts';
    const payload = readJobPayload(candidate.payloadJson);
    if (!payload) {
      await this.prisma.trainingJob.updateMany({
        where: {
          id: candidate.id,
          status: TrainingJobStatus.PENDING,
          attempts: candidate.attempts,
          maxAttempts: candidate.maxAttempts,
        },
        data: deadJobData(code, message, failedAt),
      });
      return;
    }

    await this.runSerializable(async (tx) => {
      const providerIdentity =
        await tx.trainingFactSuggestionProviderRun.findFirst({
          where: {
            id: payload.providerRunId,
            suggestionRunId: payload.suggestionRunId,
          },
          select: {
            id: true,
            projectVersionId: true,
          },
        });
      if (!providerIdentity) {
        await tx.trainingJob.updateMany({
          where: {
            id: candidate.id,
            status: TrainingJobStatus.PENDING,
            attempts: candidate.attempts,
            maxAttempts: candidate.maxAttempts,
          },
          data: deadJobData(code, message, failedAt),
        });
        return;
      }

      await lockTrainingVersionForContentMutation(
        tx,
        providerIdentity.projectVersionId,
      );
      await this.lockRunAndProvider(
        tx,
        payload.suggestionRunId,
        providerIdentity.id,
      );
      const providerRun =
        await tx.trainingFactSuggestionProviderRun.findFirst({
          where: {
            id: providerIdentity.id,
            suggestionRunId: payload.suggestionRunId,
          },
          select: { status: true },
        });
      if (!providerRun) return;

      const exhausted = await tx.trainingJob.updateMany({
        where: {
          id: candidate.id,
          status: TrainingJobStatus.PENDING,
          attempts: candidate.attempts,
          maxAttempts: candidate.maxAttempts,
        },
        data:
          providerRun.status === TrainingProviderRunStatus.SUCCEEDED
            ? succeededJobData(failedAt)
            : deadJobData(code, message, failedAt),
      });
      if (exhausted.count !== 1) return;

      await this.terminalizeProviderBeforeRequest(
        tx,
        providerIdentity.id,
        providerRun.status,
        code,
        'attempts_exhausted',
        failedAt,
      );
      await this.recalculateRunInTransaction(
        tx,
        payload.suggestionRunId,
      );
    });
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

  private async persistProviderResult(
    job: ClaimedJob,
    providerRunId: string,
    suggestionRunId: string,
    result: TrainingFactSuggestionProviderResult,
  ) {
    const suggestions = result.suggestions.filter(
      (suggestion) => suggestion.duplicateOfFactId === null,
    );
    const responseHash = canonicalHash({
      actualModelId: result.actualModelId,
      responseStatus: result.responseStatus,
      suggestions,
    });
    await this.runSerializable(async (tx) => {
      const context = await this.lockGenerationContext(
        tx,
        providerRunId,
        suggestionRunId,
        TrainingProviderRunStatus.REQUESTING,
      );
      await this.assertOwnedJob(tx, job);
      if (!context.valid) {
        const failed = await tx.trainingFactSuggestionProviderRun.updateMany({
          where: {
            id: providerRunId,
            status: TrainingProviderRunStatus.REQUESTING,
          },
          data: {
            status: TrainingProviderRunStatus.FAILED,
            errorCode: context.code,
            errorClass: 'stale_context',
            completedAt: this.now(),
          },
        });
        if (failed.count !== 1) {
          throw new LostFactSuggestionJobOwnershipError();
        }
        await this.finishOwnedJob(
          tx,
          job,
          deadJobData(
            context.code,
            'Fact suggestion context changed before result persistence',
            this.now(),
          ),
        );
        await this.recalculateRunInTransaction(tx, suggestionRunId);
        return;
      }
      if (suggestions.length > 0) {
        await tx.trainingFactSuggestion.createMany({
          data: suggestions.map((suggestion, suggestionIndex) => ({
            projectVersionId: context.projectVersionId,
            suggestionRunId,
            providerRunId,
            suggestionIndex,
            status: TrainingFactSuggestionStatus.PENDING,
            suggestedCode: suggestion.suggestedCode,
            topicCode: suggestion.topicCode,
            statement: suggestion.statement,
            acceptedAliasesJson: suggestion.acceptedAliases,
            importance: suggestion.importance,
            sourceQuote: suggestion.sourceQuote,
            sourceLocatorJson: suggestion.sourceLocator,
            sourceContentHash: context.sourceContentHash,
          })),
        });
      }
      const completedProvider =
        await tx.trainingFactSuggestionProviderRun.updateMany({
        where: {
          id: providerRunId,
          status: TrainingProviderRunStatus.REQUESTING,
        },
        data: {
          status: TrainingProviderRunStatus.SUCCEEDED,
          actualModelId: result.actualModelId,
          reasoningEffort: result.reasoningEffort,
          requestId: result.requestId,
          responseStatus: result.responseStatus,
          responseHash,
          providerUsageJson: result.usage
            ? (result.usage as Prisma.InputJsonObject)
            : Prisma.JsonNull,
          latencyMs: result.latencyMs,
          retryCount: result.retryCount,
          completedAt: this.now(),
          ambiguousOutcome: false,
          errorCode: null,
          errorClass: null,
        },
      });
      if (completedProvider.count !== 1) {
        throw new LostFactSuggestionJobOwnershipError();
      }
      await this.finishOwnedJob(tx, job, succeededJobData(this.now()));
      await tx.auditLog.create({
        data: {
          action: 'training.fact-suggestion-provider.complete',
          entityType: 'training_fact_suggestion_provider_run',
          entityId: providerRunId,
          metadata: {
            suggestionRunId,
            suggestionCount: suggestions.length,
            duplicateCount: result.suggestions.length - suggestions.length,
            responseHash,
          },
        },
      });
      await this.recalculateRunInTransaction(tx, suggestionRunId);
    });
  }

  private async recordProviderFailure(
    job: ClaimedJob,
    providerRunId: string,
    suggestionRunId: string,
    error: unknown,
  ) {
    const providerError =
      error instanceof TrainingOpenAiRequestError ? error : null;
    const ambiguous = providerError?.ambiguous ?? false;
    const errorCode =
      providerError?.code ?? 'OPENAI_FACT_SUGGESTION_PROVIDER_FAILED';
    await this.runSerializable(async (tx) => {
      await this.lockVersionForProviderRun(tx, providerRunId);
      await this.lockRunAndProvider(tx, suggestionRunId, providerRunId);
      await this.assertOwnedJob(tx, job);
      const failed = await tx.trainingFactSuggestionProviderRun.updateMany({
        where: {
          id: providerRunId,
          status: TrainingProviderRunStatus.REQUESTING,
        },
        data: {
          status: ambiguous
            ? TrainingProviderRunStatus.AMBIGUOUS
            : TrainingProviderRunStatus.FAILED,
          requestId: providerError?.requestId,
          responseStatus:
            providerError?.status === null ||
            providerError?.status === undefined
              ? ambiguous
                ? 'ambiguous'
                : 'failed'
              : `http_${providerError.status}`,
          retryCount: providerError?.retryCount ?? 0,
          errorCode,
          errorClass:
            error instanceof Error ? error.name.slice(0, 120) : 'Error',
          ambiguousOutcome: ambiguous,
          completedAt: this.now(),
        },
      });
      if (failed.count !== 1) {
        throw new LostFactSuggestionJobOwnershipError();
      }
      await this.finishOwnedJob(
        tx,
        job,
        deadJobData(
          errorCode,
          safeTrainingFailureMessage(error, 'Fact suggestion provider failed'),
          this.now(),
        ),
      );
      await this.recalculateRunInTransaction(tx, suggestionRunId);
    });
    writeSafeTrainingLog(
      this.logger,
      ambiguous ? 'warn' : 'error',
      'training.fact-suggestion.provider-failed',
      {
        jobId: job.id,
        providerRequestId: providerError?.requestId ?? undefined,
        retryCount: providerError?.retryCount ?? 0,
        errorCode,
      },
    );
  }

  private async markProviderResultPersistenceAmbiguous(
    job: ClaimedJob,
    providerRunId: string,
    suggestionRunId: string,
    error: unknown,
  ) {
    const code = 'OPENAI_FACT_SUGGESTION_RESULT_PERSIST_AMBIGUOUS';
    await this.runSerializable(async (tx) => {
      await this.lockVersionForProviderRun(tx, providerRunId);
      await this.lockRunAndProvider(tx, suggestionRunId, providerRunId);
      await this.assertOwnedJob(tx, job);
      const ambiguous =
        await tx.trainingFactSuggestionProviderRun.updateMany({
          where: {
            id: providerRunId,
            status: TrainingProviderRunStatus.REQUESTING,
          },
          data: {
            status: TrainingProviderRunStatus.AMBIGUOUS,
            ambiguousOutcome: true,
            errorCode: code,
            errorClass:
              error instanceof Error ? error.name.slice(0, 120) : 'Error',
            responseStatus: 'ambiguous',
            completedAt: this.now(),
          },
        });
      if (ambiguous.count !== 1) {
        throw new LostFactSuggestionJobOwnershipError();
      }
      await this.finishOwnedJob(
        tx,
        job,
        deadJobData(
          code,
          'Provider result could not be persisted safely',
          this.now(),
        ),
      );
      await this.recalculateRunInTransaction(tx, suggestionRunId);
    });
  }

  private async markRecoveredRequestAmbiguous(
    job: ClaimedJob,
    providerRunId: string,
    suggestionRunId: string,
  ) {
    const code = 'OPENAI_RECOVERED_REQUEST_AMBIGUOUS';
    await this.runSerializable(async (tx) => {
      await this.lockVersionForProviderRun(tx, providerRunId);
      await this.lockRunAndProvider(tx, suggestionRunId, providerRunId);
      await this.assertOwnedJob(tx, job);
      const ambiguousRun =
        await tx.trainingFactSuggestionProviderRun.updateMany({
        where: {
          id: providerRunId,
          status: TrainingProviderRunStatus.REQUESTING,
        },
        data: {
          status: TrainingProviderRunStatus.AMBIGUOUS,
          ambiguousOutcome: true,
          errorCode: code,
          errorClass: 'recovery',
          responseStatus: 'ambiguous',
          completedAt: this.now(),
        },
      });
      if (ambiguousRun.count !== 1) {
        throw new LostFactSuggestionJobOwnershipError();
      }
      await this.finishOwnedJob(
        tx,
        job,
        deadJobData(
          code,
          'Interrupted provider request has an ambiguous outcome',
          this.now(),
        ),
      );
      await this.recalculateRunInTransaction(tx, suggestionRunId);
    });
  }

  private async markInputStale(
    job: ClaimedJob,
    providerRunId: string,
    suggestionRunId: string,
  ) {
    const code = 'FACT_SUGGESTION_INPUT_STALE';
    await this.runSerializable(async (tx) => {
      await this.lockVersionForProviderRun(tx, providerRunId);
      await this.lockRunAndProvider(tx, suggestionRunId, providerRunId);
      await this.assertOwnedJob(tx, job);
      const failed = await tx.trainingFactSuggestionProviderRun.updateMany({
        where: {
          id: providerRunId,
          status: TrainingProviderRunStatus.PENDING,
        },
        data: {
          status: TrainingProviderRunStatus.FAILED,
          errorCode: code,
          errorClass: 'stale_input',
          completedAt: this.now(),
        },
      });
      if (failed.count !== 1) {
        throw new LostFactSuggestionJobOwnershipError();
      }
      await this.finishOwnedJob(
        tx,
        job,
        deadJobData(
          code,
          'Fact suggestion source or existing facts changed',
          this.now(),
        ),
      );
      await this.recalculateRunInTransaction(tx, suggestionRunId);
    });
  }

  private async recalculateRunInTransaction(
    tx: Prisma.TransactionClient,
    suggestionRunId: string,
  ) {
    await tx.$queryRaw`SELECT "id" FROM "training_fact_suggestion_runs" WHERE "id" = ${suggestionRunId}::uuid FOR UPDATE`;
    const [run, providerRuns] = await Promise.all([
      tx.trainingFactSuggestionRun.findUnique({
        where: { id: suggestionRunId },
        select: { status: true },
      }),
      tx.trainingFactSuggestionProviderRun.findMany({
        where: { suggestionRunId },
        select: { status: true, errorCode: true },
      }),
    ]);
    if (
      !run ||
      run.status === TrainingFactSuggestionRunStatus.DISMISSED
    ) {
      return;
    }
    const status = resolveFactSuggestionRunStatus(
      providerRuns.map((providerRun) => providerRun.status),
    );
    const terminal =
      status === TrainingFactSuggestionRunStatus.READY ||
      status === TrainingFactSuggestionRunStatus.PARTIAL ||
      status === TrainingFactSuggestionRunStatus.FAILED ||
      status === TrainingFactSuggestionRunStatus.AMBIGUOUS;
    const firstFailure = providerRuns.find(
      (providerRun) =>
        providerRun.status === TrainingProviderRunStatus.FAILED ||
        providerRun.status === TrainingProviderRunStatus.AMBIGUOUS,
    );
    await tx.trainingFactSuggestionRun.updateMany({
      where: {
        id: suggestionRunId,
        status: {
          not: TrainingFactSuggestionRunStatus.DISMISSED,
        },
      },
      data: {
        status,
        completedAt: terminal ? this.now() : null,
        errorCode: firstFailure?.errorCode ?? null,
        errorMessage: firstFailure
          ? 'Часть предложений не удалось сформировать. Запустите повтор.'
          : null,
      },
    });
  }

  private async completeJob(job: ClaimedJob, suggestionRunId?: string) {
    await this.runSerializable(async (tx) => {
      if (suggestionRunId) {
        await this.lockVersionForSuggestionRun(tx, suggestionRunId);
        await tx.$queryRaw`SELECT "id" FROM "training_fact_suggestion_runs" WHERE "id" = ${suggestionRunId}::uuid FOR UPDATE`;
      }
      await this.assertOwnedJob(tx, job);
      await this.finishOwnedJob(tx, job, succeededJobData(this.now()));
      if (suggestionRunId) {
        await this.recalculateRunInTransaction(tx, suggestionRunId);
      }
    });
  }

  private async failTerminalJob(
    job: ClaimedJob,
    suggestionRunId: string,
    code: string,
    message: string,
  ) {
    await this.runSerializable(async (tx) => {
      await this.lockVersionForSuggestionRun(tx, suggestionRunId);
      await tx.$queryRaw`SELECT "id" FROM "training_fact_suggestion_runs" WHERE "id" = ${suggestionRunId}::uuid FOR UPDATE`;
      await this.assertOwnedJob(tx, job);
      await this.finishOwnedJob(
        tx,
        job,
        deadJobData(code, message, this.now()),
      );
      await this.recalculateRunInTransaction(tx, suggestionRunId);
    });
  }

  private async failUnclaimedProviderRun(
    job: ClaimedJob,
    code: string,
    message: string,
  ) {
    const shouldRetry = job.attempts < job.maxAttempts;
    if (shouldRetry) {
      const failed = await this.prisma.trainingJob.updateMany({
        where: ownedJobWhere(job, this.workerId),
        data: {
          status: TrainingJobStatus.PENDING,
          runAt: new Date(this.now().getTime() + job.attempts * 2_000),
          finishedAt: null,
          lockOwner: null,
          lockedAt: null,
          heartbeatAt: null,
          lastErrorCode: code,
          lastErrorMessage: message.slice(0, 2_000),
          errorDetailsJson: { retryable: true },
        },
      });
      if (failed.count !== 1) {
        throw new LostFactSuggestionJobOwnershipError();
      }
      this.lostOwnership.add(job.id);
      return;
    }

    const payload = readJobPayload(job.payloadJson);
    if (!payload) {
      const failed = await this.prisma.trainingJob.updateMany({
        where: ownedJobWhere(job, this.workerId),
        data: deadJobData(code, message, this.now()),
      });
      if (failed.count !== 1) {
        throw new LostFactSuggestionJobOwnershipError();
      }
      this.lostOwnership.add(job.id);
      return;
    }

    await this.runSerializable(async (tx) => {
      const providerIdentity =
        await tx.trainingFactSuggestionProviderRun.findFirst({
          where: {
            id: payload.providerRunId,
            suggestionRunId: payload.suggestionRunId,
          },
          select: {
            id: true,
            projectVersionId: true,
          },
        });
      if (!providerIdentity) {
        await this.assertOwnedJob(tx, job);
        await this.finishOwnedJob(
          tx,
          job,
          deadJobData(code, message, this.now()),
        );
        return;
      }

      await lockTrainingVersionForContentMutation(
        tx,
        providerIdentity.projectVersionId,
      );
      await this.lockRunAndProvider(
        tx,
        payload.suggestionRunId,
        providerIdentity.id,
      );
      const providerRun =
        await tx.trainingFactSuggestionProviderRun.findFirst({
          where: {
            id: providerIdentity.id,
            suggestionRunId: payload.suggestionRunId,
          },
          select: { status: true },
        });
      await this.assertOwnedJob(tx, job);
      await this.finishOwnedJob(
        tx,
        job,
        providerRun?.status === TrainingProviderRunStatus.SUCCEEDED
          ? succeededJobData(this.now())
          : deadJobData(code, message, this.now()),
      );
      if (providerRun) {
        await this.terminalizeProviderBeforeRequest(
          tx,
          providerIdentity.id,
          providerRun.status,
          code,
          'worker_failure',
          this.now(),
        );
        await this.recalculateRunInTransaction(
          tx,
          payload.suggestionRunId,
        );
      }
    });
    this.lostOwnership.add(job.id);
  }

  private async terminalizeProviderBeforeRequest(
    tx: Prisma.TransactionClient,
    providerRunId: string,
    status: TrainingProviderRunStatus,
    code: string,
    errorClass: string,
    completedAt: Date,
  ) {
    if (status === TrainingProviderRunStatus.PENDING) {
      const failed =
        await tx.trainingFactSuggestionProviderRun.updateMany({
          where: {
            id: providerRunId,
            status: TrainingProviderRunStatus.PENDING,
          },
          data: {
            status: TrainingProviderRunStatus.FAILED,
            errorCode: code,
            errorClass,
            completedAt,
          },
        });
      if (failed.count !== 1) {
        throw new LostFactSuggestionJobOwnershipError();
      }
      return;
    }
    if (status === TrainingProviderRunStatus.REQUESTING) {
      const ambiguous =
        await tx.trainingFactSuggestionProviderRun.updateMany({
          where: {
            id: providerRunId,
            status: TrainingProviderRunStatus.REQUESTING,
          },
          data: {
            status: TrainingProviderRunStatus.AMBIGUOUS,
            ambiguousOutcome: true,
            errorCode: code,
            errorClass,
            responseStatus: 'ambiguous',
            completedAt,
          },
        });
      if (ambiguous.count !== 1) {
        throw new LostFactSuggestionJobOwnershipError();
      }
    }
  }

  private async releaseJob(job: ClaimedJob) {
    const released = await this.prisma.trainingJob.updateMany({
      where: ownedJobWhere(job, this.workerId),
      data: releaseJobData(job, this.now()),
    });
    if (released.count !== 1) {
      throw new LostFactSuggestionJobOwnershipError();
    }
    this.lostOwnership.add(job.id);
  }
}

function isProviderInputCurrent(
  providerRun: {
    chunkIndex: number;
    inputHash: string;
    inputMetadataJson: Prisma.JsonValue;
    sourceContentHash: string;
    sourceDocument: {
      id: string;
      checksum: string;
      extractionStatus: TrainingSourceExtractionStatus;
      extractedText: string | null;
      extractionMetadataJson: Prisma.JsonValue;
    } | null;
    sourceOfficialUrl: {
      id: string;
      contentHash: string | null;
      extractionStatus: TrainingSourceExtractionStatus;
      extractedText: string | null;
      extractionMetadataJson: Prisma.JsonValue;
    } | null;
  },
  facts: Array<{
    id: string;
    code: string;
    statement: string;
    acceptedAliasesJson: Prisma.JsonValue;
  }>,
) {
  const source = providerRun.sourceDocument
    ? {
        id: providerRun.sourceDocument.id,
        checksum: providerRun.sourceDocument.checksum,
        extractionStatus: providerRun.sourceDocument.extractionStatus,
        extractedText: providerRun.sourceDocument.extractedText ?? '',
        extractionMetadata:
          providerRun.sourceDocument.extractionMetadataJson,
      }
    : providerRun.sourceOfficialUrl
      ? {
          id: providerRun.sourceOfficialUrl.id,
          checksum: providerRun.sourceOfficialUrl.contentHash ?? '',
          extractionStatus:
            providerRun.sourceOfficialUrl.extractionStatus,
          extractedText: providerRun.sourceOfficialUrl.extractedText ?? '',
          extractionMetadata:
            providerRun.sourceOfficialUrl.extractionMetadataJson,
        }
      : null;
  if (
    !source ||
    source.extractionStatus !== TrainingSourceExtractionStatus.READY ||
    !source.extractedText.trim() ||
    hashTrainingFactSuggestionText(source.extractedText) !==
      providerRun.sourceContentHash
  ) {
    return false;
  }
  const chunked = buildTrainingFactSuggestionChunks([source]);
  const chunk = chunked.chunks.find(
    (candidate) => candidate.index === providerRun.chunkIndex,
  );
  if (!chunk) return false;
  const existingFacts: TrainingExistingFactInput[] = facts.map((fact) => ({
    id: fact.id,
    code: fact.code,
    statement: fact.statement,
    acceptedAliases: readStringArray(fact.acceptedAliasesJson),
  }));
  const existingFactsHash = canonicalHash(existingFacts);
  const metadata = readRecord(providerRun.inputMetadataJson);
  return (
    metadata?.chunkInputHash === chunk.inputHash &&
    metadata?.existingFactsHash === existingFactsHash &&
    providerRun.inputHash ===
      canonicalHash({
        chunkInputHash: chunk.inputHash,
        existingFactsHash,
      })
  );
}

export function resolveStaleFactSuggestionRecovery(
  providerStatus: TrainingProviderRunStatus | null,
  attempts: number,
  maxAttempts: number,
) {
  if (providerStatus === TrainingProviderRunStatus.SUCCEEDED) {
    return 'SUCCEEDED' as const;
  }
  if (
    providerStatus === TrainingProviderRunStatus.PENDING &&
    attempts < maxAttempts
  ) {
    return 'RETRY_PENDING' as const;
  }
  if (providerStatus === TrainingProviderRunStatus.REQUESTING) {
    return 'AMBIGUOUS' as const;
  }
  return 'DEAD' as const;
}

export function resolveFactSuggestionRunStatus(
  statuses: TrainingProviderRunStatus[],
) {
  if (statuses.length === 0) {
    return TrainingFactSuggestionRunStatus.FAILED;
  }
  if (
    statuses.every(
      (status) => status === TrainingProviderRunStatus.PENDING,
    )
  ) {
    return TrainingFactSuggestionRunStatus.PENDING;
  }
  if (
    statuses.some(
      (status) =>
        status === TrainingProviderRunStatus.PENDING ||
        status === TrainingProviderRunStatus.REQUESTING,
    )
  ) {
    return TrainingFactSuggestionRunStatus.RUNNING;
  }
  if (
    statuses.every(
      (status) => status === TrainingProviderRunStatus.SUCCEEDED,
    )
  ) {
    return TrainingFactSuggestionRunStatus.READY;
  }
  if (
    statuses.some(
      (status) => status === TrainingProviderRunStatus.SUCCEEDED,
    )
  ) {
    return TrainingFactSuggestionRunStatus.PARTIAL;
  }
  if (
    statuses.every(
      (status) => status === TrainingProviderRunStatus.AMBIGUOUS,
    )
  ) {
    return TrainingFactSuggestionRunStatus.AMBIGUOUS;
  }
  return TrainingFactSuggestionRunStatus.FAILED;
}

function readJobPayload(value: Prisma.JsonValue): JobPayload | null {
  const record = readRecord(value);
  if (
    !record ||
    typeof record.suggestionRunId !== 'string' ||
    typeof record.providerRunId !== 'string'
  ) {
    return null;
  }
  return {
    suggestionRunId: record.suggestionRunId,
    providerRunId: record.providerRunId,
  };
}

function readRecord(value: unknown) {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readStringArray(value: Prisma.JsonValue) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function succeededJobData(finishedAt: Date) {
  return {
    status: TrainingJobStatus.SUCCEEDED,
    finishedAt,
    lockOwner: null,
    lockedAt: null,
    heartbeatAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    errorDetailsJson: Prisma.JsonNull,
  } satisfies Prisma.TrainingJobUpdateManyMutationInput;
}

function deadJobData(code: string, message: string, finishedAt: Date) {
  return {
    status: TrainingJobStatus.DEAD,
    finishedAt,
    lockOwner: null,
    lockedAt: null,
    heartbeatAt: null,
    lastErrorCode: code,
    lastErrorMessage: message.slice(0, 2_000),
    errorDetailsJson: { retryable: false },
  } satisfies Prisma.TrainingJobUpdateManyMutationInput;
}

function releaseJobData(job: ClaimedJob, releasedAt: Date) {
  return {
    status: TrainingJobStatus.PENDING,
    attempts: Math.max(0, job.attempts - 1),
    runAt: releasedAt,
    finishedAt: null,
    lockOwner: null,
    lockedAt: null,
    heartbeatAt: null,
  } satisfies Prisma.TrainingJobUpdateManyMutationInput;
}

function ownedJobWhere(job: ClaimedJob, workerId: string) {
  return {
    id: job.id,
    status: TrainingJobStatus.RUNNING,
    lockOwner: workerId,
    attempts: job.attempts,
  } satisfies Prisma.TrainingJobWhereInput;
}

function readErrorCode(error: unknown) {
  if (error instanceof TrainingOpenAiRequestError) return error.code;
  return formatTrainingErrorForLog(error);
}

class LostFactSuggestionJobOwnershipError extends Error {}

function readBoundedWorkerOption(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
) {
  const resolved = value ?? fallback;
  if (
    !Number.isInteger(resolved) ||
    resolved < minimum ||
    resolved > maximum
  ) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return resolved;
}
