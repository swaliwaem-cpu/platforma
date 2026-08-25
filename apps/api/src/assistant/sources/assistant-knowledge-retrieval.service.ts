import { Injectable } from '@nestjs/common';
import {
  AssistantKnowledgeSourceType,
  AssistantSourceFactKind,
  Prisma,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import type { AssistantStructuredIntent } from '../assistant-query-planner';
import { AssistantEmbeddingGateway } from './assistant-embedding.gateway';

const maximumRetrievalCacheMilliseconds = 6 * 60 * 60 * 1_000;
const maximumEvidenceItems = 12;

type RetrievalChannel = 'STRUCTURED_SQL' | 'POSTGRES_FTS' | 'PGVECTOR';

type FactRow = {
  id: string;
  sourceId: string;
  sourceRevisionId: string;
  kind: AssistantSourceFactKind;
  label: string;
  valueJson: Prisma.JsonValue;
  searchText: string;
  canonicalUrl: string;
  observedAt: Date;
  validFrom: Date | null;
  sourceType: AssistantKnowledgeSourceType;
  sourcePriority: number;
  projectKey: string | null;
  developerKey: string | null;
  fetchedAt: Date;
};

export type AssistantKnowledgeEvidence = {
  evidenceType: 'KNOWLEDGE_SOURCE';
  factId: string;
  sourceId: string;
  sourceRevisionId: string;
  sourceType: AssistantKnowledgeSourceType;
  sourcePriority: number;
  kind: AssistantSourceFactKind;
  label: string;
  value: Prisma.JsonValue;
  canonicalUrl: string;
  observedAt: string;
  fetchedAt: string;
  projectKey: string | null;
  developerKey: string | null;
  retrievalChannels: RetrievalChannel[];
  retrievalScore: number;
};

type RetrievalCacheEntry = {
  expiresAt: number;
  revisionFingerprint: string;
  evidence: AssistantKnowledgeEvidence[];
};

@Injectable()
export class AssistantKnowledgeRetrievalService {
  private readonly cache = new Map<string, RetrievalCacheEntry>();
  private readonly cacheTtlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings: AssistantEmbeddingGateway,
  ) {
    this.cacheTtlMs = readCacheTtl(process.env.ASSISTANT_RETRIEVAL_CACHE_TTL_MS);
  }

  async retrieve(input: {
    query: string;
    intent: AssistantStructuredIntent;
    includeExternalLots: boolean;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const query = normalizeQuery(input.query);
    if (!query) return [];
    const fingerprint = await this.readRevisionFingerprint();
    const cacheKey = createCacheKey(query, input.intent, input.includeExternalLots);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now.getTime() && cached.revisionFingerprint === fingerprint) {
      return cached.evidence.map(copyEvidence);
    }

    const structured = await this.retrieveStructured(input.intent, input.includeExternalLots);
    const ftsRevisions = await this.retrieveFtsRevisionScores(query);
    const vectorRevisions = await this.retrieveVectorRevisionScores(query);
    const revisionIds = [...new Set([
      ...ftsRevisions.keys(),
      ...vectorRevisions.keys(),
    ])];
    const retrievedByText = revisionIds.length > 0
      ? await this.readFactsForRevisions(revisionIds, input.includeExternalLots)
      : [];
    const candidates = new Map<string, { row: FactRow; channels: Set<RetrievalChannel>; score: number }>();

    for (const row of structured) {
      candidates.set(row.id, {
        row,
        channels: new Set(['STRUCTURED_SQL']),
        score: lexicalScore(query, row),
      });
    }
    for (const row of retrievedByText) {
      const candidate = candidates.get(row.id) ?? { row, channels: new Set<RetrievalChannel>(), score: lexicalScore(query, row) };
      const ftsScore = ftsRevisions.get(row.sourceRevisionId);
      const vectorScore = vectorRevisions.get(row.sourceRevisionId);
      if (ftsScore !== undefined) {
        candidate.channels.add('POSTGRES_FTS');
        candidate.score += ftsScore * 10;
      }
      if (vectorScore !== undefined) {
        candidate.channels.add('PGVECTOR');
        candidate.score += vectorScore * 8;
      }
      candidates.set(row.id, candidate);
    }

    const evidence = [...candidates.values()]
      .filter(({ row, score }) => score > 0 || shouldIncludeStructuredExternalLot(row, input.includeExternalLots))
      .sort(compareCandidates)
      .filter(deduplicateCanonicalFacts())
      .slice(0, maximumEvidenceItems)
      .map(({ row, channels, score }) => ({
        evidenceType: 'KNOWLEDGE_SOURCE' as const,
        factId: row.id,
        sourceId: row.sourceId,
        sourceRevisionId: row.sourceRevisionId,
        sourceType: row.sourceType,
        sourcePriority: row.sourcePriority,
        kind: row.kind,
        label: row.label,
        value: row.valueJson,
        canonicalUrl: row.canonicalUrl,
        observedAt: row.observedAt.toISOString(),
        fetchedAt: row.fetchedAt.toISOString(),
        projectKey: row.projectKey,
        developerKey: row.developerKey,
        retrievalChannels: [...channels].sort(),
        retrievalScore: Number(score.toFixed(6)),
      }));
    this.cache.set(cacheKey, {
      expiresAt: now.getTime() + this.cacheTtlMs,
      revisionFingerprint: fingerprint,
      evidence,
    });
    this.pruneCache(now.getTime());
    return evidence.map(copyEvidence);
  }

  clearCache() {
    this.cache.clear();
  }

  private retrieveStructured(intent: AssistantStructuredIntent, includeExternalLots: boolean) {
    const filters = intent.hardFilters;
    const kinds = includeExternalLots
      ? Object.values(AssistantSourceFactKind)
      : Object.values(AssistantSourceFactKind).filter((kind) => kind !== AssistantSourceFactKind.EXTERNAL_LOT);
    const conditions: Prisma.Sql[] = [
      Prisma.sql`f."is_active" = TRUE`,
      Prisma.sql`s."state" = 'active'::assistant_knowledge_source_state`,
      Prisma.sql`r."processing_status" = 'indexed'::assistant_source_revision_status`,
      Prisma.sql`f."kind" IN (${Prisma.join(kinds.map((kind) => Prisma.sql`${kind.toLocaleLowerCase('en-US')}::assistant_source_fact_kind`))})`,
    ];
    if (includeExternalLots) {
      if (filters.budgetMinRub !== null) {
        conditions.push(Prisma.sql`(
          f."kind" <> 'external_lot'::assistant_source_fact_kind OR
          (f."value_json"->>'priceRub')::numeric >= ${filters.budgetMinRub}
        )`);
      }
      if (filters.budgetMaxRub !== null) {
        conditions.push(Prisma.sql`(
          f."kind" <> 'external_lot'::assistant_source_fact_kind OR
          (f."value_json"->>'priceRub')::numeric <= ${filters.budgetMaxRub}
        )`);
      }
      if (filters.rooms.length > 0) {
        conditions.push(Prisma.sql`(
          f."kind" <> 'external_lot'::assistant_source_fact_kind OR
          (f."value_json"->>'rooms')::integer IN (${Prisma.join(filters.rooms)})
        )`);
      }
    }
    return this.prisma.$queryRaw<FactRow[]>(Prisma.sql`
      ${factSelectSql}
      WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY s."priority" DESC, f."observed_at" DESC, f."id" ASC
      LIMIT 80
    `);
  }

  private async retrieveFtsRevisionScores(query: string) {
    const tsQuery = significantTokens(query).join(' | ');
    if (!tsQuery) return new Map<string, number>();
    const rows = await this.prisma.$queryRaw<Array<{ sourceRevisionId: string; score: number }>>(Prisma.sql`
      SELECT
        c."source_revision_id"::text AS "sourceRevisionId",
        MAX(ts_rank_cd(to_tsvector('russian', c."text"), to_tsquery('russian', ${tsQuery})))::float8 AS "score"
      FROM "assistant_source_chunks" c
      JOIN "assistant_source_revisions" r ON r."id" = c."source_revision_id"
      JOIN "assistant_knowledge_sources" s ON s."id" = c."source_id"
      WHERE c."is_active" = TRUE
        AND s."state" = 'active'::assistant_knowledge_source_state
        AND r."processing_status" = 'indexed'::assistant_source_revision_status
        AND to_tsvector('russian', c."text") @@ to_tsquery('russian', ${tsQuery})
      GROUP BY c."source_revision_id"
      ORDER BY "score" DESC
      LIMIT 20
    `);
    return new Map(rows.map(({ sourceRevisionId, score }) => [sourceRevisionId, Number(score)]));
  }

  private async retrieveVectorRevisionScores(query: string) {
    if (!this.embeddings.isEnabled()) return new Map<string, number>();
    const model = this.embeddings.getModel();
    if (!model) return new Map<string, number>();
    const embedded = await this.embeddings.embed([query]);
    const vector = formatVector(embedded.vectors[0]!);
    const rows = await this.prisma.$queryRaw<Array<{ sourceRevisionId: string; score: number }>>(Prisma.sql`
      SELECT
        c."source_revision_id"::text AS "sourceRevisionId",
        MAX(1 - (c."embedding" <=> ${vector}::vector))::float8 AS "score"
      FROM "assistant_source_chunks" c
      JOIN "assistant_source_revisions" r ON r."id" = c."source_revision_id"
      JOIN "assistant_knowledge_sources" s ON s."id" = c."source_id"
      WHERE c."is_active" = TRUE
        AND s."state" = 'active'::assistant_knowledge_source_state
        AND c."embedding_model" = ${model}
        AND c."embedding" IS NOT NULL
        AND r."processing_status" = 'indexed'::assistant_source_revision_status
      GROUP BY c."source_revision_id"
      ORDER BY "score" DESC
      LIMIT 20
    `);
    return new Map(rows.map(({ sourceRevisionId, score }) => [sourceRevisionId, Number(score)]));
  }

  private readFactsForRevisions(revisionIds: string[], includeExternalLots: boolean) {
    const kindCondition = includeExternalLots
      ? Prisma.sql`TRUE`
      : Prisma.sql`f."kind" <> 'external_lot'::assistant_source_fact_kind`;
    return this.prisma.$queryRaw<FactRow[]>(Prisma.sql`
      ${factSelectSql}
      WHERE f."is_active" = TRUE
        AND s."state" = 'active'::assistant_knowledge_source_state
        AND r."processing_status" = 'indexed'::assistant_source_revision_status
        AND f."source_revision_id" IN (${Prisma.join(revisionIds.map((id) => Prisma.sql`${id}::uuid`))})
        AND ${kindCondition}
      ORDER BY s."priority" DESC, f."observed_at" DESC, f."id" ASC
    `);
  }

  private async readRevisionFingerprint() {
    const [row] = await this.prisma.$queryRaw<Array<{ fingerprint: string }>>(Prisma.sql`
      SELECT CONCAT(
        COUNT(*)::text,
        ':',
        COALESCE(MAX("assistant_source_revisions"."created_at")::text, ''),
        ':',
        COALESCE(MAX("assistant_source_revisions"."id"::text), '')
      ) AS "fingerprint"
      FROM "assistant_source_revisions"
      JOIN "assistant_knowledge_sources" ON "assistant_knowledge_sources"."id" = "assistant_source_revisions"."source_id"
      WHERE "assistant_source_revisions"."processing_status" = 'indexed'::assistant_source_revision_status
        AND "assistant_knowledge_sources"."state" = 'active'::assistant_knowledge_source_state
    `);
    return row?.fingerprint ?? '0::';
  }

  private pruneCache(now: number) {
    if (this.cache.size <= 200) return;
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now || this.cache.size > 200) this.cache.delete(key);
    }
  }
}

