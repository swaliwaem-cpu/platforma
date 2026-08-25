import { Injectable } from '@nestjs/common';
import type {
  AssistantAnswer,
  AssistantGeoSearchContext,
  AssistantGeoSearchView,
  AssistantPageContext,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

import {
  AssistantQueryPlanner,
  type AssistantPlannerTelemetry,
  type AssistantStructuredIntent,
} from './assistant-query-planner';
import {
  buildAssistantSearchAnswer,
  validateAssistantSearchAnswer,
  type AssistantSearchEvidence,
} from './assistant-search-ranking';
import { AssistantSearchService } from './assistant-search.service';
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
  telemetry: AssistantPlannerTelemetry[];
};

@Injectable()
export class AssistantAnswerService {
  constructor(
    private readonly planner: AssistantQueryPlanner,
    private readonly search: AssistantSearchService,
    private readonly knowledge?: AssistantKnowledgeRetrievalService,
  ) {}

  async answer(input: {
    messages: string[];
    context: AssistantPageContext | null;
    geo?: AssistantGeoSearchContext | null;
    now?: Date;
  }): Promise<AssistantAnswerResult> {
    const now = input.now ?? new Date();
    const planned = await this.planner.planWithValidation(
      {
        messages: input.messages,
        context: input.geo
          ? { pageContext: input.context, geo: input.geo }
          : input.context,
      },
      async (intent) => {
        if (intent.taskType === 'LEGAL_TAX') {
          return {
            content: [
              'Я могу помочь найти и сравнить объекты по подтверждённым данным Platforma,',
              'но ответ по налогам или правовым условиям не заменяет консультацию профильного специалиста.',
            ].join(' '),
            answer: { kind: 'SAFE_BOUNDARY' } as const,
            evidence: [] as AssistantSearchEvidence[],
          };
        }
        if (intent.needsClarification) {
          return {
            content: intent.clarificationQuestion!,
            answer: { kind: 'CLARIFICATION' } as const,
            evidence: [] as AssistantSearchEvidence[],
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
          });
          const grounded = buildAssistantKnowledgeAnswer(evidence, now);
          if (grounded.answer.facts.length > 0) return grounded;
          return {
            content: 'Не могу подтвердить ответ по доступным источникам.',
            answer: { kind: 'REFUSAL' } as const,
            evidence: [] as AssistantKnowledgeEvidence[],
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
          });
          const knowledgeAnswer = buildAssistantKnowledgeAnswer(knowledgeEvidence, now);
          if (knowledgeAnswer.answer.externalLots.length > 0) return knowledgeAnswer;
        }
        const evidence = [...searchResult.exact, ...searchResult.alternatives];
        const grounded = buildAssistantSearchAnswer(
          intent,
          searchResult.exact,
          searchResult.alternatives,
          now,
        );
        validateAssistantSearchAnswer(grounded, evidence, intent, now);
        if (grounded.exactResults.length === 0
          && grounded.alternatives.length === 0
          && !searchResult.geo) {
          return {
            content: grounded.content,
            answer: { kind: 'REFUSAL' } as const,
            evidence: [] as AssistantSearchEvidence[],
          };
        }
        const selectedIds = new Set([
          ...grounded.exactResults.map(({ unitId }) => unitId),
          ...grounded.alternatives.map(({ unitId }) => unitId),
        ]);
        const selectedEvidence = evidence.filter(({ unitId }) => selectedIds.has(unitId));
        const geo = searchResult.geo
          ? createGeoSearchView(
              searchResult.geo,
              selectedEvidence,
              new Set(grounded.exactResults.map(({ unitId }) => unitId)),
            )
          : null;
        return {
          content: grounded.content,
          answer: {
            kind: 'SEARCH_RESULTS',
            exactResults: grounded.exactResults,
            alternatives: grounded.alternatives,
            ...(geo ? { geo } : {}),
          } as const,
          evidence: selectedEvidence,
        };
      },
    );

    return {
      ...planned.value,
      intent: planned.intent,
      telemetry: planned.telemetry,
    };
  }
}

function createGeoSearchView(
  geo: Omit<AssistantGeoSearchView, 'markers'>,
  evidence: AssistantSearchEvidence[],
  primaryIds: Set<string>,
): AssistantGeoSearchView {
  let primaryCount = 0;
  let alternativeCount = 0;
  return {
    ...geo,
    markers: evidence.flatMap((candidate) => {
      if (typeof candidate.latitude !== 'number'
        || typeof candidate.longitude !== 'number'
        || typeof candidate.distanceMeters !== 'number') return [];
      const kind = primaryIds.has(candidate.unitId) ? 'PRIMARY' as const : 'ALTERNATIVE' as const;
      if (kind === 'PRIMARY' && primaryCount >= 3) return [];
      if (kind === 'ALTERNATIVE' && alternativeCount >= 2) return [];
      if (kind === 'PRIMARY') primaryCount += 1;
      else alternativeCount += 1;
      return [{
        unitId: candidate.unitId,
        latitude: candidate.latitude,
        longitude: candidate.longitude,
        distanceMeters: candidate.distanceMeters,
        kind,
      }];
    }),
  };
}
