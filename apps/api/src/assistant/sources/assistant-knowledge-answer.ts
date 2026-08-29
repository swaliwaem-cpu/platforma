import { AssistantSourceFactKind } from '@prisma/client';
import type {
  AssistantAnswer,
  AssistantExternalLotCard,
  AssistantKnowledgeFactCard,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

import type { AssistantKnowledgeEvidence } from './assistant-knowledge-retrieval.service';
import {
  assistantKnowledgeAuthorityTier,
  assistantKnowledgePromotionFocusScore,
  assistantKnowledgeMatchesPromotionTopic,
  assistantKnowledgePromotionTopic,
  assistantKnowledgeSemanticConflictKey,
  isSafeOfficialHttpsUrl,
} from './assistant-knowledge-policy';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function buildAssistantKnowledgeAnswer(
  rawEvidence: AssistantKnowledgeEvidence[],
  now = new Date(),
  query = '',
): {
  content: string;
  answer: Extract<AssistantAnswer, { kind: 'KNOWLEDGE_RESULTS' }>;
  evidence: AssistantKnowledgeEvidence[];
} {
  const validEvidence = selectFocusedPromotionRepresentations(rawEvidence
    .filter(isValidEvidence)
    .filter((evidence) => isRelevantEvidence(query, evidence)));
  const factGroups = new Map<string, AssistantKnowledgeEvidence[]>();
  const externalEvidence: AssistantKnowledgeEvidence[] = [];
  for (const evidence of validEvidence) {
    if (evidence.kind === AssistantSourceFactKind.EXTERNAL_LOT) {
      externalEvidence.push(evidence);
      continue;
    }
    const key = assistantKnowledgeSemanticConflictKey(evidence);
    const group = factGroups.get(key) ?? [];
    group.push(evidence);
    factGroups.set(key, group);
  }
  const conflictGroups: AssistantKnowledgeEvidence[][] = [];
  const ranked = [
    ...[...factGroups.values()].map((group) => {
      const ordered = [...group].sort(compareConflictAuthority);
      if (hasConflictingValues(ordered)) conflictGroups.push(ordered);
      return ordered[0]!;
    }),
    ...externalEvidence,
  ].sort(compareEvidence);
  const selectedEvidence: AssistantKnowledgeEvidence[] = [];
  const facts: AssistantKnowledgeFactCard[] = [];
  const externalLots: AssistantExternalLotCard[] = [];
  const seenFacts = new Set<string>();
  const seenLots = new Set<string>();

  for (const evidence of ranked) {
    if (evidence.kind === AssistantSourceFactKind.EXTERNAL_LOT) {
      if (externalLots.length >= 3 || seenLots.has(evidence.canonicalUrl)) continue;
      const lot = parseExternalLot(evidence, now);
      if (!lot) continue;
      seenLots.add(evidence.canonicalUrl);
      externalLots.push(lot);
      selectedEvidence.push(evidence);
      continue;
    }
    if (facts.length >= 6 || typeof evidence.value !== 'string') continue;
    const key = assistantKnowledgeSemanticConflictKey(evidence);
    if (seenFacts.has(key)) continue;
    seenFacts.add(key);
    const freshness = createFreshness(evidence.verifiedAt, now);
    facts.push({
      id: evidence.factId,
      label: evidence.label,
      value: evidence.value,
      sourceLabel: evidence.sourceLabel,
      sourceUrl: evidence.sourceUrl,
      verifiedAt: evidence.verifiedAt,
      freshnessLabel: freshness.label,
      isStale: freshness.isStale,
    });
    selectedEvidence.push(evidence);
  }

  const baseContent = facts.length > 0 && externalLots.length > 0
    ? 'Нашёл подтверждённые факты и доступные лоты по официальным данным.'
    : externalLots.length > 0
      ? 'В Platforma подходящего лота нет, но он найден на официальном сайте застройщика.'
      : 'Нашёл подтверждённую информацию по официальным данным.';
  const content = conflictGroups.length > 0
    ? `${baseContent} Источники расходятся; выбраны данные ${authorityLabel(conflictGroups[0]![0]!)} как источника с высшим приоритетом.`
    : baseContent;
  return {
    content,
    answer: { kind: 'KNOWLEDGE_RESULTS', facts, externalLots },
    evidence: selectedEvidence,
  };
}

function compareEvidence(left: AssistantKnowledgeEvidence, right: AssistantKnowledgeEvidence) {
  const relevance = right.retrievalScore - left.retrievalScore;
  if (relevance !== 0) return relevance;
  const authority = assistantKnowledgeAuthorityTier(right) - assistantKnowledgeAuthorityTier(left);
  if (authority !== 0) return authority;
  const sourcePriority = right.sourcePriority - left.sourcePriority;
  if (sourcePriority !== 0) return sourcePriority;
  const freshness = Date.parse(right.verifiedAt) - Date.parse(left.verifiedAt);
  if (freshness !== 0) return freshness;
  return left.factId.localeCompare(right.factId, 'en-US');
}

function compareConflictAuthority(left: AssistantKnowledgeEvidence, right: AssistantKnowledgeEvidence) {
  const authority = assistantKnowledgeAuthorityTier(right) - assistantKnowledgeAuthorityTier(left);
  if (authority !== 0) return authority;
  const priority = right.sourcePriority - left.sourcePriority;
  if (priority !== 0) return priority;
  const promotionFocus = assistantKnowledgePromotionFocusScore(right)
    - assistantKnowledgePromotionFocusScore(left);
  if (promotionFocus !== 0) return promotionFocus;
  const freshness = Date.parse(right.verifiedAt) - Date.parse(left.verifiedAt);
  if (freshness !== 0) return freshness;
  const relevance = right.retrievalScore - left.retrievalScore;
  if (relevance !== 0) return relevance;
  return left.factId.localeCompare(right.factId, 'en-US');
}

function hasConflictingValues(evidence: AssistantKnowledgeEvidence[]) {
  return evidence.length > 1
    && new Set(evidence.map((item) => stringifyValue(item.value))).size > 1;
}

function isRelevantEvidence(query: string, evidence: AssistantKnowledgeEvidence) {
  const topic = assistantKnowledgePromotionTopic(query);
  if (!topic) return true;
  if (evidence.kind !== AssistantSourceFactKind.PROMOTION) return false;
  return assistantKnowledgeMatchesPromotionTopic(
    `${evidence.label} ${stringifyValue(evidence.value)}`,
    topic,
  );
}

function selectFocusedPromotionRepresentations(evidence: AssistantKnowledgeEvidence[]) {
  const grouped = new Map<string, AssistantKnowledgeEvidence[]>();
  const selected: AssistantKnowledgeEvidence[] = [];
  for (const item of evidence) {
    if (item.kind !== AssistantSourceFactKind.PROMOTION) {
      selected.push(item);
      continue;
    }
    const topic = assistantKnowledgePromotionTopic(`${item.label} ${stringifyValue(item.value)}`);
    if (!topic) {
      selected.push(item);
      continue;
    }
    const key = `${item.sourceId}:${topic}`;
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  for (const group of grouped.values()) {
    const maximumFocus = Math.max(...group.map(assistantKnowledgePromotionFocusScore));
    selected.push(...group.filter((item) => assistantKnowledgePromotionFocusScore(item) === maximumFocus));
  }
  return selected;
}

function stringifyValue(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function authorityLabel(evidence: AssistantKnowledgeEvidence) {
  const tier = assistantKnowledgeAuthorityTier(evidence);
  if (tier === 3) return 'официального сайта проекта';
  if (tier === 2) return 'официального сайта застройщика или банка';
  return 'детерминированных внутренних данных';
}

function parseExternalLot(
  evidence: AssistantKnowledgeEvidence,
  now: Date,
): AssistantExternalLotCard | null {
  if (!isRecord(evidence.value)) return null;
  const value = evidence.value;
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 300
    || typeof value.priceRub !== 'number' || !Number.isFinite(value.priceRub) || value.priceRub <= 0
    || value.availability !== 'AVAILABLE'
    || typeof value.href !== 'string' || value.href !== evidence.canonicalUrl || !isSafeOfficialHttpsUrl(value.href)) {
    return null;
  }
  const rooms = typeof value.rooms === 'number' && Number.isInteger(value.rooms) && value.rooms >= 0
    ? value.rooms
    : null;
  const area = typeof value.area === 'number' && Number.isFinite(value.area) && value.area > 0
    ? value.area
    : null;
  const subtitle = [
    rooms === null ? null : rooms === 0 ? 'Студия' : `${rooms}-комнатная`,
    area === null ? null : `${formatNumber(area)} м²`,
  ].filter((item): item is string => Boolean(item)).join(' · ') || 'Лот на официальном сайте';
  const freshness = createFreshness(evidence.verifiedAt, now);
  return {
    id: evidence.factId,
    title: value.title,
    subtitle,
    priceRub: value.priceRub,
    availabilityLabel: 'В продаже на официальном сайте',
    freshnessLabel: freshness.label,
    isStale: freshness.isStale,
    href: value.href,
  };
}

function isValidEvidence(evidence: AssistantKnowledgeEvidence) {
  return evidence.evidenceType === 'KNOWLEDGE_SOURCE'
    && uuidPattern.test(evidence.factId)
    && uuidPattern.test(evidence.sourceId)
    && uuidPattern.test(evidence.sourceRevisionId)
    && evidence.label.trim().length > 0
    && evidence.label.length <= 300
    && Number.isFinite(Date.parse(evidence.observedAt))
    && Number.isFinite(Date.parse(evidence.fetchedAt))
    && Number.isFinite(Date.parse(evidence.verifiedAt))
    && evidence.sourceLabel.trim().length > 0
    && evidence.sourceLabel.length <= 300
    && isSafeOfficialHttpsUrl(evidence.sourceUrl)
    && isSafeOfficialHttpsUrl(evidence.canonicalUrl);
}

function createFreshness(value: string, now: Date) {
  const fetchedAt = new Date(value);
  const hours = Math.floor(Math.max(0, now.getTime() - fetchedAt.getTime()) / 3_600_000);
  if (hours < 1) return { label: 'обновлено менее часа назад', isStale: false };
  if (hours < 24) {
    return { label: `обновлено ${hours} ${pluralize(hours, 'час', 'часа', 'часов')} назад`, isStale: false };
  }
  const days = Math.floor(hours / 24);
  return {
    label: `данные могут быть устаревшими · обновлено ${days} ${pluralize(days, 'день', 'дня', 'дней')} назад`,
    isStale: true,
  };
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
}

function pluralize(value: number, one: string, few: string, many: string) {
  const modulo100 = value % 100;
  const modulo10 = value % 10;
  if (modulo100 >= 11 && modulo100 <= 14) return many;
  if (modulo10 === 1) return one;
  if (modulo10 >= 2 && modulo10 <= 4) return few;
  return many;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
