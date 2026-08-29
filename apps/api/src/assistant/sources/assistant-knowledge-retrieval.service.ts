import { Injectable } from '@nestjs/common';
import {
  AssistantKnowledgeSourceType,
  AssistantSourceFactKind,
  Prisma,
} from '@prisma/client';
import type { AssistantPageContext } from '@platforma/shared' with { 'resolution-mode': 'import' };

import { PrismaService } from '../../prisma/prisma.service';
import type { AssistantStructuredIntent } from '../assistant-query-planner';
import { AssistantEmbeddingGateway } from './assistant-embedding.gateway';
import type { AssistantEmbeddingOperationContext } from './assistant-embedding.gateway';
import {
  assistantKnowledgeAuthorityTier,
  assistantKnowledgeMatchesPromotionTopic,
  assistantKnowledgePromotionTopic,
  extractAssistantKnowledgeProjectReferenceClause,
  hasExplicitAssistantKnowledgeProjectReference,
  isDelimitedAssistantKnowledgeProjectReference,
  normalizeAssistantKnowledgeRegistryKey,
  requiresAssistantKnowledgeCurrentVerification,
  resolveAssistantKnowledgeProjectIdentity,
} from './assistant-knowledge-policy';

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
  verifiedAt: Date;
  sourceUrl: string;
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
  sourceLabel: string;
  sourceUrl: string;
  observedAt: string;
  fetchedAt: string;
  verifiedAt: string;
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

type KnowledgeScope = {
  projectKey: string | null;
  developerKey: string | null;
};

