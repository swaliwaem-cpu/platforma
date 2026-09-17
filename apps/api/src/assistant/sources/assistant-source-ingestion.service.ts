import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import { Injectable } from '@nestjs/common';
import {
  AssistantKnowledgeSourceState,
  AssistantSourceFactKind,
  AssistantSourceRevisionStatus,
  Prisma,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { AssistantEmbeddingGateway } from './assistant-embedding.gateway';
import { AssistantSourceConnectorRegistry } from './assistant-source-connector.registry';
import {
  OfficialSourceExtractor,
  type ExtractedSourceChunk,
  type ExtractedSourceFact,
} from './official-source.extractor';

// DashScope text-embedding-v4 rejects requests with more than 10 inputs (InvalidParameter).
const embeddingBatchSize = 10;

export class AssistantSourceIngestionError extends Error {
  constructor(readonly code: string, readonly retryable: boolean, options?: { cause?: unknown }) {
    super(code, options);
    this.name = 'AssistantSourceIngestionError';
  }
}

type PreparedChunk = ExtractedSourceChunk & {
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  embeddingVector: number[] | null;
};

export type AssistantSourceIngestionFence = {
  jobId: string;
  executionId: string;
  leaseOwner: string;
  attemptStartedAt: Date;
};

@Injectable()
export class AssistantSourceIngestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: AssistantSourceConnectorRegistry,
    private readonly extractor: OfficialSourceExtractor,
    private readonly embeddings: AssistantEmbeddingGateway,
  ) {}

  async ingest(sourceId: string, fence?: AssistantSourceIngestionFence) {
    if (fence) {
      await this.embeddings.reconcileExecution?.(fence.jobId, fence.executionId);
    }
    const source = await this.prisma.assistantKnowledgeSource.findUnique({
      where: { id: sourceId },
      select: {
        id: true,
        type: true,
        state: true,
        canonicalUrl: true,
        priority: true,
        scheduleMinutes: true,
        connectorKey: true,
        connectorConfigJson: true,
        projectKey: true,
        developerKey: true,
      },
    });
    if (!source) throw new AssistantSourceIngestionError('ASSISTANT_SOURCE_NOT_FOUND', false);
    if (source.state !== AssistantKnowledgeSourceState.ACTIVE) {
      throw new AssistantSourceIngestionError('ASSISTANT_SOURCE_NOT_ACTIVE', false);
    }

    const connector = this.connectors.get(source.connectorKey);
    const attemptStartedAt = fence?.attemptStartedAt ?? await this.prisma.$transaction(
      (transaction) => reserveAssistantSourceAttempt(transaction, source.id),
    );
    const fetched = await connector.fetch({
      id: source.id,
      canonicalUrl: source.canonicalUrl,
      connectorKey: source.connectorKey,
      connectorConfig: source.connectorConfigJson,
    });
    const persisted = await this.persistFetchedRevision(source, fetched, attemptStartedAt, fence);
    if (persisted.processingStatus === AssistantSourceRevisionStatus.INDEXED) {
      if (!(await this.hasStaleActiveEmbeddings(source.id))) {
        await this.markSourceSuccess(source.id, source.scheduleMinutes, attemptStartedAt, false, fence);
        return { outcome: 'UNCHANGED' as const, revisionId: persisted.id, embeddedChunks: 0 };
      }
      // Same page, different embedding model: retrieval only sees vectors of the configured
      // model, so the revision goes back through extraction instead of silently dropping out.
      await this.prisma.assistantSourceRevision.updateMany({
        where: { id: persisted.id, processingStatus: AssistantSourceRevisionStatus.INDEXED },
        data: {
          processingStatus: AssistantSourceRevisionStatus.FAILED,
          processingErrorCode: 'SOURCE_EMBEDDING_MODEL_CHANGED',
        },
      });
    }

    let extracted: ReturnType<OfficialSourceExtractor['extract']>;
    let chunks: PreparedChunk[];
    try {
      extracted = this.extractor.extract({
        source: {
          id: source.id,
          type: source.type,
          canonicalUrl: source.canonicalUrl,
          projectKey: source.projectKey,
          developerKey: source.developerKey,
          priority: source.priority,
          connectorConfig: source.connectorConfigJson,
        },
        revisionId: persisted.id,
        fetchedAt: persisted.fetchedAt,
        contentType: fetched.contentType,
        payload: fetched.payload,
      });
      if (extracted.facts.length === 0 && extracted.chunks.length === 0) {
        throw new AssistantSourceIngestionError('SOURCE_EXTRACTION_EMPTY', false);
      }
      chunks = await this.prepareEmbeddings(source.id, extracted.chunks, fence);
      await this.persistExtraction({
        sourceId: source.id,
        revisionId: persisted.id,
        scheduleMinutes: source.scheduleMinutes,
        revisionFetchedAt: persisted.fetchedAt,
        attemptStartedAt,
        facts: extracted.facts,
        chunks,
        fence,
      });
    } catch (error) {
      const failure = normalizeIngestionError(error);
      await this.prisma.assistantSourceRevision.updateMany({
        where: { id: persisted.id, processingStatus: AssistantSourceRevisionStatus.FAILED },
        data: { processingErrorCode: failure.code },
      });
      throw failure;
    }

    return {
      outcome: 'INDEXED' as const,
      revisionId: persisted.id,
      facts: extracted.facts.length,
      chunks: extracted.chunks.length,
      embeddedChunks: chunks.filter(({ embeddingVector }) => embeddingVector !== null).length,
    };
  }

  private async persistFetchedRevision(
    source: { id: string },
    fetched: Awaited<ReturnType<ReturnType<AssistantSourceConnectorRegistry['get']>['fetch']>>,
    attemptStartedAt: Date,
    fence?: AssistantSourceIngestionFence,
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await assertIngestionFence(transaction, fence);
      await transaction.$queryRaw(Prisma.sql`
        SELECT "id"
        FROM "assistant_knowledge_sources"
        WHERE "id" = ${source.id}::uuid
        FOR UPDATE
      `);
      const previous = await transaction.assistantSourceRevision.findFirst({
        where: { sourceId: source.id, nextRevision: { is: null } },
        select: { id: true, checksum: true, fetchedAt: true, processingStatus: true },
      });
      if (previous?.checksum === fetched.checksum) return previous;
      return transaction.assistantSourceRevision.create({
        data: {
          id: randomUUID(),
          sourceId: source.id,
          previousRevisionId: previous?.id ?? null,
          checksum: fetched.checksum,
          rawPayload: gzipSync(fetched.payload, { level: 9 }),
          rawEncoding: 'gzip',
          rawSizeBytes: fetched.payload.length,
          contentType: fetched.contentType,
          finalUrl: fetched.finalUrl,
          httpStatus: fetched.statusCode,
          etag: fetched.etag,
          lastModified: fetched.lastModified,
          fetchedAt: attemptStartedAt,
          processingStatus: AssistantSourceRevisionStatus.FAILED,
          processingErrorCode: 'SOURCE_PROCESSING_PENDING',
        },
        select: { id: true, fetchedAt: true, processingStatus: true },
      });
    });
  }

  private async hasStaleActiveEmbeddings(sourceId: string) {
    if (!this.embeddings.isEnabled()) return false;
    const model = this.embeddings.getModel();
    const dimensions = this.embeddings.getDimensions();
    if (!model || !dimensions) return false;
    const stale = await this.prisma.assistantSourceChunk.count({
      where: {
        sourceId,
        isActive: true,
        OR: [
          { embeddingModel: null },
          { embeddingModel: { not: model } },
          { embeddingDimensions: { not: dimensions } },
        ],
      },
    });
    return stale > 0;
  }

  private async prepareEmbeddings(
    sourceId: string,
    chunks: ExtractedSourceChunk[],
    fence?: AssistantSourceIngestionFence,
  ) {
    if (!this.embeddings.isEnabled() || chunks.length === 0) {
      return chunks.map((chunk) => ({
        ...chunk,
        embeddingModel: null,
        embeddingDimensions: null,
        embeddingVector: null,
      }));
    }
    const model = this.embeddings.getModel();
    const dimensions = this.embeddings.getDimensions();
    if (!model || !dimensions) {
      throw new AssistantSourceIngestionError('ASSISTANT_EMBEDDING_MODEL_REQUIRED', false);
    }
    const hashes = [...new Set(chunks.map(({ contentHash }) => contentHash))];
    const reusable = hashes.length === 0 ? [] : await this.prisma.$queryRaw<Array<{
      contentHash: string;
      embedding: string;
    }>>(Prisma.sql`
      SELECT DISTINCT ON ("content_hash")
        "content_hash" AS "contentHash",
        "embedding"::text AS "embedding"
      FROM "assistant_source_chunks"
      WHERE "source_id" = ${sourceId}::uuid
        AND "content_hash" IN (${Prisma.join(hashes)})
        AND "embedding_model" = ${model}
        AND "embedding_dimensions" = ${dimensions}
        AND "embedding" IS NOT NULL
      ORDER BY "content_hash", "created_at" DESC
    `);
    const vectorsByHash = new Map(reusable.map((row) => [row.contentHash, parseVector(row.embedding)]));
    const changed = chunks.filter(({ contentHash }) => !vectorsByHash.has(contentHash));
    let attemptOrdinal = 0;
    for (let offset = 0; offset < changed.length; offset += embeddingBatchSize) {
      const batch = changed.slice(offset, offset + embeddingBatchSize);
      const result = await this.embeddings.embed(
        batch.map(({ text }) => text),
        fence ? {
          operation: 'EMBEDDING_INGESTION',
          operationRunId: fence.jobId,
          executionId: fence.executionId,
          nextAttemptOrdinal: () => {
            attemptOrdinal += 1;
            return attemptOrdinal;
          },
        } : undefined,
      );
      batch.forEach((chunk, index) => vectorsByHash.set(chunk.contentHash, result.vectors[index]!));
    }
    return chunks.map((chunk) => ({
      ...chunk,
      embeddingModel: model,
      embeddingDimensions: dimensions,
      embeddingVector: vectorsByHash.get(chunk.contentHash) ?? null,
    }));
  }

  private async persistExtraction(input: {
    sourceId: string;
    revisionId: string;
    scheduleMinutes: number;
    revisionFetchedAt: Date;
    attemptStartedAt: Date;
    facts: ExtractedSourceFact[];
    chunks: PreparedChunk[];
    fence?: AssistantSourceIngestionFence;
  }) {
    await this.prisma.$transaction(async (transaction) => {
      await assertIngestionFence(transaction, input.fence);
      await transaction.$queryRaw(Prisma.sql`
        SELECT "id"
        FROM "assistant_knowledge_sources"
        WHERE "id" = ${input.sourceId}::uuid
        FOR UPDATE
      `);
      const revision = await transaction.assistantSourceRevision.findUniqueOrThrow({
        where: { id: input.revisionId },
        select: { processingStatus: true },
      });
      const sourceHealth = await transaction.assistantKnowledgeSource.findUniqueOrThrow({
        where: { id: input.sourceId },
        select: {
          lastAttemptAt: true,
          lastSuccessAt: true,
          lastIndexedAt: true,
          nextRefreshAt: true,
          lastErrorCode: true,
          lastErrorMessage: true,
        },
      });
      const persistSuccessHealth = (lastIndexedAt?: Date) => (
        transaction.assistantKnowledgeSource.update({
          where: { id: input.sourceId },
          data: {
            lastSuccessAt: latestDate(sourceHealth.lastSuccessAt, input.attemptStartedAt),
            ...(lastIndexedAt ? { lastIndexedAt } : {}),
            ...(isSameInstant(sourceHealth.lastAttemptAt, input.attemptStartedAt)
              ? { lastErrorCode: null, lastErrorMessage: null }
              : {
                  lastErrorCode: sourceHealth.lastErrorCode,
                  lastErrorMessage: sourceHealth.lastErrorMessage,
                }),
            nextRefreshAt: latestDate(
              sourceHealth.nextRefreshAt,
              new Date(input.attemptStartedAt.getTime() + input.scheduleMinutes * 60_000),
            ),
          },
        })
      );
      if (revision.processingStatus === AssistantSourceRevisionStatus.INDEXED) {
        await persistSuccessHealth();
        return;
      }
      const shouldActivate = sourceHealth.lastIndexedAt === null
        || input.revisionFetchedAt >= sourceHealth.lastIndexedAt;

      if (shouldActivate) {
        await transaction.assistantSourceFact.updateMany({
          where: { sourceId: input.sourceId, isActive: true },
          data: { isActive: false },
        });
        await transaction.assistantSourceChunk.updateMany({
          where: { sourceId: input.sourceId, isActive: true },
          data: { isActive: false },
        });
      }
      // A revision can be processed again (embedding model change): keep fact ids stable,
      // drop facts the extractor no longer produces and upsert chunks by ordinal.
      const factHashes = input.facts.map((fact) => createHash('sha256').update(JSON.stringify(fact.value)).digest('hex'));
      await transaction.assistantSourceFact.deleteMany({
        where: {
          sourceRevisionId: input.revisionId,
          ...(factHashes.length > 0 ? { valueHash: { notIn: factHashes } } : {}),
        },
      });
      await transaction.$executeRaw(Prisma.sql`
        DELETE FROM "assistant_source_chunks"
        WHERE "source_revision_id" = ${input.revisionId}::uuid
          AND "ordinal" >= ${input.chunks.length}
      `);
      if (input.facts.length > 0) {
        await transaction.assistantSourceFact.createMany({
          data: input.facts.map((fact, index) => ({
            sourceId: input.sourceId,
            sourceRevisionId: input.revisionId,
            kind: fact.kind as AssistantSourceFactKind,
            label: fact.label.slice(0, 300),
            valueJson: fact.value as Prisma.InputJsonValue,
            valueHash: factHashes[index]!,
            searchText: fact.searchText,
            canonicalUrl: fact.canonicalUrl,
            observedAt: fact.observedAt,
            validFrom: fact.validFrom,
            isActive: shouldActivate,
          })),
          skipDuplicates: true,
        });
        await transaction.assistantSourceFact.updateMany({
          where: { sourceRevisionId: input.revisionId },
          data: { isActive: shouldActivate },
        });
      }
      for (const chunk of input.chunks) {
        const embedding = chunk.embeddingVector
          ? Prisma.sql`${formatVector(chunk.embeddingVector)}::vector`
          : Prisma.sql`NULL`;
        const embeddedAt = chunk.embeddingVector ? input.revisionFetchedAt : null;
        await transaction.$executeRaw(Prisma.sql`
          INSERT INTO "assistant_source_chunks" (
            "id", "source_id", "source_revision_id", "ordinal", "text", "content_hash",
            "embedding", "embedding_model", "embedding_dimensions", "embedded_at", "is_active", "created_at"
          ) VALUES (
            ${randomUUID()}::uuid,
            ${input.sourceId}::uuid,
            ${input.revisionId}::uuid,
            ${chunk.ordinal},
            ${chunk.text},
            ${chunk.contentHash},
            ${embedding},
            ${chunk.embeddingModel},
            ${chunk.embeddingDimensions},
            ${embeddedAt},
            ${shouldActivate},
            CURRENT_TIMESTAMP
          )
          ON CONFLICT ("source_revision_id", "ordinal") DO UPDATE SET
            "text" = EXCLUDED."text",
            "content_hash" = EXCLUDED."content_hash",
            "embedding" = EXCLUDED."embedding",
            "embedding_model" = EXCLUDED."embedding_model",
            "embedding_dimensions" = EXCLUDED."embedding_dimensions",
            "embedded_at" = EXCLUDED."embedded_at",
            "is_active" = EXCLUDED."is_active"
        `);
      }
      await transaction.assistantSourceRevision.update({
        where: { id: input.revisionId },
        data: {
          processingStatus: AssistantSourceRevisionStatus.INDEXED,
          processingErrorCode: null,
        },
      });
      await persistSuccessHealth(shouldActivate ? input.revisionFetchedAt : undefined);
    });
  }

  private markSourceSuccess(
    sourceId: string,
    scheduleMinutes: number,
    fetchedAt: Date,
    indexed: boolean,
    fence?: AssistantSourceIngestionFence,
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await assertIngestionFence(transaction, fence);
      await transaction.$queryRaw(Prisma.sql`
        SELECT "id"
        FROM "assistant_knowledge_sources"
        WHERE "id" = ${sourceId}::uuid
        FOR UPDATE
      `);
      const sourceHealth = await transaction.assistantKnowledgeSource.findUniqueOrThrow({
        where: { id: sourceId },
        select: {
          lastAttemptAt: true,
          lastSuccessAt: true,
          lastIndexedAt: true,
          nextRefreshAt: true,
          lastErrorCode: true,
          lastErrorMessage: true,
        },
      });
      const isLatestAttempt = isSameInstant(sourceHealth.lastAttemptAt, fetchedAt);
      return transaction.assistantKnowledgeSource.update({
        where: { id: sourceId },
        data: {
          lastAttemptAt: latestDate(sourceHealth.lastAttemptAt, fetchedAt),
          lastSuccessAt: latestDate(sourceHealth.lastSuccessAt, fetchedAt),
          ...(indexed ? { lastIndexedAt: latestDate(sourceHealth.lastIndexedAt, fetchedAt) } : {}),
          ...(isLatestAttempt
            ? { lastErrorCode: null, lastErrorMessage: null }
            : {
                lastErrorCode: sourceHealth.lastErrorCode,
                lastErrorMessage: sourceHealth.lastErrorMessage,
              }),
          nextRefreshAt: latestDate(
            sourceHealth.nextRefreshAt,
            new Date(fetchedAt.getTime() + scheduleMinutes * 60_000),
          ),
        },
        select: { id: true },
      });
    });
  }
}

