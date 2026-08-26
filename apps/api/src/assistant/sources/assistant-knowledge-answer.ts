import { AssistantSourceFactKind } from '@prisma/client';
import type {
  AssistantAnswer,
  AssistantExternalLotCard,
  AssistantKnowledgeFactCard,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

import type { AssistantKnowledgeEvidence } from './assistant-knowledge-retrieval.service';
import {
  assistantKnowledgeAuthorityScore,
  assistantKnowledgeConflictKey,
  isSafeOfficialHttpsUrl,
} from './assistant-knowledge-policy';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function buildAssistantKnowledgeAnswer(
  rawEvidence: AssistantKnowledgeEvidence[],
  now = new Date(),
): {
  content: string;
  answer: Extract<AssistantAnswer, { kind: 'KNOWLEDGE_RESULTS' }>;
  evidence: AssistantKnowledgeEvidence[];
} {
  const ranked = rawEvidence.filter(isValidEvidence).sort(compareEvidence);
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
    const key = assistantKnowledgeConflictKey(evidence);
    if (seenFacts.has(key)) continue;
    seenFacts.add(key);
    const freshness = createFreshness(evidence.fetchedAt, now);
    facts.push({
      id: evidence.factId,
      label: evidence.label,
      value: evidence.value,
      freshnessLabel: freshness.label,
      isStale: freshness.isStale,
    });
    selectedEvidence.push(evidence);
  }

  const content = facts.length > 0 && externalLots.length > 0
    ? 'Нашёл подтверждённые факты и доступные лоты по официальным данным.'
    : externalLots.length > 0
      ? 'В Platforma подходящего лота нет, но он найден на официальном сайте застройщика.'
      : 'Нашёл подтверждённую информацию по официальным данным.';
  return {
    content,
    answer: { kind: 'KNOWLEDGE_RESULTS', facts, externalLots },
    evidence: selectedEvidence,
  };
}

function compareEvidence(left: AssistantKnowledgeEvidence, right: AssistantKnowledgeEvidence) {
  const authority = assistantKnowledgeAuthorityScore(right) - assistantKnowledgeAuthorityScore(left);
  if (authority !== 0) return authority;
  const relevance = right.retrievalScore - left.retrievalScore;
  if (relevance !== 0) return relevance;
  const freshness = Date.parse(right.observedAt) - Date.parse(left.observedAt);
  if (freshness !== 0) return freshness;
  return left.factId.localeCompare(right.factId, 'en-US');
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
  const freshness = createFreshness(evidence.fetchedAt, now);
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
