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

const embeddingBatchSize = 64;

export class AssistantSourceIngestionError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) {
    super(code);
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
  leaseOwner: string;
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
    const fetchedAt = new Date();
    const fetched = await connector.fetch({
      id: source.id,
      canonicalUrl: source.canonicalUrl,
      connectorKey: source.connectorKey,
      connectorConfig: source.connectorConfigJson,
    });
    const persisted = await this.persistFetchedRevision(source, fetched, fetchedAt, fence);
    if (persisted.processingStatus === AssistantSourceRevisionStatus.INDEXED) {
      await this.markSourceSuccess(source.id, source.scheduleMinutes, fetchedAt, false);
      return { outcome: 'UNCHANGED' as const, revisionId: persisted.id, embeddedChunks: 0 };
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
        fetchedAt,
        contentType: fetched.contentType,
        payload: fetched.payload,
      });
      if (extracted.facts.length === 0 && extracted.chunks.length === 0) {
        throw new AssistantSourceIngestionError('SOURCE_EXTRACTION_EMPTY', false);
      }
      chunks = await this.prepareEmbeddings(source.id, extracted.chunks);
      await this.persistExtraction({
        sourceId: source.id,
        revisionId: persisted.id,
        scheduleMinutes: source.scheduleMinutes,
        fetchedAt,
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
    fetchedAt: Date,
    fence?: AssistantSourceIngestionFence,
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`
        SELECT "id"
        FROM "assistant_knowledge_sources"
        WHERE "id" = ${source.id}::uuid
        FOR UPDATE
      `);
      await assertIngestionFence(transaction, fence);
      const previous = await transaction.assistantSourceRevision.findFirst({
        where: { sourceId: source.id },
        orderBy: [{ fetchedAt: 'desc' }, { id: 'desc' }],
        select: { id: true, checksum: true, processingStatus: true },
      });
      await transaction.assistantKnowledgeSource.update({
        where: { id: source.id },
        data: { lastAttemptAt: fetchedAt },
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
          fetchedAt,
          processingStatus: AssistantSourceRevisionStatus.FAILED,
          processingErrorCode: 'SOURCE_PROCESSING_PENDING',
        },
        select: { id: true, processingStatus: true },
      });
    });
  }

  private async prepareEmbeddings(sourceId: string, chunks: ExtractedSourceChunk[]) {
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
    for (let offset = 0; offset < changed.length; offset += embeddingBatchSize) {
      const batch = changed.slice(offset, offset + embeddingBatchSize);
      const result = await this.embeddings.embed(batch.map(({ text }) => text));
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
    fetchedAt: Date;
    facts: ExtractedSourceFact[];
    chunks: PreparedChunk[];
    fence?: AssistantSourceIngestionFence;
  }) {
    await this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`
        SELECT "id"
        FROM "assistant_knowledge_sources"
        WHERE "id" = ${input.sourceId}::uuid
        FOR UPDATE
      `);
      await assertIngestionFence(transaction, input.fence);
      const revision = await transaction.assistantSourceRevision.findUniqueOrThrow({
        where: { id: input.revisionId },
        select: { processingStatus: true },
      });
      if (revision.processingStatus === AssistantSourceRevisionStatus.INDEXED) return;

      await transaction.assistantSourceFact.updateMany({
        where: { sourceId: input.sourceId, isActive: true },
        data: { isActive: false },
      });
      await transaction.assistantSourceChunk.updateMany({
        where: { sourceId: input.sourceId, isActive: true },
        data: { isActive: false },
      });
      if (input.facts.length > 0) {
        await transaction.assistantSourceFact.createMany({
          data: input.facts.map((fact) => ({
            sourceId: input.sourceId,
            sourceRevisionId: input.revisionId,
            kind: fact.kind as AssistantSourceFactKind,
            label: fact.label.slice(0, 300),
            valueJson: fact.value as Prisma.InputJsonValue,
            valueHash: createHash('sha256').update(JSON.stringify(fact.value)).digest('hex'),
            searchText: fact.searchText,
            canonicalUrl: fact.canonicalUrl,
            observedAt: fact.observedAt,
            validFrom: fact.validFrom,
          })),
        });
      }
      for (const chunk of input.chunks) {
        const embedding = chunk.embeddingVector
          ? Prisma.sql`${formatVector(chunk.embeddingVector)}::vector`
          : Prisma.sql`NULL`;
        const embeddedAt = chunk.embeddingVector ? input.fetchedAt : null;
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
            TRUE,
            CURRENT_TIMESTAMP
          )
        `);
      }
      await transaction.assistantSourceRevision.update({
        where: { id: input.revisionId },
        data: {
          processingStatus: AssistantSourceRevisionStatus.INDEXED,
          processingErrorCode: null,
        },
      });
      await transaction.assistantKnowledgeSource.update({
        where: { id: input.sourceId },
        data: {
          lastSuccessAt: input.fetchedAt,
          lastIndexedAt: input.fetchedAt,
          lastErrorCode: null,
          lastErrorMessage: null,
          nextRefreshAt: new Date(input.fetchedAt.getTime() + input.scheduleMinutes * 60_000),
        },
      });
    });
  }

  private markSourceSuccess(sourceId: string, scheduleMinutes: number, fetchedAt: Date, indexed: boolean) {
    return this.prisma.assistantKnowledgeSource.update({
      where: { id: sourceId },
      data: {
        lastSuccessAt: fetchedAt,
        ...(indexed ? { lastIndexedAt: fetchedAt } : {}),
        lastErrorCode: null,
        lastErrorMessage: null,
        nextRefreshAt: new Date(fetchedAt.getTime() + scheduleMinutes * 60_000),
      },
      select: { id: true },
    });
  }
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
  return new AssistantSourceIngestionError('SOURCE_PROCESSING_FAILED', true);
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