const factSelectSql = Prisma.sql`
  SELECT
    f."id"::text AS "id",
    f."source_id"::text AS "sourceId",
    f."source_revision_id"::text AS "sourceRevisionId",
    UPPER(f."kind"::text) AS "kind",
    f."label" AS "label",
    f."value_json" AS "valueJson",
    f."search_text" AS "searchText",
    f."canonical_url" AS "canonicalUrl",
    f."observed_at" AS "observedAt",
    f."valid_from" AS "validFrom",
    UPPER(s."type"::text) AS "sourceType",
    s."priority"::integer AS "sourcePriority",
    s."project_key" AS "projectKey",
    s."developer_key" AS "developerKey",
    r."fetched_at" AS "fetchedAt"
  FROM "assistant_source_facts" f
  JOIN "assistant_knowledge_sources" s ON s."id" = f."source_id"
  JOIN "assistant_source_revisions" r ON r."id" = f."source_revision_id"
`;

function compareCandidates(
  left: { row: FactRow; score: number },
  right: { row: FactRow; score: number },
) {
  const authority = authorityScore(right.row) - authorityScore(left.row);
  if (authority !== 0) return authority;
  const relevance = right.score - left.score;
  if (relevance !== 0) return relevance;
  const freshness = right.row.observedAt.getTime() - left.row.observedAt.getTime();
  if (freshness !== 0) return freshness;
  return left.row.id.localeCompare(right.row.id, 'en-US');
}

