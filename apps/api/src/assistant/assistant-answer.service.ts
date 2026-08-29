import { Injectable } from '@nestjs/common';
import type {
  AssistantAnswer,
  AssistantGeoSearchContext,
  AssistantGeoSearchView,
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
import { AssistantPlaceResolverService } from './geo/assistant-place-resolver.service';
import { buildAssistantKnowledgeAnswer } from './sources/assistant-knowledge-answer';
import {
  AssistantKnowledgeRetrievalService,
  type AssistantKnowledgeEvidence,
} from './sources/assistant-knowledge-retrieval.service';

export type AssistantAnswerResult = {
  content: string;
  answer: AssistantAnswer;
  intent: AssistantStructuredIntent;
  evidence: Array<AssistantSearchEvidence | AssistantKnowledgeEvidence>;
  candidateEvidence: Array<AssistantSearchEvidence | AssistantKnowledgeEvidence>;
  telemetry: AssistantPlannerTelemetry[];
};

@Injectable()
export class AssistantAnswerService {
  constructor(
    private readonly planner: AssistantQueryPlanner,
    private readonly search: AssistantSearchService,
    private readonly knowledge?: AssistantKnowledgeRetrievalService,
    private readonly places?: AssistantPlaceResolverService,
  ) {}

  async answer(input: {
    messages: string[];
    context: AssistantPageContext | null;
    geo?: AssistantGeoSearchContext | null;
    operationRunId?: string;
    executionId?: string;
    now?: Date;
  }): Promise<AssistantAnswerResult> {
    const now = input.now ?? new Date();
    const districtResolution = await this.resolveDistrict(input.messages, input.geo ?? null);
    const planned = await this.planner.planWithValidation(
      {
        messages: input.messages,
        context: input.geo || districtResolution
          ? {
              pageContext: input.context,
              ...(districtResolution ? { districtResolution } : {}),
              ...(input.geo ? {
                geo: {
                  hasGeoConstraint: true,
                  kind: input.geo.kind,
                  mode: input.geo.mode,
                  label: input.geo.label,
                  source: input.geo.source,
                  ...(input.geo.source === 'LANDMARK' ? { landmarkId: input.geo.landmarkId } : {}),
                  ...(input.geo.mode === 'NEAR' ? { distanceMeters: input.geo.distanceMeters } : {}),
                },
              } : {}),
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

        const query = input.messages[input.messages.length - 1] ?? '';
        if (intent.taskType === 'FACT' && this.knowledge) {
          const evidence = await this.knowledge.retrieve({
            query,
            intent,
            includeExternalLots: false,
            context: input.context,
            now,
            embeddingOperation: {
              operationRunId: request.operationRunId,
              executionId: request.executionId,
              nextAttemptOrdinal: attempts.nextAttemptOrdinal,
            },
          });
          const grounded = buildAssistantKnowledgeAnswer(evidence, now);
          if (grounded.answer.facts.length > 0) return { ...grounded, candidateEvidence: evidence };
          return {
            content: 'Не могу подтвердить ответ по доступным источникам.',
            answer: { kind: 'REFUSAL' } as const,
            evidence: [] as AssistantKnowledgeEvidence[],
            candidateEvidence: evidence,
          };
        }

        const searchResult = await this.search.search(intent, input.context, input.geo ?? null);
        if (!input.geo && searchResult.exact.length === 0 && this.knowledge) {
          const knowledgeEvidence = await this.knowledge.retrieve({
            query,
            intent,
            includeExternalLots: true,
            context: input.context,
            now,
            embeddingOperation: {
              operationRunId: request.operationRunId,
              executionId: request.executionId,
              nextAttemptOrdinal: attempts.nextAttemptOrdinal,
            },
          });
          const knowledgeAnswer = buildAssistantKnowledgeAnswer(knowledgeEvidence, now);
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

  private async resolveDistrict(messages: string[], geo: AssistantGeoSearchContext | null) {
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
    if (geo?.source !== 'LANDMARK' || !geo.landmarkId) return null;
    const resolvedByGeo = await this.places.matchesTrustedLandmark(geo.landmarkId, district);
    return resolvedByGeo ? { input: district, canonicalName: null, resolvedByGeo: true } : null;
  }
}

function createGeoSearchView(
  geo: AssistantGeoSearchResult,
  evidence: AssistantSearchEvidence[],
  primaryIds: Set<string>,
): AssistantGeoSearchView {
  let primaryCount = 0;
  let alternativeCount = 0;
  return {
    ...geo,
    markers: evidence.flatMap((candidate) => {
      if (typeof candidate.latitude !== 'number' || typeof candidate.longitude !== 'number') return [];
      if (geo.mode === 'NEAR' && typeof candidate.distanceMeters !== 'number') return [];
      const kind = primaryIds.has(candidate.unitId) ? 'PRIMARY' as const : 'ALTERNATIVE' as const;
      if (kind === 'PRIMARY' && primaryCount >= 3) return [];
      if (kind === 'ALTERNATIVE' && alternativeCount >= 2) return [];
      if (kind === 'PRIMARY') primaryCount += 1;
      else alternativeCount += 1;
      return [{
        unitId: candidate.unitId,
        latitude: candidate.latitude,
        longitude: candidate.longitude,
        ...(typeof candidate.distanceMeters === 'number' ? { distanceMeters: candidate.distanceMeters } : {}),
        kind,
      }];
    }),
  };
}