type ProjectIdentityRow = {
  projectKey: string;
  objectTitle: string;
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

  async resolveProjectContext(query: string): Promise<AssistantPageContext | null | undefined> {
    const projectReference = extractAssistantKnowledgeProjectReferenceClause(query);
    if (!projectReference) return undefined;
    if (!hasExplicitAssistantKnowledgeProjectReference(query)) return undefined;
    const normalizedTitle = Prisma.sql`
      TRIM(REGEXP_REPLACE(
        REGEXP_REPLACE(
          REPLACE(LOWER(o."title"), 'ё', 'е'),
          '^[[:space:]]*(жк|жилой[[:space:]]+комплекс)[[:space:]]+',
          ''
        ),
        '[^[:alnum:]]+',
        ' ',
        'g'
      ))
    `;
    const normalizedProjectKey = Prisma.sql`
      TRIM(REGEXP_REPLACE(
        REPLACE(LOWER(o."slug"), 'ё', 'е'),
        '[^[:alnum:]]+',
        ' ',
        'g'
      ))
    `;
    const rows = await this.prisma.$queryRaw<ProjectIdentityRow[]>(Prisma.sql`
      SELECT DISTINCT
        o."slug" AS "projectKey",
        o."title" AS "objectTitle"
      FROM "real_estate_objects" o
      WHERE o."status" = 'published'::object_status
        AND o."type" = 'residential'::real_estate_object_type
        AND o."deleted_at" IS NULL
        AND o."archived_at" IS NULL
        AND (
          ${normalizedTitle} = ${projectReference}
          OR ${projectReference} LIKE (${normalizedTitle} || ' %')
          OR ${normalizedProjectKey} = ${projectReference}
          OR ${projectReference} LIKE (${normalizedProjectKey} || ' %')
        )
      ORDER BY o."slug" ASC
    `);
    const identity = resolveAssistantKnowledgeProjectIdentity(projectReference, rows, {
      allowReferenceTail: !isDelimitedAssistantKnowledgeProjectReference(query),
      referenceQuery: query,
    });
    if (!identity) {
      return null;
    }
    const projectKey = normalizeAssistantKnowledgeRegistryKey(identity.projectKey);
    return projectKey
      ? { kind: 'OBJECT', key: projectKey, label: identity.objectTitle }
      : null;
  }

  async retrieve(input: {
    query: string;
    intent: AssistantStructuredIntent;
    includeExternalLots: boolean;
    context?: AssistantPageContext | null;
    now?: Date;
    embeddingOperation?: Omit<AssistantEmbeddingOperationContext, 'operation'>;
  }) {
    const now = input.now ?? new Date();
    const query = normalizeQuery(input.query);
    if (!query) return [];
    let scope = createKnowledgeScope(input.context);
    const projectReferenceClause = extractAssistantKnowledgeProjectReferenceClause(input.query);
    if (input.intent.taskType === 'FACT'
      && !projectReferenceClause
      && requiresAssistantKnowledgeCurrentVerification(input.query)
      && scope.projectKey === null
      && scope.developerKey === null) return [];
    if (input.intent.taskType === 'FACT' && projectReferenceClause) {
      const resolvedContext = await this.resolveProjectContext(input.query);
      if (resolvedContext === null) return [];
      if (resolvedContext === undefined && scope.projectKey === null) return [];
      if (resolvedContext) scope = createKnowledgeScope(resolvedContext);
    }
    const fingerprint = await this.readRevisionFingerprint();
    const cacheKey = createCacheKey(query, input.intent, input.includeExternalLots, scope);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now.getTime() && cached.revisionFingerprint === fingerprint) {
      return cached.evidence.map(copyEvidence);
    }

    const structured = await this.retrieveStructured(input.intent, input.includeExternalLots, scope);
    const ftsRevisions = await this.retrieveFtsRevisionScores(query, scope);
    const vectorRevisions = await this.retrieveVectorRevisionScores(
      query,
      scope,
      input.embeddingOperation,
    );
    const revisionIds = [...new Set([
      ...ftsRevisions.keys(),
      ...vectorRevisions.keys(),
    ])];
    const retrievedByText = revisionIds.length > 0
      ? await this.readFactsForRevisions(revisionIds)
      : [];
    const candidates = new Map<string, { row: FactRow; channels: Set<RetrievalChannel>; score: number }>();

    for (const row of structured) {
      candidates.set(row.id, {
        row,
        channels: new Set(['STRUCTURED_SQL']),
        score: lexicalScore(query, row) + externalLotScopeScore(row, input.intent, scope),
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

    let candidateValues = [...candidates.values()].filter(({ score }) => score > 0);
    const inferredProjectKey = input.intent.taskType === 'FACT' && !scope.developerKey
      ? scope.projectKey ?? (projectReferenceClause ? null : chooseMostRelevantProjectKey(candidateValues))
      : null;
    const inferredDeveloperKeys = new Set(candidateValues
      .filter(({ row }) => row.projectKey === inferredProjectKey && row.developerKey !== null)
      .map(({ row }) => row.developerKey!));
    candidateValues = candidateValues.filter(({ row }) => isRelevantCandidate(query, row));
    if (input.intent.taskType === 'FACT' && !scope.developerKey) {
      if (inferredProjectKey) {
        candidateValues = candidateValues.filter(({ row }) => row.projectKey === inferredProjectKey
          || (
            row.projectKey === null
            && row.developerKey !== null
            && row.kind === AssistantSourceFactKind.PROMOTION
            && (scope.projectKey !== null || inferredDeveloperKeys.has(row.developerKey))
          ));
      }
    }
    const evidence = candidateValues
      .sort(compareCandidates)
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
        sourceLabel: createSourceLabel(row.sourceType, row.sourceUrl),
        sourceUrl: row.sourceUrl,
        observedAt: row.observedAt.toISOString(),
        fetchedAt: row.fetchedAt.toISOString(),
        verifiedAt: row.verifiedAt.toISOString(),
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

  private retrieveStructured(
    intent: AssistantStructuredIntent,
    includeExternalLots: boolean,
    scope: KnowledgeScope,
  ) {
    const filters = intent.hardFilters;
    const answerKinds = Object.values(AssistantSourceFactKind)
      .filter((kind) => kind !== AssistantSourceFactKind.ADDRESS);
    const kinds = includeExternalLots
      ? answerKinds
      : answerKinds.filter((kind) => kind !== AssistantSourceFactKind.EXTERNAL_LOT);
    const conditions: Prisma.Sql[] = [
      Prisma.sql`f."is_active" = TRUE`,
      Prisma.sql`s."state" = 'active'::assistant_knowledge_source_state`,
      Prisma.sql`r."processing_status" = 'indexed'::assistant_source_revision_status`,
      Prisma.sql`f."kind" IN (${Prisma.join(kinds.map((kind) => Prisma.sql`${kind.toLocaleLowerCase('en-US')}::assistant_source_fact_kind`))})`,
      createKnowledgeScopeSql(scope),
    ];
    if (includeExternalLots) {
      if (filters.objectType === 'COMMERCIAL') {
        conditions.push(Prisma.sql`f."kind" <> 'external_lot'::assistant_source_fact_kind`);
      }
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
      if (filters.areaMin !== null) {
        conditions.push(Prisma.sql`(
          f."kind" <> 'external_lot'::assistant_source_fact_kind OR
          (f."value_json"->>'area')::numeric >= ${filters.areaMin}
        )`);
      }
      if (filters.areaMax !== null) {
        conditions.push(Prisma.sql`(
          f."kind" <> 'external_lot'::assistant_source_fact_kind OR
          (f."value_json"->>'area')::numeric <= ${filters.areaMax}
        )`);
      }
      if (filters.floorMin !== null) {
        conditions.push(Prisma.sql`(
          f."kind" <> 'external_lot'::assistant_source_fact_kind OR
          (f."value_json"->>'floor')::integer >= ${filters.floorMin}
        )`);
      }
      if (filters.floorMax !== null) {
        conditions.push(Prisma.sql`(
          f."kind" <> 'external_lot'::assistant_source_fact_kind OR
          (f."value_json"->>'floor')::integer <= ${filters.floorMax}
        )`);
      }
      if (filters.developer) {
        const developer = normalizeQuery(filters.developer).replace(/[-_.]+/gu, ' ');
        conditions.push(Prisma.sql`(
          f."kind" <> 'external_lot'::assistant_source_fact_kind OR
          regexp_replace(LOWER(COALESCE(s."developer_key", '')), '[-_.]+', ' ', 'g') LIKE ${`%${developer}%`}
        )`);
      }
      for (const location of [filters.district, filters.metro].filter((value): value is string => Boolean(value))) {
        conditions.push(Prisma.sql`(
          f."kind" <> 'external_lot'::assistant_source_fact_kind OR
          LOWER(f."search_text") LIKE ${`%${normalizeQuery(location)}%`}
        )`);
      }
      if (filters.completionYearMin !== null) {
        conditions.push(Prisma.sql`(
          f."kind" <> 'external_lot'::assistant_source_fact_kind OR
          (f."value_json"->>'completionYear')::integer >= ${filters.completionYearMin}
        )`);
      }
      if (filters.completionYearMax !== null) {
        conditions.push(Prisma.sql`(
          f."kind" <> 'external_lot'::assistant_source_fact_kind OR
          (f."value_json"->>'completionYear')::integer <= ${filters.completionYearMax}
        )`);
      }
      if (filters.completionQuarter !== null) {
        conditions.push(Prisma.sql`(
          f."kind" <> 'external_lot'::assistant_source_fact_kind OR
          (f."value_json"->>'completionQuarter')::integer = ${filters.completionQuarter}
        )`);
      }
      if (filters.propertyClass) {
        conditions.push(Prisma.sql`(
          f."kind" <> 'external_lot'::assistant_source_fact_kind OR
          LOWER(f."value_json"->>'propertyClass') = ${normalizeQuery(filters.propertyClass)}
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

  private async retrieveFtsRevisionScores(query: string, scope: KnowledgeScope) {
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
        AND ${createKnowledgeScopeSql(scope)}
        AND to_tsvector('russian', c."text") @@ to_tsquery('russian', ${tsQuery})
      GROUP BY c."source_revision_id"
      ORDER BY "score" DESC
      LIMIT 20
    `);
    return new Map(rows.map(({ sourceRevisionId, score }) => [sourceRevisionId, Number(score)]));
  }

  private async retrieveVectorRevisionScores(
    query: string,
    scope: KnowledgeScope,
    embeddingOperation?: Omit<AssistantEmbeddingOperationContext, 'operation'>,
  ) {
    if (!this.embeddings.isEnabled()) return new Map<string, number>();
    const model = this.embeddings.getModel();
    const dimensions = this.embeddings.getDimensions();
    if (!model || !dimensions) return new Map<string, number>();
    const embedded = await this.embeddings.embed(
      [query],
      embeddingOperation ? { operation: 'EMBEDDING_RETRIEVAL', ...embeddingOperation } : undefined,
    );
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
        AND c."embedding_dimensions" = ${dimensions}
        AND c."embedding" IS NOT NULL
        AND r."processing_status" = 'indexed'::assistant_source_revision_status
        AND ${createKnowledgeScopeSql(scope)}
      GROUP BY c."source_revision_id"
      ORDER BY "score" DESC
      LIMIT 20
    `);
    return new Map(rows.map(({ sourceRevisionId, score }) => [sourceRevisionId, Number(score)]));
  }

  private readFactsForRevisions(revisionIds: string[]) {
    return this.prisma.$queryRaw<FactRow[]>(Prisma.sql`
      ${factSelectSql}
      WHERE f."is_active" = TRUE
        AND s."state" = 'active'::assistant_knowledge_source_state
        AND r."processing_status" = 'indexed'::assistant_source_revision_status
        AND f."source_revision_id" IN (${Prisma.join(revisionIds.map((id) => Prisma.sql`${id}::uuid`))})
        AND f."kind" <> 'external_lot'::assistant_source_fact_kind
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
        COALESCE(MAX("assistant_source_revisions"."id"::text), ''),
        ':',
        COALESCE(MD5(STRING_AGG(DISTINCT CONCAT(
          "assistant_knowledge_sources"."id"::text,
          ':',
          "assistant_knowledge_sources"."state"::text,
          ':',
          "assistant_knowledge_sources"."priority"::text,
          ':',
          "assistant_knowledge_sources"."updated_at"::text
        ), '|' ORDER BY CONCAT(
          "assistant_knowledge_sources"."id"::text,
          ':',
          "assistant_knowledge_sources"."state"::text,
          ':',
          "assistant_knowledge_sources"."priority"::text,
          ':',
          "assistant_knowledge_sources"."updated_at"::text
        ))), '')
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
    r."fetched_at" AS "fetchedAt",
    COALESCE(s."last_success_at", r."fetched_at") AS "verifiedAt",
    CASE
      WHEN s."canonical_url" ~* '^https://' THEN s."canonical_url"
      ELSE f."canonical_url"
    END AS "sourceUrl"
  FROM "assistant_source_facts" f
  JOIN "assistant_knowledge_sources" s ON s."id" = f."source_id"
  JOIN "assistant_source_revisions" r ON r."id" = f."source_revision_id"
`;

function compareCandidates(
  left: { row: FactRow; score: number },
  right: { row: FactRow; score: number },
) {
  const relevance = right.score - left.score;
  if (relevance !== 0) return relevance;
  const authority = assistantKnowledgeAuthorityTier(right.row) - assistantKnowledgeAuthorityTier(left.row);
  if (authority !== 0) return authority;
  const sourcePriority = right.row.sourcePriority - left.row.sourcePriority;
  if (sourcePriority !== 0) return sourcePriority;
  const freshness = right.row.verifiedAt.getTime() - left.row.verifiedAt.getTime();
  if (freshness !== 0) return freshness;
  return left.row.id.localeCompare(right.row.id, 'en-US');
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

function externalLotScopeScore(
  row: FactRow,
  intent: AssistantStructuredIntent,
  scope: KnowledgeScope,
) {
  if (row.kind !== AssistantSourceFactKind.EXTERNAL_LOT) return 0;
  const filters = intent.hardFilters;
  return scope.projectKey || scope.developerKey
    || filters.budgetMinRub !== null || filters.budgetMaxRub !== null
    || filters.rooms.length > 0 || filters.areaMin !== null || filters.areaMax !== null
    || filters.floorMin !== null || filters.floorMax !== null || filters.developer
    || filters.district || filters.metro || filters.completionYearMin !== null
    || filters.completionYearMax !== null || filters.completionQuarter !== null
    || filters.propertyClass ? 1 : 0;
}

function chooseMostRelevantProjectKey(
  candidates: Array<{ row: FactRow; score: number }>,
) {
  return [...candidates]
    .filter(({ row }) => row.projectKey !== null)
    .sort((left, right) => right.score - left.score || compareCandidates(left, right))[0]
    ?.row.projectKey ?? null;
}

function isRelevantCandidate(query: string, row: FactRow) {
  const topic = assistantKnowledgePromotionTopic(query);
  if (!topic) return true;
  if (row.kind !== AssistantSourceFactKind.PROMOTION) return false;
  return assistantKnowledgeMatchesPromotionTopic(`${row.label} ${row.searchText}`, topic);
}

function createCacheKey(
  query: string,
  intent: AssistantStructuredIntent,
  includeExternalLots: boolean,
  scope: KnowledgeScope,
) {
  return JSON.stringify({
    query,
    taskType: intent.taskType,
    hardFilters: intent.hardFilters,
    requiredFacts: intent.requiredFacts,
    includeExternalLots,
    scope,
  });
}

function createKnowledgeScope(context: AssistantPageContext | null | undefined): KnowledgeScope {
  if (!context) return { projectKey: null, developerKey: null };
  if (context.kind === 'OBJECT') {
    return { projectKey: normalizeAssistantKnowledgeRegistryKey(context.key), developerKey: null };
  }
  if (context.kind === 'DEVELOPER') {
    return { projectKey: null, developerKey: normalizeAssistantKnowledgeRegistryKey(context.key) };
  }
  if (context.kind === 'CATALOG_FILTERS') {
    const developerKey = new URLSearchParams(context.key).get('developerId');
    return { projectKey: null, developerKey: normalizeAssistantKnowledgeRegistryKey(developerKey) };
  }
  return { projectKey: null, developerKey: null };
}

function createKnowledgeScopeSql(scope: KnowledgeScope) {
  const conditions: Prisma.Sql[] = [];
  if (scope.projectKey) conditions.push(Prisma.sql`(
    s."project_key" = ${scope.projectKey}
    OR (
      s."project_key" IS NULL
      AND (
        s."type" IN (
          'developer_promotion'::assistant_knowledge_source_type,
          'bank_promotion'::assistant_knowledge_source_type
        )
        AND s."developer_key" IN (
          SELECT project_source."developer_key"
          FROM "assistant_knowledge_sources" project_source
          WHERE project_source."project_key" = ${scope.projectKey}
            AND project_source."developer_key" IS NOT NULL
            AND project_source."type" = 'development_page'::assistant_knowledge_source_type
            AND project_source."state" = 'active'::assistant_knowledge_source_state
        )
      )
    )
  )`);
  if (scope.developerKey) conditions.push(Prisma.sql`s."developer_key" = ${scope.developerKey}`);
  return conditions.length > 0 ? Prisma.join(conditions, ' AND ') : Prisma.sql`TRUE`;
}

function copyEvidence(evidence: AssistantKnowledgeEvidence): AssistantKnowledgeEvidence {
  return {
    ...evidence,
    value: structuredClone(evidence.value),
    retrievalChannels: [...evidence.retrievalChannels],
  };
}

function createSourceLabel(sourceType: AssistantKnowledgeSourceType, sourceUrl: string) {
  const prefix = sourceType === AssistantKnowledgeSourceType.DEVELOPMENT_PAGE
    ? 'Официальный сайт проекта'
    : sourceType === AssistantKnowledgeSourceType.DEVELOPER_PROMOTION
      ? 'Официальный сайт застройщика'
      : sourceType === AssistantKnowledgeSourceType.BANK_PROMOTION
        ? 'Официальный сайт банка'
        : 'Зарегистрированный источник';
  return `${prefix} · ${new URL(sourceUrl).hostname.toLocaleLowerCase('ru-RU')}`;
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