function latestDate(current: Date | null, candidate: Date) {
  return current && current > candidate ? current : candidate;
}

function isSameInstant(left: Date | null, right: Date) {
  return left?.getTime() === right.getTime();
}

export async function reserveAssistantSourceAttempt(
  transaction: Prisma.TransactionClient,
  sourceId: string,
) {
  const [attempt] = await transaction.$queryRaw<Array<{ attemptStartedAt: Date }>>(Prisma.sql`
    UPDATE "assistant_knowledge_sources"
    SET
      "last_attempt_at" = GREATEST(
        CLOCK_TIMESTAMP(),
        COALESCE("last_attempt_at" + INTERVAL '1 millisecond', CLOCK_TIMESTAMP())
      ),
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${sourceId}::uuid
    RETURNING "last_attempt_at" AS "attemptStartedAt"
  `);
  if (!attempt) throw new AssistantSourceIngestionError('ASSISTANT_SOURCE_NOT_FOUND', false);
  return attempt.attemptStartedAt;
}

async function assertIngestionFence(
  transaction: Prisma.TransactionClient,
  fence: AssistantSourceIngestionFence | undefined,
) {
  if (!fence) return;
  const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"::text AS "id"
    FROM "assistant_source_jobs"
    WHERE "id" = ${fence.jobId}::uuid
      AND "status" = 'running'::assistant_source_job_status
      AND "lease_owner" = ${fence.leaseOwner}
      AND "lease_expires_at" > CURRENT_TIMESTAMP
    FOR UPDATE
  `);
  if (rows.length !== 1) {
    throw new AssistantSourceIngestionError('SOURCE_JOB_LEASE_LOST', true);
  }
}

function normalizeIngestionError(error: unknown) {
  if (error instanceof AssistantSourceIngestionError) return error;
  if (isRetryableCodedError(error)) {
    return new AssistantSourceIngestionError(error.code, error.retryable);
  }
  return new AssistantSourceIngestionError('SOURCE_PROCESSING_FAILED', true, { cause: error });
}

function isRetryableCodedError(error: unknown): error is { code: string; retryable: boolean } {
  return typeof error === 'object' && error !== null
    && typeof (error as { code?: unknown }).code === 'string'
    && typeof (error as { retryable?: unknown }).retryable === 'boolean';
}

function parseVector(value: string) {
  if (!/^\[(?:-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)(?:,-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)*\]$/iu.test(value)) {
    throw new AssistantSourceIngestionError('ASSISTANT_STORED_EMBEDDING_INVALID', false);
  }
  const vector = value.slice(1, -1).split(',').map(Number);
  if (vector.length === 0 || vector.some((item) => !Number.isFinite(item))) {
    throw new AssistantSourceIngestionError('ASSISTANT_STORED_EMBEDDING_INVALID', false);
  }
  return vector;
}

function formatVector(vector: number[]) {
  if (vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
    throw new AssistantSourceIngestionError('ASSISTANT_EMBEDDING_RESPONSE_INVALID', false);
  }
  return `[${vector.join(',')}]`;
}
