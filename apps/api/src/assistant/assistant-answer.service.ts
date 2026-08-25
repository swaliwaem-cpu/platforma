import { Injectable } from '@nestjs/common';
import type {
  AssistantAnswer,
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
    now?: Date;
  }): Promise<AssistantAnswerResult> {
    const now = input.now ?? new Date();
    const planned = await this.planner.planWithValidation(
      { messages: input.messages, context: input.context },
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

        const searchResult = await this.search.search(intent, input.context);
        if (searchResult.exact.length === 0 && this.knowledge) {
          const knowledgeEvidence = await this.knowledge.retrieve({
            query,
            intent,
            includeExternalLots: true,
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
        if (grounded.exactResults.length === 0 && grounded.alternatives.length === 0) {
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
        return {
          content: grounded.content,
          answer: {
            kind: 'SEARCH_RESULTS',
            exactResults: grounded.exactResults,
            alternatives: grounded.alternatives,
          } as const,
          evidence: evidence.filter(({ unitId }) => selectedIds.has(unitId)),
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