function authorityScore(row: FactRow) {
  if (row.kind === AssistantSourceFactKind.PROMOTION) {
    return (row.sourceType === AssistantKnowledgeSourceType.BANK_PROMOTION
      || row.sourceType === AssistantKnowledgeSourceType.DEVELOPER_PROMOTION ? 4_000 : 3_000)
      + row.sourcePriority;
  }
  if (row.kind === AssistantSourceFactKind.STATIC_DESCRIPTION
    || row.kind === AssistantSourceFactKind.ARCHITECTURE
    || row.kind === AssistantSourceFactKind.INFRASTRUCTURE) {
    return (row.sourceType === AssistantKnowledgeSourceType.DEVELOPMENT_PAGE ? 4_000 : 2_000)
      + row.sourcePriority;
  }
  return (row.sourceType === AssistantKnowledgeSourceType.DEVELOPMENT_PAGE ? 3_000 : 1_000)
    + row.sourcePriority;
}

function lexicalScore(query: string, row: FactRow) {
  const queryTokens = significantTokens(query);
  const haystack = normalizeQuery(`${row.label} ${row.searchText} ${row.projectKey ?? ''} ${row.developerKey ?? ''}`);
  return queryTokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function significantTokens(value: string) {
  return [...new Set(normalizeQuery(value).split(' ').filter((token) => token.length >= 3 && !stopWords.has(token)))];
}

const stopWords = new Set(['для', 'про', 'что', 'как', 'где', 'когда', 'мне', 'есть', 'это', 'или', 'под', 'над']);

function shouldIncludeStructuredExternalLot(row: FactRow, includeExternalLots: boolean) {
  return includeExternalLots && row.kind === AssistantSourceFactKind.EXTERNAL_LOT;
}

function deduplicateCanonicalFacts() {
  const seen = new Set<string>();
  return ({ row }: { row: FactRow }) => {
    const key = row.kind === AssistantSourceFactKind.EXTERNAL_LOT
      ? `${row.kind}:${row.canonicalUrl}`
      : `${row.kind}:${row.projectKey ?? row.developerKey ?? row.sourceId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}

function createCacheKey(query: string, intent: AssistantStructuredIntent, includeExternalLots: boolean) {
  return JSON.stringify({
    query,
    taskType: intent.taskType,
    hardFilters: intent.hardFilters,
    requiredFacts: intent.requiredFacts,
    includeExternalLots,
  });
}

function copyEvidence(evidence: AssistantKnowledgeEvidence): AssistantKnowledgeEvidence {
  return {
    ...evidence,
    value: structuredClone(evidence.value),
    retrievalChannels: [...evidence.retrievalChannels],
  };
}

function normalizeQuery(value: string) {
  return value.toLocaleLowerCase('ru-RU')
    .replace(/ё/gu, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 1_000);
}

function formatVector(vector: number[]) {
  if (vector.length === 0 || vector.some((item) => !Number.isFinite(item))) return '[]';
  return `[${vector.join(',')}]`;
}

function readCacheTtl(value: string | undefined) {
  if (value === undefined || value.trim() === '') return maximumRetrievalCacheMilliseconds;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximumRetrievalCacheMilliseconds)
    : maximumRetrievalCacheMilliseconds;
}
