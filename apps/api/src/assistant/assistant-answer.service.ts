import { Injectable } from '@nestjs/common';
import type {
  AssistantAnswer,
  AssistantGeoConstraint,
  AssistantGeoSearchContext,
  AssistantGeoSearchSelection,
  AssistantGeoView,
  AssistantPageContext,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

import {
  AssistantQueryPlanner,
  extractAssistantExplicitHardFilters,
  type AssistantPlannerTelemetry,
  type AssistantStructuredIntent,
} from './assistant-query-planner';
import {
  buildAssistantSearchAnswer,
  validateAssistantSearchAnswer,
  type AssistantSearchEvidence,
} from './assistant-search-ranking';
import { AssistantSearchService } from './assistant-search.service';
import type { AssistantGeoSearchResult } from './assistant-search.service';
import { buildAssistantComparisonAnswer } from './assistant-comparison-answer';
import {
  buildAssistantObjectAnswer,
  validateAssistantObjectAnswer,
  type AssistantObjectEvidence,
} from './catalog/assistant-object-answer';
import { AssistantPlatformCatalogService } from './catalog/assistant-platform-catalog.service';
import {
  AssistantPlaceResolverService,
  stripAssistantGeoClauses,
} from './geo/assistant-place-resolver.service';
import { buildAssistantKnowledgeAnswer } from './sources/assistant-knowledge-answer';
import {
  AssistantKnowledgeRetrievalService,
  type AssistantKnowledgeEvidence,
} from './sources/assistant-knowledge-retrieval.service';
import { AssistantCurrentFactRefreshCoordinator } from './sources/assistant-current-fact-refresh.service';
import {
  createAssistantKnowledgePageContext,
  createAssistantKnowledgeQueryContext,
  extractAssistantKnowledgeProjectReferenceClause,
  hasExplicitAssistantKnowledgeProjectReference,
  requiresAssistantKnowledgeCurrentVerification,
} from './sources/assistant-knowledge-policy';

export type AssistantAnswerResult = {
  content: string;
  answer: AssistantAnswer;
  intent: AssistantStructuredIntent;
  evidence: Array<AssistantSearchEvidence | AssistantKnowledgeEvidence | AssistantObjectEvidence>;
  candidateEvidence: Array<AssistantSearchEvidence | AssistantKnowledgeEvidence | AssistantObjectEvidence>;
  telemetry: AssistantPlannerTelemetry[];
};

@Injectable()
export class AssistantAnswerService {
  constructor(
    private readonly planner: AssistantQueryPlanner,
    private readonly search: AssistantSearchService,
    private readonly knowledge?: AssistantKnowledgeRetrievalService,
    private readonly places?: AssistantPlaceResolverService,
    private readonly currentFactRefresh?: AssistantCurrentFactRefreshCoordinator,
    private readonly platformCatalog?: AssistantPlatformCatalogService,
  ) {}

  async answer(input: {
    messages: string[];
    context: AssistantPageContext | null;
    geo?: AssistantGeoSearchSelection | null;
    operationRunId?: string;
    executionId?: string;
    now?: Date;
    deadlineAt?: Date;
  }): Promise<AssistantAnswerResult> {
    const now = input.now ?? new Date();
    const plannerMessages = input.messages.map((message) => stripAssistantGeoClauses(message));
    const districtResolution = await this.resolveDistrict(plannerMessages, input.geo ?? null);
    const planned = await this.planner.planWithValidation(
      {
        messages: plannerMessages,
        context: input.geo || districtResolution
          ? {
              pageContext: input.context,
              ...(districtResolution ? { districtResolution } : {}),
              ...(input.geo ? { geo: createPlannerGeoSummary(input.geo) } : {}),
            }
          : input.context,
        operationRunId: input.operationRunId,
        executionId: input.executionId,
      },
      async (intent, request, attempts) => {
        if (intent.taskType === 'LEGAL_TAX') {
          return {
            content: [
              'Я могу помочь найти и сравнить объекты по подтверждённым данным Platforma,',
              'но ответ по налогам или правовым условиям не заменяет консультацию профильного специалиста.',
            ].join(' '),
            answer: { kind: 'SAFE_BOUNDARY' } as const,
            evidence: [] as AssistantSearchEvidence[],
            candidateEvidence: [] as AssistantSearchEvidence[],
          };
        }
        if (intent.needsClarification) {
          return {
            content: intent.clarificationQuestion!,
            answer: { kind: 'CLARIFICATION' } as const,
            evidence: [] as AssistantSearchEvidence[],
            candidateEvidence: [] as AssistantSearchEvidence[],
          };
        }

        const query = createAssistantKnowledgeQueryContext(plannerMessages, input.context);
        let knowledgeContext = createAssistantKnowledgePageContext(plannerMessages, input.context);
        if (intent.taskType === 'OBJECT') {
          if (!this.platformCatalog) throw new Error('ASSISTANT_PLATFORM_CATALOG_UNAVAILABLE');
          const result = await this.platformCatalog.ground({
            query,
            intent,
            context: input.context,
          });
          const grounded = buildAssistantObjectAnswer(result.evidence, result.totalObjects, query);
          validateAssistantObjectAnswer(grounded, result.evidence, result.totalObjects, query);
          const { content, ...answer } = grounded;
          const selectedIds = new Set([
            ...answer.objects.map(({ objectId }) => objectId),
            ...answer.additionalObjects.map(({ objectId }) => objectId),
          ]);
          return {
            content,
            answer,
            evidence: result.evidence.filter(({ objectId }) => selectedIds.has(objectId)),
            candidateEvidence: result.evidence,
          };
        }
        if (intent.taskType === 'FACT' && this.knowledge) {
          const currentVerificationRequested = requiresAssistantKnowledgeCurrentVerification(query);
          const projectReferenceClause = extractAssistantKnowledgeProjectReferenceClause(query);
          if (projectReferenceClause) {
            const canResolveProject = typeof this.knowledge.resolveProjectContext === 'function';
            const resolvedProjectContext = await this.knowledge.resolveProjectContext?.(query);
            if (resolvedProjectContext === null
              || (canResolveProject
                && resolvedProjectContext === undefined
                && hasExplicitAssistantKnowledgeProjectReference(query))) {
              return sourceNotConnectedResult([]);
            }
            if (resolvedProjectContext) {
              knowledgeContext = resolvedProjectContext;
            } else if (input.context?.kind === 'OBJECT') {
              knowledgeContext = input.context;
            } else {
              return knowledgeScopeRequiredResult([]);
            }
          } else {
            knowledgeContext = input.context;
          }
          if (currentVerificationRequested
            && knowledgeContext?.kind !== 'OBJECT'
            && knowledgeContext?.kind !== 'DEVELOPER') {
            return knowledgeScopeRequiredResult([]);
          }
          const evidence = await this.knowledge.retrieve({
            query,
            intent,
            includeExternalLots: false,
            context: knowledgeContext,
            now,
            embeddingOperation: {
              operationRunId: request.operationRunId,
              executionId: request.executionId,
              nextAttemptOrdinal: attempts.nextAttemptOrdinal,
            },
          });
          const grounded = buildAssistantKnowledgeAnswer(evidence, now, query);
          const refreshRequired = currentVerificationRequested
            || grounded.evidence.some((item) => isStaleKnowledgeEvidence(item, now));
          if (refreshRequired) {
            if (!this.currentFactRefresh || !request.operationRunId) {
              return currentVerificationFailure(evidence);
            }
            const refresh = await this.currentFactRefresh.refreshForRun({
              operationRunId: request.operationRunId,
              context: knowledgeContext,
              preferredSourceId: grounded.evidence[0]?.sourceId ?? null,
              deadlineAt: input.deadlineAt ?? new Date(now.getTime() + 15_000),
            });
            if (refresh.status === 'SOURCE_NOT_CONNECTED') {
              return sourceNotConnectedResult(evidence);
            }
            if (refresh.status !== 'COMPLETED') return currentVerificationFailure(evidence);
            const refreshedEvidence = await this.knowledge.retrieve({
              query,
              intent,
              includeExternalLots: false,
              context: knowledgeContext,
              now,
              embeddingOperation: {
                operationRunId: request.operationRunId,
                executionId: request.executionId,
                nextAttemptOrdinal: attempts.nextAttemptOrdinal,
              },
            });
            const refreshedGrounded = buildAssistantKnowledgeAnswer(refreshedEvidence, now, query);
            if (refreshedGrounded.answer.facts.length > 0
              && !refreshedGrounded.evidence.some((item) => isStaleKnowledgeEvidence(item, now))) {
              return { ...refreshedGrounded, candidateEvidence: refreshedEvidence };
            }
            return currentVerificationFailure(refreshedEvidence);
          }
          if (grounded.answer.facts.length > 0) return { ...grounded, candidateEvidence: evidence };
          return {
            content: 'Не могу подтвердить ответ по доступным источникам.',
            answer: { kind: 'REFUSAL' } as const,
            evidence: [] as AssistantKnowledgeEvidence[],
            candidateEvidence: evidence,
          };
        }

        if (intent.taskType === 'COMPARE' && intent.comparisonTargets.length === 2) {
          const comparisonContext = input.context?.kind === 'CATALOG_FILTERS'
            ? input.context
            : null;
          const comparisonResults = await Promise.all(intent.comparisonTargets.map((target, index) => (
            this.search.search({
              ...intent,
              comparisonTargets: [target],
              comparisonTargetModes: [intent.comparisonTargetModes?.[index] ?? 'EXACT'],
            }, comparisonContext, input.geo ?? null)
          )));
          const grounded = buildAssistantComparisonAnswer(intent, comparisonResults.map((result, index) => ({
            target: intent.comparisonTargets[index]!,
            evidence: result.exact,
            totalExactResults: result.totalExactResults,
            summary: result.summary,
          })), now);
          const geoResult = comparisonResults.find(({ geo }) => geo !== null)?.geo ?? null;
          const geo = geoResult
            ? createGeoSearchView(
                geoResult,
                grounded.evidence,
                new Set(grounded.evidence.map(({ unitId }) => unitId)),
              )
            : null;
          return {
            ...grounded,
            answer: { ...grounded.answer, ...(geo ? { geo } : {}) },
            candidateEvidence: uniqueSearchEvidence(comparisonResults.flatMap(({ exact }) => exact)),
          };
        }

        const searchResult = await this.search.search(intent, input.context, input.geo ?? null);
        if (!input.geo && searchResult.exact.length === 0 && this.knowledge) {
          const knowledgeEvidence = await this.knowledge.retrieve({
            query,
            intent,
            includeExternalLots: true,
            context: knowledgeContext,
            now,
            embeddingOperation: {
              operationRunId: request.operationRunId,
              executionId: request.executionId,
              nextAttemptOrdinal: attempts.nextAttemptOrdinal,
            },
          });
          const knowledgeAnswer = buildAssistantKnowledgeAnswer(knowledgeEvidence, now, query);
          if (knowledgeAnswer.answer.externalLots.length > 0) {
            return { ...knowledgeAnswer, candidateEvidence: knowledgeEvidence };
          }
        }
        const evidence = [...searchResult.exact, ...searchResult.alternatives];
        const grounded = buildAssistantSearchAnswer(
          intent,
          searchResult.exact,
          searchResult.alternatives,
          now,
          searchResult.totalExactResults,
        );
        validateAssistantSearchAnswer(
          grounded,
          evidence,
          intent,
          now,
          searchResult.totalExactResults,
        );
        if (grounded.exactResults.length === 0
          && grounded.alternatives.length === 0
          && !searchResult.geo) {
          return {
            content: grounded.content,
            answer: { kind: 'REFUSAL' } as const,
            evidence: [] as AssistantSearchEvidence[],
            candidateEvidence: evidence,
          };
        }
        const selectedIds = new Set([
          ...grounded.exactResults.map(({ unitId }) => unitId),
          ...grounded.additionalExactResults.map(({ unitId }) => unitId),
          ...grounded.alternatives.map(({ unitId }) => unitId),
        ]);
        const selectedEvidence = evidence.filter(({ unitId }) => selectedIds.has(unitId));
        const geoVisibleIds = new Set([
          ...grounded.exactResults.map(({ unitId }) => unitId),
          ...grounded.alternatives.map(({ unitId }) => unitId),
        ]);
        const geo = searchResult.geo
          ? createGeoSearchView(
              searchResult.geo,
              evidence.filter(({ unitId }) => geoVisibleIds.has(unitId)),
              new Set(grounded.exactResults.map(({ unitId }) => unitId)),
            )
          : null;
        return {
          content: grounded.content,
          answer: {
            kind: 'SEARCH_RESULTS',
            totalExactResults: grounded.totalExactResults,
            exactResults: grounded.exactResults,
            additionalExactResults: grounded.additionalExactResults,
            alternatives: grounded.alternatives,
            ...(geo ? { geo } : {}),
          } as const,
          evidence: selectedEvidence,
          candidateEvidence: evidence,
        };
      },
    );

    return {
      ...planned.value,
      intent: planned.intent,
      telemetry: planned.telemetry,
    };
  }

  private async resolveDistrict(messages: string[], geo: AssistantGeoSearchSelection | null) {
    const district = extractAssistantExplicitHardFilters(messages).district;
    if (!district || !this.places) return null;
    const administrativeDistrict = await this.places.findAdministrativeDistrict(district);
    if (administrativeDistrict) {
      return {
        input: district,
        canonicalName: administrativeDistrict.name,
        resolvedByGeo: false,
      };
    }
    const landmarks = geo ? geoConstraints(geo).filter((constraint) =>
      constraint.source === 'LANDMARK' && Boolean(constraint.landmarkId)) : [];
    for (const constraint of landmarks) {
      const resolvedByGeo = await this.places.matchesTrustedLandmark(constraint.landmarkId!, district);
      if (resolvedByGeo) return { input: district, canonicalName: null, resolvedByGeo: true };
    }
    return null;
  }
}

function isStaleKnowledgeEvidence(evidence: AssistantKnowledgeEvidence, now: Date) {
  const verifiedAt = Date.parse(evidence.verifiedAt);
  return !Number.isFinite(verifiedAt) || now.getTime() - verifiedAt >= 24 * 60 * 60 * 1_000;
}

function currentVerificationFailure(candidateEvidence: AssistantKnowledgeEvidence[]) {
  return {
    content: 'Не удалось подтвердить текущие условия по зарегистрированному источнику.',
    answer: { kind: 'REFUSAL' } as const,
    evidence: [] as AssistantKnowledgeEvidence[],
    candidateEvidence,
  };
}

function sourceNotConnectedResult(candidateEvidence: AssistantKnowledgeEvidence[]) {
  return {
    content: 'Для этого объекта не найден доверенный зарегистрированный источник.',
    answer: { kind: 'REFUSAL', code: 'SOURCE_NOT_CONNECTED' } as const,
    evidence: [] as AssistantKnowledgeEvidence[],
    candidateEvidence,
  };
}

function knowledgeScopeRequiredResult(candidateEvidence: AssistantKnowledgeEvidence[]) {
  return {
    content: 'Нужно указать ЖК или открыть страницу объекта, чтобы подтвердить ответ.',
    answer: { kind: 'REFUSAL' } as const,
    evidence: [] as AssistantKnowledgeEvidence[],
    candidateEvidence,
  };
}

function uniqueSearchEvidence(evidence: AssistantSearchEvidence[]) {
  return [...new Map(evidence.map((item) => [item.unitId, item])).values()];
}

function createGeoSearchView(
  geo: AssistantGeoSearchResult,
  evidence: AssistantSearchEvidence[],
  primaryIds: Set<string>,
): AssistantGeoView {
  let primaryCount = 0;
  let alternativeCount = 0;
  const isComposite = 'operator' in geo;
  return {
    ...geo,
    markers: evidence.flatMap((candidate) => {
      if (typeof candidate.latitude !== 'number' || typeof candidate.longitude !== 'number') return [];
      if (!isComposite && geo.mode === 'NEAR' && typeof candidate.distanceMeters !== 'number') return [];
      const kind = primaryIds.has(candidate.unitId) ? 'PRIMARY' as const : 'ALTERNATIVE' as const;
      if (kind === 'PRIMARY' && primaryCount >= 3) return [];
      if (kind === 'ALTERNATIVE' && alternativeCount >= 2) return [];
      if (kind === 'PRIMARY') primaryCount += 1;
      else alternativeCount += 1;
      return [{
        unitId: candidate.unitId,
        latitude: candidate.latitude,
        longitude: candidate.longitude,
        ...(!isComposite && typeof candidate.distanceMeters === 'number'
          ? { distanceMeters: candidate.distanceMeters }
          : {}),
        kind,
      }];
    }),
  } as AssistantGeoView;
}

function geoConstraints(geo: AssistantGeoSearchSelection): AssistantGeoConstraint[] {
  return 'operator' in geo ? geo.constraints : [geo];
}

function createPlannerGeoSummary(geo: AssistantGeoSearchSelection) {
  const summarize = (constraint: AssistantGeoSearchContext) => ({
    kind: constraint.kind,
    mode: constraint.mode,
    label: constraint.label,
    source: constraint.source,
    ...(constraint.source === 'LANDMARK' ? { landmarkId: constraint.landmarkId } : {}),
    ...(constraint.mode === 'NEAR' ? { distanceMeters: constraint.distanceMeters } : {}),
  });
  return 'operator' in geo
    ? { hasGeoConstraint: true, operator: 'ALL' as const, constraints: geo.constraints.map(summarize) }
    : { hasGeoConstraint: true, ...summarize(geo) };
}
