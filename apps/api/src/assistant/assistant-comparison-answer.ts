import type {
  AssistantAnswer,
  AssistantComparisonGroup,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

import type { AssistantStructuredIntent } from './assistant-query-planner';
import {
  AssistantAnswerValidationError,
  buildAssistantSearchAnswer,
  type AssistantSearchEvidence,
} from './assistant-search-ranking';

export type AssistantComparisonSearchGroup = {
  target: string;
  evidence: AssistantSearchEvidence[];
  totalExactResults: number;
  summary?: AssistantComparisonGroup['summary'];
};

export const assistantComparisonSummaryItemLimit = 20;
const assistantComparisonCardLimit = 8;

export function parseAssistantComparisonSummary(
  value: unknown,
  status: AssistantComparisonGroup['status'],
): AssistantComparisonGroup['summary'] | null {
  if (!isRecord(value)
    || !isBoundedSummaryList(value.completion, 80)
    || !isBoundedSummaryList(value.metros, 160)) return null;
  const minimumPriceRub = value.minimumPriceRub;
  if (status === 'NO_MATCH') {
    return minimumPriceRub === null && value.completion.length === 0 && value.metros.length === 0
      ? { minimumPriceRub: null, completion: [], metros: [] }
      : null;
  }
  if (typeof minimumPriceRub !== 'number'
    || !Number.isFinite(minimumPriceRub)
    || minimumPriceRub <= 0) return null;
  return {
    minimumPriceRub,
    completion: [...value.completion],
    metros: [...value.metros],
  };
}

export function buildAssistantComparisonAnswer(
  intent: AssistantStructuredIntent,
  rawGroups: AssistantComparisonSearchGroup[],
  now = new Date(),
): {
  content: string;
  answer: Extract<AssistantAnswer, { kind: 'COMPARISON_RESULTS' }>;
  evidence: AssistantSearchEvidence[];
} {
  if (intent.taskType !== 'COMPARE' || intent.comparisonTargets.length !== 2 || rawGroups.length !== 2) {
    throw new AssistantAnswerValidationError('ASSISTANT_COMPARISON_GROUPS_INVALID');
  }
  rawGroups.forEach((group, index) => validateSearchGroup(group, intent.comparisonTargets[index]!));
  const allocatedGroups = allocateDistinctEvidence(rawGroups);
  const groups = allocatedGroups.map((group, index) => buildGroup(
    intent,
    group,
    intent.comparisonTargets[index]!,
    now,
  )) as [AssistantComparisonGroup, AssistantComparisonGroup];
  const selectedIds = new Set(groups.flatMap((group) => [
    ...group.exactResults.map(({ unitId }) => unitId),
    ...group.additionalExactResults.map(({ unitId }) => unitId),
  ]));
  const evidence = allocatedGroups
    .flatMap((group) => group.evidence)
    .filter(({ unitId }, index, items) => selectedIds.has(unitId)
      && items.findIndex((candidate) => candidate.unitId === unitId) === index);
  return {
    content: groups.some(({ status }) => status === 'MATCHED')
      ? 'Сравнил подтверждённые предложения отдельно по каждому выбранному ЖК.'
      : 'По каждому выбранному ЖК показываю отдельный результат: подтверждённых предложений нет.',
    answer: { kind: 'COMPARISON_RESULTS', groups },
    evidence,
  };
}

function buildGroup(
  intent: AssistantStructuredIntent,
  group: AssistantComparisonSearchGroup,
  expectedTarget: string,
  now: Date,
): AssistantComparisonGroup {
  validateSearchGroup(group, expectedTarget);
  if (group.totalExactResults === 0) {
    return {
      target: expectedTarget,
      status: 'NO_MATCH',
      totalExactResults: 0,
      exactResults: [],
      additionalExactResults: [],
      summary: { minimumPriceRub: null, completion: [], metros: [] },
    };
  }
  const normalizedIntent: AssistantStructuredIntent = {
    ...intent,
    taskType: 'SEARCH',
    comparisonTargets: [],
    comparisonTargetModes: [],
  };
  const built = buildAssistantSearchAnswer(normalizedIntent, group.evidence, [], now);
  const cards = [...built.exactResults, ...built.additionalExactResults];
  if (cards.length === 0) {
    throw new AssistantAnswerValidationError('ASSISTANT_COMPARISON_EVIDENCE_INVALID');
  }
  const selectedIds = new Set(cards.map(({ unitId }) => unitId));
  const selectedEvidence = group.evidence.filter(({ unitId }) => selectedIds.has(unitId));
  const summary = group.summary
    ? validateSummary(group.summary)
    : createSummary(selectedEvidence);
  if (summary.minimumPriceRub === null
    || summary.minimumPriceRub > Math.min(...cards.map(({ priceRub }) => priceRub))) {
    throw new AssistantAnswerValidationError('ASSISTANT_COMPARISON_SUMMARY_INVALID');
  }
  return {
    target: expectedTarget,
    status: 'MATCHED',
    totalExactResults: group.totalExactResults,
    exactResults: built.exactResults,
    additionalExactResults: built.additionalExactResults,
    summary,
  };
}

function validateSearchGroup(
  group: AssistantComparisonSearchGroup,
  expectedTarget: string,
) {
  if (group.target !== expectedTarget
    || !Number.isSafeInteger(group.totalExactResults)
    || group.totalExactResults < 0
    || group.totalExactResults < group.evidence.length
    || (group.totalExactResults === 0) !== (group.evidence.length === 0)) {
    throw new AssistantAnswerValidationError('ASSISTANT_COMPARISON_GROUP_INVALID');
  }
}

function allocateDistinctEvidence(
  rawGroups: AssistantComparisonSearchGroup[],
): [AssistantComparisonSearchGroup, AssistantComparisonSearchGroup] {
  const uniqueEvidence = rawGroups.map((group) => uniqueEvidenceByUnitId(group.evidence));
  if (rawGroups.some(({ totalExactResults }) => totalExactResults === 0)) {
    return rawGroups.map((group, index) => ({
      ...group,
      evidence: uniqueEvidence[index]!,
    })) as [AssistantComparisonSearchGroup, AssistantComparisonSearchGroup];
  }

  let reservedPair: [AssistantSearchEvidence, AssistantSearchEvidence] | null = null;
  for (const first of uniqueEvidence[0]!) {
    const second = uniqueEvidence[1]!.find(({ unitId }) => unitId !== first.unitId);
    if (!second) continue;
    reservedPair = [first, second];
    break;
  }
  if (!reservedPair) {
    throw new AssistantAnswerValidationError('ASSISTANT_COMPARISON_EVIDENCE_INVALID');
  }

  const assignedIds = [
    new Set([reservedPair[0].unitId]),
    new Set([reservedPair[1].unitId]),
  ];
  const usedIds = new Set(reservedPair.map(({ unitId }) => unitId));
  const maximumLength = Math.max(uniqueEvidence[0]!.length, uniqueEvidence[1]!.length);
  for (let rank = 0; rank < maximumLength; rank += 1) {
    for (const groupIndex of [0, 1] as const) {
      if (assignedIds[groupIndex]!.size >= assistantComparisonCardLimit) continue;
      const candidate = uniqueEvidence[groupIndex]![rank];
      if (!candidate || usedIds.has(candidate.unitId)) continue;
      assignedIds[groupIndex]!.add(candidate.unitId);
      usedIds.add(candidate.unitId);
    }
  }

  return rawGroups.map((group, index) => ({
    ...group,
    evidence: uniqueEvidence[index]!.filter(({ unitId }) => assignedIds[index]!.has(unitId)),
  })) as [AssistantComparisonSearchGroup, AssistantComparisonSearchGroup];
}

function uniqueEvidenceByUnitId(evidence: AssistantSearchEvidence[]) {
  const seen = new Set<string>();
  return evidence.filter(({ unitId }) => {
    if (seen.has(unitId)) return false;
    seen.add(unitId);
    return true;
  });
}

function createSummary(evidence: AssistantSearchEvidence[]) {
  return {
    minimumPriceRub: evidence.reduce<number | null>((minimum, item) => (
      minimum === null ? item.priceRub : Math.min(minimum, item.priceRub)
    ), null),
    completion: [...new Set(evidence.flatMap((item) => item.completionYear === null
      ? []
      : [item.completionQuarter === null
          ? `${item.completionYear} год`
          : `${item.completionQuarter} кв. ${item.completionYear}`]))]
      .sort((left, right) => left.localeCompare(right, 'ru-RU'))
      .slice(0, assistantComparisonSummaryItemLimit),
    metros: [...new Set(evidence.flatMap(({ metros }) => metros))]
      .sort((left, right) => left.localeCompare(right, 'ru-RU'))
      .slice(0, assistantComparisonSummaryItemLimit),
  };
}

function validateSummary(summary: AssistantComparisonGroup['summary']) {
  const parsed = parseAssistantComparisonSummary(summary, 'MATCHED');
  if (!parsed) throw new AssistantAnswerValidationError('ASSISTANT_COMPARISON_SUMMARY_INVALID');
  return parsed;
}

function isBoundedSummaryList(value: unknown, maximumItemLength: number): value is string[] {
  return Array.isArray(value)
    && value.length <= assistantComparisonSummaryItemLimit
    && value.every((item) => typeof item === 'string'
      && item.trim().length > 0
      && item.length <= maximumItemLength)
    && new Set(value).size === value.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
